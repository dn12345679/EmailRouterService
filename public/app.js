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
  if (!id) return '—';
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
const PAGE_SIZE = 5;

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



async function runJob(job, btn) {
  if (job === 'submit-selected') {
    const out = outputEl('submit-selected');
    const ids = getSelectedConvIds();
    if (!ids.length) {
      renderError(out, 'Tick at least one email in the intents table (run "Check All Intents" first).');
      return;
    }
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
  setLoading(btn, out, 'Running…');

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
     
      setLoading(null, out, 'Completed.'); // just sets the status of the 'running...' to complete

      out = outputEl('inbox'); // want to bundle all stuff into 1 UI for consistency
      
      renderClassifiedList(out, {messages, classified}); 
    }
    else if (job === 'group-selected') {
      const result = await fetchJSON('/api/group-selected', { method: 'POST' });
      intents = result.intents;
      setLoading(null, out, 'Completed.');
      out = outputEl('inbox')
      // fresh load: default to all actionable threads selected, start on the first page
      intentSelected = new Set(Object.keys(intents));
      intentPage = 0;
      renderIntentsList(out, { messages: result.messages, intents }, 0);
    }

    
    else if (job === 'classify-all') {
      const result = await fetchJSON('/api/classify-all', { method: 'POST' });
      renderOk(out, `Done. Checked ${result.count} email(s).`);
    }
  } catch (err) {
    renderError(out, err.message);
  } finally {
    resetLoading(btn, job === 'inbox' ? 'Run' : 'Run batch job');
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
  if (btn) { btn.disabled = true; btn.dataset.originalText = btn.textContent; btn.textContent = label; }
  out.classList.remove('err');
  out.innerHTML = `<span class="ok-line">${label}</span>`;
}

function resetLoading(btn, fallbackLabel) {
  if (btn) { btn.disabled = false; btn.textContent = btn.dataset.originalText || fallbackLabel; }
}

function renderOk(out, message) {
  out.classList.remove('err');
  out.innerHTML = `<span class="ok-line">${escapeHTML(message)}</span>`;
}

function renderError(out, message) {
  out.classList.add('err');
  out.textContent = message;
}



let classifiedPage = 0;

