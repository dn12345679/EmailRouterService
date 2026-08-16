import pg from "pg";
import dotenv from 'dotenv';
const {Pool, Client} = pg
import { load } from 'cheerio';
import { CONDITION_BUCKETS, ROUTING_CONFIG, SUBJECT_BUCKETS, REMINDER_CONFIG, REMOVE_SENDER_ON_ESCALATION, NEEDS_INFO_CONFIG } from "./appsettings.js";
import {
  getConversationMessagesAsync,
  extractBodyTextWithCheerio,
  forwardThreadAsync,
  replyAllToThreadAsync,
  replyToThreadAsync,
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
const data = JSON.parse(response);

// Property codes are guaranteed to exist in propertyToRegion.json, and lot numbers are
// guaranteed never to match a property code. So the authoritative test for "is this token a
// property code?" is simply membership in this set -- anything else (numeric like "55" or
// alphanumeric like "A44") is a lot. This is how we tell codes and lots apart when the
// classifier lumps them together.
const PROPERTY_CODES = new Set(
  (data ?? [])
    .map(o => o?.['Community Code'])
    .filter(Boolean)
    .map(c => String(c).trim().toUpperCase())
);
export function isRealPropertyCode(token) {
  return !!token && PROPERTY_CODES.has(String(token).trim().toUpperCase());
}





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

export const PROMPT = (SUBJECTS, MESSAGE, SUBJECT_LINE, CONDITIONS, TEMPLATE, REMINDERS) =>  
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


const DUPLICATE_CLOSING_MESSAGE = 'This message has been marked as a duplicate. Closing this thread.';
const THREAD_COMPLETE_MESSAGE = 'This thread has been marked as complete. Thank you.';
const REMINDER_MESSAGE = (due_date) =>  `Has this task been completed? ${due_date}`;
const supervisorsEmail = () => ROUTING_CONFIG['Supervisors']?.email ?? null;

// Automated / notification senders we never want to route, classify, or remind on.
// Add patterns here (matched case-insensitively against the sender address).
const IGNORED_SENDER_PATTERNS = [
  /no-?reply@/i,
  /do-?not-?reply@/i,
  /don'?treply@/i,
  /notifications?@/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /@.*\.?teams\.microsoft\.com$/i,
];
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

// reply to targets
function replyTargets(m) {
  if (isInternalSender(m.sender)) return null;
  const sender = (m.sender || '').toLowerCase();
  const recips = (m.intended_recipients ?? [])
    .filter(Boolean)
    .filter(a => a.toLowerCase() !== sender);
  return recips.length ? recips : null; // no internal recipients -> fall back to reply-all
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
    const str = PROMPT(JSON.stringify(SUBJECT_BUCKETS), cheeriod,  email.subject, JSON.stringify(CONDITION_BUCKETS), EXAMPLE, REMINDER_CONFIG)
    
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
      AND e.duplicate_of IS NULL          -- only match a canonical original, never another duplicate
      AND e.status <> 'complete'          -- don't fold into / reopen an already-finished thread
      AND similarity(e.synopsis, $1) > 0.3
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

// Debug/inspection helper: given conversation ids, return everything the DB knows about
// each thread -- the email row, its property pairs, its recipient/reminder rows, and the
// currently-computed intent list -- so the whole state can be viewed from the UI.
export async function inspectConversations(ids) {
  const list = (ids ?? []).map(s => String(s).trim()).filter(Boolean);
  if (!list.length) return [];

  const [emails, props, recips] = await Promise.all([
    pool.query(`SELECT * FROM email WHERE conversation_id = ANY($1)`, [list]),
    pool.query(`SELECT * FROM email_property WHERE conversation_id = ANY($1)`, [list]),
    pool.query(`SELECT * FROM recipients WHERE conversation_id = ANY($1)`, [list]),
  ]);

  // intents are computed over the full working set; pull the map once and index into it
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

    // drop automated/notification threads entirely (no-reply, Teams, etc.) so they never
    // get intents even if an older row is still in the DB
    const messages = result.rows.filter(m => !isIgnoredSender(m.sender));

    // intents are now a LIST per thread: intents[convId] = [ { intent, interestedParty, ... }, ... ]
    // An absent key or empty list means "do nothing" -- the default when a thread does not
    // need forwarding, is not a real duplicate, and has no reminder to set/send/escalate.
    const intentsByConversationId = new Map();
    const pushIntent = (convId, obj) => {
      if (!intentsByConversationId.has(convId)) intentsByConversationId.set(convId, []);
      intentsByConversationId.get(convId).push(obj);
    };

    // "Needs information": threads we can't route because Claude couldn't pin down the
    // property code and/or lot. These get a reply asking the sender to identify the property
    // instead of being forwarded/reminded/escalated.
    const needsInfoSet = new Set();
    if (NEEDS_INFO_CONFIG?.enabled && messages.length) {
      const convIds = messages.map(m => m.conversation_id);
      // Pull the raw tokens and classify each against propertyToRegion.json rather than
      // trusting which column it landed in -- a real code (in the JSON) means "has code",
      // any other non-placeholder token means "has lot". This is robust even to rows where
      // the classifier stored a lot ("55", "A44") in the property_code column.
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
        if (skipSubjects.has(m.subject_main)) continue; // e.g. Miscellaneous never needs a lot
        if (m.duplicate_of !== null) continue;          // duplicates inherit the original's identity
        if (m.flagged_complete) continue;               // a resolved thread should be completed, not asked for info
        if (m.forwarded) continue;                       // already routed / in progress
        const p = presence.get(m.conversation_id) ?? { hasCode: false, hasLot: false };
        const missingCode = NEEDS_INFO_CONFIG.requirePropertyCode && !p.hasCode;
        const missingLot = NEEDS_INFO_CONFIG.requireLot && !p.hasLot;
        if (missingCode || missingLot) needsInfoSet.add(m.conversation_id);
      }
    }

    const reminderIntents = { scheduled: [], reminder: [], supervisor: [] };
    await scheduleNewReminders(messages, reminderIntents);
    await checkReminders(messages, reminderIntents);

    const supervisorSet = new Set(reminderIntents.supervisor);
    const reminderDueSet = new Set(reminderIntents.reminder.map(r => r.convId));
    // threads Claude flagged as resolved -> a `complete` intent (for confirmation), which
    // takes precedence over reminders/escalation
    const completeSet = new Set();

    for (const m of messages) {
      const convId = m.conversation_id;
      const recipients = (m.intended_recipients ?? []).filter(Boolean);
      const isDuplicate = m.duplicate_of !== null;
      const flaggedComplete = m.flagged_complete === true;

      // duplicate of an existing thread (can co-exist with a reminder if the thread has recipients)
      if (isDuplicate) {
        const original = messages.find(mm => mm.conversation_id === m.duplicate_of);
        pushIntent(convId, { intent: 'duplicate', interestedParty: original?.created ?? null });
      }

      // can't identify the property -> ask for it instead of routing blindly
      if (needsInfoSet.has(convId)) {
        pushIntent(convId, { intent: 'needs_info', interestedParty: null });
      }

      // forward only when there is actually a new recipient to forward to (fixes the
      // "everything becomes a forward" default that produced spurious intents), and never
      // when we're still waiting on the sender to identify the property (needs_info).
      // Forwarding still composes with `complete` (forward-if-needed, then close).
      else if (!m.forwarded && recipients.length && !isDuplicate) {
        pushIntent(convId, { intent: 'forward', interestedParty: recipients });
      }

      // Claude flagged this thread as resolved -> surface a `complete` intent for confirmation.
      // This is only a premature flag; the thread is finalized to status='complete' when the
      // intent is executed.
      if (flaggedComplete && !isDuplicate) {
        pushIntent(convId, { intent: 'complete', interestedParty: null });
        completeSet.add(convId);
      }
    }

    // reminder-family intents. A thread being completed (or flagged complete) is never
    // reminded or escalated. Supervisor escalation takes precedence over a nudge, and a due
    // reminder takes precedence over first-scheduling.
    for (const convId of reminderIntents.supervisor) {
      const m = messages.find(mm => mm.conversation_id === convId);
      if (!m || m.status === 'complete' || completeSet.has(convId)) continue;
      pushIntent(convId, { intent: 'supervisor', interestedParty: null });
    }
    for (const { convId, date, nextIndex } of reminderIntents.reminder) {
      if (supervisorSet.has(convId) || needsInfoSet.has(convId) || completeSet.has(convId)) continue;
      const m = messages.find(mm => mm.conversation_id === convId);
      if (!m || m.status === 'complete') continue;
      pushIntent(convId, { intent: 'reminder', interestedParty: date, nextIndex });
    }
    for (const { convId, date } of reminderIntents.scheduled) {
      if (supervisorSet.has(convId) || reminderDueSet.has(convId) || needsInfoSet.has(convId) || completeSet.has(convId)) continue;
      const m = messages.find(mm => mm.conversation_id === convId);
      if (!m || m.status === 'complete') continue;
      pushIntent(convId, { intent: 'reminder_scheduled', interestedParty: date });
    }

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

export async function executeIntents(conversationIds = null, { dryRun = true } = {}) {
  const { messages, intents } = await getReadEmailsWithIntents();
  const byId = new Map(messages.map(m => [m.conversation_id, m]));

  const selected = (Array.isArray(conversationIds) && conversationIds.length)
    ? messages.filter(m => conversationIds.includes(m.conversation_id))
    : messages;

  const results = [];

  for (const m of selected) {
    const entryList = intents[m.conversation_id] ?? [];
    const findIntent = (name) => entryList.find(e => e.intent === name);
    const duplicateIntent = findIntent('duplicate');
    const forwardIntent = findIntent('forward');
    const completeIntent = findIntent('complete');
    const supervisorIntent = findIntent('supervisor');
    const reminderIntent = findIntent('reminder');
    const scheduledIntent = findIntent('reminder_scheduled');
    const needsInfoIntent = findIntent('needs_info');
    const intentLabel = entryList.map(e => e.intent).join(' + ') || '-';
    const actions = [];

    // previews or performs
    const perform = async (label, fn) => {
      if (dryRun) { actions.push({ label, status: 'planned' }); return; }
      try { await fn(); actions.push({ label, status: 'done' }); }
      catch (e) { actions.push({ label, status: 'error', error: e.message }); }
    };

    // based on audience
    const targets = replyTargets(m);
    const audienceLabel = targets ? `reply to ${targets.join(', ')}` : 'reply-all';
    const sendReply = (comment) =>
      targets ? replyToThreadAsync(m.id, comment, targets) : replyAllToThreadAsync(m.id, comment);

    // shared "mark complete" path, reused by the complete intent and by the resolution gate when a deadline-passed thread turns out to be resolved
    const completeThread = async () => {
      await perform(`Complete (${audienceLabel}): "${THREAD_COMPLETE_MESSAGE}"`,
        () => sendReply(THREAD_COMPLETE_MESSAGE));
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

        await perform(`Close duplicate thread (${audienceLabel}): "${DUPLICATE_CLOSING_MESSAGE}"`,
          () => sendReply(DUPLICATE_CLOSING_MESSAGE));

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

        // don't forward while we're still waiting on the sender to identify the property
        if (!needsInfoIntent && !m.forwarded && recipients.length) {
          await perform(`Forward thread to: ${recipients.join(', ')}`,
            () => forwardThreadAsync(m.id, recipients, ''));
          await perform(`Mark forwarded in DB`,
            () => pool.query(`UPDATE email SET forwarded=true WHERE conversation_id=$1`, [m.conversation_id]));
        }

        // property/lot unclear -> reply asking for it, then archive until the sender responds
        // (a reply re-surfaces the thread in the inbox and it gets re-classified)
        if (needsInfoIntent) {
          await perform(`Needs-info reply (${audienceLabel}): "${NEEDS_INFO_CONFIG.message}"`,
            () => sendReply(NEEDS_INFO_CONFIG.message));
          await perform(`Mark archived in DB (reopens on the sender's reply)`,
            () => pool.query(`UPDATE email SET archived=true WHERE conversation_id=$1`, [m.conversation_id]));
          await perform(`Archive thread in Outlook`,
            () => archiveThreadAsync(m.conversation_id));
        }

        else if (completeIntent) {
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
        // resolved => complete now, otherwise send the nudge and reschedule the next reminder
        else if (reminderIntent) {
          const date = reminderIntent.interestedParty;
          const nextIndex = reminderIntent.nextIndex ?? null;
          const resolved = await threadLooksResolved(m.body || '');
          actions.push({ label: `Resolution check -> ${resolved ? 'resolved' : 'not resolved'}`, status: 'done' });

          if (resolved) {
            await completeThread();
          } else {
            await perform(`Reminder (${audienceLabel}): "${REMINDER_MESSAGE( date? " This was due on " + date : "" )}"`,
              () => sendReply(REMINDER_MESSAGE(date? " This was due on " + date : "" )));
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
    pairs.push({ code, lot: lotNum ?? NO_LOT });
  }

  // The classifier is inconsistent about e.g. "BL 55" / "OM A44": sometimes the lot lands in
  // the code array (code=["BL","55"] or ["OM","A44"]) instead of the lot array. Property codes
  // are guaranteed to be in propertyToRegion.json, so any token that is NOT a real code is a
  // stray lot. When there is exactly one real code, fold the stray lots onto it so all
  // classifications normalize to the same (code, lot) pair -- otherwise duplicate detection
  // misses them and needs_info fires incorrectly.
  const rawCodes = (codes || []).map(c => String(c).trim()).filter(c => !isPlaceholder(c));
  const realCodes = rawCodes.filter(isRealPropertyCode);
  const strayLots = rawCodes.filter(c => !isRealPropertyCode(c));
  const foldStrays = realCodes.length === 1 && strayLots.length > 0;

  if (foldStrays) {
    for (const lot of strayLots) {
      if (!pairs.some(p => p.code === realCodes[0] && p.lot === lot)) {
        pairs.push({ code: realCodes[0], lot });
      }
    }
  }

  // remaining bare codes: real codes always; stray tokens only when we couldn't fold them
  // (ambiguous multi-code cases are left as-is rather than guessed)
  const leftoverCodes = foldStrays ? realCodes : rawCodes;
  for (const code of leftoverCodes) {
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

  // if the hard deadline passed, just send to supervisors
  const hardDeadlineBlown =
    config.completeByDate &&
    recipientRow.target_date &&
    now > new Date(recipientRow.target_date);

  if (hardDeadlineBlown) return 'supervisor';

  const reminderDue =
    recipientRow.reminder_date && now > new Date(recipientRow.reminder_date);

  if (!reminderDue) return 'none';

  return recipientRow.reminder_count >= 8 ? 'supervisor' : 'reminder_due';
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


// INITIAL INSERT ONLY, INTENTS occur after
// this is directly called from graphHelper.uploadToDB() and uses the output from graphHelper.getUniqueMessages()
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

      const classification = await classify_email(email);
      const recipients = await classification_to_email(classification);

      const similar = await find_similar_synopsis(
        client,
        classification.important.synopsis,
        classification.property.code,
        classification.property.lot,
        classification.subject.main,
        classification.subject.sub,
        email.conversationId
      );

      // never let a thread be a duplicate of itself (belt-and-suspenders on top of the SQL guard)
      const duplicateOf = (similar && similar.conversation_id !== email.conversationId) ? similar : null;

      output.push({ conversationId: email.conversationId, updated: email.updated, classification, recipients, similar: duplicateOf });

      if (duplicateOf) {
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
            duplicate_of = EXCLUDED.duplicate_of,
            archived = false
        `, [
          email.conversationId, email.id, email.status, email.created || null,
          email.forwarded, email.updated, email.sender, email.subject,
          email.body, email.in_reply_to || null, classification.important.synopsis,
          classification.subject.main, classification.subject.sub,
          duplicateOf.conversation_id
        ]);

        await client.query(`UPDATE email SET status = 'read' WHERE conversation_id = $1`, [duplicateOf.conversation_id]);
        continue;
      }

      // Claude's "completed" is a PREMATURE flag only -- the thread stays 'read' and is
      // surfaced as a `complete` intent for confirmation. It is only finalized to
      // status='complete' when that intent is executed.
      email.status = 'read';
      email.flaggedComplete = !!classification.important.completed;

      // Forwarding is unnecessary when the sender said so explicitly (LLM flag) or every
      // routed recipient is already a party on the thread. (Completion no longer suppresses
      // forwarding -- a completing thread should still make sure everyone is included first.)
      if (
        classification.important.forwardingNotNeeded ||
        recipients.every(([name, addr]) => party_included_list(email.all_parties, addr.toLowerCase()))
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
          flagged_complete
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (conversation_id) DO UPDATE SET
          id = EXCLUDED.id, status = EXCLUDED.status, created = EXCLUDED.created,
          updated = EXCLUDED.updated, sender = EXCLUDED.sender, subject = EXCLUDED.subject,
          body = EXCLUDED.body, in_reply_to = EXCLUDED.in_reply_to, forwarded = EXCLUDED.forwarded,
          synopsis = EXCLUDED.synopsis, subject_main = EXCLUDED.subject_main,
          subject_sub = EXCLUDED.subject_sub, duplicate_of = EXCLUDED.duplicate_of,
          flagged_complete = EXCLUDED.flagged_complete,
          archived = false
      `, [
        email.conversationId, email.id, email.status, email.created || null,
        email.forwarded ?? null, email.updated, email.sender, email.subject,
        email.body, email.in_reply_to || null, classification.important.synopsis,
        classification.subject.main, classification.subject.sub, null,
        email.flaggedComplete ?? false
      ]);

      if (!duplicateOf) {
        await upsertPropertyPairs(client, email.conversationId, classification.property.code, classification.property.lot);

        if (recipients.length > 0) {
          const scheduledReminder = classification.important.scheduledReminder;
          const targetDate = scheduledReminder && scheduledReminder !== "-" ? new Date(scheduledReminder) : null;
          const reminderType = classification.important.reminderType ?? "Miscellaneous";

        let sentDate = new Date(email.created ?? email.updated ?? new Date());
          if (isNaN(sentDate.getTime())) sentDate = new Date();

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

    console.log(output)
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
  const addDays = (date, n) => new Date(date.getTime() + day2ms(n));

  switch (config.mode) {
    case "repeat": {
      const anchor = config.anchor === "last_response"
        ? (recipientRow.last_response_date ?? recipientRow.assigned_date ?? now)
        : (recipientRow.assigned_date ?? now);
      return addDays(anchor, config.interval_days);
    }
    case "repeat_or_anchor": {
      if (targetDate) return targetDate;
      const anchor = recipientRow.last_response_date ?? recipientRow.assigned_date ?? now;
      return addDays(anchor, config.interval_days);
    }
    case "deadline_schedule": {
      if (!targetDate) {
        return addDays(recipientRow.assigned_date ?? now, config.checkInDaysAfterAssignment);
      }
      const idx = recipientRow.interval_index ?? 0;
      if (idx === 0) return addDays(recipientRow.assigned_date ?? now, config.checkInDaysAfterAssignment);
      const offset = config.deadlineOffsets[idx - 1];
      if (offset !== undefined) return addDays(targetDate, -offset);
      return addDays(now, config.fallbackIntervalDays);
    }
    case "single_anchor":
      return targetDate ?? addDays(now, 7);
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
    // A row is relevant if a reminder is actually due, OR it qualifies for escalation
    // (too many reminders sent, or the hard deadline has passed). The reminder_count / deadline
    // conditions are checked here directly so a high count with a NULL/future reminder_date
    // still escalates -- previously such rows were never selected and got mis-treated as normal.
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

      // escalate to supervisors when the hard deadline has passed or too many reminders were
      // sent (> 8). The "not flagged complete in any way" half of the condition is enforced in
      // getReadEmailsWithIntents, which drops complete / flagged-complete threads from the
      // supervisor list before the intent is emitted.
      if (pastTargetDate || row.reminder_count > 8) {
        intents.supervisor.push(convId);
        continue;
      }

      // otherwise, only nudge if a reminder is genuinely due (the row may have been selected
      // solely by the deadline clause with completeByDate off -> nothing to do)
      const reminderDue = row.reminder_date && now > new Date(row.reminder_date);
      if (!reminderDue) continue;

      const nextIndex = row.interval_index + 1;
      const nextDate = getReminderDateForRecipient(row.reminder_type, row.target_date, { ...row, interval_index: nextIndex });
      intents.reminder.push({ convId, date: nextDate, nextIndex });
    }
  } finally {
    client.release();
  }
}

