import pg from "pg";
import dotenv from 'dotenv';
const {Pool, Client} = pg
import { load } from 'cheerio';
import { CONDITION_BUCKETS, ROUTING_CONFIG, SUBJECT_BUCKETS, REMINDER_CONFIG, REMOVE_SENDER_ON_ESCALATION, NEEDS_INFO_CONFIG, UNCLASSIFIABLE_CONFIG } from "./appsettings.js";
import {
  getConversationMessagesAsync,
  extractBodyTextWithCheerio,
  forwardThreadAsync,
  replyAllToThreadAsync,
  replyToThreadAsync,
  replyAllDraft,
  archiveThreadAsync,
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


// from propertyToRegion.json (see above), i deleted entries for hurst and son, hurst and son office, and the romack entries
const data = JSON.parse(response);
const PROPERTY_CODES = new Set(
  (data ?? [])
    .map(o => o?.['Community Code'])
    .filter(Boolean) // missing filter
    .map(c => String(c).trim().toUpperCase())
);

// the property code is real if it is not null (exists) and is in the property codes object above
export function isRealPropertyCode(token) {
  return !!token && PROPERTY_CODES.has(String(token).trim().toUpperCase());
}

//maps community code to full name and associated region  for the LLM
const COMMUNITY_LIST = (data ?? [])
  .map(c => `${c['Community Code']} = ${c.Community} [${c.Region}]`)
  .join('\n');





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
    "summary": "this is a summary of the email in 10 words or less",
    "completed": false,
    "removeFromThread": [],
    "reminderType": "Miscellaneous",
    "forwardingNotNeeded": false,
    "scheduledReminder": "MM/DD/YYYY" or "-"
  }
}
`

export const TEST_EMAIL = `The pipes in bakerview lot 99 are currently undergoind maintenance. Avoid using excessive water for now.`

export const PROMPT = (SUBJECTS, MESSAGE, SUBJECT_LINE, CONDITIONS, TEMPLATE, REMINDERS, COMMUNITIES) =>
`Given the email below, classify it into the predefined subject buckets provided here: ${SUBJECTS} \n

Email Message to classify:\n ${MESSAGE}
Email Subject Line: \n ${SUBJECT_LINE}

Community list (each line is "CODE = Community Name [Region]"). This is the authoritative list of
every property/community; a property code is ONLY valid if it appears here:
${COMMUNITIES}

Instructions:
1. Compute a probability for every top-level subject and bottom-level subcategory, and return the main subject and the most likely subcategory under "subject.main" and "subject.sub". Pay attention to the order that
the emails in the chain are in, as noted by the date and time of received. The messages in the thread may not have been ordered in sequential time.
2. Evaluate every condition independently. It is not required to figure out if the region is North Dakota or eastGroup or westGroup, but fill if possible. Return true if the likelihood is at least 0.5; otherwise return false. The conditions are here: ${CONDITIONS}
3. Property identification. Using the Community list above, work out WHICH community the email is about and return it. Tenants routinely refer to a community by an informal, partial, or old name (e.g. "Jefferson Mobile Home Park" -> "Jefferson Community LLC", "the Bakerview park" -> "Badger Lake Estates", "Aero MHP" -> "Aero Community LLC"), so match by meaning, not exact wording. Then, if relevant and not just a brief mention, return:
   - Property Location: the matched Community Name(s) from the list, array format, e.g. ["Badger Lake Estates LLC"].
   - Property Code: the EXACT 2-letter Community Code(s) from the list for the matched community/communities, array format, e.g. [BV, AP]. Use ONLY codes that appear in the list above. If you cannot confidently match any community, return an empty array [] (do not guess a code that is not in the list).
   - Lot Number enclosed in array format regardless of count []. If there are multiple Lot numbers, List them in an array format. And if they are associated with a Property Code, prefix it. For example: [BV_83, AP_21, none_14, BV_99]
4. Write a short summary consisting of a few sentences or words. Add the summary content as a string in the "summary" property under "important". 
5. Under the "completed" field in "important", Set completed = true if the thread reaches a clear resolution, specifically from the initial sender or all involved parties (e.g. "looks good", "thanks for completing this", or similar  closing acknowledgment) AND no message after that point raises  a new problem or requests further action. Otherwise, completed = false.
6. Under "removeFromThread" field in "important", there is an empty array. If at any point in the thread a recipient requests to have their email removed from the thread, add their 
7. Under "synopsis" field in "important", create a string of around 5-6 words t
hat fits as a title of the email in the form: 
 Property Code + Lot Number + Subjects + Adjective/Description. For example "AR 42 Increase Rescission Delivered"
 If there are multiple property codes or lot numbers, List them like this: "BV 99, AD 23, ..."
 If there is no valid property code, lot number, then just write "ANY" + Subjects + Description.
8. Under "reminderType" in "important", classify it based on the types of reminders here: ${Object.keys(REMINDERS)}. By default, everything will be "Miscellaneous".
9. Under "scheduledReminder" in "important", if there is a mention of a specific deadline(s), choose the one from the most recent email, and assign that value in the MM/DD/YYYY format to this property. Otherwise leave as "-".
10. Under "forwardingNotNeeded" in "important", set this to true ONLY if the email explicitly states (do not assume) that forwarding is unnecessary or that it has already been sent to the correct recipient(s) 
   (e.g. "this does not need to be forwarded", "already sent to the right people", "no need to forward this"). 
   Do not infer this from context or assume it based on who is included - only set true if the email says so directly. Otherwise, set false.
11. Return only a valid JSON string matching the format with example values shown below (Actual Conditions and Subjects may not match the template exactly due to changes in structure). Do not include any explanations or extra content, just fill out the JSON.

${TEMPLATE}

