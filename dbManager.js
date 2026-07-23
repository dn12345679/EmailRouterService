import pg from "pg";
import dotenv from 'dotenv';
const {Pool, Client} = pg
import { load } from 'cheerio';
import { CONDITION_BUCKETS, ROUTING_CONFIG, SUBJECT_BUCKETS } from "./appsettings.js"; 
import {
  getConversationMessagesAsync,
  extractBodyTextWithCheerio,
} from './graphHelper.js';
import fs from 'fs/promises'; 

import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();


import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const region_tracker = path.join(__dirname, 'propertyToRegion.json');
const response = await fs.readFile(region_tracker, 'utf8');
const data = JSON.parse(response);





// https://node-postgres.com/features/connecting
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PW,
  port: process.env.DB_PORT,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME
})



export const EXAMPLE = 
`
{
  "subject": {
    "main": "Maintenance",
    "sub": "Utilities and Infrastructure"
  },
  "conditions": {
    "northDakota": false,
    "eastGroup": false,
    "westGroup": false,
    "unusualWaterBill": false,
    "tenantNonCompliance": false,
    "significantSafetyIssue": false,
    "minorSafetyIssue": false,
    "normalRuleViolation": false,
    "companySellingHome": false,
    "employeeExpenseOrTimeOff": false
  },
  "property": {
    "location": ["Bakerview Estates"],
    "code": ["BV"],
    "lot": ["99"]
  },
  "important": {
    "synopsis": "BV 99 Pavement Path Damaged",
    "summary": "this is a summary of the email in 100 words or less",
    "completed": false,
    "removeFromThread": [],
    "scheduledReminder": "MM/DD/YYYY" or "-"
  }
}
`

export const TEST_EMAIL = `The pipes in bakerview lot 99 are currently undergoind maintenance. Avoid using excessive water for now.`

export const PROMPT = (SUBJECTS, MESSAGE, SUBJECT_LINE, CONDITIONS, TEMPLATE) =>  
`Given the email below, classify it into the predefined subject buckets provided here: ${SUBJECTS} \n

Email Message to classify:\n ${MESSAGE}
Email Subject Line: \n ${SUBJECT_LINE}

Instructions:
1. Compute a probability for every top-level subject and bottom-level subcategory, and return the main subject and the most likely subcategory under "subject.main" and "subject.sub". Pay attention to the order that
the emails in the chain are in, as noted by the date and time of received. The messages in the thread may not have been ordered in sequential time.
2. Evaluate every condition independently. It is not required to figure out if the region is North Dakota or eastGroup or westGroup, but fill if possible. Return true if the likelihood is at least 0.5; otherwise return false. The conditions are here: ${CONDITIONS}
3. If relevant to the message and not a brief mention, return also:
   - Property Location. If there are multiple locations, list them in an array format like this: [Bakerview, Appaloosa]
   - Property Code enclosed in array format regardless of count []. If there are multiple 2 Letter Property Codes, List them in an array format like this: [BV, AP]
   - Lot Number enclosed in array format regardless of count []. If there are multiple Lot numbers, List them in an array format. And if they are associated with a Property Code, prefix it. For example: [BV_83, AP_21, none_14, BV_99]
4. Write a short summary consisting of a few sentences or words. Add the summary content as a string in the "summary" property under "important". 
5. Under the "completed" field in "important", Set completed = true if the thread reaches a clear resolution  (e.g. "looks good", "thanks for completing this", or similar  closing acknowledgment) AND no message after that point raises  a new problem or requests further action. Otherwise, completed = false.
6. Under "removeFromThread" field in "important", there is an empty array. If at any point in the thread a recipient requests to have their email removed from the thread, add their 
7. Under "synopsis" field in "important", create a string of around 5-6 words that fits as a title of the email in the form: 
 Property Code + Lot Number + Subjects + Adjective/Description. For example "AR 42 Increase Rescission Delivered"
 If there are multiple property codes or lot numbers, List them like this: "BV 99, AD 23, ..."
 If there is no valid property code, lot number, then just write "ANY" + Subjects + Description.
8. Under "scheduledReminder" in "important", if there is a mention of a specific deadline(s), choose the one from the most recent email, and assign that value in the MM/DD/YYYY format to this property. Otherwise leave as "-".
9. Return only a valid JSON string matching the format with example values shown below (Actual Conditions and Subjects may not match the template exactly due to changes in structure). Do not include any explanations or extra content, just fill out the JSON.

${TEMPLATE}

`





