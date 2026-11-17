const signinView = document.getElementById('signin-view');
const dashboardView = document.getElementById('dashboard-view');

const startBtn = document.getElementById('start-btn');
const codePanel = document.getElementById('code-panel');
const userCodeEl = document.getElementById('user-code');
const verifyLink = document.getElementById('verify-link');
const statusText = document.getElementById('status-text');
const copyBtn = document.getElementById('copy-btn');
const errorLine = document.getElementById('error-line');
const signedInName = document.getElementById('signed-in-name');

let pollHandle = null;
let messages = []; // list of UNIQUE message objects
let classified = [];
let intents = [];


const searchState = { keyword: '', party: '', intent: '', dueFrom: '', dueTo: '' };
// each render sets this so the search bar can re-render the active view from page 0
let rerenderCurrent = () => {};

let selectedConvId = null;
// convId -> normalized {convId, subject, sender, updated, synopsis, topic, recipients, body},
// rebuilt by every render*() from whatever's currently visible (post-search-filter) in that view.
let currentRowIndex = new Map();
// signed-in mailbox address, used only to decide which side a bubble renders on
let signedInEmail = null;


let modifyIntentState = null;
// [{ name, email }, ...] from ROUTING_CONFIG, fetched once and cached for the forward-target dropdown
let routingConfigCache = null;

function isDateLike(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !isNaN(Date.parse(v));
}

// true if a row passes the active filters. entryList = that row's intent objects (when on the
// intents view), used to search intent targets (parties) and reminder/due dates.
function rowMatchesSearch(m, entryList = []) {
  const kw = searchState.keyword.trim().toLowerCase();
  if (kw) {
    const hay = [m.subject, m.synopsis, m.subject_main, m.subject_sub]
      .filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(kw)) return false;
  }

  const pq = searchState.party.trim().toLowerCase();
  if (pq) {
    const parties = [m.sender, ...(m.all_parties || []), ...(m.intended_recipients || [])];
    for (const e of entryList) {
      const t = e.interestedParty;
      if (typeof t === 'string') parties.push(t);
      else if (Array.isArray(t)) parties.push(...t);
    }
    if (!parties.filter(Boolean).join(' ').toLowerCase().includes(pq)) return false;
  }

  // intent filter: "__none__" matches threads with no intent ("do nothing"), otherwise the
  // thread must carry the selected intent among its (possibly several) intents
  if (searchState.intent) {
    if (searchState.intent === '__none__') {
      if (entryList.length) return false;
    } else if (!entryList.some((e) => e.intent === searchState.intent)) {
      return false;
    }
  }

  if (searchState.dueFrom || searchState.dueTo) {
    // "due dates" are the date-valued intent targets (reminder / reminder_scheduled). Rows with
    // no such date (e.g. plain inbox listing) never match a due-date filter.
    const dates = entryList.map(e => e.interestedParty).filter(isDateLike).map(v => new Date(v));
    if (!dates.length) return false;
    const from = searchState.dueFrom ? new Date(searchState.dueFrom + 'T00:00:00') : null;
    const to = searchState.dueTo ? new Date(searchState.dueTo + 'T23:59:59') : null;
    if (!dates.some(d => (!from || d >= from) && (!to || d <= to))) return false;
  }
  return true;
}

function searchActive() {
  return !!(searchState.keyword || searchState.party || searchState.intent
    || searchState.dueFrom || searchState.dueTo);
}

function updateSearchSummary(shown, total, unit) {
  const el = document.getElementById('search-summary');
  if (!el) return;
  el.textContent = searchActive() ? `${shown} / ${total} ${unit} match` : '';
}

// "Group by" only makes sense once "Check intents" has run (it re-sorts the intents table), so
// it's hidden for the inbox/classified views and only shown while renderIntentsList is active.
function setGroupByVisible(show) {
  document.getElementById('group-by-wrap')?.classList.toggle('hidden', !show);
}

// Auth 

async function checkStatusOnLoad() {
  const state = await fetchJSON('/api/auth/status');
  if (state.status === 'authenticated') {
    showDashboard(state);
  } else if (state.status === 'awaitingCode') {
    startBtn.classList.add('hidden');
    codePanel.classList.remove('hidden');
    applyDeviceCodeState(state);
    startPolling();
  }
}



// th is part is for the sign in
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.textContent = 'Requesting code…';
  errorLine.classList.add('hidden');

  try {
    await fetchJSON('/api/auth/start', { method: 'POST' });
    startBtn.classList.add('hidden');
    codePanel.classList.remove('hidden');
    startPolling();
  } catch (err) {
    showAuthError(err.message);
    startBtn.disabled = false;
    startBtn.textContent = 'Start sign-in';
  }
});



copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(userCodeEl.textContent.trim());
  copyBtn.textContent = 'Copied';
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
});

function startPolling() {
  if (pollHandle) return;
  pollHandle = setInterval(async () => {
    const state = await fetchJSON('/api/auth/status');
    applyDeviceCodeState(state);

    if (state.status === 'authenticated') {
      clearInterval(pollHandle);
      pollHandle = null;
      showDashboard(state);
    } else if (state.status === 'error') {
      clearInterval(pollHandle);
      pollHandle = null;
      showAuthError(state.error);
    }
  }, 2000);
}

function applyDeviceCodeState(state) {
  if (state.deviceCode) {
    userCodeEl.textContent = state.deviceCode.userCode ?? '------';
    verifyLink.href = state.deviceCode.verificationUri ?? '#';
  }
  if (state.status === 'awaitingCode') {
    statusText.textContent = 'waiting for confirmation…';
  }
}

function showAuthError(message) {
  errorLine.textContent = message || 'Something went wrong during sign-in.';
  errorLine.classList.remove('hidden');
  statusText.textContent = 'failed';
}

function showDashboard(state) {
  signinView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  const name = state.user?.displayName || state.user?.mail || 'signed in';
  signedInName.textContent = name;
  // used only to decide which side a reading-pane bubble renders on ("mine" vs "theirs")
  signedInEmail = (state.user?.mail || '').toLowerCase() || null;
}








// all jobs
document.querySelectorAll('.run-btn').forEach((btn) => {
  btn.addEventListener('click', () => runJob(btn.dataset.job, btn));
});

// thread-count control: reveal the custom number box only when "Custom…" is picked
const fetchCountSel = document.getElementById('fetch-count');
const fetchCountCustom = document.getElementById('fetch-count-custom');
fetchCountSel?.addEventListener('change', () => {
  fetchCountCustom.classList.toggle('hidden', fetchCountSel.value !== 'custom');
  if (fetchCountSel.value === 'custom') fetchCountCustom.focus();
});

// resolves the currently chosen thread count (1..500), defaulting to 10
function getFetchCount() {
  if (!fetchCountSel) return 10;
  if (fetchCountSel.value === 'custom') {
    const n = parseInt(fetchCountCustom.value, 10);
    return Number.isFinite(n) ? Math.min(500, Math.max(1, n)) : 10;
  }
  return parseInt(fetchCountSel.value, 10) || 10;
}

// short, human-scannable tail of a conversation id, e.g. "...RsN0A"
function shortId(id) {
  if (!id) return '-';
  return '...' + String(id).replace(/=+$/, '').slice(-5);
}

// a table cell showing the short id plus a button that copies the FULL id to the clipboard
// (so it can be pasted into the Inspect box)
function idCell(id) {
  return `<td class="id-cell">
    <code class="short-id" title="${escapeHTML(id || '')}">${escapeHTML(shortId(id))}</code>
    <button class="copy-id" data-id="${escapeHTML(id || '')}" title="Copy full conversation ID" type="button">copy</button>
  </td>`;
}

