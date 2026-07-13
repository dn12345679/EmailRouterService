
## Install & run

```
npm install express
node server.js
```

Then open `http://localhost:3000`. You'll get a device code + a link — same flow as before, just rendered in the browser instead of the terminal. Once you finish signing in at microsoft.com/devicelogin, the page automatically swaps to the dashboard (it polls every 2s).

## What each job button calls

| Card | Old `index.js` menu option | Calls |
|---|---|---|
| List inbox | 0 | `getInboxAsync()` |
| Send mail | 1 | `sendMailAsync(subject, body, recipient)` |
| Classify all & insert into DB | 2 | `uploadToDB()` → `insertIntoDB()` |
| Classify email | 3 | `classify_email_by_ID(id)` |


## On login caching, for later

`authState` lives in a single in-memory object in `server.js`, on purpose — it's a single-user local tool, so there's no session/cookie machinery to fight with. When you figure out persistent token caching:

- Look at `TokenCachePersistenceOptions` on `DeviceCodeCredential` (`@azure/identity`), or
- Write/read the token yourself to a local file after `getUserTokenAsync()` succeeds.

Either way, the change is contained to the top of `/api/auth/start` in `server.js` — check for a valid cached token first, and if found, skip straight to `authState = { status: 'authenticated', ... }` instead of calling `initializeGraphForUserAuth` + `getUserTokenAsync`. Nothing in the frontend (`app.js`) needs to change.
