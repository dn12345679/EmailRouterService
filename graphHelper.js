

import 'isomorphic-fetch';
import {DeviceCodeCredential, useIdentityPlugin } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
// prettier-ignore
import { TokenCredentialAuthenticationProvider } from
'@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';


import { load } from 'cheerio'; 
import { insertIntoDB }  from './dbManager.js';

import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';

let _settings = undefined;
let _deviceCodeCredential = undefined;
let _userClient = undefined;


import { cachePersistencePlugin } from '@azure/identity-cache-persistence';
useIdentityPlugin(cachePersistencePlugin);


const CACHE_FILE = path.join(app.getPath('userData'), 'auth-record.json');

export async function initializeGraphForUserAuth(settings, deviceCodePrompt) {
  // Ensure settings isn't null
  if (!settings) {
      throw new Error('Settings cannot be undefined');
  }

  _settings = settings;
  let savedRecord = undefined;

  try {
      const fileContent = await fs.readFile(CACHE_FILE, 'utf8');
      savedRecord = JSON.parse(fileContent);
  } catch (err) {
      console.log('No cached session found. A device code prompt will be required.');
  }

  _deviceCodeCredential = new DeviceCodeCredential({
      clientId: settings.clientId,
      tenantId: settings.tenantId,
      userPromptCallback: deviceCodePrompt,
      authenticationRecord: savedRecord ,
      tokenCachePersistenceOptions: {
        enabled: true,
        name: 'email-router-token-cache'
      }
  });


  if (!savedRecord) {
      try {

          const authRecord = await _deviceCodeCredential.authenticate(settings.graphUserScopes);
          await fs.writeFile(CACHE_FILE, JSON.stringify(authRecord));
      } catch (error) {
          console.error('Authentication failed:', error);
          throw error;
      }
  }

  const authProvider = new TokenCredentialAuthenticationProvider(
      _deviceCodeCredential,
      {
      scopes: settings.graphUserScopes,
      },
  );
  
  _userClient = Client.initWithMiddleware({
      authProvider: authProvider,
  });
}

export async function getUserTokenAsync() {
    if (!_deviceCodeCredential) {
        throw new Error('Graph has not been initialized for user auth');
    }

    if (!_settings?.graphUserScopes) {
        throw new Error('Setting "scopes" cannot be undefined');
    }
    const response = await _deviceCodeCredential.getToken(
        _settings?.graphUserScopes,
    );
    return response.token;
}

export async function getUserAsync() {

    if (!_userClient) {
        throw new Error('Graph has not been initialized for user auth');
    }

    // Only request specific properties with .select()
    return _userClient
        .api(`/me`)
        .select(['displayName', 'mail', 'userPrincipalName'])
        .get();
}

// address of user signed in
let _ownerAddress = undefined;
export async function getSignedInAddress() {
  if (_ownerAddress !== undefined) return _ownerAddress;
  try {
    const u = await getUserAsync();
    _ownerAddress = (u?.mail ?? u?.userPrincipalName ?? '').toLowerCase() || null;
  } catch (e) {
    console.error('getSignedInAddress failed:', e.message);
    _ownerAddress = null;
  }
  return _ownerAddress;
}
// THIS ASSUMES that jessica is forwarded the email chain, rather than included in it


export async function getConversationMessagesAsync(conversationId) {
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }
  const result = await _userClient
    .api(`/me/messages`)
    .filter(`conversationId eq '${conversationId}'`)
    .header('Prefer', 'IdType="ImmutableId"') // immutable so that no issues come up when the email thread is moved around
    .select([
      'subject',
      'from',
      'toRecipients',
      'ccRecipients',
      'receivedDateTime',
      'lastModifiedDateTime',
      'body',
      'uniqueBody',
      'isRead',
      'conversationIndex',
      'id',
      'internetMessageHeaders',

      'bccRecipients',
      'replyTo',
      'sender'
    ])
    .top(100)
    .get();
    // graph doesnot allow filtering and orderby at the same time.
  return result;
}



async function greetUserAsync() {
  try {
    const user = await getUserAsync();
    console.log(`Hello, ${user?.displayName}!`);

    console.log(`Email: ${user?.mail ?? user?.userPrincipalName ?? ''}`);
  } catch (err) {
    console.log(`Error getting user: ${err}`);
  }
}
export async function getInboxAsync() {
  // Ensure client isn't undefined
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }

  return _userClient
    // only check inbox messages (archive used for hiding from rechecking)
    .api('/me/mailFolders/inbox/messages')
    .select(['from', 'isRead', 'receivedDateTime', 'subject', 'conversationId', 'id'])
    .header('Prefer', 'IdType="ImmutableId", outlook.body-content-type="text"')
    .top(5)
    .orderby('receivedDateTime DESC')
    .get();
}


function extractReplyInfo(msg) {
  const headers = msg.internetMessageHeaders || [];
  
  const inReplyTo = headers.find(h => h.name === 'In-Reply-To')?.value;
  const references = headers.find(h => h.name === 'References')?.value?.split(' ');
  
  return {
    inReplyTo,
    references
  };
}

