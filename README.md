# InvestPub SMS Campaigns

A multi-tenant Twilio SMS marketing platform. Each customer brings their own Twilio Account SID, Auth Token, and Messaging Service, and sends through their own toll-free number. The app handles fan-out, status callbacks, scheduled sends, RCS read receipts, and live counter aggregation.

Built on Node.js 20 ESM + Firebase (Hosting, Firestore, Cloud Functions Gen 2). No frontend build step — vanilla JS modules loaded directly from the browser.

## Features

- **Email + password auth** via Firebase Auth.
- **Twilio credential storage** — AES-256-GCM encrypted Auth Token, decrypted server-side only when a Twilio API call is needed.
- **CSV contact list upload** — streaming papaparse, libphonenumber-js E.164 normalization, BulkWriter fan-out, live progress.
- **Single Send composer** — Messaging Service picker (live from Twilio), contact-list picker, GSM-7/UCS-2 segment counter, emoji picker, schedule control (15 min - 7 days), test SMS, iOS-style phone preview, `{name}` personalization.
- **Sending engine** — Bottleneck rate-limited fan-out, cursor-based resume, transactional 50-shard counter increments, scheduled-send support via Twilio's native `sendAt`/`scheduleType:'fixed'`.
- **Multi-chunk worker** — self-yields before the 540 s Cloud Functions timeout, persists progress, triggers continuation via a doc-update sentinel. Sustains arbitrarily long fan-outs.
- **Status callback webhook** — public endpoint, `X-Twilio-Signature` validated per-tenant, transactional state machine with forward-only transitions, decrement+increment on the same shard.
- **Cancel scheduled sends** — Twilio `messages(sid).update({status:'canceled'})` per recipient, transactional counter swap.
- **Single Sends list view** — live `onSnapshot` per-row, status filter, scheduled-time pill.
- **Detail view** — live stat tiles (Sent / Delivered / Read / Failed / Undelivered / Blocked / Canceled) with rAF tween + pulse animation, Overview / Recipients / Errors tabs, paginated recipient list, CSV export.
- **Branded modal dialogs** replace native `alert`/`confirm`.
- **Dark sidebar layout** with aurora-style background, mobile hamburger, View Transitions API for smooth page navigation.

## Architecture

```
┌──────────────────┐    ┌────────────────────┐    ┌──────────────────┐
│ Browser          │───▶│ Firebase Hosting   │───▶│ Cloud Function   │
│ (vanilla JS)     │    │ (static + rewrites)│    │ "api" (Express)  │
│                  │◀───┤                    │◀───┤                  │
│                  │    └────────────────────┘    └────────┬─────────┘
│                  │                                       │
│                  │◀────────── onSnapshot ────────────────│
│                  │                                       ▼
└──────────────────┘                              ┌──────────────────┐
                                                  │   Firestore      │
                                                  └────────┬─────────┘
                                                           │ document update
                                                           ▼
                                                  ┌──────────────────┐
                                                  │ Cloud Function   │     ┌──────────┐
                                                  │ "processSend"    │────▶│  Twilio  │
                                                  │ (worker)         │     │          │
                                                  └──────────────────┘     └─────┬────┘
                                                                                 │ status callback
                                                                                 ▼
                                                                       /webhooks/twilio/status
```

- **`api`** — HTTP Cloud Function (Gen 2). Mounts the Express app. Handles all authenticated REST endpoints (`/api/**`) and the public Twilio webhook (`/webhooks/twilio/status/:tenantId/:sendId`). Hosting rewrites route to it.
- **`processSend`** — Firestore-triggered Cloud Function (Gen 2). Fires on `tenants/{tenantId}/singleSends/{sendId}` updates. Runs the fan-out worker when status transitions to `sending` or when the worker writes `continuationNonce` to chain to a fresh invocation.
- **Frontend reads Firestore directly** via the JS SDK's `onSnapshot()`. Security rules scope every read to `request.auth.uid == tenant.ownerUid`. All writes go through the backend.

## Tech stack

| Layer | Tools |
|---|---|
| Backend runtime | Node.js 20 ESM, Cloud Functions Gen 2 |
| HTTP | Express 4 |
| Validation | Zod |
| Firestore | `firebase-admin` |
| Twilio | `twilio` |
| Phone normalization | `libphonenumber-js` |
| CSV parsing | `papaparse` (streaming) |
| Multipart upload | `busboy` |
| Rate limiting | `bottleneck` |
| Logging | `pino` + `pino-http` (with redaction) |
| Auth | Firebase Auth (email/password) |
| Frontend | Vanilla JS modules, Firebase JS SDK from CDN, emoji-mart from esm.sh |
| Tests | Jest 29 (ESM via `--experimental-vm-modules`) |

