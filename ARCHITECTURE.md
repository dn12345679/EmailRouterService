# Email Router - Architecture & Flow

## What this project does

**Email Router** is an Electron desktop app for a property-management team. It:

1. Signs into a Microsoft 365 / Outlook mailbox.
2. Pulls email threads from the inbox.
3. Uses specifically **Anthropic Claude API** (must have access to an api key for config) to classify each thread (subject, conditions, property/lot, synopsis, deadlines, reminder type).
4. Matches each classification against configurable **routing rules** to decide who should receive it.
5. Stores everything in **PostgreSQL**.
6. Computes an **intent** per thread (forward / duplicate / complete / reminder / escalate).
7. Lets the user preview a plan (dry run) and then **execute** it: forwarding, replying, sending reminders, escalating to supervisors, and archiving, all via the Microsoft Graph API.

## Tech stack

| Concern | Technology |
| --- | --- |
| Desktop shell | Electron |
| Backend / API | Express (ES modules, `type: "module"`) |
| Email I/O | Microsoft Graph API (`@microsoft/microsoft-graph-client`, `@azure/identity` device-code auth) |
| Classification | Anthropic Claude (`@anthropic-ai/sdk`, model `claude-haiku-4-5`) |
| Database | PostgreSQL (`pg`), with the `pg_trgm` `similarity()` extension for duplicate detection |
| HTML parsing | `cheerio` (strips signatures/quoted replies from email bodies) |
| Config | `dotenv` + `config/config.js` |

## File map

```
main.js              Electron entry point. starts Express, opens the window at localhost:3000
server.js            Express server + REST API routes (the UI talks to this)
graphHelper.js       Microsoft Graph: auth, reading inbox/threads, send/forward/reply/archive
dbManager.js         Core logic: Claude classification, routing, Postgres, reminders, intent engine
appsettings.js       Loads .env and re-exports user config buckets
config/config.js     User-tunable config: subject buckets, conditions, routing rules, reminders
propertyToRegion.json  Lookup table: property "Community Code" -> Region (East/West/North)
public/              Static front-end served by Express (no framework/build step)
  index.html           Sign-in view + dashboard view (ribbon, search bar, workspace, modals)
  app.js               All front-end behavior: job dispatch, rendering, search, reading pane, modals
  style.css            All styling, keyed off CSS custom properties on :root
```


## Component responsibilities

### `main.js` - Electron entry
- `createWindow()`: awaits `startServer()`, then opens a BrowserWindow pointed at `http://localhost:3000`.

### `server.js` - Express API
Holds in-memory `authState` (`signedOut | awaitingCode | authenticated | error`) and exposes:

| Route | Purpose |
| --- | --- |
| `GET /api/auth/status` | Current auth state |
| `POST /api/auth/start` | Begin Microsoft device-code sign-in (returns a code for the user to enter in a browser) |
| `GET /api/inbox` | Fetch unique conversation threads (`getUniqueMessages`) |
| `POST /api/classify-selected` | Classify a provided array of messages to DB; also returns reminder-due IDs |
| `POST /api/classify-all` | Pull the whole inbox and classify (`uploadToDB`) |
| `POST /api/classify-email` | Classify a single conversation by ID |
| `POST /api/group-selected` | Compute intents for read emails (`getReadEmailsWithIntents`) |
| `POST /api/execute-plan` | **Dry run** : preview the actions that would be taken without actually committing anything |
| `POST /api/execute` | **Execute** the planned actions for real |
| `POST /api/send-mail` | Send a one-off email |

All data routes are gated by `requireAuth` (401 unless `authenticated`).

### `graphHelper.js` - Microsoft Graph (email I/O)
**Auth**
- `initializeGraphForUserAuth(settings, deviceCodePrompt)` - sets up `DeviceCodeCredential` with a persisted token cache (`auth-record.json` in Electron userData).
- `getUserTokenAsync()`, `getUserAsync()`, `getSignedInAddress()`.

**Reading**
- `getInboxAsync()` - top messages from the inbox folder.
- `getConversationMessagesAsync(conversationId)` - all messages in a thread (immutable IDs).
- `getConversationMessageIdsAsync(conversationId)` - just the message IDs.
- `getUniqueMessages()` - dedupes the inbox to one object **per thread**: sorts messages by time, joins the full thread body, computes `all_parties`, `last_response_date`, and reply info. This shape is what feeds the DB.
- `uploadToDB()` - `getUniqueMessages()` → `insertIntoDB()`.