// one delegated listener handles every copy button, current and future
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-id');
  if (!btn) return;
  navigator.clipboard.writeText(btn.dataset.id || '');
  const prev = btn.textContent;
  btn.textContent = 'copied';
  setTimeout(() => { btn.textContent = prev; }, 1000);
});

// shared pagination: ~5 rows per page across inbox / classification / intents tables
const PAGE_SIZE = 12;

function pagerMarkup(page, pageCount, total, unit) {
  return `<div class="pager">
    <button class="pager-btn" data-page="prev" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
    <span class="pager-info">Page ${page + 1} / ${pageCount} · ${total} ${unit}</span>
    <button class="pager-btn" data-page="next" ${page >= pageCount - 1 ? 'disabled' : ''}>Next ›</button>
  </div>`;
}

function wirePager(out, page, pageCount, goTo) {
  out.querySelector('[data-page="prev"]')?.addEventListener('click', () => goTo(Math.max(0, page - 1)));
  out.querySelector('[data-page="next"]')?.addEventListener('click', () => goTo(Math.min(pageCount - 1, page + 1)));
}

// The pager lives in its own #pager-slot ABOVE the table (not nested inside .output, which now
// scrolls horizontally on its own) so Prev/Next stay visible and easy to notice regardless of
// how the table itself scrolls. All three views share this one slot since only one view is ever
// rendered at a time.
function renderPager(page, pageCount, total, goTo) {
  const slot = document.getElementById('pager-slot');
  if (!slot) return;
  slot.innerHTML = pagerMarkup(page, pageCount, total, 'threads');
  wirePager(slot, page, pageCount, goTo);
}
function clearPager() {
  const slot = document.getElementById('pager-slot');
  if (slot) slot.innerHTML = '';
}



async function runJob(job, btn) {
  if (job === 'submit-selected') {
    const out = outputEl('submit-selected');
    const ids = getSelectedConvIds();
    if (!ids.length) {
      renderError(out, 'Tick at least one email in the intents table (run "Check All Intents" first).');
      return;
    }
    executeModal.open();
    setLoading(btn, out, 'Building preview…');
    try {
      const plan = await fetchJSON('/api/execute-plan', {
        method: 'POST',
        body: JSON.stringify({ conversationIds: ids }),
      });
      renderExecutionReport(out, plan, ids);
    } catch (err) {
      renderError(out, err.message);
    } finally {
      resetLoading(btn, 'Submit and Save');
    }
    return;
  }

  if (job === 'inspect') {
    const out = outputEl('inspect');
    const raw = document.getElementById('inspect-ids')?.value ?? '';
    const ids = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) {
      renderError(out, 'Paste at least one conversation ID.');
      return;
    }
    if (ids.length > 4) {
      renderError(out, 'Inspect supports at most 4 conversations at a time.');
      return;
    }
    setLoading(btn, out, 'Inspecting…');
    try {
      const info = await fetchJSON('/api/inspect', {
        method: 'POST',
        body: JSON.stringify({ conversationIds: ids }),
      });
      renderInspect(out, info);
    } catch (err) {
      renderError(out, err.message);
    } finally {
      resetLoading(btn, 'Inspect');
    }
    return;
  }

  let out = outputEl(job);
  setLoading(btn, out, 'Running...');
  let succeeded = false;

  try {
    if (job === 'inbox') {
      const count = getFetchCount();
      const msgs = await fetchJSON(`/api/inbox?count=${count}`); // UNIQUE threads
      messages = msgs; // assigns to the temp variable
      renderInbox(out, messages);
    }
    else if (job === 'classify-selected') {
      const result = await fetchJSON('/api/classify-selected', {
        method: 'POST',
        body: JSON.stringify({ messages }),
      });
      classified = result.result;
      console.log(classified)

      out = outputEl('inbox'); // want to bundle all stuff into 1 UI for consistency

      renderClassifiedList(out, {messages, classified});
      flashOutput(out);
      showToast('Classification completed.', { type: 'success' });
      succeeded = true;
    }
    else if (job === 'group-selected') {
      const result = await fetchJSON('/api/group-selected', { method: 'POST' });
      intents = result.intents;
      out = outputEl('inbox')
      // fresh load: default to all actionable threads selected, start on the first page
      intentSelected = new Set(Object.keys(intents));
      intentPage = 0;
      renderIntentsList(out, { messages: result.messages, intents }, 0);
      flashOutput(out);
      showToast('Check intents completed.', { type: 'success' });
      succeeded = true;
    }


    else if (job === 'classify-all') {
      const result = await fetchJSON('/api/classify-all', { method: 'POST' });
      renderOk(out, `Done. Checked ${result.count} email(s).`);
    }
  } catch (err) {
    renderError(out, err.message);
  } finally {
    if (succeeded) {
      markCompleted(btn);
    } else {
      resetLoading(btn, job === 'inbox' ? 'Run' : 'Run batch job');
    }
  }
}

// Render helpers

function statusEl(job) {
  return document.querySelector(`[type="${job}"]`)
}

function outputEl(job) {
  return document.querySelector(`[data-output="${job}"]`);
}

function setLoading(btn, out, label) {
  // button-only feedback: disables + relabels the clicked button so the user can tell their
  // click registered, without touching `out` (which used to get its content replaced with a
  // bare "Running..." line
  if (btn) {
    // starting a fresh run cancels any pending "revert on hover" from a previous completion,
    // and must not capture the checkmark glyph itself as the button's "original" label
    if (btn._completedRevert) { btn.removeEventListener('mouseenter', btn._completedRevert); btn._completedRevert = null; }
    if (!btn.classList.contains('btn-completed')) { btn.dataset.originalText = btn.textContent; }
    btn.classList.remove('btn-completed');
    btn.disabled = true;
    btn.textContent = label;
  }
}

function resetLoading(btn, fallbackLabel) {
  if (btn) { btn.disabled = false; btn.textContent = btn.dataset.originalText || fallbackLabel; }
}

// Swaps a finished action button to a checkmark instead of straight back to its normal label,
// so completion is visible even after the "Running..." state disappears. Re-hovering it peeks
// back at the real label as a one-shot reveal (the button stays clickable throughout).
function markCompleted(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.classList.add('btn-completed');
  btn.textContent = '✓';
  const revert = () => {
    btn.classList.remove('btn-completed');
    btn.textContent = btn.dataset.originalText;
    btn._completedRevert = null;
  };
  btn._completedRevert = revert;
  btn.addEventListener('mouseenter', revert, { once: true });
}

// Briefly pulses an output panel's border to draw the eye to freshly-rendered content.
function flashOutput(out) {
  if (!out) return;
  out.classList.remove('flash-new');
  void out.offsetWidth; // force reflow so re-adding the class retriggers the animation
  out.classList.add('flash-new');
  out.addEventListener('animationend', () => out.classList.remove('flash-new'), { once: true });
}

function renderOk(out, message) {
  out.classList.remove('err');
  out.innerHTML = `<span class="ok-line">${escapeHTML(message)}</span>`;
}

