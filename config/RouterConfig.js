export const DEFAULT_REMINDER_CONFIG = {
  "Screening Only": {
    mode: "repeat",
    anchor: "last_response",   // reset clock when party replies to email
    interval_days: 2,
    stopWhen: "complete",      // task complete
  },
  "Screening with Completed and Generated Lease": {
    mode: "repeat_or_anchor",
    anchor: "last_response",
    interval_days: 7,
    overrideAnchorField: "target_date",
    stopWhen: "complete",
  },
  "Specific Deadline": {
    mode: "deadline_schedule",
    checkInDaysAfterAssignment: 4,
    deadlineOffsets: [2, 1, 0],
    fallbackIntervalDays: 1,
    stopWhen: "complete",
    completeByDate: true,   // once target_date passes, escalate to Supervisors
  },
  "Intent to Vacate": {
    mode: "single_anchor",
    anchorField: "target_date",
    completeByDate: true,   // once target_date passes, escalate to Supervisors
  },
  "Miscellaneous": {
    mode: "repeat",
    anchor: "assigned",
    interval_days: 7,
    stopWhen: "complete",
  },
  // Contentless / image-only forwards that couldn't be classified. There's no deadline, so we
  // nudge the sender for context on a fixed cadence and escalate to Supervisors after a few
  // unanswered nudges (see escalateAfterReminders).
  "Unclassifiable": {
    mode: "repeat",
    anchor: "assigned",
    interval_days: 3,
    stopWhen: "complete",
    escalateAfterReminders: 3,   // escalate to Supervisors once this many nudges go unanswered
  },
};

export const DEFAULT_NEEDS_INFO_CONFIG = {
  enabled: true,
  // subject buckets that never need a property/lot 
  skipSubjects: ["Miscellaneous"],
  // which identifiers are required, prompt when a required one is missing
  requirePropertyCode: true,
  requireLot: true,
  message:
    "Thank you for your inquiry, but would you be able to specify the Property Code and Lot number for identification?",
};

export const DEFAULT_UNCLASSIFIABLE_CONFIG = {
  enabled: true,
  // A forwarded image / contentless thread: too little text to discern a topic AND no
  // property/lot found. Full parsed chain shorter than maxChars (with no code/lot) is treated
  // as unclassifiable and routed to the "ask the sender for context" flow instead of a bucket.
  maxChars: 50,
  reminderType: "Unclassifiable",
  message:
    "Context not found. Please reply with the subject, property, and lot so this can be routed.",
};

// Fallback used when a REMINDER_CONFIG entry doesn't set its own escalateAfterReminders
// (e.g. "Screening Only", "Miscellaneous" above never set one).
export const DEFAULT_ESCALATE_AFTER_REMINDERS = 9;

// How closely a new email's synopsis has to match an existing open thread's (0-1, via
// Postgres pg_trgm similarity()) before it's flagged as a possible duplicate of it.
export const DEFAULT_DUPLICATE_SIMILARITY_THRESHOLD = 0.3;

// Shown to the classifier LLM as a worked example of the exact JSON shape it must return.
// Keep the field names/shape in sync with what classify_email() (dbManager.js) expects back.
export const DEFAULT_CLASSIFICATION_EXAMPLE =
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
`;

// The actual classification prompt sent to the LLM. Called as
// CLASSIFICATION_PROMPT(subjectsJSON, messageText, subjectLine, conditionsJSON, exampleTemplate,
// reminderConfig, communityList). see classify_email() in dbManager.js.
export const DEFAULT_CLASSIFICATION_PROMPT = (SUBJECTS, MESSAGE, SUBJECT_LINE, CONDITIONS, TEMPLATE, REMINDERS, COMMUNITIES) =>
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

`;

// Sent back to the thread (via reply-all) once a thread is marked complete or closed as a
// duplicate. `classification` is the LLM classification object for the thread being closed.
export const DEFAULT_CLOSING_MESSAGE = (classification) =>
  `
    This thread has been marked as complete. Thank you for your responses.
    Synopsis: ${classification.important.synopsis || 'N/A'}
    Summary: ${classification.important.summary || 'N/A'}
  `;

