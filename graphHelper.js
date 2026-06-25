

import 'isomorphic-fetch';
import {DeviceCodeCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
// prettier-ignore
import { TokenCredentialAuthenticationProvider } from
'@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';

let _settings = undefined;
let _deviceCodeCredential = undefined;
let _userClient = undefined;




// cache login to skip annoyance
import { readFileSync, writeFileSync, existsSync } from 'fs';
const cachePath = './token_cache.json';


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
      userPromptCallback: deviceCodePrompt
  });

  console.log('Client ID being used:', settings.clientId);
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
        .api(`/users/${_settings.userEmail}`)
        .select(['displayName', 'mail', 'userPrincipalName'])
        .get();
}
// THIS ASSUMES that jessica is forwarded the email chain, rather than included in it
export async function getConversationMessagesAsync(conversationId) {
  if (!_userClient) {
    throw new Error('Graph has not been initialized for user auth');
  }
  return _userClient
    .api(`/users/${_settings.userEmail}/mailFolders/inbox/messages/`)
    .filter(`conversationId eq '${conversationId}'`)
    .select(['subject', 'from', 'toRecipients', 'ccRecipients', 
             'receivedDateTime', 'body', 'isRead', 'conversationIndex'])
    .get();
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
    .top(25)
    .orderby('receivedDateTime DESC')
    .get();
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
  return _userClient.api(`/users/${_settings.userEmail}/sendMail`).post({
    message: message,
  });
}