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


// not used rn
document.getElementById('send-mail-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const out = outputEl('send-mail');
  const submitBtn = form.querySelector('button[type="submit"]');
  const payload = Object.fromEntries(new FormData(form).entries());

  setLoading(submitBtn, out, 'Sending…');
  try {
    await fetchJSON('/api/send-mail', { method: 'POST', body: JSON.stringify(payload) });
    renderOk(out, 'Sent.');
    form.reset();
  } catch (err) {
    renderError(out, err.message);
  } finally {
    resetLoading(submitBtn, 'Send');
  }
});

document.getElementById('classify-email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const out = outputEl('classify-email');
  const submitBtn = form.querySelector('button[type="submit"]');
  const { id } = Object.fromEntries(new FormData(form).entries());

  setLoading(submitBtn, out, 'Classifying…');
  try {
    const result = await fetchJSON('/api/classify-email', { method: 'POST', body: JSON.stringify({ id }) });
    renderClassification(out, result);
    
  } catch (err) {
    renderError(out, err.message);
  } finally {
    resetLoading(submitBtn, 'Classify');
  }
});

async function runJob(job, btn) {
  let out = outputEl(job);
  setLoading(btn, out, 'Running…');

  try {
    if (job === 'inbox') {
      const msgs = await fetchJSON('/api/inbox'); // UNIQUE messages 
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
      renderIntentsList(out, { messages: result.messages, intents });
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



function renderClassifiedList(out, items) {
  out.classList.remove('err');
  const { messages, classified } = items;

  if (!classified || !classified.length) {
    out.textContent = 'Nothing needed reclassification.';
    return;
  }

  const messageById = new Map((messages || []).map(m => [m.conversationId, m]));

  // im reversing the order because otherwise it would be earliest first latest last which is bad
  const rows = [...classified].reverse().map(({ conversationId, classification: c, recipients, similar }) => {
    const m = messageById.get(conversationId) || {};
    const recipientNames = (recipients || []).map(r => escapeHTML(r[0])).join(', ') || '—';
    return `
      <tr>
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
        <th>Subject</th><th>From</th><th>Updated</th>
        <th>Synopsis</th><th>Subject bucket</th><th>Routed to</th><th>Completed</th><th>Flags</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderInbox(out, messages) {
  out.classList.remove('err');
  if (!messages.length) {
    out.textContent = 'Inbox is empty.';
    return;
  }
  const rows = messages.map((m) => `
    <tr>
      <td>${escapeHTML(m.subject || '(no subject)')}</td>
      <td>${escapeHTML(m.sender || '—')}</td>
      <td>${m.updated ? new Date(m.updated).toLocaleString() : '—'}</td>
    </tr>`).join('');
  out.innerHTML = `<table>
    <thead><tr><th>Subject</th><th>From</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
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

function renderIntentsList(out, items) {
  out.classList.remove('err');
  const { messages, intents } = items;

  if (!messages || !messages.length) {
    out.textContent = 'Nothing needs review right now.';
    return;
  }

  const rows = messages.map((m) => {
    const entry = intents[m.conversation_id];
    const intent = entry?.intent || '—';
    const interestedParty = entry?.interestedParty;

    const intentColor = {
      'forward': 'lightblue',
      'duplicate': 'orange',
      'complete': 'green',
      'reminder_scheduled': 'teal',
      'reminder': 'purple',
      'supervisor': 'red'
    }[intent] || 'gray';

    return `
      <tr>
        <td>${escapeHTML(m.subject || '(no subject)')}</td>
        <td>${escapeHTML(m.sender || '—')}</td>
        <td>${m.updated ? new Date(m.updated).toLocaleString() : '—'}</td>
        <td>${escapeHTML(m.synopsis || '—')}</td>
        <td style="background-color: ${intentColor}; color: white; font-weight: bold;">
          ${escapeHTML(intent)}
        </td>
        <td>${formatInterestedParty(interestedParty)}</td>
      </tr>`;
  }).join('');

  out.innerHTML = `<table>
    <thead>
      <tr>
        <th>Subject</th><th>From</th><th>Updated</th><th>Synopsis</th><th>Intent</th><th>Target</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
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