# Twilio SMS Marketing Campaigns — Build Plan

A re-implementation of the SendGrid SMS Marketing Campaigns private beta, where each customer brings their own Twilio Account SID + Auth Token and sends through their own Messaging Services.

**Scale target:** 300,000 messages/day, contact lists up to 300K each.

**Stack:** Node.js + Express backend, vanilla JS frontend (no build step), Firestore for all data and live updates.

---

## 1. Architecture

```
┌─────────────────┐       ┌──────────────┐      ┌──────────────┐
│  Vanilla JS     │──────▶│  Node API    │─────▶│  Customer's  │
│  (HTML + JS)    │       │  (Express)   │      │  Twilio      │
│                 │       │              │◀─────│              │
│                 │       └──────┬───────┘      └──────────────┘
│                 │              │                   status
│                 │              ▼                  callbacks
│                 │       ┌──────────────┐
│                 │◀─────▶│  Firestore   │
└─────────────────┘       └──────────────┘
  direct onSnapshot()
  subscriptions for
  live stat updates
```

**Key idea:** the frontend reads directly from Firestore using the JS SDK's `onSnapshot()` for live updates. The Node backend only handles things that require the customer's Twilio credentials (sending, validating, fetching Messaging Services) or that must be server-only (webhook signature validation, encryption).

---

## 2. Tech Stack

### Backend (Node.js 20 LTS)
| Purpose | Package |
|---|---|
| HTTP | `express` |
| Validation | `zod` |
| Firestore | `firebase-admin` |
| Twilio | `twilio` (build a fresh client per request from customer creds) |
| Segment counting | `@twilio/messaging-segments` |
| CSV parsing | `papaparse` (streaming) |
| Phone validation | `libphonenumber-js` |
| Rate limiting | `bottleneck` |
| In-process queue | `p-queue` |
| Logging | `pino` with redaction filter |

### Frontend (no build step)
- Plain HTML + vanilla JS + CSS
- Firebase JS SDK from CDN (modular, v10+)
- Tailwind via Play CDN for styling (`https://cdn.tailwindcss.com`)
- `emoji-mart` via CDN for the emoji picker
- Multiple HTML pages with shared JS modules — no SPA framework

---

## 3. Firestore Data Model

```
tenants/{tenantId}
├── name: string
├── ownerUid: string                    # Firebase Auth UID
├── twilioAccountSid: string
├── twilioAuthTokenCiphertext: bytes    # AES-256-GCM
├── twilioAuthTokenIv: bytes
├── twilioAuthTokenAuthTag: bytes
├── twilioConnectedAt: timestamp
└── createdAt: timestamp

tenants/{tenantId}/contactLists/{listId}
├── name: string
├── count: number
├── status: 'uploading' | 'ready' | 'error'
├── uploadProgress: { processed: number, total: number, errors: number }
└── createdAt: timestamp

tenants/{tenantId}/contactLists/{listId}/contacts/{contactId}
├── phone: string                       # E.164
├── firstName?: string
├── lastName?: string
└── customFields?: map

tenants/{tenantId}/singleSends/{sendId}
├── name: string
├── senderName: string
├── messagingServiceSid: string
├── contactListId: string
├── contactListName: string             # denormalized
├── recipientCount: number              # denormalized at send time
├── body: string
├── hasEmoji: boolean
├── segmentCount: number
├── encoding: 'GSM-7' | 'UCS-2'
├── scheduledAt: timestamp | null
├── status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'
├── createdAt: timestamp
└── sentAt: timestamp | null

tenants/{tenantId}/singleSends/{sendId}/counterShards/{0..49}
├── queued: number
├── sent: number
├── delivered: number
├── failed: number
├── undelivered: number
└── blocked: number

tenants/{tenantId}/singleSends/{sendId}/recipients/{messageSid}
├── to: string                          # E.164
├── status: 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered' | 'blocked'
├── errorCode?: number
├── errorMessage?: string
└── updatedAt: timestamp
```

### Why distributed counters

Firestore caps writes to a single document at ~1/sec sustained. A 300K send produces 300K status callbacks. Splitting the counters across **50 shards** per Single Send gives ~50 writes/sec of headroom — plenty for any realistic campaign pace.