const NO_CODE = 'none';
const NO_LOT = 'unspecified';




// testing for now. Returns a classification of the email based on a prompt
async function LLM_classification(prompt) {
  const message = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    cache_control: { type: "ephemeral" },
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });
  // currently assumes its valid 
  try {
    const classification_JSON = message.content[0].text;
    return classification_JSON;
  }
  catch (error) {
    console.log(error)
  }
  
}


// https://stackoverflow.com/questions/49035237/how-to-find-and-match-a-specific-value-in-a-json-object-array
// Given a property code(s), checks the region against the JSON. Return a JSON object representing the region
// if multiple property codes are given, then return the regions that all the property codes are related to. 
/*
{
  East: boolean,
  West: boolean,
  North: boolean
}
*/
async function check_region_by_code(codes) {
  const return_json = {
    East: false,
    West: false,
    North: false
  };

  for (const code of codes) {
    const community = data?.find(o =>
      Object.entries(o).some(([k, value]) => k === 'Community Code' && value === code)
    );

    if (!community) continue; // no match for this code, skip

    if (community.Region === "East") return_json.East = true;
    if (community.Region === "West") return_json.West = true;
    if (community.Region === "North") return_json.North = true;
  }

  return return_json;
}


export async function classify_email(email) {
  try{
    const body_content = email.body
    const cheeriod = extractBodyTextWithCheerio(body_content ?? ' ').join(" ")
    const str = PROMPT(JSON.stringify(SUBJECT_BUCKETS), cheeriod,  email.subject, JSON.stringify(CONDITION_BUCKETS), EXAMPLE)
    
    const initial_JSON = await LLM_classification(str)
    const clean = initial_JSON.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(clean);

    // classify region
    const property_code_classification = await check_region_by_code(obj.property.code)
    obj.conditions.northDakota = property_code_classification.North
    obj.conditions.eastGroup = property_code_classification.East 
    obj.conditions.westGroup = property_code_classification.West
    
    return obj; // should be good from here. 
  }
  catch(error){
    console.log(error)
  }
  
}


// given an input conversation id, representing the conversation of a forwarded or CC'd or direct email from graphHelper.getConversationMessagesAsync(id),
// calls Claude to classify and update the database if the database has missing data that it can fill in. 
export async function classify_email_by_ID(id) {
  try{
    const conversation = await getConversationMessagesAsync(id)
    //const body_content = conversation.value[0].body?.content

    
    return classify_email(conversation); // should be good from here. 
  }
  catch(error){
    console.log(error)
  }

}


// checks if emails even need attention 
export async function email_needs_classification(emails) {
  const conversation_ids = emails.map(e => e.conversationId);
  const updated_dates = emails.map(e => e.updated);

  const result = await pool.query(`
    SELECT t.conversationId
    FROM UNNEST($1::text[], $2::timestamptz[]) AS t(conversationId, updated)
    LEFT JOIN email m ON m.conversation_id = t.conversationId
    WHERE m.conversation_id IS NULL
       OR m.updated IS DISTINCT FROM t.updated
  `, [conversation_ids, updated_dates]);

  return result.rows.map(row => row.conversationid);
}
export async function email_needs_reminder() {
  const result = await pool.query(`
    SELECT DISTINCT m.conversation_id
    FROM email m
    JOIN recipients r ON r.conversation_id = m.conversation_id
    WHERE m.status != 'complete'
      AND r.reminder_date IS NOT NULL
      AND r.reminder_date < NOW()
  `);
  return result.rows.map(row => row.conversation_id);
}

// Returns the conversation_id of a similar existing email