**Parsing helpers**
- `extractBodyTextWithCheerio(html)` - strips `<style>/<script>`, signatures, quoted forward blocks, `<hr>`; returns clean text.
- `extractReplyInfo(msg)` - pulls `In-Reply-To` / `References` headers.

**Actions**
- `sendMailAsync(subject, body, recipient)`
- `forwardThreadAsync(messageId, recipients, comment)`
- `replyAllToThreadAsync(messageId, comment)`
- `replyToThreadAsync(messageId, comment, toRecipients)`
- `archiveThreadAsync(conversationId)` - moves every message in the thread to Archive.

### `dbManager.js` - Core logic
**Claude classification**
- `PROMPT(...)` - builds the large classification prompt (subjects, conditions, property code/lot extraction, synopsis, summary, completion detection, reminder type, scheduled deadline, forwarding-needed flag). Output is a strict JSON object (see `EXAMPLE`).
- `LLM_classification(prompt)` - calls Claude Haiku.
- `classify_email(email)` - parses the JSON, then fills region conditions via `check_region_by_code()`. **Unclassifiable override:** if the whole parsed chain is shorter than `UNCLASSIFIABLE_CONFIG.maxChars` (default 50) *and* no property/lot was found (image-only / contentless forwards), it relabels `subject.main`/`subject.sub` to the sentinel `"Unclassifiable email"` and sets `reminderType = "Unclassifiable"`. That sentinel is intentionally **not** in `SUBJECT_BUCKETS`, so `classification_to_email` returns `[]` (no routing) and it flows to the dedicated "ask the sender for context" path instead of a random bucket.
- `classify_email_by_ID(id)` - fetch thread by ID then classify.
- `threadLooksResolved(threadText)` - a secondary yes/no Claude check used before sending a reminder or escalating, so resolved threads get closed instead.

**Routing**
- `check_region_by_code(codes)` - maps property codes → `{East, West, North}` using `propertyToRegion.json`.
- `classification_to_email(LLM_output)` - matches subject (main/sub index) + conditions against `ROUTING_CONFIG` rules → list of `[name, email]` recipients.
- `conditionsMatch(ruleConditions, context)` - every rule condition must equal the classified context.

**Persistence (`insertIntoDB(emails)`)** - the main write path, run in a transaction:
1. `email_needs_classification()` - skip threads already in the DB with an unchanged `updated` timestamp.
2. Classify each new/changed thread and resolve recipients.
3. `find_similar_synopsis()` - trigram-similarity search for an existing thread with the same subject + property/lot ⇒ mark as **duplicate** (`duplicate_of`). Skipped while a thread is still unclassifiable (two contentless forwards would false-match on placeholder subject/property).
4. Upsert into `email`; upsert property pairs into `email_property` (`upsertPropertyPairs` / `parsePropertyPairs`); insert `recipients` rows with reminder scheduling fields. For an **unclassifiable** thread there are no routed recipients, so a single `recipients` row is anchored on the **sender** to drive its reminder cadence; when a thread reclassifies out of unclassifiable, that stale sender-anchor row is deleted.
5. Track `last_response_date`.

**`forwarded` is sticky (monotonic false→true only).** Both `email` upserts write `forwarded = email.forwarded OR EXCLUDED.forwarded` instead of unconditionally overwriting it. Reasoning: `forwarded` means "we already sent the one-time routing email", which is an execution-state flag, not a classification-derived one. Forwarding a thread doesn't archive it in Outlook, so it stays re-discoverable by "Fetch inbox"; a later reclassification recomputes a *fresh* `forwarded` value from that pass's Graph data (defaulting to `false`, only flipping `true` again if that particular pass happens to satisfy "forwarding not needed" or "everyone's already on the thread"). Without the `OR`, a thread could silently un-forward and resurface the `forward` intent with no meaningful update having occurred. (`recipients` rows don't have this problem - they're inserted `ON CONFLICT DO NOTHING`, so reminder state is never overwritten by reclassification.)

Supporting helpers: `party_included_DB/list`, `email_within_domain`, `email_needs_reminder`.

