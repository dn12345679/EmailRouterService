// This template ships next to the installed application. To configure a freshly installed copy
// of the app WITHOUT rebuilding it:
//   1. Copy this file to "config.js", in the same folder as the app's executable.
//   2. Fill in SUBJECT_BUCKETS / CONDITION_BUCKETS / ROUTING_CONFIG below for your own routing
//      rules (these three are required).
//   3. Restart the app. It's picked up automatically on next launch.
//
// Configuration rules:
//   1. When adding a new bucket, append it to the END of the list since order matters.
//   2. Any change to the buckets is reflected automatically in ROUTING_CONFIG.
//   3. If you add a new "Main Subject" with no real subcategories, still add a default
//      subcategory (it is guaranteed to be that one anyway).
//   4. `main` in a rule is the 0-based index into SUBJECT_BUCKETS keys; `subject` is the
//      0-based index/indices into that main's subcategory list.

export default {
  // Top-level subjects, each with ordered subcategories.
  SUBJECT_BUCKETS: {
    "Support": ["Email", "Phone"],
    "Maintenance": ["Infrastructure", "Equipment"],
    "Miscellaneous": ["Miscellaneous"],
  },

  // Conditions the classifier evaluates.
  CONDITION_BUCKETS: {
    exampleRegionFlag: "Property belongs to the example region",
    exampleUrgentFlag: "The message describes an urgent safety issue",
  },

  // People with emails and which of the conditions/topics they fall into.
  ROUTING_CONFIG: {
    "Example Support Person": {
      email: "support@example.com",
      rules: [
        { main: 0, subject: [0, 1], conditions: {} }, // "Support": Email, Phone
      ],
    },
    "Example Maintenance Person": {
      email: "maintenance@example.com",
      rules: [
        { main: 1, subject: [0, 1], conditions: {} }, // "Maintenance": Infrastructure, Equipment
      ],
    },
    // A "Supervisors" entry is required by default -- used when an email falls out of every
    // other category, and for reminder/deadline escalations.
    "Supervisors": {
      email: "supervisors@example.com",
      rules: [
        { main: 2, subject: [0], conditions: {} }, // "Miscellaneous"
      ],
    },
  },

  // -- Everything below is optional. Uncomment only what you want to change; anything you
  //    leave out keeps the built-in default. --

  // ESCALATE_AFTER_REMINDERS_DEFAULT: 9,
  // DUPLICATE_SIMILARITY_THRESHOLD: 0.3,
  // CLASSIFICATION_EXAMPLE: `...`,
  // CLASSIFICATION_PROMPT: (SUBJECTS, MESSAGE, SUBJECT_LINE, CONDITIONS, TEMPLATE, REMINDERS, COMMUNITIES) => `...`,
  // CLOSING_MESSAGE: (classification) => `...`,
  // DUPLICATE_CLOSING_MESSAGE: "This message has been marked as a duplicate. Closing this thread.",
  // THREAD_COMPLETE_MESSAGE: "This thread has been marked as complete. Thank you.",
  // REMINDER_MESSAGE: (dueDateText) => `Has the assigned tasks been completed? ${dueDateText}`,
  // NO_CODE_TOKEN: "none",
  // NO_LOT_TOKEN: "unspecified",
  // MAX_PROPERTY_CODE_LEN: 10,
  // UNCLASSIFIABLE_SUBJECT_LABEL: "Unclassifiable email",
  // IGNORED_SENDER_PATTERNS: [/no-?reply@/i, /do-?not-?reply@/i],
  // SUPERVISORS_ROUTING_KEY: "Supervisors",
};
