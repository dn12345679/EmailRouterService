

// THIS IS a template, not the real config file. Please make your own file
// Configuration rules:
//   1. When adding a new bucket, append it to the END of the
//      list since order matters
//   2. Any change to the buckets is reflected automatically in ROUTING_CONFIG.
//   3. If you add a new "Main Subject" with no real subcategories, still add a
//      default subcategory (it is guaranteed to be that one anyway).
//   4. `main` in a rule is the 0-based index into SUBJECT_BUCKETS keys;
//      `subject` is the 0-based index/indices into that main's subcategory list.

import { RouterConfig } from './RouterConfig.js';

export class UserConfig extends RouterConfig {
  constructor() {
    super(); 

    // Top-level subjects has ordered subcategories.
    this.SUBJECT_BUCKETS = {
      "Support": [
        "Email",
        "Phone",
      ],
      "Maintenance": [
        "Infrastructure",
        "Equipment",
      ],
      "Miscellaneous": [
        "Miscellaneous",
      ],
    };

    // conditions the classifier evaluates 
    this.CONDITION_BUCKETS = {
      exampleRegionFlag: "Property belongs to the example region",
      exampleUrgentFlag: "The message describes an urgent safety issue",
    };

    // people with emails and which of the conditions/topics they fall into
    this.ROUTING_CONFIG = {
      "Example Support Person": {
        email: "support@example.com",
        rules: [
          {
            main: 0,            // "Support"
            subject: [0, 1],    // Email, Phone
            conditions: {},     // no conditions required
          },
        ],
      },
      "Example Maintenance Person": {
        email: "maintenance@example.com",
        rules: [
          {
            main: 1,            // "Maintenance"
            subject: [0, 1],    // Infrastructure, Equipment
            conditions: {},
          },
        ],
      },
      // A "Supervisors" entry is required by default in the case the email falls out of eveyr other category
      "Supervisors": {
        email: "supervisors@example.com",
        rules: [
          {
            main: 2,            // "Miscellaneous"
            subject: [0],
            conditions: {},
          },
        ],
      },
    };

    // -- Optional overrides (inherited from RouterConfig if omitted) --

    // Reminder types in REMINDER_CONFIG above can each set their own escalateAfterReminders;
    // any that don't fall back to this value.
    this.ESCALATE_AFTER_REMINDERS_DEFAULT = 9;

    // How closely a new email's synopsis has to match an existing open thread's (0-1) before
    // it's flagged as a possible duplicate. Lower = more duplicates get flagged (more false
    // positives); higher = fewer, more confident matches.
    this.DUPLICATE_SIMILARITY_THRESHOLD = 0.3;

    // other overrides such as default prompts lie in /config/RouterConfig.js
    //   this.CLASSIFICATION_EXAMPLE      -- worked example shown to the classifier LLM
    //   this.CLASSIFICATION_PROMPT       -- the actual classification prompt/instructions
    //   this.CLOSING_MESSAGE             -- (classification) => string, unused by default
    //   this.DUPLICATE_CLOSING_MESSAGE   -- reply sent when closing a duplicate thread
    //   this.THREAD_COMPLETE_MESSAGE     -- reply sent when closing a completed thread
    //   this.REMINDER_MESSAGE            -- (dueDateText) => string, sent as a nudge
    //   this.NO_CODE_TOKEN               -- placeholder when no property code was found
    //   this.NO_LOT_TOKEN                -- placeholder when no lot number was found
    //   this.MAX_PROPERTY_CODE_LEN       -- must match email_property.property_code's column width
    //   this.UNCLASSIFIABLE_SUBJECT_LABEL -- subject bucket label for contentless/image threads
    //   this.IGNORED_SENDER_PATTERNS     -- array of RegExp; matching senders are never processed
    //   this.SUPERVISORS_ROUTING_KEY     -- which ROUTING_CONFIG key above counts as "Supervisors"
  }
}

export default new UserConfig().validate();