**Reminders**
- `REMINDER_CONFIG` modes: `repeat`, `repeat_or_anchor`, `deadline_schedule`, `single_anchor`. Per-type optional fields: `completeByDate` (a passed `target_date` escalates) and `escalateAfterReminders` (escalation cap, default 9). The `Unclassifiable` type is a `repeat` cadence with `escalateAfterReminders: 3`.
- `getReminderDateForRecipient()` / `nextReminderDate()` - compute the next reminder date from anchors, intervals, and deadline offsets.
- `scheduleNewReminders()` - for recipients with no reminder yet, propose a first reminder date.
- `checkReminders()` - for reminders now past due, either escalate to supervisor or schedule the next reminder. Escalation fires when the hard deadline has passed **and at least one reminder has already been sent** (grace period), or when `reminder_count >= escalateAfterReminders` (per-type; default 9).
- `determineReminderAction()` - classifies a recipient row into `none | reminder_due | supervisor` (currently unused; kept in sync with `checkReminders`).

**Intent engine**
- `getReadEmailsWithIntents()` - pulls read/duplicate, non-archived emails and assigns each thread one intent:
  - `forward` - not yet forwarded, has intended recipients
  - `duplicate` - matched an existing thread
  - `complete` - thread reached resolution
  - `needs_info` - routed, but Claude couldn't pin down property/lot; also asks the sender to identify it
  - `unclassifiable` - image-only / contentless forward; reply to the **sender** asking for subject/property/lot, then let the sender-anchored reminder cadence nudge and (after `escalateAfterReminders` nudges) escalate. Suppresses `forward`/`needs_info` for that thread.
  - `reminder_scheduled` - first reminder to set
  - `reminder` - reminder due, send a nudge (for unclassifiable threads the nudge re-asks the sender for context rather than the generic reminder message)
  - `supervisor` - escalate (deadline blown after ≥1 reminder, or too many reminders)

  Intents are a **list** per thread, so e.g. `forward` + `reminder_scheduled` can co-occur.
- `executeIntents(conversationIds, { dryRun })` - the orchestrator. For each selected thread it builds a list of `actions`; with `dryRun: true` they're labeled `planned` (preview only, no Graph/DB calls fire), with `dryRun: false` they're actually performed via `graphHelper` + DB updates. Returns `{ dryRun, results: [{ conversationId, subject, synopsis, intent, actions, status }] }`.
  - Two separate reply-all exclusion lists: **`forwardExclude`** (external/non-internal original sender + explicit `remove_from_thread` requests) applies **only** to the initial routing/forward reply-all, so the internal hand-off doesn't loop the third party in. **`replyExclude`** (explicit removals only) applies to every *later* reply - reminder nudge, complete, duplicate-close - deliberately keeping the external sender on the thread so they stay informed on updates to a thread they're already part of.

  Elsewhere in the intent-execution flow: the deadline-passed → supervisor escalation path (and the reminder-due path) first gates on `threadLooksResolved()`. resolved threads get closed instead of escalated/nudged.

### `appsettings.js` / `config/config.js` - Configuration
Loads `.env` and re-exports the tunable config:
- `SUBJECT_BUCKETS` - top-level subjects → subcategories.
- `CONDITION_BUCKETS` - boolean conditions the LLM evaluates.
- `ROUTING_CONFIG` - people, their emails, and match rules (`{ main, subject[], conditions }`).
- `REMINDER_CONFIG` - reminder cadence per reminder type (incl. `completeByDate`, `escalateAfterReminders`).
- `NEEDS_INFO_CONFIG` - when to ask the sender to identify property/lot, and the message to send.
- `UNCLASSIFIABLE_CONFIG` - image-only / contentless-forward handling: `enabled`, `maxChars` (parsed-chain length threshold, default 50), `reminderType`, and the "context not found" `message`. Defaults live in `config/RouterConfig.js`; override in `config/config.js` if needed.
- `REMOVE_SENDER_ON_ESCALATION` - whether to drop the original sender when escalating.

### `public/` - Front-end UI (Electron renderer)

Static HTML/CSS/vanilla JS (no framework, no build step) served by Express and loaded into the Electron `BrowserWindow`. Three files: `index.html` (structure), `app.js` (all behavior), `style.css` (all styling, keyed off CSS custom properties on `:root`).