Each status callback picks a random shard 0-49 and atomically increments the relevant counter using `FieldValue.increment(1)`. The UI reads all 50 shards and sums them client-side (this is fine — `onSnapshot` on a collection of 50 docs is cheap, and listening is push-based, not polled).

---

## 4. Security Model

### Firebase Auth
- Email/password auth via Firebase Auth.
- Each user is the owner of exactly one tenant (v1 — no multi-user tenants yet).
- User UID → tenant lookup via `ownerUid` field.

### Firestore Security Rules
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tenants/{tenantId} {
      allow read: if request.auth.uid == resource.data.ownerUid;
      allow write: if false;  // only backend writes tenant docs

      match /{document=**} {
        allow read: if request.auth.uid == get(/databases/$(database)/documents/tenants/$(tenantId)).data.ownerUid;
        allow write: if false;  // only backend writes
      }
    }
  }
}
```

**All writes go through the backend.** The frontend only reads. This keeps validation, rate limiting, and the encryption boundary on the server.

### Twilio credential encryption
- AES-256-GCM via Node `crypto`.
- Master key from `MASTER_ENCRYPTION_KEY` env var (32 bytes base64).
- For production, swap to Google Cloud KMS — wraps the same DEK pattern.
- **Never log the token.** Pino redaction filter on `req.body.authToken`, `req.body.twilioAuthToken`, and `tenant.twilioAuthToken*`.
- On entry: validate creds by calling `client.api.v2010.accounts(sid).fetch()` before storing.
- "Disconnect" flow wipes the encrypted blob.

### Webhook signature validation
Status callback URL: `/webhooks/twilio/status/:tenantId/:sendId`

For each incoming webhook:
1. Look up tenant by `tenantId` from URL path
2. Decrypt their Auth Token
3. Validate `X-Twilio-Signature` using `twilio.validateRequest(authToken, signature, url, params)`
4. Reject with 403 if invalid

---

## 5. Project Structure

```
sms-campaigns/
├── package.json
├── .env                          # MASTER_ENCRYPTION_KEY, PUBLIC_BASE_URL, FIREBASE_* etc
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── server/
│   ├── index.js                  # Express app entry
│   ├── firebase.js               # Firebase Admin init
│   ├── auth.js                   # verify Firebase ID token middleware
│   ├── crypto.js                 # AES-256-GCM encrypt/decrypt
│   ├── twilioClient.js           # build per-tenant Twilio client
│   ├── segments.js               # wrap @twilio/messaging-segments
│   ├── counterShards.js          # distributed counter helpers
│   ├── routes/
│   │   ├── tenant.js             # connect/disconnect Twilio
│   │   ├── messagingServices.js  # proxy list from customer's Twilio
│   │   ├── contactLists.js       # CRUD + CSV upload
│   │   ├── singleSends.js        # create, list, get, test send, confirm send
│   │   └── webhooks.js           # Twilio status callback handler
│   └── jobs/
│       ├── queue.js              # p-queue + bottleneck setup
│       ├── uploadContacts.js     # CSV → Firestore batched writes
│       └── sendCampaign.js       # iterate contacts, call Twilio API
└── web/
    ├── index.html                # landing → login
    ├── login.html
    ├── signup.html
    ├── settings.html             # connect Twilio
    ├── contacts.html             # list view
    ├── contacts-new.html         # CSV upload
    ├── sends.html                # Single Sends list view
    ├── sends-new.html            # composer
    ├── sends-detail.html         # detail with live stats
    └── js/
        ├── firebase-init.js
        ├── auth.js
        ├── api.js                # wrapper around fetch() with auth header
        ├── phone-preview.js      # the SMS bubble component
        ├── segment-counter.js
        └── pages/
            ├── settings.js
            ├── contacts.js
            ├── contacts-new.js
            ├── sends.js
            ├── sends-new.js
            └── sends-detail.js
