

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
// THIS ASSUMES that jessica is forwarded the email chain, rather than included in it

/*
 Input: a valid conversationId referencing an email thread.
 Output: A JSON object containing 1 column: 'value'
  'value' is an array of JSON object(s) where each object is an individual message.
*/
export async function getConversationMessagesAsync(conversationId) {
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }
  const result = await _userClient
    .api(`/me/mailFolders/inbox/messages/`)
    .filter(`conversationId eq '${conversationId}'`)
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
      'internetMessageHeaders'
    ])
    .get();
    // graph doesnot allow filtering and orderby at the same time.
  return result;
}



async function greetUserAsync() {
  try {
    const user = await getUserAsync();
    console.log(`Hello, ${user?.displayName}!`);
    // For Work/school accounts, email is in mail property
    // Personal accounts, email is in userPrincipalName
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
    .api('/me/mailFolders/inbox/messages')
    .select(['from', 'isRead', 'receivedDateTime', 'subject', 'conversationId'])
    .header('Prefer', 'outlook.body-content-type="text"')
    .top(10)
    .orderby('receivedDateTime ASC')
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

  const output = [];

  for (const id of unique_cid) {
    const thread = await getConversationMessagesAsync(id);
    const threadMessages = thread.value;

    const sorted = threadMessages.sort((a, b) =>
      new Date(a.receivedDateTime) - new Date(b.receivedDateTime)
    );

    const fullBody = sorted.map(msg => {
      const text = extractBodyTextWithCheerio(msg.body?.content ?? '').join(" ");
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
      in_reply_to: replyInfo.inReplyTo ?? null,
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

  for (let i = 1; i < 3; i++) {
    //console.log(output[i])
    //console.log('')
    //console.log(JSON.stringify(output[i], "", 2));  // EXAMPLE of output
  }
  
  

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


export async function sendMailAsync(subject, body, recipient) {
  // Ensure client isn't undefined
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }

  // Create a new message
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