// checks property_code, lots, main, subtopic, exclude the current email, and checks whether an existing email on the database exists
async function find_similar_synopsis(client, synopsis, propertyCodes, lots, subjectMain, subjectSub, currentConversationId) {
  const pairs = parsePropertyPairs(propertyCodes, lots);
  const codesArr = pairs.map(p => p.code);
  const lotsArr = pairs.map(p => p.lot);

  const result = await client.query(`
    SELECT DISTINCT e.conversation_id, e.synopsis,
           similarity(e.synopsis, $1) AS score
    FROM email e
    JOIN email_property ep ON ep.conversation_id = e.conversation_id
    JOIN UNNEST($2::text[], $3::text[]) AS t(code, lot)
      ON t.code = ep.property_code AND t.lot = ep.lot
    WHERE e.subject_main = $4
      AND e.subject_sub = $5
      AND e.conversation_id != $6
    ORDER BY score DESC
    LIMIT 1;
  `, [synopsis, codesArr, lotsArr, subjectMain, subjectSub, currentConversationId]);

  return result.rows[0] ?? null;
}


function conditionsMatch(ruleConditions, context) {
  return Object.entries(ruleConditions).every(
    ([key, expectedValue]) => context[key] === expectedValue
  );
}


export async function getReadEmailsWithIntents() {
  try {
    const result = await pool.query(`
      SELECT *
      FROM email
      WHERE status = 'read' OR duplicate_of IS NOT NULL
    `);
    const messages = result.rows;
    const forward = messages
      .filter(m => !m.forwarded)
      .map(m => m.conversation_id);

    const complete = messages
      .filter(m => m.status === 'complete' && m.duplicate_of === null)
      .map(m => m.conversation_id);

    const duplicate = messages
      .filter(m => m.duplicate_of !== null)
      .map(m => [m.conversation_id, m.duplicate_of]);

    const reminderIntents = { reminder: [], supervisor: [] };
    await checkReminders(messages, reminderIntents);

    const intentsByConversationId = new Map();
    for (const convId of forward) intentsByConversationId.set(convId, 'forward');
    for (const [newConvId] of duplicate) intentsByConversationId.set(newConvId, 'duplicate');
    for (const convId of complete) intentsByConversationId.set(convId, 'complete');
    for (const convId of reminderIntents.reminder) {
      if (!intentsByConversationId.has(convId)) intentsByConversationId.set(convId, 'reminder');
    }
    for (const convId of reminderIntents.supervisor) intentsByConversationId.set(convId, 'supervisor');

    return { messages, intents: Object.fromEntries(intentsByConversationId) };
  } catch (err) {
    console.error(err);
    throw err;
  }
}



// from settings.js config, converts the outpuyt to the email addresses (must go through classify_email_by_ID first to get the JSON object)
export async function classification_to_email(LLM_output) {
  try{
    const main = LLM_output.subject.main;
    const sub = LLM_output.subject.sub;

    const bucket = SUBJECT_BUCKETS[main];// get the overall bucket
    if (!bucket) return [];

    const mainIndex = Object.keys(SUBJECT_BUCKETS).indexOf(main);
    const subjectIndex = bucket.indexOf(sub);
    if (subjectIndex === -1) return [];

    const context = LLM_output.conditions; // for checking conditional brnach

    const matches = [];
    for (const [name, person] of Object.entries(ROUTING_CONFIG)) {
      for (const rule of person.rules) {
        if (rule.main === mainIndex && rule.subject.includes(subjectIndex)) {
          const mainMatches = rule.main === mainIndex;
          const subjectMatches = rule.subject.includes(subjectIndex);
          
          const condMatches = conditionsMatch(rule.conditions ?? {}, context);

          if (mainMatches && subjectMatches && condMatches) {
            matches.push([name, person.email]);
            break; // no double count
          }
        }
      }
    }

    return matches;
  }
  catch(error) {
    console.log(error)
  }
}



function parsePropertyPairs(codes, lots) {
  const pairs = [];

  for (const entry of lots || []) {
    const [prefix, lotNum] = entry.split('_');
    const code = prefix === 'none' ? NO_CODE : prefix;
    pairs.push({ code, lot: lotNum ?? NO_LOT });
  }

  for (const code of codes || []) {
    if (!pairs.some(p => p.code === code)) {
      pairs.push({ code, lot: NO_LOT });
    }
  }

  if (!pairs.length) {
    pairs.push({ code: NO_CODE, lot: NO_LOT });
  }

  return pairs;
}


