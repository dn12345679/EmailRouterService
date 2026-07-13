import pg from "pg";
import dotenv from 'dotenv';
const {Pool, Client} = pg
import { load } from 'cheerio';
import { CONDITION_BUCKETS, SUBJECT_BUCKETS } from "./appsettings.js"; 
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
    "location": "Bakerview Estates",
    "code": "BV",
    "lot": "99"
  },
  "important": {
    "synopsis": "BV 99 Pavement Path Damaged",
    "summary": "this is a summary of the email in 100 words or less",
    "completed": false,
    "removeFromThread": []
  }
}
`

export const TEST_EMAIL = `The pipes in bakerview lot 99 are currently undergoind maintenance. Avoid using excessive water for now.`

export const PROMPT = (SUBJECTS, MESSAGE, CONDITIONS, TEMPLATE) =>  
`Given the email below, classify it into the predefined subject buckets provided here: ${SUBJECTS} \n

Email Message to classify:\n ${MESSAGE}

Instructions:
1. Compute a probability for every top-level subject and bottom-level subcategory, and return the main subject and the most likely subcategory under "subject.main" and "subject.sub". Pay attention to the order that
the emails in the chain are in, as noted by the date and time of received. The messages in the thread may not have been ordered in sequential time.
3. Evaluate every condition independently. It is not required to figure out if the region is North Dakota or eastGroup or westGroup, but fill if possible. Return true if the likelihood is at least 0.5; otherwise return false. The conditions are here: ${CONDITIONS}
4. If relevant to the message and not a brief mention, return also:
   - Property Location. If there are multiple locations, list them in an array format like this: [Bakerview, Appaloosa]
   - Property Code enclosed in array format regardless of count []. If there are multiple 2 Letter Property Codes, List them in an array format like this: [BV, AP]
   - Lot Number enclosed in array format regardless of count []. If there are multiple Lot numbers, List them in an array format. And if they are associated with a Property Code, prefix it. For example: [BV_83, AP_21, none_14, BV_99]
5. Write a short summary consisting of a few sentences or words. Add the summary content as a string in the "summary" property under "important". 
6. Under the "completed" field in "important", update the value to be 'true' only if the email thread signifies that the subject as a whole is resolved or the email does not mention that further action is necessary, unless if there is a further query indicating the problem was not successfully resolved. Be careful with wording that may indicate that an unrelated task was resolved instead.
7. Under "removeFromThread" field in "important", there is an empty array. If at any point in the thread a recipient requests to have their email removed from the thread, add their 
8. Under "synopsis" field in "important", create a string of around 6 words that fits as a title of the email in the form: 
 Property Code + Lot Number + Subjects + Adjective/Description. 
 If there are multiple property codes or lot numbers, List them like this: "BV 99, AD 23, ..."
 If there is no valid property code, lot number, then just write "ANY" + Subjects + Description.
9. Return only a valid JSON string matching the format with example values shown below (Actual Conditions and Subjects may not match the template exactly due to changes in structure). Do not include any explanations or extra content, just fill out the JSON.

${TEMPLATE}

`

// testing for now. Returns a classification of the email based on a prompt
async function LLM_classification(prompt) {
  const message = await client.messages.create({
    model: "claude-sonnet-4-5",
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

// given an input conversation id, representing the conversation of a forwarded or CC'd or direct email from graphHelper.getConversationMessagesAsync(id),
// calls Claude to classify and update the database if the database has missing data that it can fill in.
export async function classify_email_by_ID(id) {
  try{
    const conversation = await getConversationMessagesAsync(id)
    const body_content = conversation.value[0].body?.content
    const cheeriod = extractBodyTextWithCheerio(body_content ?? ' ').join(" ")
    const str = PROMPT(JSON.stringify(SUBJECT_BUCKETS), cheeriod, JSON.stringify(CONDITION_BUCKETS), EXAMPLE)
  
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


// checks if emails even need attention 
export async function email_needs_processing(emails) {
  try {
    const conversation_ids = emails.map(e => e.conversationId);
    const updated_dates = emails.map(e => e.updated);

    // i currently have 3 checks: conversation id is new, or existing was changed, or reminder date has paassed but status is incomplete
    const result = await pool.query(`
      SELECT t.conversationId
      FROM UNNEST($1::text[], $2::timestamptz[]) AS t(conversationId, updated)
      LEFT JOIN email m ON m.conversation_id = t.conversationId
      LEFT JOIN recipients r ON r.conversation_id = m.conversation_id
      WHERE m.conversation_id IS NULL                             
        OR m.updated IS DISTINCT FROM t.updated                
        OR (                                                       
          m.status != 'completed'
          AND r.reminder_date IS NOT NULL
          AND r.reminder_date < NOW()
        )
    `, [conversation_ids, updated_dates]);

    return result.rows.map(row => row.conversationid);
  } catch (error) {
    console.error(error);
  }
}


// from settings.js config, converts the outpuyt to the email addresses (must go through classify_email_by_ID first to get the JSON object)
async function classification_to_email(LLM_output) {
  try{
    
  }
  catch(error) {
    console.log(error)
  }
}


// Given a set of emails from graphHelper.uploadToDB(), inserts into local postgres database.
// ensure table exists and .env contains login credentials
// no AI processing here yet.
export async function insertIntoDB(emails) {
  try {

    // does an u psert on initial and post classification
    console.log('connected to db');



        // Note I am not checking if status = status.completed because it is possible for an email to be completed but original party sends an additional request?
        // can be fixed by having a pregenerated prompt that tells the recipient to simply send a new email thread to continue the problem
    const updated_conversation_ids = new Set(await email_needs_processing(emails));

    for (const email of emails) {
      // only continue checks if conversationid is in need of update
      if (updated_conversation_ids.has(email.conversationId)){

        // steps 2 and 1 (classify first, and then upload all to db). skipping the unread -> read part, but oh well
        const classification = await classify_email_by_ID("AAQkADQzNTI4NjQ3LTkwYmItNDljYS1hZmQ1LTc2YzNjMmM2MTQ0NAAQAIRtK3CVkxRHqi9C7wFif9Y=") 

        console.log(classification)
        return;
        
        await pool.query(`
        INSERT INTO email (
          conversation_id, id, status, created, forwarded, updated,
          sender, subject, body, in_reply_to
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (conversation_id) DO UPDATE SET
          id          = EXCLUDED.id,
          status      = EXCLUDED.status,
          created     = EXCLUDED.created,
          updated     = EXCLUDED.updated,
          sender      = EXCLUDED.sender,
          subject     = EXCLUDED.subject,
          body        = EXCLUDED.body,
          in_reply_to = EXCLUDED.in_reply_to
          -- forwarded: intentionally omitted, set manually
          -- synopsis:  intentionally omitted, set by AI later
          -- property_code, lot: intentionally omitted, set by AI later
        `, [
          email.conversationId,  
          email.id,               
          email.status,           
          email.created || null,  
          email.forwarded ?? null, // first insert only
          email.updated,        
          email.sender,         
          email.subject,         
          email.body,           
          email.in_reply_to || null 
        ]);
        
        // maybe figure out a way to batch call= to save compute time? 
      }
    }

    console.log(`Inserted ${emails.length} emails`);
    console.log(emails);
  } catch (err) {
    console.error(`Error: ${err.message}`);
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