// part of uploadToDB(), just gets all the unique conversation threads
export async function getUniqueMessages() {
 if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }
  
  const uc = await getInboxAsync();
  const unique_cid = [...new Set(uc.value.map(message => message.conversationId))];

  const owner = await getSignedInAddress(); // lowercase address of this mailbox

  const output = [];

  for (const id of unique_cid) {
    const thread = await getConversationMessagesAsync(id);
    const threadMessages = thread.value;

    const sorted = threadMessages.sort((a, b) =>
      new Date(a.receivedDateTime) - new Date(b.receivedDateTime)
    );

    // newest message any
    const lastIncoming = [...sorted].reverse().find(
      msg => (msg.from?.emailAddress?.address || '').toLowerCase() !== owner
    );
    const lastResponseDate = lastIncoming?.receivedDateTime ?? null;

    const fullBody = sorted.map(msg => {
      const text = extractBodyTextWithCheerio(msg.uniqueBody?.content ?? '').join(" ");
      return `[${msg.receivedDateTime} - ${msg.from?.emailAddress?.address}]:\n${text}`;
    }).join('\n\n---\n\n');

    const latest = sorted[sorted.length - 1];
    const replyInfo = extractReplyInfo(latest);

    output.push({
      id: latest.id,
      conversationId: id,
      status: 'read',
      created: sorted[0].receivedDateTime,
      forwarded: false,
      updated: latest.receivedDateTime,
      sender: sorted[0].from?.emailAddress?.address,
      subject: latest.subject,
      synopsis: null,
      body: fullBody,
      last_response_date: lastResponseDate,
      in_reply_to: replyInfo.inReplyTo ?? null,
      
      all_parties: Array.from(new Set(
        sorted.flatMap(msg => [
          msg.sender?.emailAddress?.address,
          msg.from?.emailAddress?.address,
          ...(msg.toRecipients ?? []).map(r => r.emailAddress?.address),
          ...(msg.ccRecipients ?? []).map(r => r.emailAddress?.address),
          ...(msg.bccRecipients ?? []).map(r => r.emailAddress?.address),
          ...(msg.replyTo ?? []).map(r => r.emailAddress?.address),
        ].filter(Boolean).map(a => a.toLowerCase()))
      )),

      internal: false, // whether is from internal domain or not
    });
  }
  return output;
}

// handles uploading
export async function uploadToDB() {
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }
  
  const output = await getUniqueMessages()

  console.log(`Total emails: ${output.length}`);
  
  
  

  await insertIntoDB(output); // check local db
  
  return output;
}


export function extractBodyTextWithCheerio(htmlContent) {
  const $ = load(htmlContent);

  $('style').remove();
  $('script').remove();
  $('[id*="Signature"]').remove();
  $('[class*="Signature"]').remove();
  $('[id*="divRplyFwdMsg"]').remove();
  $('[class*="divRplyFwdMsg"]').remove();
  $('hr').remove();

  const full_text = $.text().trim()
  
  return [full_text];
}


function toRecipientList(recipients) {
  const list = Array.isArray(recipients) ? recipients : [recipients];
  return list
    .filter(Boolean)
    .map(address => ({ emailAddress: { address } }));
}

// forwardcs whole thread with messageId to recipients wiht a comment
export async function forwardThreadAsync(messageId, recipients, comment = '') {
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }
  const toRecipients = toRecipientList(recipients);
  if (!toRecipients.length) {
    throw new Error('forwardThreadAsync: at least one recipient is required');
  }
  return _userClient.api(`/me/messages/${messageId}/forward`).post({
    comment,
    toRecipients,
  });
}

// reply all with status (used for closing)
export async function replyAllToThreadAsync(messageId, comment) {
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }
  return _userClient.api(`/me/messages/${messageId}/replyAll`).post({
    comment,
  });
}

// reply to singular (or all)
export async function replyToThreadAsync(messageId, comment, toRecipients = null) {
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }
  const list = toRecipientList(toRecipients ?? []);
  if (!list.length) {
    return _userClient.api(`/me/messages/${messageId}/replyAll`).post({ comment });
  }
  return _userClient.api(`/me/messages/${messageId}/reply`).post({
    comment,
    message: { toRecipients: list },
  });
}


export async function getConversationMessageIdsAsync(conversationId) {
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }
  const result = await _userClient
    .api('/me/messages')
    .filter(`conversationId eq '${conversationId}'`)
    .header('Prefer', 'IdType="ImmutableId"')
    .select(['id'])
    .top(100)
    .get();
  return (result.value ?? []).map(m => m.id);
}

// archive message
export async function archiveThreadAsync(conversationId) {
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }
  const ids = await getConversationMessageIdsAsync(conversationId);
  let moved = 0;
  for (const id of ids) {
    try {
      await _userClient.api(`/me/messages/${id}/move`).post({ destinationId: 'archive' });
      moved++;
    } catch (err) {
      console.error(`archiveThreadAsync: failed to move message ${id}:`, err.message);
    }
  }
  return moved;
}


export async function sendMailAsync(subject, body, recipient) {

  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }

  const message = {
    subject: subject,
    body: {
      content: body,
      contentType: 'text',
    },
    toRecipients: [
      {
        emailAddress: {
          address: recipient,
        },
      },
    ],
  };

  // Send the `message`
  return _userClient.api(`/me/sendMail`).post({
    message: message,
  });
}