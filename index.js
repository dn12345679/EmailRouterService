
import { load } from 'cheerio'; 



import { writeFileSync } from 'fs';

import { keyInSelect } from 'readline-sync';


import settings from './appSettings.js';
import {
  initializeGraphForUserAuth,
  getUserAsync,
  getUserTokenAsync,
  getInboxAsync,
  sendMailAsync,
  uploadToDB,
  getConversationMessagesAsync,

  extractBodyTextWithCheerio,
  //makeGraphCallAsync,
} from './graphHelper.js';
import { text } from 'stream/consumers';
import { classify_email_by_ID } from './dbManager.js';




async function main() {

  let choice = 0;

  // Initialize Graph
  await initializeGraph(settings);

  // Greet the user by name
  await greetUserAsync();

  const choices = [
    'Display access token',
    'List my inbox',
    'Send mail',
    'Insert into DB',
    'Classify Email',
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
        const msgs = await getInboxAsync();
        console.log(msgs);

        break;
      case 2:
        // Send an email message
        await sendMailToSelfAsync();
        break;
      case 3:
        await uploadToDB();

        break;
      case 4:
        const id = "AAQkADQzNTI4NjQ3LTkwYmItNDljYS1hZmQ1LTc2YzNjMmM2MTQ0NAAQALsp2nyFykVghdNWvlsw5qY="
        
        await classify_email(id);
        break;
      
      default:
        console.log('Invalid choice! Please try again.');
    }
  }
}

main();



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
  console.log('')
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

// yeah this a waste of space
async function classify_email(id) {
  
  await classify_email_by_ID(id)
}