// Toasts surface at the bottom of the screen (auto-dismiss after `ms`, or sooner if the user
// closes them) rather than inline in the output panel, so a message doesn't leave a stray
// block sitting in the middle of the UI. `type` is 'error' (default) or 'success'.
function showToast(message, { type = 'error', ms = 15000 } = {}) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-message"></span>
    <button class="toast-close" type="button" aria-label="Dismiss">&times;</button>
  `;
  toast.querySelector('.toast-message').textContent = message || 'Something went wrong.';
  stack.appendChild(toast);

  const dismiss = () => {
    if (!toast.isConnected) return;
    toast.classList.add('toast-leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };

  const timer = setTimeout(dismiss, ms);
  toast.querySelector('.toast-close').addEventListener('click', () => {
    clearTimeout(timer);
    dismiss();
  });
}

function showErrorToast(message, ms = 15000) {
  showToast(message, { type: 'error', ms });
}

// clears whatever the output panel was showing (e.g. a stale "Running…" line) and reports the
// failure as a toast instead of writing it into the panel itself
function renderError(out, message) {
  out.classList.remove('err');
  out.innerHTML = '';
  showErrorToast(message);
}



function parseThreadBody(body) {
  if (!body || !body.trim()) return [];
  return body.split(/\n\n---\n\n/).map((chunk) => {
    const m = /^\[(.+?) - (.+?)\]:\n([\s\S]*)$/.exec(chunk.trim());
    if (!m) return { date: null, sender: null, text: cleanExtractedText(chunk) };
    return { date: m[1], sender: m[2], text: cleanExtractedText(m[3]) };
  }).filter((seg) => seg.text);
}

function cleanExtractedText(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


function toPaneRecord({ convId, subject, sender, updated, synopsis, topic, recipients, body, intentList, isIntentsView }) {
  return {
    convId, subject, sender, updated, synopsis: synopsis || null, topic: topic || null,
    recipients: recipients || null, body, intentList: intentList || [], isIntentsView: !!isIntentsView,
  };
}

// Heuristically splits a message's real content from a trailing signature/sign-off block, so the
// two can be styled distinctly (bigger/clearer text vs. smaller/muted signature). Looks for the
// first line that reads like a sign-off ("Thanks,", "Best regards", "Sent from my iPhone", ...)
// and treats everything from there on as signature. If no such line exists (or it's the very
// first line, meaning there's no real message body to separate it from), the whole text is
// treated as the main message -- no split.
function splitSignature(text) {
  const lines = text.split('\n');
  const marker = /^(thanks|thank you|thank u|best regards|kind regards|warm regards|regards|sincerely|respectfully|best|cheers)[,.]?\s*$|^sent from my (i?phone|i?pad|android|mobile|samsung)/i;
  const idx = lines.findIndex((l) => marker.test(l.trim()));
  if (idx <= 0) return { main: text, signature: '' };
  return { main: lines.slice(0, idx).join('\n').trim(), signature: lines.slice(idx).join('\n').trim() };
}

function renderReadingPaneContent(record) {
  const pane = document.getElementById('reading-pane');
  if (!pane) return;

  const bubbles = parseThreadBody(record.body).map((seg) => {
    const mine = !!(signedInEmail && seg.sender && seg.sender.toLowerCase() === signedInEmail);
    const meta = [seg.sender || 'Unknown sender', seg.date ? new Date(seg.date).toLocaleString() : null]
      .filter(Boolean).map(escapeHTML).join(' · ');
    const { main, signature } = splitSignature(seg.text);
    const signatureHtml = signature ? `<div class="msg-bubble-signature">${escapeHTML(signature)}</div>` : '';
    return `
      <div class="msg-bubble ${mine ? 'msg-out' : 'msg-in'}">
        <div class="msg-bubble-meta">${meta}</div>
        <div class="msg-bubble-text">${escapeHTML(main)}</div>${signatureHtml}
      </div>`;
  }).join('') || '<p class="reading-pane-empty">No message content available.</p>';

  const topicLine = record.topic ? `<div class="reading-pane-row"><strong>Topic:</strong> ${escapeHTML(record.topic)}</div>` : '';
  const synopsisLine = record.synopsis ? `<div class="reading-pane-row"><strong>Synopsis:</strong> ${escapeHTML(record.synopsis)}</div>` : '';
  const recipientsLine = (record.recipients && record.recipients.length)
    ? `<div class="reading-pane-row"><strong>Routed to:</strong> ${record.recipients.map(escapeHTML).join(', ')}</div>` : '';

  // Lets the currently-open thread be queued for Submit & Save without hunting for its row in the
  // (possibly scrolled-away) table -- only shown when the thread actually has an intent, mirroring
  // the table's own rule that only actionable rows get a checkbox.
  const selectToggle = record.intentList.length
    ? `<label class="reading-pane-select-toggle">
         <input type="checkbox" id="reading-pane-select" class="intent-select" data-convid="${escapeHTML(record.convId)}" ${intentSelected.has(record.convId) ? 'checked' : ''} />
         Selected for Submit &amp; Save
       </label>`
    : '';

  // only meaningful on the intents view -- forward/complete/duplicate/reminder intents are
  // computed there, so editing them elsewhere (inbox/classified) wouldn't have anything to show
  const modifyIntentBtn = record.isIntentsView
    ? `<button type="button" id="modify-intent-btn" class="btn btn-secondary btn-small reading-pane-modify-btn">Modify Intent</button>`
    : '';

  // rebuilding the whole subtree (rather than patching in place) is what makes pane-slide-in
  // replay on every selection change, including switching directly between two threads
  pane.innerHTML = `
    <div class="reading-pane-inner">
      <div class="reading-pane-head">
        <div class="reading-pane-head-text">
          <div class="reading-pane-subject">${escapeHTML(record.subject || '(no subject)')}</div>
          <div class="reading-pane-meta">${escapeHTML(record.sender || '-')} · ${record.updated ? new Date(record.updated).toLocaleString() : '-'}</div>
          ${topicLine}${synopsisLine}${recipientsLine}
          ${selectToggle}
          ${modifyIntentBtn}
        </div>
        <button class="reading-pane-close" type="button" aria-label="Close preview">&times;</button>
      </div>
      <div class="reading-pane-thread">${bubbles}</div>
    </div>`;

  pane.querySelector('.reading-pane-close')?.addEventListener('click', closeReadingPane);
  pane.querySelector('#reading-pane-select')?.addEventListener('change', (e) => {
    toggleIntentSelection(record.convId, e.target.checked);
  });
  pane.querySelector('#modify-intent-btn')?.addEventListener('click', () => openModifyIntent(record));
}

// --- Modify Intent popup ---
//
// Lets the user manually add/edit/delete a thread's computed intents. Four of the eight intent
// types each map to exactly one real DB column/table that getReadEmailsWithIntents() and
// executeIntents() already read (recipients rows for forward, email.flagged_complete for
// complete, email.duplicate_of for duplicate, recipients.reminder_date for reminder /
// reminder_scheduled) -- see dbManager.js's modifyIntent(). supervisor/needs_info/unclassifiable
// are recomputed from multi-factor logic with no single backing flag, so they're shown read-only.

async function ensureRoutingConfig() {
  if (routingConfigCache) return routingConfigCache;
  try {
    routingConfigCache = await fetchJSON('/api/routing-config');
  } catch {
    routingConfigCache = [];
  }
  return routingConfigCache;
}

// datetime-local inputs want "YYYY-MM-DDTHH:mm" in the viewer's local time, no timezone/seconds
function toDatetimeLocalValue(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let modifyIntentRowSeq = 0;
function nextModifyIntentRowId() {
  return `mi-row-${Date.now()}-${modifyIntentRowSeq++}`;
}

// Expands intentList into one editable/read-only row per (intent, individual target) pair --
// e.g. a 'forward' entry with 3 recipients becomes 3 separate rows, matching how the popup is
// meant to display multiple targets for one intent as separate lines.
function buildModifyIntentRows(intentList) {
  const rows = [];
  for (const entry of intentList) {
    if (entry.intent === 'forward') {
      const targets = Array.isArray(entry.interestedParty) ? entry.interestedParty : [entry.interestedParty].filter(Boolean);
      for (const t of targets) {
        rows.push({ id: nextModifyIntentRowId(), kind: 'forward', intentName: 'forward', target: t, editable: true, isNew: false });
      }
    } else if (entry.intent === 'complete') {
      rows.push({ id: nextModifyIntentRowId(), kind: 'complete', intentName: 'complete', target: null, editable: false, isNew: false });
    } else if (entry.intent === 'duplicate') {
      rows.push({ id: nextModifyIntentRowId(), kind: 'duplicate', intentName: 'duplicate', target: entry.interestedParty ?? null, editable: false, isNew: false });
    } else if (entry.intent === 'reminder' || entry.intent === 'reminder_scheduled') {
      rows.push({ id: nextModifyIntentRowId(), kind: 'reminder', intentName: entry.intent, target: entry.interestedParty ?? null, editable: true, isNew: false });
    } else {
      // supervisor / needs_info / unclassifiable -- read-only, no single backing flag to flip
      rows.push({ id: nextModifyIntentRowId(), kind: 'readonly', intentName: entry.intent, target: entry.interestedParty ?? null, editable: false, isNew: false });
    }
  }
  return rows;
}

async function openModifyIntent(record) {
  modifyIntentState = {
    conversationId: record.convId,
    subject: record.subject,
    rows: buildModifyIntentRows(record.intentList),
  };
  modifyIntentState.originalRows = modifyIntentState.rows.map((r) => ({ ...r }));

  renderModifyIntentBody();
  modifyIntentModal.open();

  // the forward-target dropdown needs the routing config; fetch lazily and refresh once loaded
  // (harmless if the user has already closed the popup or moved on by the time this resolves)
  await ensureRoutingConfig();
  if (modifyIntentState?.conversationId === record.convId && modifyIntentModal.isOpen()) {
    renderModifyIntentBody();
  }
}

function renderModifyIntentAddTarget() {
  const wrap = document.getElementById('mi-add-target-wrap');
  const type = document.getElementById('mi-add-type')?.value;
  if (!wrap) return;

  if (type === 'forward') {
    if (routingConfigCache && routingConfigCache.length) {
      const options = routingConfigCache
        .map((p) => `<option value="${escapeHTML(p.email)}">${escapeHTML(p.name)} (${escapeHTML(p.email)})</option>`)
        .join('');
      wrap.innerHTML = `
        <select id="mi-add-forward-select" class="mini-select">
          ${options}
          <option value="__other__">Other…</option>
        </select>
        <input id="mi-add-forward-other" class="mono-input hidden" type="text" placeholder="name@example.com" />
      `;
      wrap.querySelector('#mi-add-forward-select')?.addEventListener('change', (e) => {
        wrap.querySelector('#mi-add-forward-other')?.classList.toggle('hidden', e.target.value !== '__other__');
      });
    } else {
      wrap.innerHTML = `<input id="mi-add-forward-other" class="mono-input" type="text" placeholder="name@example.com" />`;
    }
  } else if (type === 'reminder') {
    wrap.innerHTML = `<input id="mi-add-reminder-date" class="mono-input" type="datetime-local" />`;
  } else {
    wrap.innerHTML = '';
  }
}

function addModifyIntentRow() {
  const type = document.getElementById('mi-add-type')?.value;

  if (type === 'forward') {
    const sel = document.getElementById('mi-add-forward-select');
    const other = document.getElementById('mi-add-forward-other');
    const email = (sel && sel.value !== '__other__' ? sel.value : (other?.value || '')).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showErrorToast('Enter a valid email address to forward to.');
      return;
    }
    if (modifyIntentState.rows.some((r) => r.kind === 'forward' && r.target.toLowerCase() === email.toLowerCase())) {
      showErrorToast('That address is already listed.');
      return;
    }
    modifyIntentState.rows.push({ id: nextModifyIntentRowId(), kind: 'forward', intentName: 'forward', target: email, editable: true, isNew: true });
  } else if (type === 'complete') {
    modifyIntentState.rows.push({ id: nextModifyIntentRowId(), kind: 'complete', intentName: 'complete', target: null, editable: false, isNew: true });
  } else if (type === 'reminder') {
    const val = document.getElementById('mi-add-reminder-date')?.value;
    if (!val) {
      showErrorToast('Pick a reminder date first.');
      return;
    }
    modifyIntentState.rows.push({ id: nextModifyIntentRowId(), kind: 'reminder', intentName: 'reminder_scheduled', target: val, editable: true, isNew: true });
  }

  renderModifyIntentBody();
}

function renderModifyIntentBody() {
  const out = document.querySelector('[data-output="modify-intent"]');
  if (!out || !modifyIntentState) return;
  const { rows, subject } = modifyIntentState;

  const rowMarkup = (row) => {
    let targetCell;
    if (row.kind === 'forward') {
      targetCell = `<input type="text" class="mono-input mi-target-input" data-row-id="${row.id}" value="${escapeHTML(row.target || '')}" placeholder="name@example.com" />`;
    } else if (row.kind === 'reminder') {
      targetCell = `<input type="datetime-local" class="mono-input mi-target-input" data-row-id="${row.id}" value="${toDatetimeLocalValue(row.target)}" />`;
    } else if (row.kind === 'duplicate') {
      targetCell = `<span>${formatInterestedParty(row.target)}</span>`;
    } else {
      targetCell = '<span>-</span>';
    }
    return `<tr data-row-id="${row.id}">
      <td><span class="chip">${escapeHTML(row.intentName)}</span></td>
      <td>${targetCell}</td>
      <td><button type="button" class="btn btn-ghost btn-small mi-delete-btn" data-row-id="${row.id}">Remove</button></td>
    </tr>`;
  };

  const editableRows = rows.filter((r) => r.kind !== 'readonly');
  const readonlyRows = rows.filter((r) => r.kind === 'readonly');

  const hasComplete = rows.some((r) => r.kind === 'complete');
  const hasReminder = rows.some((r) => r.kind === 'reminder');
  const addOptions = [
    '<option value="forward">forward</option>',
    !hasComplete ? '<option value="complete">complete</option>' : '',
    !hasReminder ? '<option value="reminder">reminder date</option>' : '',
  ].filter(Boolean).join('');

  out.innerHTML = `
    <p class="card-desc">Editing <strong>${escapeHTML(subject || '(no subject)')}</strong> : changes apply to the database once you click Save changes.</p>
    <table class="mi-table">
      <thead><tr><th>Intent</th><th>Target</th><th></th></tr></thead>
      <tbody>${editableRows.map(rowMarkup).join('') || '<tr><td colspan="3"><em>No editable intents yet.</em></td></tr>'}</tbody>
    </table>
    <div class="mi-add-row">
      <select id="mi-add-type" class="mini-select">${addOptions}</select>
      <span id="mi-add-target-wrap"></span>
      <button type="button" id="mi-add-btn" class="btn btn-secondary btn-small">Add</button>
    </div>
    ${readonlyRows.length ? `
      <div class="mi-readonly">
        <p class="card-desc">Also computed for this thread (not editable here):</p>
        <ul class="mi-readonly-list">
          ${readonlyRows.map((r) => `<li><span class="chip">${escapeHTML(r.intentName)}</span> ${r.target != null ? formatInterestedParty(r.target) : ''}</li>`).join('')}
        </ul>
      </div>` : ''}
    <p class="card-desc mi-caveat">Clearing a duplicate marking does not restore the original recipients/property data. Add a forward target manually, or re-run Classify, if you want it routed again. Deleting a reminder just clears the pending date; the normal cadence proposes a fresh one on the next Check Intents run.</p>
    <div class="modal-actions">
      <button type="button" id="mi-cancel-btn" class="btn btn-ghost">Cancel</button>
      <button type="button" id="mi-save-btn" class="btn btn-primary">Save changes</button>
    </div>
  `;

  renderModifyIntentAddTarget();

  out.querySelectorAll('.mi-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      modifyIntentState.rows = modifyIntentState.rows.filter((r) => r.id !== btn.dataset.rowId);
      renderModifyIntentBody();
    });
  });
  out.querySelectorAll('.mi-target-input').forEach((input) => {
    input.addEventListener('change', () => {
      const row = modifyIntentState.rows.find((r) => r.id === input.dataset.rowId);
      if (row) row.target = input.value;
    });
  });
  out.querySelector('#mi-add-type')?.addEventListener('change', renderModifyIntentAddTarget);
  out.querySelector('#mi-add-btn')?.addEventListener('click', addModifyIntentRow);
  out.querySelector('#mi-cancel-btn')?.addEventListener('click', () => modifyIntentModal.close());
  out.querySelector('#mi-save-btn')?.addEventListener('click', saveModifyIntent);
}

// Diffs the edited rows against the snapshot taken when the popup opened. Editing a forward/
// reminder row's target in place naturally falls out of this as "remove old + add new" without
// needing a distinct "modify" op.
function computeModifyIntentChanges() {
  const { rows, originalRows } = modifyIntentState;

  const origForward = new Set(originalRows.filter((r) => r.kind === 'forward').map((r) => r.target.toLowerCase()));
  const finalForward = new Set(rows.filter((r) => r.kind === 'forward').map((r) => r.target.toLowerCase()));
  const changes = {
    forwardAdd: [...finalForward].filter((t) => !origForward.has(t)),
    forwardRemove: [...origForward].filter((t) => !finalForward.has(t)),
    complete: rows.some((r) => r.kind === 'complete'),
  };

  const hadDuplicate = originalRows.some((r) => r.kind === 'duplicate');
  const hasDuplicate = rows.some((r) => r.kind === 'duplicate');
  if (hadDuplicate && !hasDuplicate) changes.clearDuplicate = true;

  const reminderRow = rows.find((r) => r.kind === 'reminder');
  const hadReminder = originalRows.some((r) => r.kind === 'reminder');
  if (reminderRow) {
    const d = new Date(reminderRow.target);
    if (!isNaN(d.getTime())) changes.reminderDate = d.toISOString();
  } else if (hadReminder) {
    changes.resetReminder = true;
  }

  return changes;
}

// Merges the server's freshly-recomputed {message, intentList} for this one thread back into the
// live intents-view state, so the table/reading pane reflect the save without a full "Check
// intents" round-trip -- same idea as removeExecutedThreadsFromView() below.
function mergeModifyIntentResult(conversationId, { message, intentList }) {
  if (!lastIntentsItems) return;
  intents[conversationId] = intentList ?? [];
  lastIntentsItems.intents[conversationId] = intentList ?? [];
  if (message) {
    const idx = lastIntentsItems.messages.findIndex((m) => m.conversation_id === conversationId);
    if (idx !== -1) lastIntentsItems.messages[idx] = message;
  }

  const out = outputEl('inbox');
  if (out) renderIntentsList(out, lastIntentsItems, intentPage);
}

async function saveModifyIntent() {
  if (!modifyIntentState) return;
  const conversationId = modifyIntentState.conversationId;
  const changes = computeModifyIntentChanges();
  const btn = document.getElementById('mi-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const result = await fetchJSON('/api/modify-intent', {
      method: 'POST',
      body: JSON.stringify({ conversationId, changes }),
    });
    modifyIntentState = null;
    modifyIntentModal.close();
    mergeModifyIntentResult(conversationId, result);
  } catch (err) {
    showErrorToast(err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
  }
}

// Applies current selection/open state to the DOM: toggles the split layout, (re)renders the
// pane content, and closes gracefully if the selected thread isn't in the current view anymore
// (e.g. it was filtered out by search, or dropped off after a fresh fetch/classify/check-intents run).
function syncReadingPane() {
  const split = document.getElementById('workspace-split');
  const pane = document.getElementById('reading-pane');
  // widens the WHOLE shell (ribbon + search bar + workspace together), not just the workspace,
  // so everything stays visually aligned while the pane is open
  const shell = document.getElementById('dashboard-shell');
  if (!split || !pane) return;

  if (!selectedConvId) {
    split.classList.remove('pane-open');
    shell?.classList.remove('pane-open-shell');
    pane.setAttribute('aria-hidden', 'true');
    return;
  }
  const record = currentRowIndex.get(selectedConvId);
  if (!record) {
    selectedConvId = null;
    split.classList.remove('pane-open');
    shell?.classList.remove('pane-open-shell');
    pane.setAttribute('aria-hidden', 'true');
    return;
  }
  split.classList.add('pane-open');
  shell?.classList.add('pane-open-shell');
  pane.setAttribute('aria-hidden', 'false');
  renderReadingPaneContent(record);
}

// Two independent, differently-styled row states:
//  - row-selected: the thread currently open in the reading pane (one at a time, darker highlight)
//  - row-checked: ticked for Submit & Save (any number at once, lighter highlight) -- driven
//    entirely by intentSelected, so it applies consistently across every rendered view.
function updateRowHighlight() {
  document.querySelectorAll('tr[data-convid]').forEach((tr) => {
    const convId = tr.dataset.convid;
    tr.classList.toggle('row-selected', convId === selectedConvId);
    tr.classList.toggle('row-checked', intentSelected.has(convId));
  });
}

// Single source of truth for "is this thread queued for Submit & Save", used by the table
// checkbox, the reading-pane toggle, and (indirectly) select-all -- so ticking one always keeps
// every other place that shows the same state (the other view's checkbox, the header
// select-all checkbox, row highlighting) in sync, regardless of which one the user clicked.
function toggleIntentSelection(convId, checked) {
  if (checked) intentSelected.add(convId);
  else intentSelected.delete(convId);

  document.querySelectorAll(`.intent-select[data-convid="${CSS.escape(convId)}"]`).forEach((cb) => {
    cb.checked = checked;
  });

  const allCbs = document.querySelectorAll('.intent-select');
  const selectAllCb = document.getElementById('intent-select-all');
  if (selectAllCb) selectAllCb.checked = allCbs.length > 0 && Array.from(allCbs).every((cb) => cb.checked);

  updateRowHighlight();
}

function closeReadingPane() {
  selectedConvId = null;
  syncReadingPane();
  updateRowHighlight();
}

// clicking the same row again closes the pane; clicking a different row switches straight to it
function toggleReadingPane(convId) {
  selectedConvId = selectedConvId === convId ? null : convId;
  syncReadingPane();
  updateRowHighlight();
}

// one delegated listener for every current and future row across all three views. Checkbox,
// copy-id, and other interactive controls inside a row are excluded so this never fights with
// bulk "select for submit" or the ID-copy button.
document.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-convid]');
  if (!tr) return;
  if (e.target.closest('.copy-id, input, button, a, label')) return;
  toggleReadingPane(tr.dataset.convid);
});

// Escape-key handling for the reading pane is unified with the two modals further down (see
// createModal / the shared keydown listener near the bottom of this file), so a modal open on
// top of the pane always takes priority.

let classifiedPage = 0;

function renderClassifiedList(out, items, page = 0) {
  out.classList.remove('err');
  rerenderCurrent = () => renderClassifiedList(out, items, 0);
  setGroupByVisible(false);
  const { messages, classified } = items;

  if (!classified || !classified.length) {
    out.textContent = 'Nothing needed reclassification.';
    updateSearchSummary(0, 0, 'threads');
    currentRowIndex = new Map();
    syncReadingPane();
    clearPager();
    return;
  }

  const messageById = new Map((messages || []).map(m => [m.conversationId, m]));

  // im reversing the order because otherwise it would be earliest first latest last which is bad,
  // then apply the active search filter (keyword/party; due-date filter matches nothing here since
  // this view has no reminder dates)
  const ordered = [...classified].reverse().filter((entry) => {
    const m = messageById.get(entry.conversationId) || {};
    const c = entry.classification || {};
    return rowMatchesSearch({
      subject: m.subject,
      sender: m.sender,
      synopsis: c.important?.synopsis,
      subject_main: c.subject?.main,
      subject_sub: c.subject?.sub,
      all_parties: m.all_parties,
      intended_recipients: (entry.recipients || []).map((r) => r[1]),
    }, []);
  });
  updateSearchSummary(ordered.length, classified.length, 'threads');

  currentRowIndex = new Map(ordered.map((entry) => {
    const m = messageById.get(entry.conversationId) || {};
    const c = entry.classification || {};
    const topic = (c.subject?.main || c.subject?.sub) ? `${c.subject?.main || '-'} / ${c.subject?.sub || '-'}` : null;
    return [entry.conversationId, toPaneRecord({
      convId: entry.conversationId, subject: m.subject, sender: m.sender, updated: m.updated,
      synopsis: c.important?.synopsis, topic,
      recipients: (entry.recipients || []).map((r) => `${r[0]} <${r[1]}>`),
      body: m.body,
    })];
  }));
  syncReadingPane();

  if (!ordered.length) {
    out.innerHTML = '<span class="ok-line">No threads match the current search.</span>';
    clearPager();
    return;
  }

  const pageCount = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  classifiedPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageRows = ordered.slice(classifiedPage * PAGE_SIZE, classifiedPage * PAGE_SIZE + PAGE_SIZE);

  const rows = pageRows.map(({ conversationId, classification: c, recipients, similar }) => {
    const m = messageById.get(conversationId) || {};
    const recipientNames = (recipients || []).map(r => escapeHTML(r[0])).join(', ') || '-';
    return `
      <tr data-convid="${escapeHTML(conversationId)}">
        ${idCell(conversationId)}
        <td>${escapeHTML(m.subject || '(no subject)')}</td>
        <td>${escapeHTML(m.sender || '-')}</td>
        <td>${m.updated ? new Date(m.updated).toLocaleString() : '-'}</td>
        <td>${escapeHTML(c?.important?.synopsis || '-')}</td>
        <td>${escapeHTML(c?.subject?.main || '-')} / ${escapeHTML(c?.subject?.sub || '-')}</td>
        <td>${recipientNames}</td>
        <td>${c?.important?.completed ? 'yes' : c ? 'no' : '-'}</td>
        <td>${similar ? 'possible duplicate' : ''}</td>
      </tr>`;
  }).join('');

  out.innerHTML = `<table>
    <thead>
      <tr>
        <th>ID</th><th>Subject</th><th>From</th><th>Updated</th>
        <th>Synopsis</th><th>Subject bucket</th><th>Routed to</th><th>Completed</th><th>Flags</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;

  renderPager(classifiedPage, pageCount, ordered.length, (p) => renderClassifiedList(out, items, p));
  updateRowHighlight();
}