**Layout**
- **Sign-in view** - device-code flow (unchanged from the original build).
- **Dashboard view** - a centered `.shell` containing, top to bottom:
  - **Ribbon** - Outlook-style command bar grouped into *Fetch inbox* / *Process* / *Execute* / *Tools*, plus a live status slot for "Running.../Completed" text. Every control (buttons, the thread-count `<select>`) shares one `--ribbon-control-h` height so nothing visually mis-aligns.
  - **Search/filter bar** - keyword (subject/synopsis/topic), involved party (sender/all_parties/intended_recipients/intent targets), intent dropdown, a "Group by" dropdown (only shown once the intents view is active), and a due-date range (matched against date-valued intent targets, i.e. `reminder`/`reminder_scheduled`). All route through one predicate, `rowMatchesSearch(m, entryList)`, called identically by all three list renderers; a live "`n / m` match" summary reflects the active filter.
  - **Workspace** - a `#pager-slot` (its own element, positioned *above* the table rather than nested inside it, so paging controls never scroll away with a horizontally-scrolling table) followed by `#workspace-split`: a `.list-pane` (the inbox/classified/intents table) and a `.reading-pane` (hidden/zero-width by default). Clicking a row toggles a `.pane-open` class that eases the list-pane down to ~46% and the reading-pane up to ~54%, and simultaneously widens the whole `.shell` (via `.pane-open-shell`) so the split isn't just squeezing into the same 1600px cap.
  - **Modals** - `#inspect-overlay` and `#execute-overlay`, both built on one generic `createModal(overlayId, opts)` controller (animated open/close matching a `.closing` CSS class, backdrop-click-to-close). A shared `Escape` handler closes whichever is topmost (execute modal → inspect modal → reading pane).
  - **Toast stack** - `#toast-stack`, fixed bottom-center, `z-index:2000`. Errors no longer render inline; `renderError()` clears the panel and calls `showErrorToast(message)`, which auto-dismisses after 15s (or sooner via its own close button) and stacks if more than one fires.

**`app.js` - key mechanisms**
- `runJob(job, btn)` - dispatches every ribbon/modal button click to the matching API call and renderer. `submit-selected` opens the execute modal and fetches `/api/execute-plan` (dry run) into it.
- Three list renderers - `renderInbox`, `renderClassifiedList`, `renderIntentsList` - each: filters via `rowMatchesSearch`, paginates (`PAGE_SIZE = 12`), rebuilds `currentRowIndex` (a `convId → toPaneRecord(...)` map normalizing each view's differently-shaped row data for the reading pane), then calls `syncReadingPane()` and `updateRowHighlight()`. `renderIntentsList` additionally reorders columns to checkbox → ID → **Intent** (moved next to ID, per-thread chips) → Subject → From → Updated → Topic → Synopsis → Target, and pins the checkbox + ID columns (`position: sticky; left:`) so they stay visible as their own "island" while the rest of a row scrolls underneath.
- **Reading pane** - click a row (not its checkbox/copy-id/any button) to preview the full thread as message bubbles. `parseThreadBody(body)` splits on the `[date - sender]:\ntext` / `\n\n---\n\n` format `graphHelper.getUniqueMessages()` produces; `cleanExtractedText()` collapses the un-collapsed whitespace cheerio's `$.text()` leaves behind (a browser normally does this, cheerio doesn't); `splitSignature()` heuristically finds a sign-off line ("Thanks,", "Sent from my iPhone", ...) and styles everything from there on as a dimmer, smaller signature block, separate from the main message text. Bubbles from the signed-in mailbox address render right-aligned/accent-colored; everyone else renders left-aligned/neutral.
- **Selection model - two independent concepts, both must stay in sync but never conflate:**
  - `intentSelected` (a `Set<convId>`) - checkbox-driven, persists across pages/re-renders/re-sorts, is what `getSelectedConvIds()` hands to Submit & Save.
  - `selectedConvId` (single value) - which thread the reading pane has open.
  - `toggleIntentSelection(convId, checked)` is the one function that mutates `intentSelected`; it's called from the table checkbox, the reading-pane's own "Selected for Submit & Save" toggle (shown only when that thread has an intent), and select-all, so ticking any one of them keeps the others (and row highlighting) in sync.
  - Row highlighting: `.row-checked` (light tint, driven by `intentSelected`, any number of rows) vs `.row-selected` (darker + left accent bar, driven by `selectedConvId`, at most one row)
- **Submit & Save → execute modal** - `renderExecutionReport()` renders the dry-run preview into the modal using semantic classes (`.exec-block`, `.exec-badge`, ...) rather than inline styles. Its "Confirm & Execute" button calls `/api/execute` for real, re-renders the same modal with the final done/error statuses, then calls `removeExecutedThreadsFromView(confirmIds)` - which prunes those conversation IDs out of the **currently displayed** intents table (via the `lastIntentsItems` reference `renderIntentsList` keeps up to date), clears them from `intentSelected`, and closes the reading pane if it had one of them open. This is a client-side view update only (no extra fetch); it exists so an already-executed action can't be immediately resubmitted before the next "Check intents" pull refreshes server-truth.