`

// used to close both duplicates and finalizing threads.
export const CLOSING_MESSAGE = (classification) => 
  `
    This thread has been marked as complete. Thank you for your responses.
    Synopsis: ${classification.important.synopsis || 'N/A'}
    Summary: ${classification.important.summary || 'N/A'}
  ` 


const NO_CODE = 'none';
const NO_LOT = 'unspecified';
const MAX_PROPERTY_CODE_LEN = 10; // matches email_property.property_code varchar(10)

// seperate bucket for emails that contain stuff that cant be read, like images
const UNCLASSIFIABLE_SUBJECT = 'Unclassifiable email';

// TODO: move this to config
const DUPLICATE_CLOSING_MESSAGE = 'This message has been marked as a duplicate. Closing this thread.';
const THREAD_COMPLETE_MESSAGE = 'This thread has been marked as complete. Thank you.';
const REMINDER_MESSAGE = (due_date) =>  `Has the assigned tasks been completed? ${due_date}`;
const supervisorsEmail = () => ROUTING_CONFIG['Supervisors']?.email ?? null;



// IGNORE all of the incoming emails that have this
const IGNORED_SENDER_PATTERNS = [
  /no-?reply@/i,
  /do-?not-?reply@/i,
  /don'?treply@/i,
  /notifications?@/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /@.*\.?teams\.microsoft\.com$/i,
];

// see above: ignores everybody that is here
export function isIgnoredSender(sender) {
  if (!sender) return false;
  const a = String(sender).toLowerCase();
  return IGNORED_SENDER_PATTERNS.some((re) => re.test(a));
}

// sender from internal domain (see env)
function isInternalSender(sender) {
  const domain = process.env.INTERNAL_DOMAIN?.toLowerCase();
  if (!domain || !sender || !sender.includes('@')) return false;
  return sender.split('@')[1].toLowerCase() === domain;
}

// ONLY used for the in initial forwarding step. removes non-internal senders , and for everybody who wants to be removed, removes them too
// for future replies to the associated thread do not remove the external sender as it is assumed that they reserve the right to remain in that conversation
function excludeFor(m) {
  const ext = (!isInternalSender(m.sender) && m.sender) ? [m.sender] : [];
  const removed = Array.isArray(m.remove_from_thread) ? m.remove_from_thread : [];
  return [...ext, ...removed].filter(Boolean);
}

// fall back if thread kinda looks complete
async function threadLooksResolved(threadText) {
  if (!threadText || !threadText.trim()) return false;
  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 5,
      messages: [{
        role: "user",
        content: `Here is an email thread:\n\n${threadText}\n\nHas the issue in this thread been fully resolved with no further action needed? Answer with only "yes" or "no".`,
      }],
    });
    return (msg.content[0]?.text || '').toLowerCase().includes('yes');
  } catch (e) {
    console.error('threadLooksResolved failed:', e.message);
    return false; // fail safe: treat as unresolved so we still nudge
  }
}




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
    const wanted = String(code).trim().toUpperCase();
    const community = data?.find(o =>
      String(o['Community Code'] ?? '').trim().toUpperCase() === wanted
    );

    if (!community) continue; // no match for this code, skip

    if (community.Region === "East") return_json.East = true;
    if (community.Region === "West") return_json.West = true;
    if (community.Region === "North") return_json.North = true;
  }

  return return_json;
}







// given any email, classifies it into the right subject bucket and conditions (LLM step)
export async function classify_email(email) {
  try{
    const body_content = email.body
    const cheeriod = extractBodyTextWithCheerio(body_content ?? ' ').join(" ")
    const str = PROMPT(JSON.stringify(SUBJECT_BUCKETS), cheeriod,  email.subject, JSON.stringify(CONDITION_BUCKETS), EXAMPLE, REMINDER_CONFIG, COMMUNITY_LIST)
    
    const initial_JSON = await LLM_classification(str)
    const clean = initial_JSON.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(clean);

    // classify region
    const property_code_classification = await check_region_by_code(obj.property.code)
    obj.conditions.northDakota = property_code_classification.North
    obj.conditions.eastGroup = property_code_classification.East
    obj.conditions.westGroup = property_code_classification.West

    // in the case that the message is too short (probably contains images), and does nto have a property code or a lot, then it will be thrown into 'Unclassifiable'
    if (UNCLASSIFIABLE_CONFIG?.enabled && cheeriod.trim().length < (UNCLASSIFIABLE_CONFIG.maxChars ?? 50)) {
      const pairs = parsePropertyPairs(obj.property?.code ?? [], obj.property?.lot ?? []);
      const hasCode = pairs.some(p => p.code !== NO_CODE);
      const hasLot = pairs.some(p => p.lot !== NO_LOT);
      if (!hasCode && !hasLot) {
        obj.subject.main = UNCLASSIFIABLE_SUBJECT;
        obj.subject.sub = UNCLASSIFIABLE_SUBJECT;
        obj.important.reminderType = UNCLASSIFIABLE_CONFIG.reminderType ?? 'Unclassifiable';
        obj.important.forwardingNotNeeded = false; // we handle it via the unclassifiable flow, not forwarding
      }
    }

    return obj; 
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
// checks sender, property_code, lots, main, subtopic, excludes the current email, and checks
// whether a matching open original already exists. Sender is matched on the lowercased address
// so a duplicate is only ever another thread from the same person about the same property/topic.
async function find_similar_synopsis(client, synopsis, propertyCodes, lots, subjectMain, subjectSub, currentConversationId, sender) {
  if (!sender) return null; // no known sender = cant claim duplicate
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
      AND LOWER(e.sender) = LOWER($7)     -- same sender only (don't merge different tenants on one lot)
      AND e.duplicate_of IS NULL          -- only match a canonical original, never another duplicate
      AND e.status <> 'complete'          -- don't fold into / reopen an already-finished thread
      AND similarity(e.synopsis, $1) > 0.3
    ORDER BY score DESC
    LIMIT 1;
  `, [synopsis, codesArr, lotsArr, subjectMain, subjectSub, currentConversationId, sender]);

  return result.rows[0] ?? null;
}


function conditionsMatch(ruleConditions, context) {
  return Object.entries(ruleConditions).every(
    ([key, expectedValue]) => context[key] === expectedValue
  );
}





// given any (or a comma sep list of) outlook conversationIds, returns everything that matters (for the check single button)
export async function inspectConversations(ids) {
  const list = (ids ?? []).map(s => String(s).trim()).filter(Boolean);
  if (!list.length) return [];

  const [emails, props, recips] = await Promise.all([
    pool.query(`SELECT * FROM email WHERE conversation_id = ANY($1)`, [list]),
    pool.query(`SELECT * FROM email_property WHERE conversation_id = ANY($1)`, [list]),
    pool.query(`SELECT * FROM recipients WHERE conversation_id = ANY($1)`, [list]),
  ]);

  // intents are computed over the full working set
  let intentMap = {};
  try {
    ({ intents: intentMap } = await getReadEmailsWithIntents());
  } catch (e) {
    console.error('inspectConversations: intent computation failed:', e.message);
  }

  return list.map(id => ({
    conversationId: id,
    email: emails.rows.find(e => e.conversation_id === id) ?? null,
    properties: props.rows.filter(p => p.conversation_id === id),
    recipients: recips.rows.filter(r => r.conversation_id === id),
    intents: intentMap[id] ?? [],
  }));
}

