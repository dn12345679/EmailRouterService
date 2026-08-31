# Email Router

An app that classifies emails with claude and performs actions like scheduling and sending reminders, marking possible duplicates, and routing to correct addresses.

> See [ARCHITECTURE.md](ARCHITECTURE.md) for a full technical walkthrough of how the pieces fit together.

**Classify Collected** (`insertIntoDB`)
Pulls unique inbox threads, classifies each with Claude (subject bucket,
conditions, property/lot, synopsis, completion, reminder type, deadline), routes
it to the right people via `ROUTING_CONFIG`, detects likely duplicates (same
sender + property/lot + topic, confirmed by synopsis similarity), and upserts
everything. 

**Check All Intents** (`getReadEmailsWithIntents`)
Reads back the non-archived threads and computes the applicable intents per
thread (a thread can carry more than one, e.g. `forward` + `reminder_scheduled`):
`duplicate`, `needs_info`, `forward`, `complete`, `reminder_scheduled`,
`reminder`, or `supervisor`. Read only

**Submit and Save** (`executeIntents`)
Tick the threads you want (or use the header "select all"), then Submit. You get
a **preview** of the exact actions per thread (forward to X, reply, archive,
resolution-check result) and nothing happens until you click **Confirm &
Execute**. On confirm it performs the Graph writes (to outlook) and DB updates 

### what are the 'intents'?

The intents aren't all the same kind of thing. They sort into categories, and the
category decides how they combine and in what order they run:

| Category | Intents | Behavior |
|---|---|---|
| **Pre-filter** (not intents) | ignored sender, archived | dropped before any intent logic runs |
| **Gate Step** | `duplicate` | exclusive and terminal |
| **Preparation Step** | `forward`, `needs_info` | attach in front of a **Lifecycle** action (do not stop the thread) |
| **Lifecycle Step** (pick exactly one) | `complete`, `supervisor` (escalate), `reminder` (send), `reminder_scheduled` (set) | mutually exclusive states of the thread |
| **Default** | `none` | do nothing |

Intent order of operation: `duplicate` (terminal) -> `forward` + `needs_info`
(composable prep) -> one of `complete` / `supervisor` / `reminder` /
`reminder_scheduled` -> `none`. A `needs_info` thread is still routed and still
runs the reminder/lifecycle flow; the only extra action is the reply asking the
sender to identify the property.

- **duplicate** - closes the duplicate thread, folds it into the original
  sender, archives both, marks the duplicate complete. Duplicates are always
  completed so they stop being tracked.
- **forward** - forwards the whole thread to the routed recipients if Graph
  shows they aren't already on it, then continues.
- **complete** - Claude flagged the thread as resolved. This is only a *premature* flag:
  the thread stays `read` and is surfaced here for confirmation. On execute it forwards to
  any still-missing recipients, replies "thread complete", then marks it complete + archived.
  A thread that is already `status = 'complete'` is finished and never gets any intent.
- **reminder** - runs an LLM resolution check on
  the thread. If it reads as resolved it is completed; otherwise it sends
  "Was the thread complete?", increments the reminder count, and reschedules.
