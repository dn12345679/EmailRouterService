import pg from "pg";
import dotenv from 'dotenv';
const {Pool, Client} = pg

// https://node-postgres.com/features/connecting
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PW,
  port: process.env.DB_PORT,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME
})

const SUBJECT_BUCKETS = {
  "Tech Support": ["Email", "Phone", "OneDrive", "RonCal Log", "Rent Roll", "RDC"],
  "Account": ["Bills, or Utility Account, or Trash, or Checkbooks"],
  "Maintenance": ["Utilties or Infrastructure", "Trees, or Roads, or Community Buildings", "Equipment"],
  "Potential New Tenancy": ["RV or Camper", "Home Sale", "Rental"],
  "Rental Assistance": ["Help with renting"],
  "Existing Tenancy/Lease": ["Existing Tenancy or Lease Question"],
  "Potential Legal issue": ["Concern, question, or claim about legal/litigation"],
  "RARF Reasonable Accomodation Form": ["Regarding a licensed or non mobile home vehicle", "Physical changes to lot of the home or structure"],
  "Miscellaneous": ["Any topic that does not fall into the other topics"]
}

const CONDITION_BUCKETS = 
  {
  1: "Location in North Dakota", 
  2: "Location regarding East Group", 
  3: "Related to strangth or unusual water bill", 
  4: "Question is regarding a Tenant not Complying with the rules",
  5: "Tenant not complying with rules is a Significant Safety Issue",
  6: "Tenant not complying with rules is a Minor Safety Issue",
  7: "Tenant not complying with rules is a Normal regulation issue",
  8: "Our party (Comm or RonCal) are the sellers regarding a Home Sale",
  9: "Question is related to Credit Card, Expense Approvals, Receipts, or needing Time Off",
    }




export async function insertIntoDB(emails) {
  try {
    console.log('connected to db');
    const seenIds = new Set();
    for (const email of emails) {
      // this isnt fully optimized but guarantees that there is no local duplicate searches.
      // a further optimization could be to have seenIds be instead the ids that exist within the database, but that could introduce some issues
      if (seenIds.has(email.conversationId)) continue;
      seenIds.add(email.conversationId);
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


async function classify() {
  // create a boolean bucket of size K, where K = number of NLP checked conditions
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

