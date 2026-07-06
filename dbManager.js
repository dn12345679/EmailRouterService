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

const region_tracker = './CSV/propertyToRegion.json' // Important! Post-processing mapping from property to region
const response = await fs.readFile(region_tracker, 'utf8')
const data = JSON.parse(response)



async function test() {
  
}
await test()





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
  "subjects": {
    "Tech Support": {
      "probability": 0.02,
      "subcategories": {
        "Email": 0.01,
        "Phone": 0.00,
        "OneDrive": 0.00,
        "RonCal Log": 0.00,
        "Rent Roll": 0.01,
        "RDC": 0.00
      }
    },

    "Account": {
      "probability": 0.05,
      "subcategories": {
        "Bills": 0.00,
        "Utility Account": 0.05,
        "Trash": 0.00,
        "Checkbooks": 0.00
      }
    },

    "Maintenance": {
      "probability": 0.84,
      "subcategories": {
        "Utilities": 0.62,
        "Infrastructure": 0.15,
        "Trees": 0.00,
        "Roads": 0.00,
        "Community Buildings": 0.00,
        "Equipment": 0.07
      }
    },

    "Potential New Tenancy": {
      "probability": 0.03,
      "subcategories": {
        "RV/Camper": 0.00,
        "Home Sale": 0.03,
        "Rental": 0.00
      }
    },

    "Rental Assistance": {
      "probability": 0.00,
      "subcategories": {
        "Rental Assistance": 0.00
      }
    },

    "Existing Tenancy/Lease": {
      "probability": 0.05,
      "subcategories": {
        "Existing Tenancy": 0.05,
        "Lease Question": 0.00
      }
    },

    "Potential Legal Issue": {
      "probability": 0.00,
      "subcategories": {
        "Legal Concern": 0.00,
        "Legal Question": 0.00,
        "Litigation": 0.00,
        "Claim": 0.00
      }
    },

    "RARF Reasonable Accommodation Form": {
      "probability": 0.00,
      "subcategories": {
        "Licensed Vehicle": 0.00,
        "Non-Mobile Home Vehicle": 0.00,
        "Lot Modification": 0.00,
        "Home Modification": 0.00,
        "Structure Modification": 0.00
      }
    },

    "Miscellaneous": {
      "probability": 0.01,
      "subcategories": {
        "Miscellaneous": 0.01
      }
    }
  },

  "conditions": {
    "northDakota": false,
    "eastGroup": false,
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
  "updates" :{
    "lastUpdatedTime": "MM/DD/YYYY"
  }
}
`

export const TEST_EMAIL = `The pipes in bakerview lot 99 are currently undergoind maintenance. Avoid using excessive water for now.`

export const PROMPT = (SUBJECTS, MESSAGE, CONDITIONS, TEMPLATE) =>  
`Given the email below, classify it into the predefined subject buckets provided here: ${SUBJECTS} \n

Email Message to classify:\n ${MESSAGE}

Instructions:
1. Compute a probability for every top-level subject category. The probabilities across all top-level categories must sum to exactly 1.0. Pay attention to the order that
the emails in the chain are in, as noted by the date and time of received. The emails may not have been ordered in sequential time.
2. Within each category, compute probabilities for every subcategory. The subcategory probabilities within a category should sum to that category's probability.
3. Evaluate every condition independently. It is not required to figure out if the region is North Dakota or eastGroup or westGroup, but fill if possible. Return true if the likelihood is at least 0.5; otherwise return false. The conditions are here: ${CONDITIONS}
4. If relevant to the message and not a brief mention, return also:
   - Property Location. If there are multiple locations, list them in an array format like this: [Bakerview, Appaloosa]
   - Property Code enclosed in array format regardless of count []. If there are multiple 2 Letter Property Codes, List them in an array format like this: [BV, AP]
   - Lot Number enclosed in array format regardless of count []. If there are multiple Lot numbers, List them in an array format. And if they are associated with a Property Code, prefix it. For example: [BV_83, AP_21, none_14, BV_99]
5. Under the json "updates" value, the "lastUpdatedTime" should be the month/day/year string representing the time of the last email sent in the thread that is relevant to the topic.
6. Return only a valid JSON string matching the format with example values shown below (Actual Conditions and Subjects may not match the template exactly). Do not include any explanations or extra content, just fill out the JSON.

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
  console.log(str)

  const initial_JSON = await LLM_classification(str)
  const clean = initial_JSON.replace(/```json|```/g, "").trim();
  const obj = JSON.parse(clean);

  // classify region
  const property_code_classification = await check_region_by_code(obj.property.code)
  obj.conditions.northDakota = property_code_classification.North
  obj.conditions.eastGroup = property_code_classification.East 
  obj.conditions.westGroup = property_code_classification.West
  
  console.log(initial_JSON)
}

// Given a set of emails from graphHelper.uploadToDB(), inserts into local postgres database.
// ensure table exists and .env contains login credentials
export async function insertIntoDB(emails) {
  try {
    console.log('connected to db');
    const seenIds = new Set();
    for (const email of emails) {
      // this isnt fully optimized but guarantees that there is no local duplicate searches.
      // a further optimization could be to have seenIds be instead the ids that exist within the database, but that could introduce some issues
      if (seenIds.has(email.conversationId)) continue;
      seenIds.add(email.conversationId);


      await 

      await pool.query(`
        INSERT INTO email (
          id, conversation_id, status, created, updated,
          sender, subject, body, in_reply_to
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING
      `, [
        email.id,
        email.conversationId || null,
        email.status,
        email.created || null,
        email.updated,
        email.sender,
        email.subject,
        email.body,
        email.in_reply_to || null
      ]);
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