## End-to-end flow

```
User signs in (device code)
        │
        ▼
GET /api/inbox ──► graphHelper.getUniqueMessages()
        │            (one object per thread: full body, parties, dates)
        ▼
POST /api/classify-* ──► dbManager.insertIntoDB()
        │                   ├─ email_needs_classification()  (skip unchanged)
        │                   ├─ classify_email()  ──► Claude Haiku → JSON
        │                   ├─ classification_to_email()  (routing rules → recipients)
        │                   ├─ find_similar_synopsis()  (duplicate detection)
        │                   └─ write email / email_property / recipients
        ▼
POST /api/group-selected ──► getReadEmailsWithIntents()
        │                       (assign forward/duplicate/complete/reminder/supervisor)
        ▼
POST /api/execute-plan ──► executeIntents(ids, { dryRun: true })   ← preview
        ▼
POST /api/execute ──────► executeIntents(ids, { dryRun: false })   ← perform
                            (forward / reply / reminder / escalate / archive
                             via graphHelper + DB status updates)
```

## Database schema (inferred from queries)

- **`email`** - one row per thread. Key columns: `conversation_id` (PK), `id` (latest Graph message id), `status` (`read | complete`), `created`, `updated`, `forwarded`, `archived`, `sender`, `subject`, `body`, `in_reply_to`, `synopsis`, `subject_main`, `subject_sub`, `duplicate_of`.
- **`email_property`** - thread ↔ property mapping: `conversation_id`, `property_code`, `lot`.
- **`recipients`** - intended recipients + reminder state: `conversation_id`, `intended_recipient`, `reminder_date`, `reminder_count`, `reminder_type`, `target_date`, `assigned_date`, `interval_index`, `last_response_date`. Unique on `(conversation_id, intended_recipient)`.

Requires the `pg_trgm` extension (used via `similarity()`).

## Environment variables

| Var | Purpose |
| --- | --- |
| `EML_CLIENT_ID`, `EML_TENANT_ID`, `EML_CLIENT_SECRET` | Azure app registration for Graph |
| `userEmail` | Signed-in mailbox address |
| `DB_USER`, `DB_PW`, `DB_PORT`, `DB_HOST`, `DB_NAME` | PostgreSQL connection |
| `INTERNAL_DOMAIN` | Domain treated as "internal" (affects reply targets / forwarding) |
| `ANTHROPIC_API_KEY` | Read by the Anthropic SDK for Claude calls |

## Key assumptions & notes for future work

- The mailbox owner is assumed to be **forwarded** email chains rather than an original participant (see comment in `graphHelper.js`).
- Graph does not allow `filter` + `orderby` together, so thread messages are sorted in JS.
- Reminders escalate to supervisors after `escalateAfterReminders` unanswered reminders (default **9**; `Unclassifiable` uses **3**), or once a hard deadline (`completeByDate`) passes **and at least one reminder has already been sent** (a one-nudge grace period before deadline escalation).
- Body extraction uses `uniqueBody`, falling back to the full `body` when `uniqueBody` is empty (e.g. a plain forward with no added comment, where the forwarded chain is all "quoted history").
- Image-only / contentless forwards (parsed chain `< UNCLASSIFIABLE_CONFIG.maxChars` with no property/lot) become the `"Unclassifiable email"` subject and the `unclassifiable` intent: the sender is asked for context, nudged on the `Unclassifiable` reminder cadence, and escalated if they never reply.
- Duplicate detection uses trigram similarity on `synopsis` (> 0.3) scoped to the same subject + property/lot.
- Classification currently assumes Claude returns valid JSON (parsed after stripping ```` ```json ```` fences).
- `email.forwarded` is sticky (see `insertIntoDB` above). Once a thread has actually been forwarded, no later reclassification can flip it back to unforwarded. It's a single boolean, not per-recipient, so if a later pass identifies *different* routing recipients for the same thread, they won't get a fresh forward - a known limitation, not a bug.
- Reply-all exclusion is asymmetric by design: the external original sender is dropped only from the initial forward/routing reply-all, and kept on every later reply (reminders, completion, duplicate-close) so they stay in the loop on a thread they're already part of.