// splits classification.property.{code,lot} into (code, lot) pairs
// and replaces the row in email property (because they changed)
async function upsertPropertyPairs(client, conversationId, codes, lots) {
  if (typeof conversationId !== 'string') {
    throw new Error('upsertPropertyPairs: conversationId must be a string — check argument order');
  }
  const pairs = parsePropertyPairs(codes, lots);

  await client.query(`DELETE FROM email_property WHERE conversation_id = $1`, [conversationId]); // delete bc property probably changed

  for (const { code, lot } of pairs) {
    await client.query(`
      INSERT INTO email_property (conversation_id, property_code, lot)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `, [conversationId, code, lot]);
  }
}

// checks if for a given email thread conversationId, and a party of interest party, checks if they already exist
export async function party_included_DB(conversationId, party){
  const result = await client.query(
    `SELECT EXISTS(SELECT 1 FROM recipients WHERE conversation_id = $1 AND intended_recipient = $2)`,
    [conversationId, party]
  );
  return result.rows[0].exists;
}
// same thing but if there is a list given
export function party_included_list(list, party) {
  return list.includes(party.toLowerCase());
}

// for checking email domain
export function email_within_domain(domain, email) {
  return domain === email.split("@")[1].toLowerCase()
}


// INITIAL INSERT ONLY, INTENTS occur after
// this is directly called from graphHelper.uploadToDB() and uses the output from graphHelper.getUniqueMessages()
export async function insertIntoDB(emails) {
  const client = await pool.connect();
  try {
    console.log('connected to db');
    await client.query('BEGIN');

    let output = [];
    const updated_conversation_ids = new Set(await email_needs_classification(emails));

    // sorted so that the oldest emails are processed first, but the display order remains unchanged
    const processingOrder = [...emails].sort(
      (a, b) => new Date(a.created ?? a.updated) - new Date(b.created ?? b.updated)
    );

    for (const email of processingOrder) {
      if (!updated_conversation_ids.has(email.conversationId)) continue;

      //const classification = await classify_email_by_ID(email.conversationId);
      const classification = await classify_email(email)
      //console.log(classification);
      const recipients = await classification_to_email(classification); // who the email needs to go to
      

      const similar = await find_similar_synopsis(
        client, 
        classification.important.synopsis,
        classification.property.code,
        classification.property.lot,
        classification.subject.main,
        classification.subject.sub,
        email.conversationId
      );


      output.push({conversationId: email.conversationId,updated: email.updated, classification, recipients, similar });
      // similarity score checking. 

      if (similar) {
        email.status = 'complete';
        email.forwarded = true;

        await client.query(`
          INSERT INTO email (
            conversation_id, id, status, created, forwarded, updated,
            sender, subject, body, in_reply_to, synopsis, subject_main, subject_sub, duplicate_of
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (conversation_id) DO UPDATE SET
            status = EXCLUDED.status,
            forwarded = EXCLUDED.forwarded,
            updated = EXCLUDED.updated,
            duplicate_of = EXCLUDED.duplicate_of
        `, [
          email.conversationId, email.id, email.status, email.created || null,
          email.forwarded, email.updated, email.sender, email.subject,
          email.body, email.in_reply_to || null, classification.important.synopsis,
          classification.subject.main, classification.subject.sub,
          similar.conversation_id
        ]);
        
        // go back and update the old email 
        await client.query(`UPDATE email SET status = 'read' WHERE conversation_id = $1`, [similar.conversation_id]);

        continue; 
      }



      if (classification.important.completed) {
        email.status = 'complete'; // manually set the new status
      }
      // check if everyone htat needs to be included is actually included
      if (recipients.every(
        ([name, email_address]) => party_included_list(email.all_parties, email_address.toLowerCase())
      )) {
        email.forwarded = true;
      }
      // set internal
      if (email_within_domain(process.env.INTERNAL_DOMAIN, email.sender)) {
        email.internal = true
      }

      // add all  mails
      await client.query(`
        INSERT INTO email (
          conversation_id, id, status, created, forwarded, updated,
          sender, subject, body, in_reply_to, synopsis, subject_main, subject_sub, duplicate_of
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (conversation_id) DO UPDATE SET
          id          = EXCLUDED.id,
          status      = EXCLUDED.status,
          created     = EXCLUDED.created,
          updated     = EXCLUDED.updated,
          sender      = EXCLUDED.sender,
          subject     = EXCLUDED.subject,
          body        = EXCLUDED.body,
          in_reply_to = EXCLUDED.in_reply_to,
          forwarded   = EXCLUDED.forwarded,
          synopsis    = EXCLUDED.synopsis,
          subject_main = EXCLUDED.subject_main,
          subject_sub  = EXCLUDED.subject_sub,
          duplicate_of = EXCLUDED.duplicate_of
      `, [
        email.conversationId, email.id, email.status, email.created || null,
        email.forwarded ?? null, email.updated, email.sender, email.subject,
        email.body, email.in_reply_to || null, classification.important.synopsis,
        classification.subject.main, classification.subject.sub,  null // handled before already
      ]);
      
      // add all related parties
      
      // skip this step for duplicates
      if (!similar){
        await upsertPropertyPairs(
          client,
          email.conversationId,
          classification.property.code,
          classification.property.lot
        );


        // add all recipients (premature until delete later)
        // notice how people in the chain that arent intended recipients are not added, that is because they do not matter (to the content of the email)
        if (recipients.length > 0) {
            for (const [name, recipientEmail] of recipients) { 
              await client.query(`
                INSERT INTO recipients (conversation_id, intended_recipient, reminder_date, reminder_count)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (conversation_id, intended_recipient) DO NOTHING
              `, [
                email.conversationId,   
                recipientEmail,         
                getReminderDateForRecipient(name, classification.subject.main, classification.subject.sub),
                0
              ]);
            }
          }
      }
        
    }
    
    await client.query('COMMIT');
    console.log(`Processed ${emails.length} emails`);
    output.sort(
      (a, b) => new Date(b.classification?.updated ?? 0) - new Date(a.classification?.updated ?? 0)
    );
    return output; // 



  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error: ${err.message}`);
    throw err; // err 500
  } finally {
    client.release();
  }
}


// DEFAULT for now, until i fugre out reminder stuff
function getReminderDateForRecipient(name, mainSubject, subSubject) {
  const now = new Date();
  now.setDate(now.getDate() + 1);
  return now;
}

export async function checkReminders(emails, intents) {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT conversation_id, intended_recipient, reminder_count
      FROM recipients
      WHERE reminder_date IS NOT NULL
        AND reminder_date < NOW()
    `);

    //  {conversationId: [{recipient, count}, ]}
    const remindersMap = new Map();
    for (const row of result.rows) {
      if (!remindersMap.has(row.conversation_id)) {
        remindersMap.set(row.conversation_id, []);
      }
      remindersMap.get(row.conversation_id).push({
        recipient: row.intended_recipient,
        count: row.reminder_count
      });
    }

    // then loop over all emails and check for reminders
    for (const email of emails) {
      // getReadEmailsWithIntents passes db rows (conversation_id), other callers may pass conversationId
      const convId = email.conversation_id ?? email.conversationId;
      const recipientsWithReminders = remindersMap.get(convId);

      if (recipientsWithReminders) {
        // check if at least 1 recipient still has reminder_count < 8
        const hasActivReminders = recipientsWithReminders.some(r => r.count < 8);

        if (hasActivReminders) {
          intents.reminder.push(convId);

          for (const { recipient, count } of recipientsWithReminders) {
            if (count < 8) {
              await client.query(`
                UPDATE recipients
                SET reminder_count = reminder_count + 1
                WHERE conversation_id = $1
                  AND intended_recipient = $2
              `, [convId, recipient]);
            }
          }
        } else {
          intents.supervisor.push(convId);

          await client.query(`
            UPDATE recipients
            SET reminder_date = NULL
            WHERE conversation_id = $1
          `, [convId]);
        }
      }
    }
  } finally {
    client.release();
  }
}



async function fetch_read() {
  const result = await pool.query(`
    SELECT m.conversationId
    FROM email m
    WHERE m.status = 'read'
  `);
}




// Checks to see if a given email with an emailId comes from an internal domain
// boolean return
function fromInternalDomain(emails, emailId) {
   const emailaddress = getValById(emails, "id", emailId, "sender");
   const domain = emailaddress.split("@");
   return domain[1].includes(process.env.INTERNAL_DOMAIN);
}

// given a JSON array emails, a column name colSearch, 
// a value to index colSearch, and a target output column to grab,
// returns the target output column's value.
function getValById(emails, colSearch, colSearchValue, colTarget) {
  const email = emails.find(item => item[colSearch] === colSearchValue);
  return email[colTarget];
}