import pg from "pg";
import dotenv from 'dotenv';
const {Pool, Client} = pg
import { load } from 'cheerio'; 
import {
  getConversationMessagesAsync,
  extractBodyTextWithCheerio,
} from './graphHelper.js';
import fs from 'fs/promises'; 

import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();

const region_tracker = './propertyToRegion.json' // Important! Post-processing mapping from property to region
const response = await fs.readFile(region_tracker, 'utf8')
const data = JSON.parse(response)





// https://node-postgres.com/features/connecting
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PW,
  port: process.env.DB_PORT,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME
})

export const SUBJECT_BUCKETS = {
  "Tech Support": [
    "Email",
    "Phone",
    "OneDrive",
    "RonCal Log",
    "Rent Roll",
    "RDC"
  ],

  "Account": [
    "Bills or Utility Account or Trash or Checkbooks"
  ],

  "Maintenance": [
    "Utilities or Infrastructure",
    "Trees or Roads or Community Buildings",
    "Equipment"
  ],

  "Potential New Tenancy": [
    "RV/Camper",
    "Home Sale",
    "Rental"
  ],

  "Rental Assistance": [
    "Rental Assistance"
  ],

  "Existing Tenancy/Lease": [
    "Existing Tenancy or Lease Question"
  ],

  "Potential Legal Issue": [
    "Legal Concern",
  ],

  "RARF Reasonable Accommodation Form": [
    "Licensed Vehicle or Non-Mobile Home Vehicle",
    "Lot or Home Modification",
  ],

  "Miscellaneous": [
    "Miscellaneous"
  ]
};

export const CONDITION_BUCKETS = {
  northDakota: "Property is located in North Dakota",
  eastGroup: "Property belongs to East Group",
  westGroup: "Property belongs to West Group", 
  unusualWaterBill: "Message concerns a high or unusual water bill if email is related to Bills.",
  tenantNonCompliance: "Tenant is not complying with community rules if email is a tenancy or lease question.",
  significantSafetyIssue: "Tenant non-compliance is a significant safety issue if tenantNonCompliance is true.",
  minorSafetyIssue: "Tenant non-compliance is a minor safety issue if tenantNonCompliance is true.",
  normalRuleViolation: "Tenant non-compliance is a normal rule violation if tenantNonCompliance is true.",
  companySellingHome: "Comm or RonCal is the seller in a home sale if email is related to Home sale.",
  employeeExpenseOrTimeOff: "Message concerns company expenses, receipts, credit cards, approvals, payroll, or time off"
};

export const EXAMPLE = 
`
{
  "subject": {
      main: "Maintenance"
      sub: "Utilities and Infrastructure"
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
  "important" :{
    "synopsis": "BV 99 Pavement Path Damaged"
    "summary": "this is a summary of the email in 100 words or less",
    "lastUpdatedTime": "MM/DD/YYYY", 
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
5. Under the json "important" value, the "lastUpdatedTime" should be the month/day/year string representing the time of the last email sent in the thread that is relevant to the topic.
6. Write a short summary consisting of a few sentences or words. Add the summary content as a string in the "summary" property under "important". 
7. Under the "completed" field in "important", update the value to be 'true' only if the email thread signifies that the subject as a whole is resolved or the email does not mention that further action is necessary, unless if there is a further query indicating the problem was not successfully resolved. Be careful with wording that may indicate that an unrelated task was resolved instead.
8. Under "removeFromThread" field in "important", there is an empty array. If at any point in the thread a recipient requests to have their email removed from the thread, add their 
9. Under "synopsis" field in "important", create a string of around 6 words that fits as a title of the email in the form: 
 Property Code + Lot Number + Subjects + Adjective/Description. 
 If there are multiple property codes or lot numbers, List them like this: "BV 99, AD 23, ..."
9. Return only a valid JSON string matching the format with example values shown below (Actual Conditions and Subjects may not match the template exactly due to changes in structure). Do not include any explanations or extra content, just fill out the JSON.

${TEMPLATE}
`

// testing for now. Returns a classification of the email based on a prompt
async function LLM_classification(prompt) {
  const message = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: prompt,
        cache_control: { type: "ephemeral" },  // cached here
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
    "East": false,
    "West": false,
    "North": false
  }
  for (code in codes) {
    const community = data?.find(o => Object.entries(o).some(([k, value]) => k === 'Community Code' && value === code))
    return_json.East = false ? community.Region === "East": true; // change to true once only
    return_json.West = false ? community.Region === "West" : true;
    return_json.North = false ? community.Region === "North" : true;
  }
  

  return return_json;
}

// given an input conversation id, representing the conversation of a forwarded or CC'd or direct email from graphHelper.getConversationMessagesAsync(id),
// calls Claude to classify and update the database if the database has missing data that it can fill in.
export async function classify_email_by_ID(id) {

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


// given input from graphHelper.uploadToDB(), returns the conversation ids where fthere is an update to review
export async function updatedEmails(emails) {
  try{
    const conversation_ids = emails.map(e => e.conversationId);
    const updated_dates = emails.map(e => e.updated);

    const query = `
      SELECT t.conversationId
      FROM UNNEST($1::text[], $2::timestamptz[]) AS t(conversationId, updated)
      LEFT JOIN email m ON m."conversationId" = t.conversationId
      WHERE m."conversationId" IS NULL
        OR m.updated IS DISTINCT FROM t.updated
    `; // returns all the email rows where tthe conversationId exists, and the database does not have a recorded time or has a different recorded update time

    const result = await pool.query(query, [conversationIds, updatedDates]);

    return result.rows.map(row => row.conversationId); // reutrns all the conv ids that fit the criteria above
  }
  catch (error){
    console.log(error)
  }
  
}



// Given a set of emails from graphHelper.uploadToDB(), inserts into local postgres database.
// ensure table exists and .env contains login credentials
export async function insertIntoDB(emails) {
  try {

    // does an u psert on initial and post classification
    console.log('connected to db');

    const updated_conversation_ids = updatedEmails(emails); // emails that actually changed
    for (const email of emails) {

      // check the database if the conversationId even needs to be reclassified:
        // conversationId exists, and lastModifiedDateTime not equal to email.updated, possibly check if the new body text is the same as the existing body text?
        // Note I am not checking if status = status.completed because it is possible for an email to be completed but original party sends an additional request?
        // can be fixed by having a pregenerated prompt that tells the recipient to simply send a new email thread to continue the problem


        // step 1, perform iniital upsert
      await pool.query(`
        INSERT INTO email (
          conversation_id, id, status, created, updated,
          sender, subject, body, in_reply_to
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (conversation_id) DO UPDATE SET
          id          = EXCLUDED.id,
          status      = EXCLUDED.status,
          created     = EXCLUDED.created,
          updated     = EXCLUDED.updated,
          sender      = EXCLUDED.sender,
          subject     = EXCLUDED.subject,
          body        = EXCLUDED.body,
          in_reply_to = EXCLUDED.in_reply_to
      `, [
        email.conversationId,
        email.id,
        email.status,
        email.created || null,
        email.updated,
        email.sender,
        email.subject,
        email.body,
        email.in_reply_to || null
      ]);
      
      // maybe figure out a way to batch call? 

      const classification_JSON = await classify_email_by_ID(email.conversationId);



    }

    console.log(`Inserted ${emails.length} emails`);
    console.log(emails);
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
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






