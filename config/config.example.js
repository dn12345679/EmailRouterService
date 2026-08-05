

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
  }
}

export default new UserConfig().validate();
