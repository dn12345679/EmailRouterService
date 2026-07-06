

import 'isomorphic-fetch';
import {DeviceCodeCredential, useIdentityPlugin } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { setLogLevel } from '@azure/logger';
setLogLevel('info');
// prettier-ignore
import { TokenCredentialAuthenticationProvider } from
'@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';


import { load } from 'cheerio'; 
import { insertIntoDB }  from './dbManager.js';

let _settings = undefined;
let _deviceCodeCredential = undefined;
let _userClient = undefined;


export async function initializeGraphForUserAuth(settings, deviceCodePrompt) {
  // Ensure settings isn't null
  if (!settings) {
      throw new Error('Settings cannot be undefined');
  }

  _settings = settings;

  _deviceCodeCredential = new DeviceCodeCredential({
      clientId: settings.clientId,
      tenantId: settings.tenantId,
      //clientSecret: settings.clientSecret,
      userPromptCallback: deviceCodePrompt,
  });

  //console.log('Client ID being used:', settings.clientId);
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
// Ensure credential isn't undefined
if (!_deviceCodeCredential) {
    throw new Error('Graph has not been initialized for user auth');
}

// Ensure scopes isn't undefined
if (!_settings?.graphUserScopes) {
    throw new Error('Setting "scopes" cannot be undefined');
}

// Request token with given scopes
const response = await _deviceCodeCredential.getToken(
    _settings?.graphUserScopes,
);
return response.token;
}

export async function getUserAsync() {
    // Ensure client isn't undefined
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
      'sentDateTime',
      'body',
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
    //.select(['from', 'isRead', 'receivedDateTime', 'subject'])
    .header('Prefer', 'outlook.body-content-type="text"')
    .top(100)
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

// handles uploading
export async function uploadToDB() {
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }
  
  const uc = await getInboxAsync();
  const output = [];

  for (const msg of uc.value) {
    const conversationId = msg.conversationId;
    const thread = await getConversationMessagesAsync(conversationId);
    const threadMessages = thread.value;

    for (const threadMsg of threadMessages) {
      const replyInfo = extractReplyInfo(threadMsg);
      const data = {
        "id": threadMsg.id,
        "conversationId": conversationId,
        "status": 'unread',
        "created": threadMsg.sentDateTime,
        "updated": threadMsg.sentDateTime,
        "sender": threadMsg.from?.emailAddress?.address,
        "subject": threadMsg.subject,
        "body": extractBodyTextWithCheerio(threadMsg.body?.content ?? '').join(" "),
        "in_reply_to": replyInfo.inReplyTo ?? null
      };
      output.push(data); 
    }
  }

  console.log(`Total emails: ${output.length}`);

  for (let i = 1; i < 3; i++) {
    console.log(JSON.stringify(output[i], "", 2));  // EXAMPLE of output
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