```

---

## 6. Phased Build Plan

Hand Claude Code **one phase at a time**. Each phase is independently testable.

---

### Phase 1 — Foundation

**Goal:** Empty app shell with Firebase Auth and the Twilio connection flow.

- [ ] Init repo, `package.json`, ESM modules, Node 20
- [ ] Set up Firebase project (Firestore + Auth enabled); add config to `.env` and `firebase-init.js`
- [ ] Express server with: CORS, JSON body parser, Pino logger with credential redaction, Firebase ID token verification middleware
- [ ] `crypto.js`: AES-256-GCM `encrypt(plaintext)` and `decrypt(ciphertext, iv, authTag)` helpers + Jest tests
- [ ] Frontend pages: `signup.html`, `login.html`, `settings.html` using Firebase Auth JS SDK (email/password)
- [ ] On signup: backend creates `tenants/{tenantId}` doc with `ownerUid`
- [ ] `POST /tenant/twilio`: accepts `{ accountSid, authToken }`, validates via Twilio API, encrypts token, stores ciphertext+iv+authTag in tenant doc
- [ ] `DELETE /tenant/twilio`: wipes the encrypted blob
- [ ] `GET /tenant/twilio`: returns `{ connected: boolean, accountSid?: string }` (never returns the token)
- [ ] Settings page: shows connection status, "Connect" form, "Disconnect" button
- [ ] Firestore security rules deployed (read-only frontend access scoped by `ownerUid`)

**Acceptance:** User can sign up, log in, paste SID/token, see "Connected" status. Disconnect works. Rules deployed and tested with the Firebase emulator's rules tester.

---

### Phase 2 — Contact Lists

**Goal:** Upload CSV → Firestore subcollection → view lists.

- [ ] **Backend** `POST /contact-lists`: multipart upload of name + CSV file
  - Stream-parse CSV with `papaparse` in streaming mode
  - Normalize each row's phone via `libphonenumber-js` (default region from a `?region=US` query param)
  - Reject rows with no normalizable phone; collect into an errors array
  - Create `contactLists/{listId}` doc with `status: 'uploading'`
  - Write contacts in batches of 500 (Firestore batch write limit) using `WriteBatch`
  - Update `uploadProgress` on the list doc every 5K rows for live progress
  - On complete: set `status: 'ready'`, final `count`
  - Return error CSV download URL (errors stored as a Firestore doc or returned inline if <1MB)
- [ ] **Backend** `GET /contact-lists`: returns list of `contactLists` docs for tenant
- [ ] **Backend** `GET /contact-lists/:id/preview`: returns first 20 contacts
- [ ] **Backend** `DELETE /contact-lists/:id`: deletes list + subcollection (use a recursive delete helper; do it in a background task for large lists)
- [ ] **Frontend** `contacts.html`: table of lists (name, count, status, created) with live updates via `onSnapshot` — uploads in progress show a progress bar
- [ ] **Frontend** `contacts-new.html`: file picker + name field + region selector + preview-first-5-rows step + commit button
- [ ] Detail/preview page: shows first 20 contacts + delete button

**Performance target:** 300K-row CSV uploads in under 10 minutes. Use parallel batched writes (5 batches of 500 in flight = 2,500 writes in parallel; Firestore handles this easily under the 10K writes/sec database limit).

**Acceptance:** Upload a 300K-row CSV, watch progress, end up with a `contactLists` doc with `count: 300000` and a populated `contacts` subcollection. Bad rows are reported, not silently dropped.

---

### Phase 3 — Single Send Composer (no actual sending yet)

**Goal:** The composer UI with live preview, segment counter, and test send.

- [ ] **Backend** `GET /messaging-services`: build Twilio client from tenant creds, return `client.messaging.v1.services.list()` — return only `{ sid, friendlyName }` per service
- [ ] **Backend** `POST /sends/test`: body `{ messagingServiceSid, to, body }` → `client.messages.create({ to, messagingServiceSid, body })`; validates `to` is E.164
- [ ] **Backend** `POST /sends`: creates a `singleSends/{sendId}` doc with `status: 'draft'`, all the form fields, computed segment count + encoding
- [ ] **Frontend** `sends-new.html`:
  - Single Send Name input
  - Messaging Service dropdown — fetched live from `/messaging-services`
  - Contact List dropdown — read directly from Firestore via `onSnapshot`
  - Message body textarea with:
    - Live character count `n / 160` (GSM-7) or `n / 70` (UCS-2) — switches when non-GSM-7 char detected
    - Live segment count using `@twilio/messaging-segments` (loaded as ESM from CDN, or computed via backend `POST /sends/segments` helper if CDN build unavailable)
    - Encoding badge: GSM-7 / UCS-2
  - Emoji picker (emoji-mart) — clicking flips encoding to UCS-2
  - Schedule control: radio buttons "Send immediately" / "Schedule for later", `datetime-local` input; validate ≤7 days + ≥15 min in future
  - **Phone preview** component to the right: iOS-style SMS bubble with sender name header, body in bubble, updates as user types
- [ ] Test SMS panel: E.164 input, "Send test" button, success/error inline
- [ ] **Review & Send** button → modal showing all details: name, MS friendly name, list name + recipient count, body, encoding, segments, schedule time
- [ ] Modal "Confirm Send" → calls `POST /sends/:id/confirm` (Phase 4 wires this up; for now just sets status to `'sending'`)

**Acceptance:** Composer feels polished, segment count correct for GSM and emoji content, test SMS arrives on a real phone in <5 sec.

---

### Phase 4 — Sending Engine + Status Callbacks

**Goal:** Actually send to a list, track per-recipient status, support scheduled sends.

- [ ] **Backend** `POST /sends/:id/confirm`:
  - Load Single Send + tenant; verify status `draft`
  - Resolve recipient count from contact list, write to `recipientCount`
  - Initialize 50 counter shards (`counterShards/0` through `counterShards/49`), all counters zero
  - Enqueue a `sendCampaign` job; respond 200 immediately
- [ ] **Backend** `jobs/sendCampaign.js`:
  - p-queue concurrency 1 per Single Send (don't double-process); Bottleneck for outgoing Twilio API calls
  - Iterate `contacts` subcollection in pages of 500 using cursor pagination
  - For each contact, call `client.messages.create({ to, messagingServiceSid, body, statusCallback: '${PUBLIC_BASE_URL}/webhooks/twilio/status/${tenantId}/${sendId}', sendAt?, scheduleType?: 'fixed' })`
  - On success: write `recipients/{messageSid}` doc with `status: 'queued'`; increment a random shard's `queued` counter
  - On `messages.create` failure: write `recipients/{generatedId}` with `status: 'failed'`, errorCode, errorMessage; increment shard's `failed` counter
  - **Twilio throughput:** Messaging Services have configurable throughput (often 10-200 msg/sec depending on number type). Configure Bottleneck `minTime` per the customer's expected throughput; expose this as an env var initially
  - On completion: update Single Send `status: 'sent'`, `sentAt`
- [ ] **Backend** `POST /webhooks/twilio/status/:tenantId/:sendId`:
  - Validate `X-Twilio-Signature` using the tenant's decrypted Auth Token (lookup tenant by ID from URL)
  - Reject with 403 if invalid
  - Map Twilio status → internal status:
    - `delivered` → `delivered`
    - `failed` → check error code: 30007 or 21610 → `blocked`; else `failed`
    - `undelivered` → check error code: 30003/30004/30005 → `undelivered`; 21610 → `blocked`; else `undelivered`
    - `sent` → `sent` (intermediate)
  - **Idempotency:** use a Firestore transaction. Read current `recipients/{messageSid}.status`. Only update + increment counter if the transition is "forward" (queued → sent → delivered, etc). Skip duplicates and out-of-order callbacks.
  - When incrementing counter: pick a shard via `Math.floor(Math.random() * 50)`; if transitioning from `queued` to `sent`, decrement `queued` and increment `sent` on the same shard atomically
- [ ] Idempotency table: define the legal transitions in code as a constant; reject anything else silently

**Twilio scheduled sends details:**
- Requires Messaging Service (not a `from` number) ✓
- `scheduleType: 'fixed'`, `sendAt` as ISO timestamp
- Must be ≥15 min in the future and ≤7 days out
- Validate in `POST /sends/:id/confirm` before fan-out
- For scheduled sends, all `messages.create` calls happen immediately (creating scheduled messages in Twilio); Twilio holds them until `sendAt`
- Status callbacks still fire normally when the scheduled time arrives

**Acceptance:** Send to a 1,000-contact test list, watch all 1,000 messages arrive, watch counters increment in near real-time. Schedule a send for 20 minutes out — confirm it arrives at the scheduled time. Restart the Node server mid-campaign — confirm no duplicate sends (idempotency on `recipients/{messageSid}` prevents this).

---

### Phase 5 — Single Sends List View + Detail View with Live Stats

**Goal:** The list view from the requirements, plus a live detail view.

- [ ] **Frontend** `sends.html`:
  - Table columns: Name | Status | Sent | Delivered | Failed | Undelivered | Blocked | Created
  - Reads from `singleSends` collection via `onSnapshot`
  - For each row, separate `onSnapshot` listener on the `counterShards` subcollection — sum client-side
  - Sortable by created date; filterable by status
  - "New Single Send" button → `sends-new.html`
- [ ] **Frontend** `sends-detail.html`:
  - Top: same stat tiles, live-updating
  - Body preview, MS name, list name, schedule time, sent time
  - Tabs: Overview | Recipients | Errors
  - Recipients tab: paginated `recipients` subcollection, filter by status
  - Errors tab: filter to `failed` + `undelivered` + `blocked`, show error code + Twilio's standard error description (maintain a static error code → description map; reference Twilio's error code docs)
  - "Export results as CSV" → calls `GET /sends/:id/export.csv` (backend streams a CSV with all recipients + statuses)
- [ ] Header row stat tiles use CSS counters that animate when values change (smooth UX)

**Acceptance:** Matches the layout exactly: `Single Send Name | Sent | Delivered | Failed | Undelivered | Blocked`. Stats update live without page refresh during an active send.

---

## 7. API Surface

```
# Auth handled by Firebase Auth on the frontend; backend verifies Firebase ID token
# All endpoints require Authorization: Bearer <Firebase ID token>