let inboxPage = 0;

function renderInbox(out, messages, page = 0) {
  out.classList.remove('err');
  rerenderCurrent = () => renderInbox(out, messages, 0);
  setGroupByVisible(false);
  if (!messages.length) {
    out.textContent = 'Inbox is empty.';
    updateSearchSummary(0, 0, 'threads');
    currentRowIndex = new Map();
    syncReadingPane();
    clearPager();
    return;
  }

  const filtered = messages.filter((m) => rowMatchesSearch(m, []));
  updateSearchSummary(filtered.length, messages.length, 'threads');

  // index built from the full filtered set (not just this page) so the pane still works while
  // paging, and closes gracefully if the open thread gets filtered out by the search bar
  currentRowIndex = new Map(filtered.map((m) => [m.conversationId, toPaneRecord({
    convId: m.conversationId, subject: m.subject, sender: m.sender, updated: m.updated,
    synopsis: null, topic: null, recipients: null, body: m.body,
  })]));
  syncReadingPane();

  if (!filtered.length) {
    out.innerHTML = '<span class="ok-line">No threads match the current search.</span>';
    clearPager();
    return;
  }

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  inboxPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageRows = filtered.slice(inboxPage * PAGE_SIZE, inboxPage * PAGE_SIZE + PAGE_SIZE);

  const rows = pageRows.map((m) => `
    <tr data-convid="${escapeHTML(m.conversationId)}">
      ${idCell(m.conversationId)}
      <td>${escapeHTML(m.subject || '(no subject)')}</td>
      <td>${escapeHTML(m.sender || '-')}</td>
      <td>${m.updated ? new Date(m.updated).toLocaleString() : '-'}</td>
    </tr>`).join('');

  out.innerHTML = `<table>
    <thead><tr><th>ID</th><th>Subject</th><th>From</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  renderPager(inboxPage, pageCount, filtered.length, (p) => renderInbox(out, messages, p));
  updateRowHighlight();
}


// 1 row of these
function renderClassification(out, result) {
  out.classList.remove('err');
  const codes = (result.property?.code || []).map((c) => `<span class="chip">${escapeHTML(c)}</span>`).join('');
  const lots = (result.property?.lot || []).map((l) => `<span class="chip">${escapeHTML(l)}</span>`).join('');

  out.innerHTML = `
    <div class="ok-line">${escapeHTML(result.important?.synopsis || 'Classified')}</div>
    <div><strong>Subject:</strong> ${escapeHTML(result.subject?.main || '-')} / ${escapeHTML(result.subject?.sub || '-')}</div>
    <div style="margin-top:6px;"><strong>Property:</strong> ${codes || '-'} ${lots}</div>
    <div style="margin-top:6px;"><strong>Summary:</strong> ${escapeHTML(result.important?.summary || '-')}</div>
    <div style="margin-top:6px;"><strong>Completed:</strong> ${result.important?.completed ? 'yes' : 'no'}</div>
  `;
}

let intentSort = 'date-desc'; // current group-by mode, persists across re-sorts

// deterministic ordering for the intents table (the SQL GROUP BY returns rows unordered)
function sortIntentMessages(messages, intents, mode) {
  const arr = [...messages];
  const dateOf = (m) => new Date(m.updated || 0).getTime();
  // primary intent name; threads with no intent ("do nothing") sort last
  const primaryIntent = (m) => intents[m.conversation_id]?.[0]?.intent ?? '~';
  if (mode === 'date-asc') arr.sort((a, b) => dateOf(a) - dateOf(b));
  else if (mode === 'intent') arr.sort((a, b) => primaryIntent(a).localeCompare(primaryIntent(b)) || dateOf(b) - dateOf(a));
  else arr.sort((a, b) => dateOf(b) - dateOf(a)); // date-desc (default)
  return arr;
}

let intentPage = 0;
// convIds checked for submission. Kept in a Set (not read from the DOM) so a selection made
// on one page survives paging and re-sorting.
let intentSelected = new Set();

function renderIntentsList(out, items, page = 0) {
  out.classList.remove('err');
  rerenderCurrent = () => renderIntentsList(out, items, 0);
  lastIntentsItems = items; // see removeExecutedThreadsFromView()
  const { messages, intents } = items;

  if (!messages || !messages.length) {
    out.textContent = 'Nothing needs review right now.';
    updateSearchSummary(0, 0, 'threads');
    currentRowIndex = new Map();
    syncReadingPane();
    clearPager();
    setGroupByVisible(false);
    return;
  }


  setGroupByVisible(true);
  const groupBySel = document.getElementById('group-by-select');
  if (groupBySel) groupBySel.value = intentSort;

  const intentColors = {
    'forward': 'lightblue',
    'duplicate': 'orange',
    'complete': 'green',
    'reminder_scheduled': 'teal',
    'reminder': 'purple',
    'supervisor': 'red',
    'needs_info': 'darkgoldenrod',
    'unclassifiable': 'dimgray'
  };


  const visible = messages.filter((m) => rowMatchesSearch(m, intents[m.conversation_id] ?? []));
  updateSearchSummary(visible.length, messages.length, 'threads');

  currentRowIndex = new Map(visible.map((m) => {
    const topic = (m.subject_main || m.subject_sub) ? `${m.subject_main || '-'} / ${m.subject_sub || '-'}` : null;
    return [m.conversation_id, toPaneRecord({
      convId: m.conversation_id, subject: m.subject, sender: m.sender, updated: m.updated,
      synopsis: m.synopsis, topic, recipients: m.intended_recipients, body: m.body,
      intentList: intents[m.conversation_id] ?? [], isIntentsView: true,
    })];
  }));
  syncReadingPane();

  if (!visible.length) {
    out.innerHTML = '<span class="ok-line">No threads match the current search.</span>';
    clearPager();
    return;
  }

  const sorted = sortIntentMessages(visible, intents, intentSort);
  const actionableIds = visible
    .filter((m) => (intents[m.conversation_id]?.length ?? 0) > 0)
    .map((m) => m.conversation_id);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  intentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageRows = sorted.slice(intentPage * PAGE_SIZE, intentPage * PAGE_SIZE + PAGE_SIZE);

  const rows = pageRows.map((m) => {
    // intents[convId] is now a LIST of intent objects (empty/absent = do nothing)
    const entryList = intents[m.conversation_id] ?? [];
    const hasIntent = entryList.length > 0;

    // one colored chip per intent so combinations (e.g. forward + reminder_scheduled) are visible
    const intentChips = hasIntent
      ? entryList.map((e) => {
          const color = intentColors[e.intent] || 'gray';
          return `<span style="background-color:${color};color:white;font-weight:bold;padding:1px 6px;border-radius:3px;display:inline-block;margin:1px;">${escapeHTML(e.intent)}</span>`;
        }).join(' ')
      : '-';

    const targets = entryList
      .map((e) => formatInterestedParty(e.interestedParty))
      .filter((v) => v && v !== '-')
      .join('; ') || '-';

    // only actionable rows get a check box; execution honors every intent on the row
    const checkbox = hasIntent
      ? `<input type="checkbox" class="intent-select" data-convid="${escapeHTML(m.conversation_id)}" ${intentSelected.has(m.conversation_id) ? 'checked' : ''} />`
      : '';

    // classified topic from the previous step (subject bucket main / sub)
    const topic = (m.subject_main || m.subject_sub)
      ? `${escapeHTML(m.subject_main || '-')} / ${escapeHTML(m.subject_sub || '-')}`
      : '-';

    // checkbox + ID are pinned (sticky) to the left of the horizontally-scrollable table, and
    // Intent sits right next to them, so the identifying info + what's about to happen stays
    // visible without scrolling right through Subject/From/Updated/etc.
    return `
      <tr data-convid="${escapeHTML(m.conversation_id)}">
        <td class="checkbox-cell">${checkbox}</td>
        ${idCell(m.conversation_id)}
        <td class="intent-cell">${intentChips}</td>
        <td>${escapeHTML(m.subject || '(no subject)')}</td>
        <td>${escapeHTML(m.sender || '-')}</td>
        <td>${m.updated ? new Date(m.updated).toLocaleString() : '-'}</td>
        <td>${topic}</td>
        <td>${escapeHTML(m.synopsis || '-')}</td>
        <td>${targets}</td>
      </tr>`;
  }).join('');

  const allSelected = actionableIds.length > 0 && actionableIds.every((id) => intentSelected.has(id));

  out.innerHTML = `
  <table class="intents-table">
    <thead>
      <tr>
        <th class="checkbox-cell"><input type="checkbox" id="intent-select-all" ${allSelected ? 'checked' : ''} title="Select all" /></th>
        <th class="id-cell">ID</th><th>Intent</th><th>Subject</th><th>From</th><th>Updated</th><th>Topic</th><th>Synopsis</th><th>Target</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;

  // per-row checkbox updates the persistent selection set (shared with the reading-pane toggle)
  out.querySelectorAll('.intent-select').forEach((cb) => {
    cb.addEventListener('change', () => toggleIntentSelection(cb.dataset.convid, cb.checked));
  });

  // select-all toggles every actionable thread across ALL pages, not just the visible ones
  out.querySelector('#intent-select-all')?.addEventListener('change', (e) => {
    if (e.target.checked) actionableIds.forEach((id) => intentSelected.add(id));
    else actionableIds.forEach((id) => intentSelected.delete(id));
    renderIntentsList(out, items, intentPage);
  });

  renderPager(intentPage, pageCount, sorted.length, (p) => renderIntentsList(out, items, p));
  updateRowHighlight();
}

