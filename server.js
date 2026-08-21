import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import settings from './appsettings.js';
import {
  initializeGraphForUserAuth,
  getUserTokenAsync,
  getUserAsync,
  getInboxAsync,
  sendMailAsync,
  uploadToDB,
  getUniqueMessages,
  getConversationMessageIdsAsync,
} from './graphHelper.js';
import {
  insertIntoDB,
  classify_email_by_ID,
  classification_to_email,
  checkReminders,
  getReadEmailsWithIntents,
  email_needs_reminder,
  executeIntents,
  inspectConversations
 } from './dbManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


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
  // already in progress or already signed in
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


app.get('/api/inbox', requireAuth, async (req, res) => {
  try {
    // how many unique threads to pull (1/10/50/100 or a custom amount); default 10
    const count = Math.min(500, Math.max(1, parseInt(req.query.count, 10) || 10));
    const msgs = await getUniqueMessages(count);
    res.json(msgs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/inspect', requireAuth, async (req, res) => {
  const { conversationIds } = req.body ?? {};
  if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
    return res.status(400).json({ error: 'conversationIds array is required' });
  }
  try {
    const info = await inspectConversations(conversationIds);
    res.json(info);
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


app.post('/api/group-selected', requireAuth, async (req, res) => {
  try {
    const result = await getReadEmailsWithIntents();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
})

app.post('/api/execute-plan', requireAuth, async (req, res) => {
  const { conversationIds } = req.body ?? {};
  try {
    const plan = await executeIntents(conversationIds ?? null, { dryRun: true });
    res.json(plan);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/execute', requireAuth, async (req, res) => {
  const { conversationIds } = req.body ?? {};
  try {
    const result = await executeIntents(conversationIds ?? null, { dryRun: false });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/classify-selected', requireAuth, async (req, res) => {
  const { messages } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  try {
    const result = await insertIntoDB(messages);
    const reminderDueIds = await email_needs_reminder()
    res.json({result, reminderDueIds  });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
})


app.post('/api/classify-all', requireAuth, async (req, res) => {
  try {
    const count = Math.min(500, Math.max(1, parseInt(req.body?.count, 10) || 10));
    const result = await uploadToDB(count);
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
    const recipient = await classification_to_email(classification)
    res.json(classification);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

export function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log(`UI running at http://localhost:${PORT}`);
      resolve(server);
    });
  });
}