import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });




// configuration rules: 
  /*
    1. order matters here, make sure that if you add a new thing, you add to the end of the list
    2. Any change to the buckets will be reflected automatically in the ROUTING_CONFIG  object
    3. If you add a new "Main Subject", but dont intend to add any "Subcategories", Be sure to include a default Subcategory that is related to the Main category since its guaranteed to be that anyway. 
    4. If SUBJECT_BUCKETS ever changes format, also change dbManager.classification_to_email because that is a direct dependency.
  
    */

// subjects referenced in ROUTING_CONFIG
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

// conditions referenced in ROUTING_CONFIG
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


// 
export const REMINDER_CONFIG =
  {
    "Screening Only": 
      {
        repeat: true,
        repeat_interval: [2], // 2 days per cycle, repeat until 'complete'

        completeByDate: false
      },
    "Screening with Completed and Generated Lease":
      {
        repeat: true,
        repeat_interval: [7],

        completeByDate:false
        
      },
    "Specific Deadline":
      {
        repeat: true,
        repeat_interval: [4, 2, 1],

        completeByDate: true
      },
    "Intent to Vacate":
      {
        repeat: false,
        repeat_interval: [],

        completeByDate: true
      }
    
  }


// actual people with emails configuration
export const ROUTING_CONFIG = {
  "Igor Oliveira":
    {
      email: "igoroliveira@HurstSonLLC.com",
      rules: [
        {
          main: 0, // "tech support"
          subject: [1, 2, 4, 5], // Email, Onedrive, Rent Roll, RDC
          conditions: {} // no conditions have to be true for igor
        }
      ]
    },
  "Christina Chang":
    {
      email: "christinachang@HurstSonLLC.com",
      rules: [
        {
          main: 0, // tech support,
          subject: [4, 5], // rent roll, RDC,
          conditions: {} // no conditions are necessary
        }
      ]
    },

  "Samuel Stevens":
    {
      email: "samuelstevens@HurstSonLLC.com",
      rules: [
        {
          main: 0, // Tech support,
          subject: [1], // just phone
          conditions: {} // no conditions necessary for tech support
        },
        {
          main: 2, // maintenance
          subject: [1, 2], // trees/roads/buildings, and Equipment
          conditions: {} // no conditions necessary for maintenance
        }
      ]
    },
  "RonCal":
    {
      email: "RonCal@HurstSonLLC.com",
      rules: [
        {
          main: 0,
          subject: [3],
          conditions: {}
        },
        {
          main: 3,
          subject: [1],
          conditions: {companySellingHome: true}
        }
      ]
    },
  "Infrastructure":
    {
      email: "Infrastructure@HurstSonLLC.com",
      rules: [
        {
          main: 2,
          subject: [0, 1],
          conditions: {}
        },
        {
          main: 1,
          subject: [0],
          conditions: {unusualWaterBill: true}
        },
        {
          main: 7,
          subject: [1],
          conditions: {}
        },
      ]
    },
  "Billing":
    {
      email: "Billing@HurstSonLLC.com",
      rules: [
        {
          main: 1,
          subject: [0],
          conditions: {}
        }
      ]
    },
  "Screening":
    {
      email: "Screenings@HurstSonLLC.com",
      rules: [
        {
          main: 3,
          subject: [0, 1, 2],
          conditions: {} // technically has conditions, but flowchart shows same result either way
        }
      ]
    },
  "Legal":
    {
      email: "Legal@HurstSonLLC.com",
      rules: [
        {
          main: 6,
          subject: [0],
          conditions: {}
        }
      ]
    },
    // TODO: REVIEW the northDakota condition later, since its possible for an email to concern multiple regions, which i can just ignore n.d check
  "West Admin":
    {
      email: "WestAdmin@HurstSonLLC.com",
      rules: [
        {
          main: 3,
          subject: [0, 1, 2],
          conditions: {northDakota: false, westGroup: true}
        },
        {
          main: 4,
          subject: [0],
          conditions: {northDakota: false, westGroup: true}
        },
        {
          main: 5,
          subject: [0],
          conditions: {northDakota: false, westGroup: true}
        },
        {
          main: 7,
          subject: [1],
          conditions: {northDakota: false, westGroup: true}
        }
      ]
    },
  "East Admin":
    {
      email: "EastAdmin@HurstSonLLC.com",
      rules: [
        {
          main: 3,
          subject: [0, 1, 2],
          conditions: {northDakota: false, eastGroup: true}
        },
        {
          main: 4,
          subject: [0],
          conditions: {northDakota: false, eastGroup: true}
        },
        {
          main: 5,
          subject: [0],
          conditions: {northDakota: false, eastGroup: true}
        },
        {
          main: 7,
          subject: [1],
          conditions: {northDakota: false, eastGroup: true}
        }
      ]
    },
    // check pink arrow condition in flowchart
  "Housing Assistance":
    {
      email: "HousingAssistance@HurstSonLLC.com",
      rules: [
        {
          main: 4,
          subject: [0],
          conditions: {}
        }
      ]
    },
  "Debbie Prewitt":
    {
      email: "debbieprewitt@hurstsonllc.com",
      rules: [
        {
          main: 5,
          subject: [0],
          conditions: {tenantNonCompliance: true, normalRuleViolation: true, minorSafetyIssue: true}
        }
      ]
    },
  "Supervisors":
    {
      email: "Supervisors@HurstSonLLC.com",
      rules: [
        {
          main: 5,
          subject: [0],
          conditions: {tenantNonCompliance: true, significantSafetyIssue: true, minorSafetyIssue: true}
        },
        {
          main: 8,
          subject: [0],
          conditions: {}
        }
      ]
    },
  "North Dakota":
    {
      email: "NorthDakota@HurstSonLLC.com",
      rules: [
        {
          main: 3,
          subject: [0, 1, 2],
          conditions: {northDakota: true}
        },
        {
          main: 4,
          subject: [0],
          conditions: {northDakota: true}
        },
        {
          main: 5,
          subject: [0],
          conditions: {northDakota: true}
        },
        {
          main: 7,
          subject: [0, 1],
          conditions: {northDakota: true}
        }
      ]
    },
  "Kortney Carter":
    {
      email: "kortneycarter@HurstSonLLC.com",
      rules: [
        {
          main: 8,
          subject: [0],
          conditions: {employeeExpenseOrTimeOff: true}
        }
      ]
    },
  "Heather Smith":
    {
      email: "heathersmith@HurstSonLLC.com",
      rules: [
        {
          main: 7,
          subject: [0, 1],
          conditions: {}
        }
      ]
    }
}


const settings = {
  clientId: process.env.EML_CLIENT_ID,
  tenantId: process.env.EML_TENANT_ID,
  clientSecret: process.env.EML_CLIENT_SECRET,
  graphUserScopes: ['offline_access','user.read', 'mail.read', 'mail.send'],
  userEmail: process.env.userEmail
};

export default settings;