## Prerequisites

1. **Node.js 20** (the deployed Functions runtime is Node 20). Local dev needs Node ≥ 20.
2. **npm** (bundled with Node).
3. **Firebase CLI** — `npm install -g firebase-tools`.
4. **A Google Cloud / Firebase project on the Blaze (pay-as-you-go) plan.** Required because Cloud Functions Gen 2 outbound calls to Twilio (and any non-Google service) are blocked on the free Spark plan. Free-tier quotas still cover typical small-volume usage.
5. **A Twilio account** — at least one verified Messaging Service with a toll-free number (or 10DLC / short code) attached. Each end-user tenant connects their own credentials in Settings.
6. **(Local dev only) `ngrok` or similar tunnel** if you want Twilio webhooks to reach your laptop. Optional; can skip if you don't need to test the status callback path locally.

## First-time setup

### 1. Clone and install

```bash
git clone https://github.com/mark0106/twilio-mc.git
cd twilio-mc
npm run install:all   # installs root + functions/ deps
```

### 2. Create a Firebase project

In the [Firebase Console](https://console.firebase.google.com/):

1. Create a new project.
2. **Upgrade to Blaze plan**: ⚙️ → Usage and billing → Modify plan → Blaze.
3. **Enable Firestore Database**: Build → Firestore Database → Create database → Production mode.
4. **Enable Authentication**: Build → Authentication → Sign-in method → Email/Password → Enable.
5. **Register a web app**: ⚙️ → Project settings → General → Your apps → `</>` icon. Skip Firebase Hosting setup (we configure it separately).

### 3. Get service-account credentials

⚙️ → Project settings → Service accounts → **Generate new private key**. A JSON file downloads. Treat it like a password.

### 4. Configure local `.env`

Create `/.env` (at the project root, not under `functions/`):

```bash
PORT=3000
PUBLIC_BASE_URL=http://localhost:3000
NODE_ENV=development

# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
MASTER_ENCRYPTION_KEY=<32-byte base64 string>

# From the downloaded service-account JSON
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@your-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
```

> `.env` is gitignored. Don't commit it.

### 5. Configure the frontend Firebase config

Edit `web/js/firebase-init.js` and paste your **web app config** (Project settings → General → Your apps → `firebaseConfig`):

```js
export const firebaseConfig = {
  apiKey: 'AIza…',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  storageBucket: 'your-project.firebasestorage.app',
  messagingSenderId: '...',
  appId: '...',
};
```

These values are **not secrets** — they identify the project, not authorize writes. Firestore security rules are what protect data.

### 6. Configure deploy-time function env vars

Edit `functions/.env.<your-project-id>` (e.g. `functions/.env.twilio-mc`):

```bash
PUBLIC_BASE_URL=https://your-project.web.app
TWILIO_SEND_RATE_PER_SECOND=3
```

> `.env` files under `functions/` cannot contain `FIREBASE_*`, `PORT`, or other reserved-prefix keys — Firebase CLI rejects them at deploy time. Only project-scoped non-reserved settings go here.

### 7. Set the master encryption key as a Firebase Secret

The deployed Cloud Function reads `MASTER_ENCRYPTION_KEY` from Firebase Secrets, not from `.env`:

```bash
firebase login
firebase use your-project-id
firebase functions:secrets:set MASTER_ENCRYPTION_KEY
# Paste the same base64 value you set in .env at the prompt.
```

### 8. Deploy

```bash
npm run deploy
```

This deploys Firestore rules + indexes, both Cloud Functions (`api` + `processSend`), and Hosting in one go. First deploy can take a few minutes — the Eventarc Service Agent permissions sometimes need propagation time. If `processSend` fails with a permission error on the first try, wait ~90 seconds and run `npm run deploy:functions` again.

Once deployed, your app lives at `https://<your-project-id>.web.app`.

## Local development

```bash
npm start
```

Starts the Express server on `localhost:3000` (or whatever `PORT` is set to). The same server serves the static `web/` directory AND the API routes, so the frontend can hit `/api/**` with no CORS configuration.

### Hot reload

```bash
npm run dev
```

Uses `node --watch` to restart on backend changes. Frontend changes don't need a restart — just refresh the browser.

### Sign up locally

1. Open `http://localhost:3000/signup.html`.
2. Create an account.
3. Land on the contacts page.
4. Go to Settings → paste a real Twilio SID + Auth Token. The validation hits Twilio's `accounts().fetch()` API to confirm them before encrypting + storing.

### Local webhook testing

Twilio webhooks need to reach a public URL. Use ngrok:

```bash
ngrok http 3000
# Update .env: PUBLIC_BASE_URL=https://abc-123.ngrok.io
# Restart npm start
```

The worker uses `PUBLIC_BASE_URL` to construct the `statusCallback` it hands to Twilio.

## Deployment

| Command | What it does |
|---|---|
| `npm run deploy` | Deploys everything (Firestore rules + indexes, functions, hosting) |
| `npm run deploy:hosting` | Frontend only |
| `npm run deploy:functions` | Cloud Functions only (passes `--force` flag if needed for retry policy) |
| `npm run deploy:rules` | Firestore rules only |

### Production environment variables

The deployed Cloud Function gets its config from:

1. **Firebase Secrets** — `MASTER_ENCRYPTION_KEY` (set via `firebase functions:secrets:set`).
2. **`functions/.env.<projectId>`** — non-secret config like `PUBLIC_BASE_URL` and `TWILIO_SEND_RATE_PER_SECOND`. Auto-loaded by the CLI at deploy time.
3. **Application Default Credentials** — Firebase Admin SDK auto-discovers the service account in Cloud Functions runtime; no `FIREBASE_*` env vars needed in production.

The local-dev `.env` at the project root is only used by `server-local.js` and is ignored by the deploy.

## Testing

```bash
npm test
```

Runs Jest in ESM mode (`--experimental-vm-modules`). Current coverage: 68 tests across crypto, segments, phone, sends state machine, template rendering, and worker yield-budget logic.

## Project structure

```
├── package.json                  # root scripts → delegate to functions/
├── firebase.json                 # hosting + functions + firestore + emulator config
├── firestore.rules               # read scoped by ownerUid; writes server-only
├── firestore.indexes.json
├── .env                          # LOCAL DEV ONLY — gitignored
├── functions/
│   ├── package.json              # backend deps
│   ├── .env.<projectId>          # deploy-time function env vars
│   ├── index.js                  # Cloud Function entrypoints (api, processSend)
│   ├── server-local.js           # local-dev entry (npm start)
│   ├── _load-env.js              # imported first to populate process.env
│   ├── app.js                    # builds the Express app
│   ├── config.js                 # PUBLIC_BASE_URL, TWILIO_SEND_RATE_PER_SECOND
│   ├── firebase.js               # Admin SDK init
│   ├── auth.js                   # verifyFirebaseToken middleware
│   ├── crypto.js                 # AES-256-GCM helpers
│   ├── twilioClient.js           # buildClientForTenant — decrypts auth token
│   ├── segments.js               # GSM-7 / UCS-2 segment math
│   ├── sendsStateMachine.js      # per-recipient transitions + Twilio status mapping
│   ├── counterShards.js          # 50-shard init + helpers
│   ├── template.js               # {name} / {firstName} / {lastName} substitution
│   ├── twilioErrorCodes.js       # error code → human description
│   ├── phone.js                  # libphonenumber-js wrappers
│   ├── routes/
│   │   ├── tenant.js             # tenant init + Twilio connect/disconnect
│   │   ├── contactLists.js       # CSV upload + list CRUD
│   │   ├── messagingServices.js  # live proxy from customer's Twilio
│   │   ├── sends.js              # draft / confirm / cancel / export
│   │   └── webhooks.js           # PUBLIC Twilio status callback (signature-validated)
│   ├── jobs/
│   │   ├── uploadContacts.js     # CSV → Firestore subcollection
│   │   └── sendCampaign.js       # Twilio fan-out with lease + self-yield + cursor
│   └── __tests__/                # Jest suites
└── web/
    ├── images/logo.png           # InvestPub logo
    ├── styles.css
    ├── index.html                # landing
    ├── login.html, signup.html   # auth pages (logo, no sidebar)
    ├── settings.html             # Twilio connect/disconnect
    ├── contacts.html             # contact lists table
    ├── contacts-new.html         # CSV upload
    ├── contacts-detail.html      # list preview + delete
    ├── sends.html                # Single Sends table with live stats
    ├── sends-new.html            # composer
    ├── sends-detail.html         # Overview / Recipients / Errors tabs
    ├── contacts-template.csv     # downloadable CSV template
    └── js/
        ├── firebase-init.js      # web SDK config (paste your project here)
        ├── auth.js               # ID token + auth-state helpers
        ├── api.js                # apiFetch wrapper (auto-prefixes /api)
        ├── nav.js                # dark-sidebar nav renderer
        ├── modal.js              # confirmDialog / alertDialog
        ├── animate-number.js     # rAF tween + pulse for counter tiles
        ├── phone-preview.js      # iOS-Messages-style preview
        ├── segment-counter.js    # mirror of server segments.js for live counts
        ├── twilio-error-codes.js # client mirror of server error code map
        └── pages/                # one module per HTML page
```

## Configuration reference

### Local `.env` (root, gitignored)

| Key | Description |
|---|---|
| `PORT` | Local-dev port for the Express server. Default 3000. |
| `PUBLIC_BASE_URL` | URL Twilio webhooks should call. Local dev: `http://localhost:3000` or your ngrok URL. |
| `NODE_ENV` | `development` locally. |
| `MASTER_ENCRYPTION_KEY` | 32-byte base64. **Must match the Firebase Secret for the deployed function.** Losing it makes every stored Twilio token unrecoverable. |
| `FIREBASE_PROJECT_ID` | From the service account JSON. |
| `FIREBASE_CLIENT_EMAIL` | From the service account JSON. |
| `FIREBASE_PRIVATE_KEY` | From the service account JSON. Keep the `\n` escapes; the code converts them. |

### `functions/.env.<projectId>` (committed)

| Key | Description |
|---|---|
| `PUBLIC_BASE_URL` | Public URL of the deployed app — used by the worker to build the `statusCallback` URL it hands to Twilio. |
| `TWILIO_SEND_RATE_PER_SECOND` | MPS ceiling enforced by Bottleneck. Set to match your slowest tenant's Messaging Service MPS. Default 3 (toll-free verified). |

### Firebase Secrets (set via CLI)

| Secret | Description |
|---|---|
| `MASTER_ENCRYPTION_KEY` | Same 32-byte base64 as local `.env`. Used to decrypt per-tenant Twilio Auth Tokens. |

## API surface

All `/api/**` routes require `Authorization: Bearer <Firebase ID token>`. The webhook is the only public endpoint and is signature-validated per request.

```
GET    /api/tenant/twilio
POST   /api/tenant/twilio                # connect
DELETE /api/tenant/twilio                # disconnect
POST   /api/tenant/init                  # idempotent tenant-doc creation

GET    /api/messaging-services           # live from customer's Twilio

POST   /api/contact-lists                # multipart CSV upload
GET    /api/contact-lists                # list view
GET    /api/contact-lists/:id/preview
DELETE /api/contact-lists/:id

POST   /api/sends                        # create draft
POST   /api/sends/test                   # test SMS
POST   /api/sends/:id/confirm            # flips status, triggers worker
POST   /api/sends/:id/cancel             # for scheduled sends
GET    /api/sends/:id
GET    /api/sends/:id/export.csv

POST   /webhooks/twilio/status/:tenantId/:sendId   # PUBLIC, signature-validated
```

## Firestore data model

```
tenants/{tenantId}
├── ownerUid: string
├── name: string
├── twilioAccountSid: string
├── twilioAuthTokenCiphertext: bytes    # AES-256-GCM
├── twilioAuthTokenIv: bytes
├── twilioAuthTokenAuthTag: bytes
├── twilioConnectedAt: timestamp
└── createdAt: timestamp

tenants/{tenantId}/contactLists/{listId}
├── name, count, status, uploadProgress, region, createdAt, ...
└── contacts/{contactId}
    ├── phone (E.164)
    ├── firstName?, lastName?, customFields?

tenants/{tenantId}/singleSends/{sendId}
├── name, messagingServiceSid, contactListId, contactListName, body
├── encoding, segmentCount, hasEmoji, recipientCount
├── status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'canceling' | 'canceled'
├── scheduledAt, createdAt, confirmedAt, fanOutCompletedAt, sentAt, canceledAt
├── processedCursor, processedQueued, processedFailed   # worker resume
├── workerLeaseExpiresAt, continuationNonce             # worker safety
└── counterShards/{0..49}/
    ├── queued, sent, delivered, read, failed, undelivered, blocked, canceled
└── recipients/{messageSid}/
    ├── to, contactId, status, shardId, errorCode?, errorMessage?, updatedAt
```

## Cost notes

Firebase Hosting + Firestore + the two Cloud Functions stay within free-tier quotas for small-to-medium volumes (under ~50 K function invocations per month, ~50 K Firestore reads per day). Real cost scales with:

- **Twilio** — customer's own account is billed directly; this app doesn't aggregate Twilio costs.
- **Cloud Functions invocations** — each chunked worker invocation is ~9 min of compute, billed per 100 ms. A single 80K send at 3 MPS runs ~50 invocations.
- **Firestore writes** — roughly 2 writes per Twilio message (recipient + shard) + 2-4 status callbacks per message.

## License

This is a private project. Not licensed for redistribution.

## Acknowledgments

Built incrementally across five phases following `sms-campaigns-build-plan.md`. The build plan stays in the repo for historical reference.
