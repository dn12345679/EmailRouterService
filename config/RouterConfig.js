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
};

export class RouterConfig {
  constructor() {
    this.SUBJECT_BUCKETS = null;
    this.CONDITION_BUCKETS = null;
    this.ROUTING_CONFIG = null;
    this.REMINDER_CONFIG = DEFAULT_REMINDER_CONFIG;
    this.REMOVE_SENDER_ON_ESCALATION = true;
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