export async function getReadEmailsWithIntents() {
  try {

    const result = await pool.query(`
      SELECT e.*, 
             ARRAY_AGG(r.intended_recipient) FILTER (WHERE r.intended_recipient IS NOT NULL) AS intended_recipients
      FROM email e
      LEFT JOIN recipients r ON e.conversation_id = r.conversation_id
      WHERE e.archived = false
        AND (e.status = 'read' OR e.duplicate_of IS NOT NULL)
      GROUP BY e.conversation_id
    `);

    // ignored senders are people like no-reply, microsoft-teams, confirmation codes, etc
    const messages = result.rows.filter(m => !isIgnoredSender(m.sender));

    // intents are a list for each thread like this: intents[convId] = [ { intent, interestedParty, ... }, ... ]
    // if there are no intents, by default it is an empty intent meaning nothing is to be done here
    const intentsByConversationId = new Map();
    const pushIntent = (convId, obj) => {
      if (!intentsByConversationId.has(convId)) intentsByConversationId.set(convId, []);
      intentsByConversationId.get(convId).push(obj);
    };

    // INTENT (NEEDS INFO): missing property or lot, this intent will inquire for it
    const needsInfoSet = new Set();

    if (NEEDS_INFO_CONFIG?.enabled && messages.length) {
      const convIds = messages.map(m => m.conversation_id);
      // unconfident check that just verifies whether a mentioned lot actually exists
      const propRes = await pool.query(
        `SELECT conversation_id, property_code, lot FROM email_property WHERE conversation_id = ANY($1)`,
        [convIds]
      );
      const presence = new Map(); // convId -> { hasCode, hasLot }
      for (const row of propRes.rows) {
        if (!presence.has(row.conversation_id)) presence.set(row.conversation_id, { hasCode: false, hasLot: false });
        const agg = presence.get(row.conversation_id);
        for (const token of [row.property_code, row.lot]) {
          const t = String(token ?? '').trim();
          if (!t || t.toLowerCase() === NO_CODE || t.toLowerCase() === NO_LOT) continue;
          if (isRealPropertyCode(t)) agg.hasCode = true;
          else agg.hasLot = true;
        }
      }
      const skipSubjects = new Set(NEEDS_INFO_CONFIG.skipSubjects ?? []);

      for (const m of messages) {
        if (m.subject_main === UNCLASSIFIABLE_SUBJECT) continue; // handled by the dedicated unclassifiable flow
        if (skipSubjects.has(m.subject_main)) continue; // Misc will never need a lot 
        if (m.duplicate_of !== null) continue;          // duplicates inherit the original's identity
        if (m.flagged_complete) continue;               // i assume resolved threads wont be needing identification
        if (m.forwarded) continue;                       // already routed / in progress
        const p = presence.get(m.conversation_id) ?? { hasCode: false, hasLot: false };
        const missingCode = NEEDS_INFO_CONFIG.requirePropertyCode && !p.hasCode;
        const missingLot = NEEDS_INFO_CONFIG.requireLot && !p.hasLot;
        if (missingCode || missingLot) needsInfoSet.add(m.conversation_id);
      }
    } // end of the INTENT: NEEDS INFO block


    // INTENT (UNCLASSIFIABLE): has the sender already been asked for context once?
    // Tracked via the sender-anchor recipient row's reminder_count rather than
    // `forwarded` -- `forwarded` is sticky (OR'd with its old value on every
    // reclassification, see insertIntoDB), so if we used it here it would get
    // pinned true after the first "please give context" reply and could never be
    // un-set once the sender actually replies with real info, silently preventing
    // the eventual real forward to the routed recipients.
    const unclassifiableContactedSet = new Set();
    if (messages.some(m => m.subject_main === UNCLASSIFIABLE_SUBJECT)) {
      const convIds = messages
        .filter(m => m.subject_main === UNCLASSIFIABLE_SUBJECT)
        .map(m => m.conversation_id);
      const contactedRes = await pool.query(
        `SELECT DISTINCT conversation_id FROM recipients WHERE conversation_id = ANY($1) AND reminder_count > 0`,
        [convIds]
      );
      for (const row of contactedRes.rows) unclassifiableContactedSet.add(row.conversation_id);
    } // end of the INTENT: UNCLASSIFIABLE contacted-once check


    // INTENT: REMINDERS/SUPERVISORS/REMINDER
    const reminderIntents = { scheduled: [], reminder: [], supervisor: [] };
    await scheduleNewReminders(messages, reminderIntents);
    await checkReminders(messages, reminderIntents);

    const supervisorSet = new Set(reminderIntents.supervisor);
    const reminderDueSet = new Set(reminderIntents.reminder.map(r => r.convId));
    // any thread  marked as complete by the LLM will ignore any form of reminder or escalation 
    const completeSet = new Set();

    for (const m of messages) {
      const convId = m.conversation_id;
      const recipients = (m.intended_recipients ?? []).filter(Boolean);
      const isDuplicate = m.duplicate_of !== null;
      const flaggedComplete = m.flagged_complete === true;
      const isUnclassifiable = m.subject_main === UNCLASSIFIABLE_SUBJECT; // unclassifiables are ones that have no discernable content (like vague images, <50 char messages)

      // duplicate of an existing thread (can co-exist with a reminder if the thread has recipients)
      if (isDuplicate) {
        const original = messages.find(mm => mm.conversation_id === m.duplicate_of);
        pushIntent(convId, { intent: 'duplicate', interestedParty: original?.created ?? null });
      }

      // unclassifiable emails ask for context from the original sender, but dont forward yet because it doesnt know who to send this to yet
      // target will always be the person who sent the confusing message. Gated on
      // reminder_count instead of forwarded (see unclassifiableContactedSet above)
      // so forwarded stays false until a real forward actually happens.
      if (isUnclassifiable && !unclassifiableContactedSet.has(convId) && !isDuplicate && !flaggedComplete) {
        pushIntent(convId, { intent: 'unclassifiable', interestedParty: m.sender });
      }


      // email will be forwarded if there is someone to forward it to even if no property is found, as long as the email has an actual topic
      if (!m.forwarded && recipients.length && !isDuplicate && !isUnclassifiable) {
        pushIntent(convId, { intent: 'forward', interestedParty: recipients });
      }

      // INTENT: NEEDS INFO flag
      if (needsInfoSet.has(convId)) {
        pushIntent(convId, { intent: 'needs_info', interestedParty: null });
      }

      // INTENT: (LOOKS) COMPLETE flag, will mark the thread as complete and add the closing 
      if (flaggedComplete && !isDuplicate) {
        pushIntent(convId, { intent: 'complete', interestedParty: null });
        completeSet.add(convId);
      }
    }


    // INTENT: ALL REMINDER TYPES
      // PRIORITY
        // 1. Complete/Complete flags, marks as complete but do not continue scheduling
        // 2. Supervisor escalation, send to supervisor and clear reminder stuff
        // 3. Due reminder
        // 4. Schedule reminder
    for (const convId of reminderIntents.supervisor) {
      const m = messages.find(mm => mm.conversation_id === convId);
      if (!m || m.status === 'complete' || completeSet.has(convId)) continue;
      pushIntent(convId, { intent: 'supervisor', interestedParty: null });
    }
    for (const { convId, date, nextIndex } of reminderIntents.reminder) {
      if (supervisorSet.has(convId) || completeSet.has(convId)) continue;
      const m = messages.find(mm => mm.conversation_id === convId);
      if (!m || m.status === 'complete') continue;
      pushIntent(convId, { intent: 'reminder', interestedParty: date, nextIndex });
    }
    for (const { convId, date } of reminderIntents.scheduled) {
      if (supervisorSet.has(convId) || reminderDueSet.has(convId) || completeSet.has(convId)) continue;
      const m = messages.find(mm => mm.conversation_id === convId);
      if (!m || m.status === 'complete') continue;
      pushIntent(convId, { intent: 'reminder_scheduled', interestedParty: date });
    }
  
    
    // END OF ALL INTENTS

    const intents = Object.fromEntries(intentsByConversationId);
    console.log('[button3] final intents:', intents);
    return { messages, intents };
  } catch (err) {
    console.error(err);
    throw err;
  }
}