GET    /tenant/twilio                                    # connection status
POST   /tenant/twilio                                    # connect
DELETE /tenant/twilio                                    # disconnect

GET    /messaging-services                               # live from customer's Twilio

POST   /contact-lists                                    # multipart CSV upload
GET    /contact-lists/:id/preview                        # first 20 contacts
DELETE /contact-lists/:id

POST   /sends                                            # create draft
POST   /sends/:id/test                                   # test SMS
POST   /sends/:id/confirm                                # actually send
GET    /sends/:id/export.csv                             # results CSV

POST   /webhooks/twilio/status/:tenantId/:sendId         # PUBLIC; signature-validated
```

**Frontend reads** (no backend involved):
- `tenants/{tenantId}` (own doc)
- `tenants/{tenantId}/contactLists/*`
- `tenants/{tenantId}/singleSends/*` and subcollections (live stats!)

---

## 8. Environment Variables

```
# Server
PORT=3000
PUBLIC_BASE_URL=https://app.example.com           # used in Twilio statusCallback
MASTER_ENCRYPTION_KEY=                            # 32-byte base64
NODE_ENV=production

# Firebase Admin
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=                             # service account JSON private_key

# Sending throughput (tune per Messaging Service capacity)
TWILIO_SEND_RATE_PER_SECOND=50

# Counter sharding
COUNTER_SHARD_COUNT=50
```

Frontend gets the public Firebase config (apiKey, authDomain, projectId, etc) inlined into `firebase-init.js` — these are not secrets.

---

## 9. Gotchas (call these out to Claude Code explicitly)

1. **Segment math is not string length.** Use `@twilio/messaging-segments` — emoji, accented characters, even some smart quotes silently flip to UCS-2 (70 chars/segment, 67 in multipart).
2. **Firestore single-doc write limit ~1/sec sustained.** Never let counters live on a single document at this scale — always shard. The plan does this.
3. **Status callbacks can arrive out of order and repeat.** Idempotency is enforced by reading `recipients/{messageSid}.status` in a transaction before incrementing. Define forward-only transitions: `queued → sent → delivered`, and treat anything backwards as a no-op.
4. **Webhook signature validation is per-tenant.** Each tenant has their own Auth Token. URL path must carry `tenantId` so we can look up the right token before validating.
5. **`messagingServiceSid` belongs to the customer.** The dropdown is a live API call to the customer's Twilio account, not a cached value.
6. **Twilio scheduled messages must use a Messaging Service**, `scheduleType: 'fixed'`, time ≥15 min out and ≤7 days out. Validate before fan-out.
7. **E.164 normalization.** Use `libphonenumber-js` with a default region. Store only E.164; reject anything that can't be normalized — never silently send to a malformed number.
8. **Local dev needs ngrok** so Twilio can reach the status callback URL.
9. **Don't load 300K contacts into memory at send time.** Stream the Firestore subcollection page by page (500 docs per page) using cursor pagination.
10. **Auth Token must never appear in logs.** Configure Pino's redact paths: `['req.body.authToken', 'req.body.twilioAuthToken', 'tenant.twilioAuthToken*', 'req.headers.authorization']`.
11. **CSV uploads can crash on bad encoding.** Detect BOM, handle CRLF, use papaparse's `skipEmptyLines` and `transformHeader`. Cap upload size in Express (e.g. 100MB) to prevent OOM.
12. **Firestore composite indexes:** when filtering Single Sends by status + sorting by createdAt, add a composite index. Define in `firestore.indexes.json` from the start.

---

## 10. How to feed this to Claude Code

Run **one Claude Code session per phase**. Don't ask it to build multiple phases at once — it will over-scaffold and conflate concerns.

**Phase 1 kickoff prompt:**
> Read `sms-campaigns-build-plan.md` in the repo root. Implement **Phase 1 only**. Set up: Node 20 ESM project, Express server with Pino logging and Firebase ID token verification middleware, Firebase Admin SDK init, AES-256-GCM encryption helpers with Jest tests, Firestore security rules, frontend signup/login/settings pages using Firebase Auth JS SDK from CDN, and the Twilio connect/disconnect flow. Do not implement contact lists, sends, or webhooks. Acceptance: I can sign up, log in, paste a real Twilio SID/token, see "Connected", and the encrypted token is in Firestore.

**Phase 2 kickoff:**
> Read `sms-campaigns-build-plan.md`. Phase 1 is complete. Implement **Phase 2 only**: contact list CSV upload using Firestore. Use streaming papaparse, libphonenumber-js for E.164 normalization, batched Firestore writes (500/batch, up to 5 batches in flight), progress updates on the contactLists doc, frontend live progress bar via onSnapshot. Do not touch Single Sends.

**Phase 3:**
> Read `sms-campaigns-build-plan.md`. Phases 1-2 complete. Implement **Phase 3 only**: the Single Send composer UI plus the messaging services endpoint and test SMS endpoint. Build the phone preview component, live segment counter using @twilio/messaging-segments, emoji picker, schedule control with validation. Confirm Send only creates a draft — actual sending is Phase 4.

**Phase 4:**
> Read `sms-campaigns-build-plan.md`. Phases 1-3 complete. Implement **Phase 4 only**: the sending engine and status callback webhook. p-queue + Bottleneck for fan-out, distributed counter shards (50 per send), transactional idempotent webhook handler, scheduled send support via Twilio native scheduling. Test with a 1,000-contact list end-to-end.

**Phase 5:**
> Read `sms-campaigns-build-plan.md`. Phases 1-4 complete. Implement **Phase 5 only**: the Single Sends list view and detail view, both with live stats via onSnapshot on counterShards subcollection. CSV export endpoint. Recipient and error tabs.

---

## 11. Explicit non-goals (for v1)

- A/B testing on message body
- Recurring/automated campaigns (drip)
- Inbound `STOP` / `UNSUBSCRIBE` handling (the Messaging Service handles this natively; surface opt-outs as `blocked` in stats)
- Link click tracking
- Personalization tokens like `{{first_name}}` (easy add later — data is already in the contact doc)
- Multi-user roles within a tenant
- Cloud Tasks / horizontal worker scaling (in-process p-queue is fine up to ~500K msg/day on a single instance; revisit if you grow past that)