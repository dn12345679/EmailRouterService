import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import settings from './appSettings.js';
import {
  initializeGraphForUserAuth,
  getUserTokenAsync,
  getUserAsync,
  getInboxAsync,
  sendMailAsync,
  uploadToDB,
} from './graphHelper.js';
import { classify_email_by_ID } from './dbManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------
// This is a single-user local tool, so one process-wide state object is
// enough — no need for cookies/sessions unless you turn this into something
// multiple people use at once.
//
// If you later figure out persistent token caching (e.g.
// TokenCachePersistenceOptions on DeviceCodeCredential, or writing/reading
// the token to disk yourself), this is the spot to check for a valid cached
// token BEFORE calling initializeGraphForUserAuth + getUserTokenAsync, and
// jump straight to `status: 'authenticated'` if one exists. Everything else
// (routes, frontend) stays the same either way.
let authState = {
  status: 'signedOut', // 'signedOut' | 'awaitingCode' | 'authenticated' | 'error'
  deviceCode: null,    // { userCode, verificationUri, message }
  user: null,           // { displayName, mail }
  error: null,
};

app.get('/api/auth/status', (req, res) => {
  res.json(authState);
});

app.post('/api/auth/start', async (req, res) => {
  // already in progress or already signed in — don't kick off a second flow
  if (authState.status === 'awaitingCode' || authState.status === 'authenticated') {
    return res.json(authState);
  }

  authState = { status: 'awaitingCode', deviceCode: null, user: null, error: null };
  res.json(authState); // respond immediately; sign-in continues in the background

  try {
    await initializeGraphForUserAuth(settings, (info) => {
      // fires as soon as Microsoft issues the device code — before the user
      // has actually gone and entered it anywhere
      authState = {
        status: 'awaitingCode',
        deviceCode: {
          userCode: info.userCode,
          verificationUri: info.verificationUri,
          message: info.message,
        },
        user: null,
        error: null,
      };
    });

    // this is what actually triggers the device-code request + the callback
    // above, and blocks until the user finishes signing in in their browser
    await getUserTokenAsync();

    const user = await getUserAsync();
    authState = {
      status: 'authenticated',
      deviceCode: null,
      user: { displayName: user?.displayName ?? null, mail: user?.mail ?? user?.userPrincipalName ?? null },
      error: null,
    };
  } catch (err) {
    console.error(err);
    authState = { status: 'error', deviceCode: null, user: null, error: err.message };
  }
});

function requireAuth(req, res, next) {
  if (authState.status !== 'authenticated') {
    return res.status(401).json({ error: 'Not signed in' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Job routes — one per option in your old index.js menu
// ---------------------------------------------------------------------------

app.get('/api/inbox', requireAuth, async (req, res) => {
  try {
    const msgs = await getInboxAsync();
    res.json(msgs.value);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-mail', requireAuth, async (req, res) => {
  const { subject, body, recipient } = req.body ?? {};
  if (!subject || !body || !recipient) {
    return res.status(400).json({ error: 'subject, body, and recipient are all required' });
  }
  try {
    await sendMailAsync(subject, body, recipient);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/classify-all', requireAuth, async (req, res) => {
  try {
    const result = await uploadToDB();
    res.json({ ok: true, count: result.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/classify-email', requireAuth, async (req, res) => {
  const { id } = req.body ?? {};
  if (!id) return res.status(400).json({ error: 'Conversation ID is required' });
  try {
    const classification = await classify_email_by_ID(id);
    res.json(classification);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UI running at http://localhost:${PORT}`));