- **supervisor** (escalation) - same resolution check first; if unresolved it
  forwards to Supervisors, resets the reminder state, then marks it complete +
  archived (once escalated it is out of the app's hands).
- **reminder_scheduled** - sets the first reminder date and archives the Outlook
  message (kept checkable in the DB).
- **needs_info** - Claude couldn't identify the property code and/or lot (and the
  thread isn't Misc, a duplicate, or already forwarded). The thread is **still
  routed and reminded normally** 
  and this just adds one extra reply to the original sender asking them to specify
  the Property Code and Lot number. Because it only fires while the thread is
  un-forwarded, the sender is asked once.
- **none** - nothing to do; the thread is left untouched.

### Sender handling (internal vs. 3rd-party)

Senders on `INTERNAL_DOMAIN` are kept on the thread.
External senders are removed from outgoing messages.

### Reminders & escalation to supervisor

Reminders are driven entirely by the DB (`recipients` + `email` tables), not by
whether the thread is currently in the inbox, so a thread keeps getting nudged
even after it's archived out of Outlook, and it does not depend on anyone
replying. A brand-new thread is first scheduled (`reminder_scheduled`), then
fires on a later run once `reminder_date` has passed (`reminder`).

Reminder dates are anchored to when the email was **received**
(`assigned_date = email.created`), not the current time, so historical emails get
historically-correct dates. (Consequence: backfilling old emails makes their
reminders immediately past-due.) If a thread later turns out to be a duplicate,
its own reminder is dropped, but the original **adopts the duplicate's hard
deadline if it is sooner** (tighter `target_date` + reminder type, rescheduled).

`last_response_date` is refreshed on every re-collection to the newest message
that isn't from the mailbox, so `last_response` reminder types
(`Screening Only`, `Screening with Completed and Generated Lease`) reset their
clock when a party replies.

Reminder types with `completeByDate: true` (`Specific Deadline`,
`Intent to Vacate`) escalate straight to Supervisors once their `target_date`
passes, regardless of reminder count. Everything else escalates only once
`reminder_count` exceeds 8 (i.e. `> 8`). A thread flagged complete in any way
(the `complete` intent, or already `status = 'complete'`) never escalates.

### Archiving & collection

Executed threads are moved to the Outlook **Archive** folder (so future inbox
pulls skip them) and flagged `archived` in the DB (so
`getReadEmailsWithIntents` skips them). Reminder intents are Graph-archived but
left `archived = false` so they stay checkable in the DB.

## Database

```sql
CREATE DATABASE email_router;
\c email_router

SET client_encoding = 'UTF8';

CREATE TYPE email_status AS ENUM ('unread', 'read', 'complete');

CREATE TABLE email (
  conversation_id TEXT PRIMARY KEY,
  id              TEXT,
  status          email_status DEFAULT 'unread',
  created         TIMESTAMP,
  forwarded       BOOLEAN,
  duplicate_of    TEXT REFERENCES email(conversation_id),
  sender          TEXT,
  subject         TEXT,
  synopsis        TEXT,
  body            TEXT,
  in_reply_to     TEXT DEFAULT NULL,
  updated         TIMESTAMP,
  subject_main    TEXT,
  subject_sub     TEXT,
  archived        BOOLEAN NOT NULL DEFAULT FALSE,
  flagged_complete BOOLEAN NOT NULL DEFAULT FALSE,  -- Claude flagged it resolved; surfaced as a `complete` intent, finalized on execute
  remove_from_thread TEXT[] NOT NULL DEFAULT '{}'   -- addresses that asked out; trimmed from reply-all recipients
);

CREATE INDEX idx_email_archived ON email (archived);

CREATE TABLE email_property (
  conversation_id TEXT REFERENCES email(conversation_id) ON DELETE CASCADE,
  property_code   VARCHAR(10),
  lot             VARCHAR(100),
  PRIMARY KEY (conversation_id, property_code, lot)
);

CREATE TABLE recipients (
  conversation_id    TEXT REFERENCES email(conversation_id),
  reminder_date      TIMESTAMP,
  reminder_count     INTEGER,
  intended_recipient TEXT,
  reminder_type      TEXT,
  target_date        TIMESTAMP,
  assigned_date      TIMESTAMP DEFAULT NOW(),
  last_response_date TIMESTAMP,
  interval_index     INTEGER DEFAULT 0,
  PRIMARY KEY (conversation_id, intended_recipient)
);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_synopsis_trgm ON email USING GIST (synopsis gist_trgm_ops);
```






### setup (running from source)

1. `npm install`
2. Create/upgrade the DB: copy the schema above into `psql`.
3. Copy `config/config.example.js` to `config/config.js` and fill in your own
   `SUBJECT_BUCKETS` / `CONDITION_BUCKETS` / `ROUTING_CONFIG` (it is not committed).
4. `propertyToRegion.json` maps property/lot to location and region, used when classifying
   properties. The default in this repo is public information; edit it directly if your own
   property list differs.
5. Copy `.env.example` to `.env` and fill in your own values (Graph API credentials, DB
   connection, your own Anthropic API key, internal domain).
6. `mail.readwrite` was added to the Graph scopes (needed to move messages to
   Archive). If you've signed in before, delete the cached `auth-record.json`
   (in Electron's userData dir) so you're re-prompted to consent.
7. Start the app and sign in, the sign in will be auto cached.


### Configuring an already-installed copy (no rebuild needed)

Secrets and business config are never baked into the installer. A packaged app looks for these
files in the **same folder as the installed executable**, and ships a ready-to-copy template of
each one there so you don't need to dig through this repo to fill them in:

| File to create | Copy from the template | Required? |
|---|---|---|
| `.env` | `.env.example` | Yes -> the app won't start without it |
| `config.js` | `config.example.js` | Yes -> must define `SUBJECT_BUCKETS` / `CONDITION_BUCKETS` / `ROUTING_CONFIG` |
| `propertyToRegion.json` | `propertyToRegion.example.json` | No -> falls back to the bundled default if omitted |

Unlike `config/config.js` in this repo (a full JS class extending `RouterConfig`), the
installed-app `config.js` template is a plain object. see the comments in
`config.example.js` for the full list of optional overrides (message templates, thresholds,
ignored-sender patterns, etc.).

