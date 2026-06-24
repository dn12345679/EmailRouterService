

import { writeFileSync } from 'fs';

import { keyInSelect } from 'readline-sync';

import settings from './appSettings.js';
import {
  initializeGraphForUserAuth,
  getUserAsync,
  getUserTokenAsync,
  getInboxAsync,
  sendMailAsync,
  getConversationMessagesAsync,
  //makeGraphCallAsync,
} from './graphHelper.js';

async function main() {
  console.log('JavaScript Graph Tutorial');

  let choice = 0;

  // Initialize Graph
  await initializeGraph(settings);

  // Greet the user by name
  await greetUserAsync();

  const choices = [
    'Display access token',
    'List my inbox',
    'Send mail',
    'Make a Graph call',
        'List conversation thread',
  ];

  while (choice != -1) {
    choice = keyInSelect(choices, 'Select an option', { cancel: 'Exit' });

    switch (choice) {
      case -1:
        // Exit
        console.log('Goodbye...');
        break;
      case 0:
        // Display access token
        await displayAccessTokenAsync();
        break;
      case 1:
        // List emails from user's inbox
        await listInboxAsync();
        break;
      case 2:
        // Send an email message
        await sendMailToSelfAsync();
        break;
      case 3:
        // Run any Graph code
        await doGraphCallAsync();
        break;
      case 4:
        await listConversationAsync();
        break;
      default:
        console.log('Invalid choice! Please try again.');
    }
  }
}

main();


async function listConversationAsync() {
  try {
    const messagePage = await getInboxAsync(); // gets the top 25* email messages
    const messages = messagePage.value;

    console.log('\nPick a message to view full');
    messages.slice(0, 5).forEach((m, i) => {
      console.log(`[${i + 1}] ${m.subject ?? 'NO SUBJECT'} — from ${m.from?.emailAddress?.name}`);
    });// list out all the messages

    // again as the options but without sender
    const idx = parseInt(keyInSelect(
      messages.slice(0, 5).map(m => m.subject ?? 'NO SUBJECT'),
      'Select a message'
    ));

    if (idx === -1) return;

    const conversationId = messages[idx].conversationId;
    console.log(`\nFetching thread for conversationId: ${conversationId}`);

    const thread = await getConversationMessagesAsync(conversationId);
    const threadMessages = thread.value;

    console.log(`\nThread contains ${threadMessages.length} messages\n`);

    for (const [i, msg] of threadMessages.entries()) {
      console.log(`[${i + 1}] Subject:  ${msg.subject}`);
      console.log(`     From:     ${msg.from?.emailAddress?.name} <${msg.from?.emailAddress?.address}>`);
      console.log(`     Received: ${msg.receivedDateTime}`);
      console.log(`     Status:   ${msg.isRead ? 'Read' : 'Unread'}`);
      console.log(`     Body:     ${msg.body?.content?.slice(0, 100).replace(/\n/g, ' ')}`);
      writeFileSync('email_body.html', msg.body?.content ?? '');
      console.log('');
    }

    
  } catch (err) {
    console.log(`Error getting conversation: ${err}`);
  }
}


async function initializeGraph(settings) {
  await initializeGraphForUserAuth(settings, (info) => {
    // Display the device code message to
    // the user. This tells them
    // where to go to sign in and provides the
    // code to use.
    console.log(info.message);
  });
}

async function greetUserAsync() {
  // TODO
}

async function displayAccessTokenAsync() {
  try {
    const userToken = await getUserTokenAsync();
    console.log(`User token: ${userToken}`);
  } catch (err) {
    console.log(`Error getting user access token: ${err}`);
  }
}

async function listInboxAsync() {
  try {
    const messagePage = await getInboxAsync();
    const messages = messagePage.value;

    // Output each message's details
    for (const message of messages) {
      console.log(`Message: ${message.subject ?? 'NO SUBJECT'}`);
      console.log(`Email Body: ${message.body ?? 'NO BODY'}`);
      console.log(`Email ID: ${message.conversationId ?? 'NO CONVERSATION ID'}`);
      console.log(`CC Recipients: ${message.ccRecipients ?? 'NO CC RECIPIENTS'}`);
      console.log(`  From: ${message.from?.emailAddress?.name ?? 'UNKNOWN'}`);
      console.log(`  Status: ${message.isRead ? 'Read' : 'Unread'}`);
      console.log(`  Received: ${message.receivedDateTime}`);
    }

    // If @odata.nextLink is not undefined, there are more messages
    // available on the server
    const moreAvailable = messagePage['@odata.nextLink'] != undefined;
    console.log(`\nMore messages available? ${moreAvailable}`);
  } catch (err) {
    console.log(`Error getting user's inbox: ${err}`);
  }
}

async function sendMailToSelfAsync() {
  try {
    // Send mail to the signed-in user
    // Get the user for their email address
    const user = await getUserAsync();
    const userEmail = user?.mail ?? user?.userPrincipalName;

    if (!userEmail) {
      console.log("Couldn't get your email address, canceling...");
      return;
    }

    await sendMailAsync('Testing Microsoft Graph', 'Hello world!', userEmail);
    console.log('Mail sent.');
  } catch (err) {
    console.log(`Error sending mail: ${err}`);
  }
}

async function doGraphCallAsync() {
  // TODO
}