function getSelectedConvIds() {
  return Array.from(intentSelected);
}



function renderExecutionReport(out, report, confirmIds) {
  out.classList.remove('err');
  const results = report?.results || [];

  if (!results.length) {

    out.innerHTML = '<div class="ok-line">No matching threads for the current selection. '
      + 'Run <strong>Check intents</strong> again and re-tick the rows you want, then Submit &amp; Save.</div>';
    return;
  }

  const badge = (status) => `<span class="exec-badge exec-badge-${escapeHTML(status)}">${escapeHTML(status)}</span>`;

  const blocks = results.map((r) => {
    const actionItems = (r.actions || []).map((a) => `
      <li class="exec-action">
        ${badge(a.status)}
        <span class="exec-action-label">${escapeHTML(a.label)}</span>
        ${a.error ? `<span class="exec-action-error">${escapeHTML(a.error)}</span>` : ''}
      </li>`).join('');

    return `
      <div class="exec-block">
        <div class="exec-block-head">
          <span class="exec-block-subject">${escapeHTML(r.subject || '(no subject)')}</span>
          ${badge(r.status)}
        </div>
        <div class="exec-block-meta">intent: ${escapeHTML(r.intent)}${r.synopsis ? ` · ${escapeHTML(r.synopsis)}` : ''}</div>
        <ul class="exec-actions">${actionItems}</ul>
      </div>`;
  }).join('');

  const count = results.length;
  const summary = report.dryRun
    ? `<div class="exec-summary">Review the ${count} thread${count === 1 ? '' : 's'} below, then confirm.</div>`
    : `<div class="exec-summary exec-summary-done">Executed ${count} thread${count === 1 ? '' : 's'}.</div>`;

  const confirmBtn = report.dryRun
    ? `<button id="confirm-exec-btn" class="btn btn-primary exec-confirm-btn" type="button">Confirm &amp; Execute</button>`
    : '';

  out.innerHTML = summary + `<div class="exec-list">${blocks}</div>` + confirmBtn;

  if (report.dryRun) {
    const btn = out.querySelector('#confirm-exec-btn');
    btn?.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Executing…';
      try {
        const live = await fetchJSON('/api/execute', {
          method: 'POST',
          body: JSON.stringify({ conversationIds: confirmIds }),
        });
        renderExecutionReport(out, live, null);
        // These threads have now actually been acted on -- drop them from the intents table so
        // the same action can't be re-submitted by mistake before the next "Check intents" run.
        if (confirmIds?.length) removeExecutedThreadsFromView(confirmIds);
      } catch (err) {
        renderError(out, err.message);
      }
    });
  }
}