export const DEFAULT_DUPLICATE_CLOSING_MESSAGE = 'This message has been marked as a duplicate. Closing this thread.';
export const DEFAULT_THREAD_COMPLETE_MESSAGE = 'This thread has been marked as complete. Thank you.';
export const DEFAULT_REMINDER_MESSAGE = (due_date) => `Has the assigned tasks been completed? ${due_date}`;

// Placeholder tokens used internally when a thread has no property code / lot number.
export const DEFAULT_NO_CODE_TOKEN = 'none';
export const DEFAULT_NO_LOT_TOKEN = 'unspecified';

// Matches the email_property.property_code column width (see config/schema.txt). if you raise
// this, widen that column too, or valid codes longer than the old limit will get silently dropped.
export const DEFAULT_MAX_PROPERTY_CODE_LEN = 10; // IE: ALTER COLUMN IN DB FIRST BEFORE CHANGING

// subject.main/subject.sub value used for contentless/image-only threads that can't be
// classified into a real bucket (see UNCLASSIFIABLE_CONFIG above).
export const DEFAULT_UNCLASSIFIABLE_SUBJECT_LABEL = 'Unclassifiable email';

// Incoming mail from any of these senders is ignored entirely (never classified/routed).
export const DEFAULT_IGNORED_SENDER_PATTERNS = [
  /no-?reply@/i,
  /do-?not-?reply@/i,
  /don'?treply@/i,
  /notifications?@/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /@.*\.?teams\.microsoft\.com$/i,
];

// Which ROUTING_CONFIG entry is treated as "Supervisors" for escalation (hard deadlines blown,
// too many unanswered reminders, etc). Must match a key in your ROUTING_CONFIG.
export const DEFAULT_SUPERVISORS_ROUTING_KEY = 'Supervisors';

export class RouterConfig {
  constructor() {
    this.SUBJECT_BUCKETS = null;
    this.CONDITION_BUCKETS = null;
    this.ROUTING_CONFIG = null;
    this.REMINDER_CONFIG = DEFAULT_REMINDER_CONFIG;
    this.NEEDS_INFO_CONFIG = DEFAULT_NEEDS_INFO_CONFIG;
    this.UNCLASSIFIABLE_CONFIG = DEFAULT_UNCLASSIFIABLE_CONFIG;
    this.REMOVE_SENDER_ON_ESCALATION = true;
    this.ESCALATE_AFTER_REMINDERS_DEFAULT = DEFAULT_ESCALATE_AFTER_REMINDERS;
    this.DUPLICATE_SIMILARITY_THRESHOLD = DEFAULT_DUPLICATE_SIMILARITY_THRESHOLD;

    this.CLASSIFICATION_EXAMPLE = DEFAULT_CLASSIFICATION_EXAMPLE;
    this.CLASSIFICATION_PROMPT = DEFAULT_CLASSIFICATION_PROMPT;
    this.CLOSING_MESSAGE = DEFAULT_CLOSING_MESSAGE;
    this.DUPLICATE_CLOSING_MESSAGE = DEFAULT_DUPLICATE_CLOSING_MESSAGE;
    this.THREAD_COMPLETE_MESSAGE = DEFAULT_THREAD_COMPLETE_MESSAGE;
    this.REMINDER_MESSAGE = DEFAULT_REMINDER_MESSAGE;
    this.NO_CODE_TOKEN = DEFAULT_NO_CODE_TOKEN;
    this.NO_LOT_TOKEN = DEFAULT_NO_LOT_TOKEN;
    this.MAX_PROPERTY_CODE_LEN = DEFAULT_MAX_PROPERTY_CODE_LEN;
    this.UNCLASSIFIABLE_SUBJECT_LABEL = DEFAULT_UNCLASSIFIABLE_SUBJECT_LABEL;
    this.IGNORED_SENDER_PATTERNS = DEFAULT_IGNORED_SENDER_PATTERNS;
    this.SUPERVISORS_ROUTING_KEY = DEFAULT_SUPERVISORS_ROUTING_KEY;
  }


  validate() {
    const required = ['SUBJECT_BUCKETS', 'CONDITION_BUCKETS', 'ROUTING_CONFIG'];
    for (const key of required) {
      if (!this[key] || (typeof this[key] === 'object' && Object.keys(this[key]).length === 0)) {
        throw new Error(
          `RouterConfig: "${key}" is required but missing. ` +
          `Copy config/config.example.js to config/config.js and fill it in.`
        );
      }
    }
    return this;
  }
}