// 'dryRun' = true means that there will be a preview window, otherwise it just executes
// Returns
//   { dryRun, results: [ { conversationId, subject, synopsis, intent,
//                          status: 'planned'|'done'|'error'|'skipped',
//                          actions: [ { label, status, error? } ] } ] }
function fmtDate(d) {
  try { return new Date(d).toLocaleString(); } catch { return String(d); }
}



// takes all the conversationIds, and actually gets their intents, then runs them
export async function executeIntents(conversationIds = null, { dryRun = true } = {}) {
  const { messages, intents } = await getReadEmailsWithIntents();
  const byId = new Map(messages.map(m => [m.conversation_id, m]));

  const selected = (Array.isArray(conversationIds) && conversationIds.length)
    ? messages.filter(m => conversationIds.includes(m.conversation_id))
    : messages;

  const results = [];

  for (const m of selected) {
    const entryList = intents[m.conversation_id] ?? [];
    const findIntent = (name) => entryList.find(e => e.intent === name); // maps all the intents by name
    const duplicateIntent = findIntent('duplicate');
    const forwardIntent = findIntent('forward');
    const completeIntent = findIntent('complete');
    const supervisorIntent = findIntent('supervisor');
    const reminderIntent = findIntent('reminder');
    const scheduledIntent = findIntent('reminder_scheduled');
    const needsInfoIntent = findIntent('needs_info');
    const unclassifiableIntent = findIntent('unclassifiable');
    const isUnclassifiable = m.subject_main === UNCLASSIFIABLE_SUBJECT;
    const intentLabel = entryList.map(e => e.intent).join(' + ') || '-';
    const actions = [];

    // previews or performs
    const perform = async (label, fn) => {
      if (dryRun) { actions.push({ label, status: 'planned' }); return; }
      try { await fn(); actions.push({ label, status: 'done' }); }
      catch (e) { actions.push({ label, status: 'error', error: e.message }); }
    };


    // 2 ways of exclusion: 
      // - forwardExclude = only applies once. Drops the external party if they exist, and only forwards to necessary recipient
      // - replyExclude = applies after the above. drops anyone who specifically asks for themself to be removed from the thread. Keep everyone else regardless
    const explicitRemovals = Array.isArray(m.remove_from_thread) ? m.remove_from_thread.filter(Boolean) : [];
    const forwardExclude = excludeFor(m);
    const replyExclude = explicitRemovals;
    const forwardExcludeLabel = forwardExclude.length ? `excl. ${forwardExclude.join(', ')}` : 'reply-all';
    const excludeLabel = replyExclude.length ? `excl. ${replyExclude.join(', ')}` : 'reply-all';

    // shared "mark complete" path, reused by the complete intent and by the resolution gate when a deadline-passed thread turns out to be resolved
    const completeThread = async () => {
      await perform(`Complete (reply-all, ${excludeLabel}): "${THREAD_COMPLETE_MESSAGE}"`,
        () => replyAllDraft(m.id, { comment: THREAD_COMPLETE_MESSAGE, remove: replyExclude }));
      await perform(`Mark complete + archived in DB`,
        () => pool.query(`UPDATE email SET status='complete', archived=true WHERE conversation_id=$1`, [m.conversation_id]));
      await perform(`Archive thread in Outlook`,
        () => archiveThreadAsync(m.conversation_id));
    };



    
    try {
      if (!entryList.length) {
        actions.push({ label: 'No actionable intent (do nothing)', status: 'skipped' });
      }

      // duplicate thread
      else if (duplicateIntent) {
        const originalId = m.duplicate_of;
        const original = originalId ? byId.get(originalId) : null;
        const originalSender = original?.sender ?? null;

        await perform(`Close duplicate thread (reply-all, ${excludeLabel}): "${DUPLICATE_CLOSING_MESSAGE}"`,
          () => replyAllDraft(m.id, { comment: DUPLICATE_CLOSING_MESSAGE, remove: replyExclude }));

        if (originalSender) {
          await perform(`Forward duplicate thread to original sender (${originalSender}), no comment`,
            () => forwardThreadAsync(m.id, originalSender, ''));
        }

        await perform(`Archive duplicate thread in Outlook`,
          () => archiveThreadAsync(m.conversation_id));
        await perform(`Mark duplicate complete + archived in DB`,
          () => pool.query(`UPDATE email SET status='complete', archived=true WHERE conversation_id=$1`, [m.conversation_id]));

        if (originalId) {
          await perform(`Archive original thread in Outlook`,
            () => archiveThreadAsync(originalId));
          await perform(`Mark original archived in DB`,
            () => pool.query(`UPDATE email SET archived=true WHERE conversation_id=$1`, [originalId]));
        }
      }

      // everything else that nots duplicate
      else {
        const recipients = (m.intended_recipients ?? []).filter(Boolean);


        // route the thread to necessary parties with necessary attachments, unless if its unclassifiable, in which case only the sender is replied to
        if (!m.forwarded && recipients.length && !isUnclassifiable) {
          await perform(`Reply-all route to: ${recipients.join(', ')} (${forwardExcludeLabel}, +attachments)`,
            () => replyAllDraft(m.id, { add: recipients, remove: forwardExclude, copyAttachments: true }));
          await perform(`Mark forwarded in DB`,
            () => pool.query(`UPDATE email SET forwarded=true WHERE conversation_id=$1`, [m.conversation_id]));
        }

        // for unclassifiable, image only, or contentless forward, reply to the sender asking for clarification.
        // "forwarded" not set to true because no intended source yet until reply.
        // is tracked via the sender's recipient row (reminder_count > 0) instead. see
        // unclassifiableContactedSet in getReadEmailsWithIntents.
        if (unclassifiableIntent) {
          const askSender = m.sender ? [m.sender] : null;
          await perform(`Unclassifiable reply to ${m.sender || 'all'}: "${UNCLASSIFIABLE_CONFIG.message}"`,
            () => askSender
              ? replyToThreadAsync(m.id, UNCLASSIFIABLE_CONFIG.message, askSender)
              : replyAllToThreadAsync(m.id, UNCLASSIFIABLE_CONFIG.message));
          await perform(`Mark first-contact sent (reminder_count -> 1) for ${m.sender}`,
            () => pool.query(
              `UPDATE recipients SET reminder_count = GREATEST(reminder_count, 1) WHERE conversation_id=$1 AND LOWER(intended_recipient)=LOWER($2)`,
              [m.conversation_id, m.sender]));
        }


        // ask the original sender to identify their property/lot if it is unclear. Routing is still the same and reminder flow is the same
        if (needsInfoIntent) {
          const askSender = m.sender ? [m.sender] : null;
          await perform(`Needs-info reply to ${m.sender || 'all'}: "${NEEDS_INFO_CONFIG.message}"`,
            () => askSender
              ? replyToThreadAsync(m.id, NEEDS_INFO_CONFIG.message, askSender)
              : replyAllToThreadAsync(m.id, NEEDS_INFO_CONFIG.message));
        }


        // or just complete the thread
        if (completeIntent) {
          await completeThread();
        }

        // deadline passed -> send to supervisors. First gate on the LLM resolution check:
        // if the thread already reads as resolved, complete it instead.
        else if (supervisorIntent) {
          const resolved = await threadLooksResolved(m.body || '');
          actions.push({ label: `Resolution check -> ${resolved ? 'resolved' : 'not resolved'}`, status: 'done' });

          if (resolved) {
            await completeThread();
          } else {
            const sup = supervisorsEmail();
            if (!sup) throw new Error('No Supervisors email configured in ROUTING_CONFIG');

            if (REMOVE_SENDER_ON_ESCALATION) {
              await perform(`Forward to Supervisors (${sup}); sender excluded`,
                () => forwardThreadAsync(m.id, sup, ''));
              if (m.sender) {
                await perform(`Remove sender (${m.sender}) from recipients`,
                  () => pool.query(`DELETE FROM recipients WHERE conversation_id=$1 AND intended_recipient=$2`, [m.conversation_id, m.sender]));
              }
            } else {
              const combined = Array.from(new Set([sup, ...recipients]));
              await perform(`Forward to Supervisors + existing recipients (${combined.join(', ')})`,
                () => forwardThreadAsync(m.id, combined, ''));
            }

            await perform(`Reset reminder_date=NULL, reminder_count=0`,
              () => pool.query(`UPDATE recipients SET reminder_date=NULL, reminder_count=0 WHERE conversation_id=$1`, [m.conversation_id]));
            // once it's escalated it is out of the LLM's hands, so finalize it as complete
            await perform(`Mark complete + archived in DB`,
              () => pool.query(`UPDATE email SET status='complete', archived=true WHERE conversation_id=$1`, [m.conversation_id]));
            await perform(`Archive thread in Outlook (so it is not re-escalated)`,
              () => archiveThreadAsync(m.conversation_id));
          }
        }

        else if (scheduledIntent) {
          const date = scheduledIntent.interestedParty;
          await perform(`Set reminder_date = ${fmtDate(date)}`,
            () => pool.query(`UPDATE recipients SET reminder_date=$2 WHERE conversation_id=$1`, [m.conversation_id, new Date(date)]));



          // DB archived stays false so the reminder stays checkable
          await perform(`Archive thread in Outlook (stays checkable in DB)`,
            () => archiveThreadAsync(m.conversation_id));
        }

        // deadline passed, reminder due -> gate on the LLM resolution check:
        // resolved => complete now, otherwise send the reminder and reschedule the next reminder
        else if (reminderIntent) {
          const date = reminderIntent.interestedParty;
          const nextIndex = reminderIntent.nextIndex ?? null;

          // unclassifiable threads that have reminders dont have actual content, so instead of asking for 'is this resolved', check again for context.
          const resolved = isUnclassifiable ? false : await threadLooksResolved(m.body || '');
          if (!isUnclassifiable) {
            actions.push({ label: `Resolution check -> ${resolved ? 'resolved' : 'not resolved'}`, status: 'done' });
          }


          // or complete the thread
          if (resolved) {
            await completeThread();
          } else {
            if (isUnclassifiable) {
              // re-ask the SENDER for context (reply-to-sender, not reply-all), same as first contact
              await perform(`Unclassifiable nudge to ${m.sender || 'all'}: "${UNCLASSIFIABLE_CONFIG.message}"`,
                () => m.sender
                  ? replyToThreadAsync(m.id, UNCLASSIFIABLE_CONFIG.message, [m.sender])
                  : replyAllToThreadAsync(m.id, UNCLASSIFIABLE_CONFIG.message));
            } else {
              await perform(`Reminder (reply-all, ${excludeLabel}, +attachments): "${REMINDER_MESSAGE( date? " This was due on " + date : "" )}"`,
                () => replyAllDraft(m.id, { comment: REMINDER_MESSAGE(date? " This was due on " + date : "" ), remove: replyExclude, copyAttachments: true }));
            }
            await perform(`Increment reminder_count, set next reminder_date=${fmtDate(date)}${nextIndex != null ? `, interval_index=${nextIndex}` : ''}`,
              () => pool.query(
                `UPDATE recipients SET reminder_count = reminder_count + 1, reminder_date=$2, interval_index=COALESCE($3, interval_index) WHERE conversation_id=$1`,
                [m.conversation_id, new Date(date), nextIndex]));
            await perform(`Archive thread in Outlook (stays checkable in DB)`,
              () => archiveThreadAsync(m.conversation_id));
          }
        }

        else if (forwardIntent) {
          // forwarding already performed above, nothing else this run
          if (m.forwarded && !recipients.length) {
            actions.push({ label: 'Already forwarded; nothing else to do', status: 'skipped' });
          }
        }
      }
    } catch (e) {
      actions.push({ label: `Fatal: ${e.message}`, status: 'error' });
    }

    const hadError = actions.some(a => a.status === 'error');
    results.push({
      conversationId: m.conversation_id,
      subject: m.subject,
      synopsis: m.synopsis,
      intent: intentLabel,
      actions,
      status: hadError ? 'error' : (dryRun ? 'planned' : 'done'),
    });
  }

  return { dryRun, results };
}