let lastIntentsItems = null;

function removeExecutedThreadsFromView(convIds) {
  if (!lastIntentsItems) return;
  const idSet = new Set(convIds);
  lastIntentsItems.messages = lastIntentsItems.messages.filter((m) => !idSet.has(m.conversation_id));
  for (const id of convIds) {
    delete lastIntentsItems.intents[id];
    intentSelected.delete(id);
  }
  if (selectedConvId && idSet.has(selectedConvId)) selectedConvId = null; // reading pane closes via the re-render below

  const out = outputEl('inbox');
  if (out) renderIntentsList(out, lastIntentsItems, intentPage);
}

// dumps the full stored state for each inspected conversation id
function renderInspect(out, info) {
  out.classList.remove('err');
  if (!Array.isArray(info) || !info.length) {
    out.textContent = 'No data.';
    return;
  }

  const kv = (obj, skip = []) => {
    if (!obj) return '<em>none</em>';
    return `<table class="kv">${Object.entries(obj)
      .filter(([k]) => !skip.includes(k))
      .map(([k, v]) => {
        let val = v;
        if (v == null) val = '-';
        else if (k === 'body') val = String(v).slice(0, 300) + (String(v).length > 300 ? '…' : '');
        else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) val = new Date(v).toLocaleString();
        return `<tr><td class="kv-key">${escapeHTML(k)}</td><td>${escapeHTML(String(val))}</td></tr>`;
      })
      .join('')}</table>`;
  };

  const rowsTable = (rows) => {
    if (!rows || !rows.length) return '<em>none</em>';
    const cols = Object.keys(rows[0]).filter((c) => c !== 'conversation_id');
    const head = cols.map((c) => `<th>${escapeHTML(c)}</th>`).join('');
    const body = rows
      .map((r) => `<tr>${cols.map((c) => {
        let v = r[c];
        if (v == null) v = '-';
        else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) v = new Date(v).toLocaleString();
        return `<td>${escapeHTML(String(v))}</td>`;
      }).join('')}</tr>`)
      .join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  };

  const blocks = info.map((rec) => {
    const intentText = (rec.intents || [])
      .map((e) => `${e.intent}${e.interestedParty != null ? ` → ${formatInterestedParty(e.interestedParty)}` : ''}`)
      .join(', ') || 'do nothing';
    return `
      <div class="exec-block" style=" #333;border-radius:4px;padding:8px;margin:8px 0;">
        <div style="font-family:var(--font-mono);font-size:0.75rem;opacity:0.8;word-break:break-all;">${escapeHTML(rec.conversationId)}</div>
        ${rec.email ? '' : '<div class="err" style="margin:4px 0;">not found in DB</div>'}
        <div style="margin-top:6px;"><strong>Intents:</strong> ${escapeHTML(intentText)}</div>
        <div style="margin-top:6px;"><strong>Email</strong>${kv(rec.email)}</div>
        <div style="margin-top:6px;"><strong>Property</strong>${rowsTable(rec.properties)}</div>
        <div style="margin-top:6px;"><strong>Recipients</strong>${rowsTable(rec.recipients)}</div>
      </div>`;
  }).join('');

  out.innerHTML = blocks;
}