function renderClassifiedList(out, items, page = 0) {
  out.classList.remove('err');
  const { messages, classified } = items;

  if (!classified || !classified.length) {
    out.textContent = 'Nothing needed reclassification.';
    return;
  }

  const messageById = new Map((messages || []).map(m => [m.conversationId, m]));

  // im reversing the order because otherwise it would be earliest first latest last which is bad
  const ordered = [...classified].reverse();
  const pageCount = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  classifiedPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageRows = ordered.slice(classifiedPage * PAGE_SIZE, classifiedPage * PAGE_SIZE + PAGE_SIZE);

  const rows = pageRows.map(({ conversationId, classification: c, recipients, similar }) => {
    const m = messageById.get(conversationId) || {};
    const recipientNames = (recipients || []).map(r => escapeHTML(r[0])).join(', ') || '—';
    return `
      <tr>
        ${idCell(conversationId)}
        <td>${escapeHTML(m.subject || '(no subject)')}</td>
        <td>${escapeHTML(m.sender || '—')}</td>
        <td>${m.updated ? new Date(m.updated).toLocaleString() : '—'}</td>
        <td>${escapeHTML(c?.important?.synopsis || '—')}</td>
        <td>${escapeHTML(c?.subject?.main || '—')} / ${escapeHTML(c?.subject?.sub || '—')}</td>
        <td>${recipientNames}</td>
        <td>${c?.important?.completed ? 'yes' : c ? 'no' : '—'}</td>
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
  </table>
  ${pagerMarkup(classifiedPage, pageCount, ordered.length, 'threads')}`;

  wirePager(out, classifiedPage, pageCount, (p) => renderClassifiedList(out, items, p));
}

let inboxPage = 0;

function renderInbox(out, messages, page = 0) {
  out.classList.remove('err');
  if (!messages.length) {
    out.textContent = 'Inbox is empty.';
    return;
  }

  const pageCount = Math.max(1, Math.ceil(messages.length / PAGE_SIZE));
  inboxPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageRows = messages.slice(inboxPage * PAGE_SIZE, inboxPage * PAGE_SIZE + PAGE_SIZE);

  const rows = pageRows.map((m) => `
    <tr>
      ${idCell(m.conversationId)}
      <td>${escapeHTML(m.subject || '(no subject)')}</td>
      <td>${escapeHTML(m.sender || '—')}</td>
      <td>${m.updated ? new Date(m.updated).toLocaleString() : '—'}</td>
    </tr>`).join('');

  out.innerHTML = `<table>
    <thead><tr><th>ID</th><th>Subject</th><th>From</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${pagerMarkup(inboxPage, pageCount, messages.length, 'threads')}`;

  wirePager(out, inboxPage, pageCount, (p) => renderInbox(out, messages, p));
}


// 1 row of these
function renderClassification(out, result) {
  out.classList.remove('err');
  const codes = (result.property?.code || []).map((c) => `<span class="chip">${escapeHTML(c)}</span>`).join('');
  const lots = (result.property?.lot || []).map((l) => `<span class="chip">${escapeHTML(l)}</span>`).join('');

  out.innerHTML = `
    <div class="ok-line">${escapeHTML(result.important?.synopsis || 'Classified')}</div>
    <div><strong>Subject:</strong> ${escapeHTML(result.subject?.main || '—')} / ${escapeHTML(result.subject?.sub || '—')}</div>
    <div style="margin-top:6px;"><strong>Property:</strong> ${codes || '—'} ${lots}</div>
    <div style="margin-top:6px;"><strong>Summary:</strong> ${escapeHTML(result.important?.summary || '—')}</div>
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
  const { messages, intents } = items;

  if (!messages || !messages.length) {
    out.textContent = 'Nothing needs review right now.';
    return;
  }

  const intentColors = {
    'forward': 'lightblue',
    'duplicate': 'orange',
    'complete': 'green',
    'reminder_scheduled': 'teal',
    'reminder': 'purple',
    'supervisor': 'red',
    'needs_info': 'darkgoldenrod'
  };

  const sorted = sortIntentMessages(messages, intents, intentSort);
  const actionableIds = messages
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
      : '—';

    const targets = entryList
      .map((e) => formatInterestedParty(e.interestedParty))
      .filter((v) => v && v !== '—')
      .join('; ') || '—';

    // only actionable rows get a check box; execution honors every intent on the row
    const checkbox = hasIntent
      ? `<input type="checkbox" class="intent-select" data-convid="${escapeHTML(m.conversation_id)}" ${intentSelected.has(m.conversation_id) ? 'checked' : ''} />`
      : '';

    // classified topic from the previous step (subject bucket main / sub)
    const topic = (m.subject_main || m.subject_sub)
      ? `${escapeHTML(m.subject_main || '—')} / ${escapeHTML(m.subject_sub || '—')}`
      : '—';

    return `
      <tr>
        <td>${checkbox}</td>
        ${idCell(m.conversation_id)}
        <td>${escapeHTML(m.subject || '(no subject)')}</td>
        <td>${escapeHTML(m.sender || '—')}</td>
        <td>${m.updated ? new Date(m.updated).toLocaleString() : '—'}</td>
        <td>${topic}</td>
        <td>${escapeHTML(m.synopsis || '—')}</td>
        <td>${intentChips}</td>
        <td>${targets}</td>
      </tr>`;
  }).join('');

  const allSelected = actionableIds.length > 0 && actionableIds.every((id) => intentSelected.has(id));

  const sortOptions = [
    ['date-desc', 'Date received (newest)'],
    ['date-asc', 'Date received (oldest)'],
    ['intent', 'Intent type'],
  ].map(([v, label]) => `<option value="${v}" ${intentSort === v ? 'selected' : ''}>${label}</option>`).join('');

  out.innerHTML = `
  <div class="intent-toolbar">
    <label class="fetch-count-label">Group by
      <select id="intent-sort" class="mini-select">${sortOptions}</select>
    </label>
  </div>
  <table>
    <thead>
      <tr>
        <th><input type="checkbox" id="intent-select-all" ${allSelected ? 'checked' : ''} title="Select all" /></th>
        <th>ID</th><th>Subject</th><th>From</th><th>Updated</th><th>Topic</th><th>Synopsis</th><th>Intent</th><th>Target</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  ${pagerMarkup(intentPage, pageCount, sorted.length, 'threads')}`;

  // per-row checkbox updates the persistent selection set
  out.querySelectorAll('.intent-select').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) intentSelected.add(cb.dataset.convid);
      else intentSelected.delete(cb.dataset.convid);
      const sa = out.querySelector('#intent-select-all');
      if (sa) sa.checked = actionableIds.length > 0 && actionableIds.every((id) => intentSelected.has(id));
    });
  });

  // select-all toggles every actionable thread across ALL pages, not just the visible ones
  out.querySelector('#intent-select-all')?.addEventListener('change', (e) => {
    if (e.target.checked) actionableIds.forEach((id) => intentSelected.add(id));
    else actionableIds.forEach((id) => intentSelected.delete(id));
    renderIntentsList(out, items, intentPage);
  });

  // group-by change re-sorts from the first page
  out.querySelector('#intent-sort')?.addEventListener('change', (e) => {
    intentSort = e.target.value;
    renderIntentsList(out, items, 0);
  });

  wirePager(out, intentPage, pageCount, (p) => renderIntentsList(out, items, p));
}

function getSelectedConvIds() {
  return Array.from(intentSelected);
}


// actual execution
function renderExecutionReport(out, report, confirmIds) {
  out.classList.remove('err');
  const results = report?.results || [];

  if (!results.length) {
    out.textContent = 'Nothing to do.';
    return;
  }

  const statusBadge = (s) => {
    const color = {
      planned: '#5a7fff', done: 'green', error: 'red', skipped: 'gray',
    }[s] || 'gray';
    return `<span style="background:${color};color:#fff;font-weight:600;padding:1px 6px;border-radius:3px;">${escapeHTML(s)}</span>`;
  };

  const blocks = results.map((r) => {
    const actionItems = (r.actions || []).map((a) => `
      <li>${statusBadge(a.status)} ${escapeHTML(a.label)}${a.error ? ` <span style="color:red;">— ${escapeHTML(a.error)}</span>` : ''}</li>
    `).join('');

    return `
      <div class="exec-block" style="border:1px solid #333;border-radius:4px;padding:8px;margin:8px 0;">
        <div><strong>${escapeHTML(r.subject || '(no subject)')}</strong> ${statusBadge(r.status)}</div>
        <div style="font-size:0.9em;opacity:0.8;">intent: ${escapeHTML(r.intent)} · ${escapeHTML(r.synopsis || '')}</div>
        <ul style="margin:6px 0 0 0;padding-left:18px;">${actionItems}</ul>
      </div>`;
  }).join('');

  const header = report.dryRun
    ? `<div class="ok-line">Review the ${results.length} threads below, then confirm.</div>`
    : `<div class="ok-line">Executed ${results.length} threads</div>`;

  const confirmBtn = report.dryRun
    ? `<button id="confirm-exec-btn" class="btn btn-primary" style="margin-top:8px;">Confirm &amp; Execute</button>`
    : '';

  out.innerHTML = header + blocks + confirmBtn;

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
      } catch (err) {
        renderError(out, err.message);
      }
    });
  }
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
        if (v == null) val = '—';
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
        if (v == null) v = '—';
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
  if (party == null) return '—';
  if (Array.isArray(party)) return party.map(escapeHTML).join(', ') || '—';
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

checkStatusOnLoad();