// Manual override path for "Modify Intent" (see public/app.js openModifyIntent). Each key below
// writes to the exact same column/table that getReadEmailsWithIntents() and executeIntents()
// already read, so no changes are needed to intent computation or execution -- editing here is
// indistinguishable from the thread having naturally arrived in that state.
//   changes: {
//     forwardAdd?: string[], forwardRemove?: string[],   // recipients.intended_recipient rows
//     complete?: boolean,                                  // email.flagged_complete
//     clearDuplicate?: boolean,                             // email.duplicate_of -> NULL
//     reminderDate?: string, resetReminder?: boolean,       // recipients.reminder_date (thread-wide)
//   }
export async function modifyIntent(conversationId, changes = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`SELECT * FROM email WHERE conversation_id=$1`, [conversationId]);
    const emailRow = rows[0];
    if (!emailRow) throw new Error('Conversation not found');

    for (const addr of changes.forwardRemove ?? []) {
      await client.query(
        `DELETE FROM recipients WHERE conversation_id=$1 AND LOWER(intended_recipient)=LOWER($2)`,
        [conversationId, addr]
      );
    }

    if (changes.forwardAdd?.length) {
      const sentDate = new Date(emailRow.created ?? emailRow.updated ?? new Date());
      for (const addr of changes.forwardAdd) {
        await client.query(`
          INSERT INTO recipients (conversation_id, intended_recipient, reminder_date, reminder_count,
                                   reminder_type, target_date, assigned_date, interval_index)
          VALUES ($1, $2, NULL, 0, 'Miscellaneous', NULL, $3, 0)
          ON CONFLICT (conversation_id, intended_recipient) DO NOTHING
        `, [conversationId, addr, sentDate]);
      }
      // a manually added recipient needs a fresh routing pass -- otherwise the forward branch in
      // executeIntents (gated on !m.forwarded) would never fire for them.
      await client.query(`UPDATE email SET forwarded=false WHERE conversation_id=$1`, [conversationId]);
    }

    if (typeof changes.complete === 'boolean') {
      await client.query(`UPDATE email SET flagged_complete=$2 WHERE conversation_id=$1`,
        [conversationId, changes.complete]);
    }

    if (changes.clearDuplicate) {
      await client.query(`UPDATE email SET duplicate_of=NULL WHERE conversation_id=$1`, [conversationId]);
    }

    if (changes.resetReminder) {
      await client.query(`UPDATE recipients SET reminder_date=NULL WHERE conversation_id=$1`, [conversationId]);
    } else if (changes.reminderDate) {
      const d = new Date(changes.reminderDate);
      if (isNaN(d.getTime())) throw new Error('Invalid reminder date');
      await client.query(`UPDATE recipients SET reminder_date=$2 WHERE conversation_id=$1`, [conversationId, d]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // recompute fresh so the caller can refresh just this thread's row/reading-pane without a
  // full "Check intents" round-trip
  const { messages, intents } = await getReadEmailsWithIntents();
  return {
    message: messages.find(m => m.conversation_id === conversationId) ?? null,
    intentList: intents[conversationId] ?? [],
  };
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
  const isPlaceholder = (s) => {
    const t = String(s).trim().toLowerCase();
    return t === '' || t === NO_CODE || t === NO_LOT;
  };
  const pairs = [];

  // explicit "CODE_LOT" entries from the lot array
  for (const entry of lots || []) {
    const [prefix, lotNum] = String(entry).split('_');
    const code = prefix === 'none' ? NO_CODE : prefix;
    // guard against classifier noise that isn't a real code and is too long for
    // property_code varchar(10) -- would otherwise crash the insert below.
    if (!isRealPropertyCode(code) && code.length > MAX_PROPERTY_CODE_LEN) continue;
    pairs.push({ code, lot: lotNum ?? NO_LOT });
  }


  // classifier sometimes inconsistent about pairing, and sometimes treats the lot number as a property code. 
  // constraint property codes to be existing in propertyToRegion.json 
  const rawCodes = (codes || []).map(c => String(c).trim()).filter(c => !isPlaceholder(c));
  const realCodes = rawCodes.filter(isRealPropertyCode);
  const strayLots = rawCodes.filter(c => !isRealPropertyCode(c));
  const foldStrays = realCodes.length === 1 && strayLots.length > 0;

  // attempts to fold pairs of read code to a lot number, this is a very unconfident approximation and is hard to replace actual human checking
  if (foldStrays) {
    for (const lot of strayLots) {
      if (!pairs.some(p => p.code === realCodes[0] && p.lot === lot)) {
        pairs.push({ code: realCodes[0], lot });
      }
    }
  }

  // remaining bare codes: real codes always. stray tokens only when unfoldable
  // (ambiguous multi-code cases are left as-is rather than guessed)
  const leftoverCodes = foldStrays ? realCodes : rawCodes;
  for (const code of leftoverCodes) {
    // a token this long can never be a real property code (they're all short community
    // codes) -- it's classifier noise from the ambiguous case above. Drop it instead of
    // letting it hit the property_code varchar(10) column and crash the insert.
    if (!isRealPropertyCode(code) && code.length > MAX_PROPERTY_CODE_LEN) continue;
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
    throw new Error('upsertPropertyPairs: conversationId must be a string');
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


function determineReminderAction(recipientRow, config) {
  const now = new Date();


  // escalate if hard deadline passed and at least 1 reminder was sent. (priority over sending another reminder)
  const hardDeadlineBlown =
    config.completeByDate &&
    recipientRow.target_date &&
    now > new Date(recipientRow.target_date);

  if (hardDeadlineBlown && recipientRow.reminder_count >= 1) return 'supervisor';

  const reminderDue =
    recipientRow.reminder_date && now > new Date(recipientRow.reminder_date);

  if (!reminderDue) return 'none';

  return recipientRow.reminder_count >= (config.escalateAfterReminders ?? 9) ? 'supervisor' : 'reminder_due';
}


// picks the next best deadline
function nextReminderDate(row, nextIndex) {
  const config = REMINDER_CONFIG[row.reminder_type] ?? REMINDER_CONFIG['Miscellaneous'];
  const intervalDate = getReminderDateForRecipient(row.reminder_type, row.target_date, { ...row, interval_index: nextIndex });
  
  if (row.target_date && new Date(row.target_date) < intervalDate) {
    return new Date(row.target_date);
  }
  return intervalDate;
}


// this is directly called from graphHelper.uploadToDB() and uses the output from graphHelper.getUniqueMessages()
// this function actually writes results to Postgresql
export async function insertIntoDB(emails) {
  const client = await pool.connect();
  try {
    console.log('connected to db');
    await client.query('BEGIN');

    let output = [];
    const updated_conversation_ids = new Set(await email_needs_classification(emails));

    const processingOrder = [...emails].sort(
      (a, b) => new Date(a.created ?? a.updated) - new Date(b.created ?? b.updated)
    );

    for (const email of processingOrder) {

      if (!updated_conversation_ids.has(email.conversationId)) continue;
      
      //console.log(email.body)

      const classification = await classify_email(email);
      const recipients = await classification_to_email(classification);

      // the conversationId of a similar thread if it exists, unless if the email is unclassifiable (in which case it is considered unique always)
      // if unclassified emails later receive context from the recipient, then it will no longer be unclassifiable and only then is it eligible for dupe matching
      const similar = (classification.subject.main === UNCLASSIFIABLE_SUBJECT)
        ? null
        : await find_similar_synopsis(
            client,
            classification.important.synopsis,
            classification.property.code,
            classification.property.lot,
            classification.subject.main,
            classification.subject.sub,
            email.conversationId,
            email.sender
          );

      // never let a thread be a duplicate of itself
      const duplicateOf = (similar && similar.conversation_id !== email.conversationId) ? similar : null;

      // people who asked to be dropped from the thread (used to trim reply-all recipients later).
      // Claude re-derives this from the full thread every classify
      const removeList = Array.from(new Set(
        (classification.important.removeFromThread ?? [])
          .map(a => String(a).trim().toLowerCase())
          .filter(Boolean)
      ));

      // addto the collection
      output.push({ conversationId: email.conversationId, updated: email.updated, classification, recipients, similar: duplicateOf });



      // duplicate emails will have the 'complete' flag ready
      if (duplicateOf) {
        email.status = 'complete';
        email.forwarded = true;

        await client.query(`
          INSERT INTO email (
            conversation_id, id, status, created, forwarded, updated,
            sender, subject, body, in_reply_to, synopsis, subject_main, subject_sub, duplicate_of,
            remove_from_thread
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (conversation_id) DO UPDATE SET
            status = EXCLUDED.status,
            -- sticky: once a thread has been actually forwarded, a later reclassification must
            -- never un-forward it (see the identical note on the non-duplicate upsert below)
            forwarded = email.forwarded OR EXCLUDED.forwarded,
            updated = EXCLUDED.updated,
            duplicate_of = EXCLUDED.duplicate_of,
            remove_from_thread = EXCLUDED.remove_from_thread,
            archived = false
        `, [
          email.conversationId, email.id, email.status, email.created || null,
          email.forwarded, email.updated, email.sender, email.subject,
          email.body, email.in_reply_to || null, classification.important.synopsis,
          classification.subject.main, classification.subject.sub,
          duplicateOf.conversation_id, removeList
        ]);

        await client.query(`UPDATE email SET status = 'read' WHERE conversation_id = $1`, [duplicateOf.conversation_id]);


        // gets the scheduled reminder date of the duplicate email (this one) if it exists, then performs an upsert to 
          // automatically move the reminders from the dupe to the existing one, tightening the deadline if one exists
        const dupTarget = (classification.important.scheduledReminder && classification.important.scheduledReminder !== "-")
          ? new Date(classification.important.scheduledReminder) : null;

        if (dupTarget && !isNaN(dupTarget.getTime())) {
          await client.query(`
            UPDATE recipients
               SET target_date = $2, reminder_type = $3, reminder_date = NULL
             WHERE conversation_id = $1
               AND (target_date IS NULL OR target_date > $2)
          `, [duplicateOf.conversation_id, dupTarget, classification.important.reminderType ?? 'Miscellaneous']);
        }

        // remove the reminders from the dupe email so multiple reminders arent sent to dupe emails
        await client.query(`DELETE FROM recipients WHERE conversation_id = $1`, [email.conversationId]);
        continue;
      }

      // the LLM classification to 'complete' is premature, and only on manual execution will the flag be set
      email.status = 'read';
      email.flaggedComplete = !!classification.important.completed; // gets the boolean value of the completed flag 
      const isUnclassifiable = classification.subject.main === UNCLASSIFIABLE_SUBJECT;



      // if the LLM determines that forwarding is unecessary (bcs someone says "dont forward this email") explicitly,
        // or if the recipients needed are already in the thread to begin with, 
        // or if the flag is not unclassifiable  (since that behavior is not possible to piece together yet)
        // then set the forwarded flag to true
      if (
        !isUnclassifiable && (
          classification.important.forwardingNotNeeded ||
          recipients.every(([name, addr]) => party_included_list(email.all_parties, addr.toLowerCase()))
        )
      ) {
        email.forwarded = true;
      }
      
      if (email_within_domain(process.env.INTERNAL_DOMAIN, email.sender)) {
        email.internal = true;
      }

      await client.query(`
        INSERT INTO email (
          conversation_id, id, status, created, forwarded, updated,
          sender, subject, body, in_reply_to, synopsis, subject_main, subject_sub, duplicate_of,
          flagged_complete, remove_from_thread
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (conversation_id) DO UPDATE SET
          id = EXCLUDED.id, status = EXCLUDED.status, created = EXCLUDED.created,
          updated = EXCLUDED.updated, sender = EXCLUDED.sender, subject = EXCLUDED.subject,
          body = EXCLUDED.body, in_reply_to = EXCLUDED.in_reply_to,
          -- "forwarded" means "we already sent the one-time routing email". A thread
          -- that gets reclassified after being forwarded (e.g. because our own reply-all is now
          -- part of the thread history, or the tenant replied) would otherwise have this
          -- recomputed from scratch by the block above which starts from a fresh Graph fetch
          -- defaulting to false, and only flips true again if THIS pass happens to satisfy
          -- forwardingNotNeeded / "everyone already on the thread".
          forwarded = email.forwarded OR EXCLUDED.forwarded,
          synopsis = EXCLUDED.synopsis, subject_main = EXCLUDED.subject_main,
          subject_sub = EXCLUDED.subject_sub, duplicate_of = EXCLUDED.duplicate_of,
          flagged_complete = EXCLUDED.flagged_complete,
          remove_from_thread = EXCLUDED.remove_from_thread,
          archived = false
      `, [
        email.conversationId, email.id, email.status, email.created || null,
        email.forwarded ?? null, email.updated, email.sender, email.subject,
        email.body, email.in_reply_to || null, classification.important.synopsis,
        classification.subject.main, classification.subject.sub, null,
        email.flaggedComplete ?? false, removeList
      ]);



      // ONLY RUN IF THIS EMAIL IS NOT A DUPLICATE
      if (!duplicateOf) {
        await upsertPropertyPairs(client, email.conversationId, classification.property.code, classification.property.lot);

        let sentDate = new Date(email.created ?? email.updated ?? new Date());
        if (isNaN(sentDate.getTime())) sentDate = new Date();

        // unclassifiable behavior
        if (isUnclassifiable) {
          
          // if nobody is routed, then also remind the sender for context or escalate by default if no reply.
            // this is treated as an anchor, since the email is still unforwareded
          const reminderType = classification.important.reminderType ?? "Unclassifiable";
          await client.query(`
            INSERT INTO recipients (
              conversation_id, intended_recipient, reminder_date, reminder_count,
              reminder_type, target_date, assigned_date, interval_index
            )
            VALUES ($1, $2, NULL, 0, $3, NULL, $4, 0)
            ON CONFLICT (conversation_id, intended_recipient) DO NOTHING
          `, [email.conversationId, email.sender, reminderType, sentDate]);
        } else {

          // unclassifiable threads have the anchors dropped once a real classification is derived
          if (email.sender) {
            await client.query(
              `DELETE FROM recipients WHERE conversation_id = $1 AND LOWER(intended_recipient) = LOWER($2)`,
              [email.conversationId, email.sender]
            );
          }

          if (recipients.length > 0) {
            const scheduledReminder = classification.important.scheduledReminder;
            const targetDate = scheduledReminder && scheduledReminder !== "-" ? new Date(scheduledReminder) : null;
            const reminderType = classification.important.reminderType ?? "Miscellaneous";

            for (const [name, recipientEmail] of recipients) {
              await client.query(`
                INSERT INTO recipients (
                  conversation_id, intended_recipient, reminder_date, reminder_count,
                  reminder_type, target_date, assigned_date, interval_index
                )
                VALUES ($1, $2, NULL, 0, $3, $4, $5, 0)
                ON CONFLICT (conversation_id, intended_recipient) DO NOTHING
              `, [email.conversationId, recipientEmail, reminderType, targetDate, sentDate]);
            }
          }
        }
      }

      // update last response
      if (email.last_response_date) {
        await client.query(
          `UPDATE recipients
             SET last_response_date = $2
           WHERE conversation_id = $1
             AND (last_response_date IS NULL OR last_response_date < $2)`,
          [email.conversationId, email.last_response_date]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`Processed ${emails.length} emails`);
    output.sort((a, b) => new Date(b.classification?.updated ?? 0) - new Date(a.classification?.updated ?? 0));

    //console.log(output)
    return output;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

// 86.4m is the number of milliseconds in a day
function day2ms(days){
  return days * 86400000
}

// DEFAULt 7
function getReminderDateForRecipient(reminderType, targetDate, recipientRow) {
  const config = REMINDER_CONFIG[reminderType] ?? REMINDER_CONFIG["Miscellaneous"];
  const now = new Date();

  // REMINDER SCHEDULING is based on the time the email was received (assigned_date = email.created), not the time the email was collected.
    // this prevents issues with late reminders and enforces 'stacking' reminders instead, otherwise if its empty just set the assigned date to collection date
  const received = recipientRow.assigned_date ? new Date(recipientRow.assigned_date) : now;
  const lastResponse = recipientRow.last_response_date ? new Date(recipientRow.last_response_date) : null;
  const addDays = (date, n) => new Date(new Date(date).getTime() + day2ms(n));

  switch (config.mode) {
    case "repeat": {
      const anchor = config.anchor === "last_response" ? (lastResponse ?? received) : received;
      return addDays(anchor, config.interval_days);
    }
    case "repeat_or_anchor": {
      if (targetDate) return targetDate;
      return addDays(lastResponse ?? received, config.interval_days);
    }
    case "deadline_schedule": {
      if (!targetDate) {
        return addDays(received, config.checkInDaysAfterAssignment);
      }
      const idx = recipientRow.interval_index ?? 0;
      if (idx === 0) return addDays(received, config.checkInDaysAfterAssignment);
      const offset = config.deadlineOffsets[idx - 1];
      if (offset !== undefined) return addDays(targetDate, -offset);
      return addDays(received, config.fallbackIntervalDays);
    }
    case "single_anchor":
      return targetDate ?? addDays(received, 7);
  }
}






// this function is read only, and is commited with every other intent
async function scheduleNewReminders(emails, intents) {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT DISTINCT ON (conversation_id)
        conversation_id, reminder_type, target_date, assigned_date, last_response_date, interval_index
      FROM recipients
      WHERE reminder_date IS NULL
        AND reminder_count <= 8
      ORDER BY conversation_id
    `);
    const byConv = new Map(result.rows.map(r => [r.conversation_id, r]));

    for (const email of emails) {
      const convId = email.conversation_id ?? email.conversationId;
      const row = byConv.get(convId);
      if (!row) continue;

      const nextDate = getReminderDateForRecipient(row.reminder_type, row.target_date, row);

      intents.scheduled.push({ convId, date: nextDate, interval_index: row.interval_index });
    }
  } finally {
    client.release();
  }
}


// read-only and commits with every other intent
export async function checkReminders(emails, intents) {
  const client = await pool.connect();
  try {

    // only check rows that have reminders due, need escalation, 
    const result = await client.query(`
      SELECT DISTINCT ON (conversation_id)
        conversation_id, reminder_count, reminder_type, target_date,
        assigned_date, last_response_date, interval_index, reminder_date
      FROM recipients
      WHERE (reminder_date IS NOT NULL AND reminder_date < NOW())
         OR reminder_count > 8
         OR (target_date IS NOT NULL AND target_date < NOW())
      ORDER BY conversation_id
    `);
    const byConv = new Map(result.rows.map(r => [r.conversation_id, r]));

    for (const email of emails) {
      const convId = email.conversation_id ?? email.conversationId;
      const row = byConv.get(convId);
      if (!row) continue;

      const config = REMINDER_CONFIG[row.reminder_type] ?? REMINDER_CONFIG["Miscellaneous"];
      const now = new Date();
      const pastTargetDate = config.completeByDate && row.target_date && now > new Date(row.target_date);
      const escalateAfter = config.escalateAfterReminders ?? 9; // hard coded value default 9 reminder to escalation



      // escalate to supervisor (push to intent supervisor) if the hard deadline has passed after at least 1 reminder after (for leniency)
      // . the complete flags are already not checked here since getReadEmailsWithIntents already takes care of that
      if ((pastTargetDate && row.reminder_count >= 1) || row.reminder_count >= escalateAfter) {
        intents.supervisor.push(convId);
        continue;
      }

      // otherwise, only nudge if a reminder is genuinely due (the row may have been selected
      // solely by the deadline clause with completeByDate off -> nothing to do)
      const reminderDue = row.reminder_date && now > new Date(row.reminder_date);
      if (!reminderDue) continue;

      const nextIndex = row.interval_index + 1; // if reminders have non-repeating cycles (ie: 1 day reminder -> 2 day -> 4 day -> repeat)
      const nextDate = getReminderDateForRecipient(row.reminder_type, row.target_date, { ...row, interval_index: nextIndex }); // check config
      intents.reminder.push({ convId, date: nextDate, nextIndex });
    }
  } finally {
    client.release();
  }
}