function formatInterestedParty(party) {
  if (party == null) return '-';
  if (Array.isArray(party)) return party.map(escapeHTML).join(', ') || '-';
  if (party instanceof Date) return party.toLocaleString();
  // dates come back from JSON as ISO strings once they cross the fetch boundary
  if (typeof party === 'string' && !isNaN(Date.parse(party)) && /^\d{4}-\d{2}-\d{2}T/.test(party)) {
    return new Date(party).toLocaleString();
  }
  return escapeHTML(String(party));
}


function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Network helper

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}


function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function wireSearch() {
  const kw = document.getElementById('search-keyword');
  const party = document.getElementById('search-party');
  const intentSel = document.getElementById('search-intent');
  const from = document.getElementById('search-due-from');
  const to = document.getElementById('search-due-to');
  const clearBtn = document.getElementById('search-clear');

  const apply = () => rerenderCurrent();
  const applyDebounced = debounce(apply, 150);

  kw?.addEventListener('input', () => { searchState.keyword = kw.value; applyDebounced(); });
  party?.addEventListener('input', () => { searchState.party = party.value; applyDebounced(); });
  intentSel?.addEventListener('change', () => { searchState.intent = intentSel.value; apply(); });
  from?.addEventListener('change', () => { searchState.dueFrom = from.value; apply(); });
  to?.addEventListener('change', () => { searchState.dueTo = to.value; apply(); });

  clearBtn?.addEventListener('click', () => {
    searchState.keyword = '';
    searchState.party = '';
    searchState.intent = '';
    searchState.dueFrom = '';
    searchState.dueTo = '';
    if (kw) kw.value = '';
    if (party) party.value = '';
    if (intentSel) intentSel.value = '';
    if (from) from.value = '';
    if (to) to.value = '';
    apply();
  });
}


function createModal(overlayId, { openBtnId, closeBtnId, onOpen, onClose } = {}) {
  const overlay = document.getElementById(overlayId);
  const openBtn = openBtnId ? document.getElementById(openBtnId) : null;
  const closeBtn = closeBtnId ? document.getElementById(closeBtnId) : overlay?.querySelector('.modal-close');
  if (!overlay) return { open() {}, close() {}, isOpen: () => false };

  const EXIT_MS = 160; // must match the .closing animation duration in style.css
  let closeTimer = null;

  const open = () => {
    clearTimeout(closeTimer);
    overlay.classList.remove('closing');
    overlay.classList.remove('hidden');
    openBtn?.setAttribute('aria-expanded', 'true');
    onOpen?.();
  };

  const close = () => {
    if (overlay.classList.contains('hidden') || overlay.classList.contains('closing')) return;
    onClose?.();
    overlay.classList.add('closing');
    openBtn?.setAttribute('aria-expanded', 'false');
    closeTimer = setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('closing');
    }, EXIT_MS);
  };

  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  // click on the darkened backdrop (but not the dialog itself) closes it
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  return { open, close, isOpen: () => !overlay.classList.contains('hidden') };
}

const inspectModal = createModal('inspect-overlay', {
  openBtnId: 'toggle-inspect',
  closeBtnId: 'inspect-close',
  onOpen: () => document.getElementById('inspect-ids')?.focus(),
});
const executeModal = createModal('execute-overlay', { closeBtnId: 'execute-close' });

const modifyIntentModal = createModal('modify-intent-overlay', {
  closeBtnId: 'modify-intent-close',
  onClose: () => { modifyIntentState = null; },
});


document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (modifyIntentModal.isOpen()) { modifyIntentModal.close(); return; }
  if (executeModal.isOpen()) { executeModal.close(); return; }
  if (inspectModal.isOpen()) { inspectModal.close(); return; }
  if (selectedConvId) closeReadingPane();
});


document.getElementById('group-by-select')?.addEventListener('change', (e) => {
  intentSort = e.target.value;
  rerenderCurrent(); // rerenderCurrent always points at the active view's render() at this point
});

wireSearch();
checkStatusOnLoad();