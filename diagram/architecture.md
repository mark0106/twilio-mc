# Twilio SMS Campaigns — Architecture Diagrams

All diagrams below are written in [Mermaid](https://mermaid.js.org/). GitHub renders them inline. For local preview, use the VS Code Mermaid extension or `npx @mermaid-js/mermaid-cli -i architecture.md`.

---

## 1. System overview

The bird's-eye view of every running component and the network paths between them.

```mermaid
flowchart LR
    subgraph Client["Browser (vanilla JS, no build step)"]
        UI["UI pages<br/>signup · login · contacts · sends · settings"]
    end

    subgraph Firebase["Firebase / GCP Project"]
        Hosting["Firebase Hosting<br/>(static + URL rewrites)"]
        API["Cloud Function 'api'<br/>Gen 2 HTTP · Express<br/>1 GiB · 600 s"]
        Worker["Cloud Function 'processSend'<br/>Gen 2 Firestore trigger<br/>2 GiB · 540 s · retry:true"]
        FS[("Firestore<br/>tenants/{uid}/...")]
        Auth["Firebase Auth<br/>email/password"]
        Secrets["Firebase Secrets<br/>MASTER_ENCRYPTION_KEY"]
    end

    Twilio["Twilio (per-tenant)<br/>Messaging Service · TFN @ 3 MPS"]

    UI -->|"HTTPS /api/** · Bearer token"| Hosting
    UI -->|"onSnapshot (live reads)"| FS
    UI -->|"signInWithEmailAndPassword<br/>getIdToken()"| Auth
    Hosting -->|"/api/** · /webhooks/**"| API
    API -->|"verifyIdToken"| Auth
    API -->|"read/write<br/>(scoped to req.user.uid)"| FS
    API -->|"messages.create<br/>messages(sid).update"| Twilio
    API -.->|"reads MASTER_ENCRYPTION_KEY<br/>at cold start"| Secrets
    FS -->|"onDocumentUpdated trigger<br/>(status flip · nonce bump)"| Worker
    Worker -->|"messages.create<br/>(Bottleneck-rate-limited)"| Twilio
    Worker -->|"transactional shard updates<br/>cursor + lease writes"| FS
    Worker -.->|"reads MASTER_ENCRYPTION_KEY"| Secrets
    Twilio -->|"POST /webhooks/twilio/status<br/>X-Twilio-Signature"| Hosting

    classDef cloud fill:#243d81,color:#fff,stroke:#1a2d60,stroke-width:1px
    classDef store fill:#fef3c7,color:#92400e,stroke:#d97706
    classDef ext fill:#fee2e2,color:#991b1b,stroke:#b91c1c
    class Hosting,API,Worker,Auth,Secrets cloud
    class FS store
    class Twilio ext
```

---

## 2. Single Send lifecycle (sequence)

How a Single Send moves from a user clicking "Confirm" through fan-out to Twilio and the resulting status callbacks updating the UI in real time.

```mermaid
sequenceDiagram
    actor User
    participant UI as Browser
    participant API as api Function
    participant FS as Firestore
    participant Worker as processSend Worker
    participant T as Twilio

    User->>UI: Fill composer, click "Review & Send" → Confirm
    UI->>API: POST /api/sends (draft body)
    API->>FS: Write singleSends/{id} {status:'draft', body, segmentCount, ...}
    API-->>UI: { sendId }

    UI->>API: POST /api/sends/{id}/confirm
    API->>FS: Init 50 counter shards (all counters = 0)
    API->>FS: Update {status:'sending', recipientCount, processedCursor:null}
    API-->>UI: 200 OK (returns immediately)

    Note over FS,Worker: Firestore trigger fires on status → 'sending'<br/>OR on later continuationNonce bumps
    FS->>Worker: Eventarc trigger
    Worker->>FS: Transactional lease claim (workerLeaseExpiresAt)
    Worker->>FS: Read send doc + cursor + Twilio creds (decrypted)

    loop For each contact page (500 docs)
        loop Per contact (Bottleneck @ 3 MPS)
            Worker->>T: messages.create({to, body, statusCallback, sendAt?})
            T-->>Worker: { sid: SMxxxx, status: 'queued' }
            Worker->>FS: Tx: write recipients/{sid} + shard.queued += 1
        end
        Worker->>FS: Update processedCursor + extend lease
    end

    alt Time budget exhausted (~480s)
        Worker->>FS: Release lease + bump continuationNonce
        Note over FS,Worker: Trigger re-fires on nonce change → fresh worker resumes
        FS->>Worker: Eventarc trigger (continuation)
    end

    Worker->>FS: Update {status:'scheduled' or 'sending', fanOutCompletedAt}
    Note over T: Twilio holds scheduled msgs until sendAt;<br/>immediate sends go out now

    loop For each delivered/failed message
        T-->>API: POST /webhooks/twilio/status (X-Twilio-Signature)
        API->>API: Decrypt tenant authToken + validate signature
        API->>FS: Tx: update recipient status + swap shard counter
        FS-->>UI: onSnapshot pushes new counter values
        UI->>UI: Animate tile to new value
    end

    Note over API,FS: After each terminal callback, sum (queued + sent) across<br/>all 50 shards. When 0, flip send doc → status:'sent'
```

---

## 3. Per-recipient state machine

Every `recipients/{messageSid}` document advances through these states. Transitions are **forward-only** and enforced by `canTransition()` inside the webhook transaction — duplicate or out-of-order Twilio callbacks are silent no-ops.

```mermaid
stateDiagram-v2
    [*] --> queued: messages.create OK
    [*] --> failed_init: messages.create rejected

    queued --> sent: Twilio handed to carrier
    queued --> delivered: direct delivery
    queued --> failed: carrier rejected
    queued --> undelivered: unreachable handset
    queued --> blocked: STOP / opt-out (30007 / 21610)
    queued --> canceled: scheduled send canceled by user

    sent --> delivered: carrier confirmation
    sent --> failed
    sent --> undelivered
    sent --> blocked

    delivered --> read: RCS read receipt

    failed_init --> [*]
    failed --> [*]
    undelivered --> [*]
    blocked --> [*]
    canceled --> [*]
    read --> [*]

    note right of delivered
        Not terminal — RCS can
        still fire a 'read' refinement
    end note
```

Error-code → internal-status mapping (see `functions/sendsStateMachine.js#mapTwilioStatus`):

| Twilio MessageStatus | ErrorCode | Internal status |
|---|---|---|
| `delivered` | — | `delivered` |
| `read` | — | `read` |
| `sent` | — | `sent` |
| `failed` | `30007` or `21610` | `blocked` |
| `failed` | any other | `failed` |
| `undelivered` | `21610` | `blocked` |
| `undelivered` | `30003`/`30004`/`30005` | `undelivered` |
| `undelivered` | any other | `undelivered` |
| `canceled` | — | `canceled` |
| anything else | — | (no state change) |

---

## 4. Send-level state machine

The parent `singleSends/{sendId}` document has its own status, which is a function of the worker's progress AND aggregate recipient state. The webhook handler advances this status as delivery progresses.

```mermaid
stateDiagram-v2
    [*] --> draft: POST /api/sends
    draft --> sending: POST /api/sends/:id/confirm (immediate or scheduled)
    sending --> scheduled: worker finishes fan-out + scheduledAt is set
    sending --> sent: worker fan-out done AND 0 recipients in-flight
    scheduled --> sending: 1st delivery callback (Twilio releases held messages)
    sending --> sent: shard sum(queued + sent) reaches 0
    scheduled --> canceling: user clicks Cancel Send
    canceling --> canceled: every queued recipient canceled with Twilio

    sent --> [*]
    canceled --> [*]

    note right of sending
        Worker continuation:
        self-yields at 480s,
        bumps continuationNonce,
        re-trigger picks up from
        processedCursor
    end note
```

---

## 5. Firestore data model

Multi-tenant, root collection is `tenants`. Every read/write from the backend is scoped to `tenantRef(req.user.uid)` so cross-tenant access is structurally impossible.

```mermaid
erDiagram
    TENANT ||--o{ CONTACT_LIST : owns
    TENANT ||--o{ SINGLE_SEND : owns
    CONTACT_LIST ||--o{ CONTACT : contains
    SINGLE_SEND ||--|{ COUNTER_SHARD : "50 shards"
    SINGLE_SEND ||--o{ RECIPIENT : has

    TENANT {
        string ownerUid PK "Firebase UID"
        string twilioAccountSid
        bytes  twilioAuthTokenCiphertext "AES-256-GCM"
        bytes  twilioAuthTokenIv "12 bytes"
        bytes  twilioAuthTokenAuthTag "16 bytes"
        timestamp twilioConnectedAt
        timestamp createdAt
    }
    CONTACT_LIST {
        string id PK "auto-id"
        string name
        number count
        enum   status "uploading|ready|error"
        map    uploadProgress
        string region "default E.164 region"
        timestamp createdAt
    }
    CONTACT {
        string id PK "auto-id"
        string phone "E.164"
        string firstName
        string lastName
        map    customFields
    }
    SINGLE_SEND {
        string id PK "auto-id"
        string name
        string messagingServiceSid
        string contactListId
        string contactListName "denormalized"
        number recipientCount "denormalized at confirm"
        string body
        enum   encoding "GSM-7|UCS-2"
        number segmentCount
        boolean hasEmoji
        timestamp scheduledAt
        enum   status "draft|sending|scheduled|sent|canceling|canceled|failed"
        timestamp createdAt
        timestamp confirmedAt
        timestamp fanOutCompletedAt
        timestamp sentAt
        timestamp canceledAt
        string processedCursor "worker resume pointer"
        number processedQueued
        number processedFailed
        timestamp workerLeaseExpiresAt "worker lock TTL"
        number continuationNonce "worker self-yield signal"
    }
    COUNTER_SHARD {
        string id PK "0..49"
        number queued
        number sent
        number delivered
        number read
        number failed
        number undelivered
        number blocked
        number canceled
    }
    RECIPIENT {
        string messageSid PK "Twilio SID"
        string to "E.164"
        string contactId "ref to CONTACT.id"
        enum   status "queued|sent|delivered|read|failed|undelivered|blocked|canceled"
        number shardId "0..49 — which shard counts this recipient"
        number errorCode
        string errorMessage
        timestamp createdAt
        timestamp updatedAt
    }
```

Firestore document paths:

```
tenants/{uid}
tenants/{uid}/contactLists/{listId}
tenants/{uid}/contactLists/{listId}/contacts/{contactId}
tenants/{uid}/singleSends/{sendId}
tenants/{uid}/singleSends/{sendId}/counterShards/{0..49}
tenants/{uid}/singleSends/{sendId}/recipients/{messageSid}
```

Security rules:
- **Reads** are scoped to `request.auth.uid == ownerUid` (recursively for all subcollections).
- **Writes** from the client are denied entirely. Every mutation goes through the Cloud Function.

---

## 6. Request routing through Firebase Hosting

How a single URL gets to the right backend.

```mermaid
flowchart TD
    Req["Incoming request<br/>https://app.web.app/{path}"]
    Hosting{"Firebase Hosting<br/>(rewrite rules)"}

    Hosting -->|"matches /api/**"| API["api Function<br/>verifyFirebaseToken middleware → routes"]
    Hosting -->|"matches /webhooks/**"| API
    Hosting -->|"matches /health"| API
    Hosting -->|"static file exists (with cleanUrls)"| Static["Serve from /web<br/>(index.html, login.html, ...)"]
    Hosting -->|"no match"| NotFound["404"]

    API --> RoutesAuth["Authenticated routes:<br/>/api/tenant/*<br/>/api/contact-lists/*<br/>/api/messaging-services<br/>/api/sends/*"]
    API --> RoutesPublic["Public webhook:<br/>/webhooks/twilio/status/:tenantId/:sendId<br/>(X-Twilio-Signature validated)"]

    classDef cloud fill:#243d81,color:#fff,stroke:#1a2d60
    classDef static fill:#f8f3ef,color:#111,stroke:#d1d5db
    class API,RoutesAuth,RoutesPublic cloud
    class Static static
```

Why `/api/**` and not bare paths: Firebase Hosting's `cleanUrls: true` matches `/sends` to the static `sends.html` file *before* trying rewrites. Putting authenticated APIs under `/api` avoids the static/dynamic collision.

---

## 7. Multi-chunk worker invocation

Why one logical "Single Send" can take 50+ Cloud Function invocations to deliver — and how the cursor + lease + nonce primitives chain them safely.

```mermaid
sequenceDiagram
    participant FS as Firestore
    participant T as Eventarc Trigger
    participant W1 as Worker invocation #1
    participant W2 as Worker invocation #2
    participant WN as Worker invocation #N
    participant Twilio

    Note over FS: status: 'sending', processedCursor: null
    FS->>T: doc updated (status flip)
    T->>W1: Fire (timeout: 540s)
    W1->>FS: Tx: claim lease (9 min TTL)
    W1->>FS: Update processedCursor as each<br/>500-doc page completes
    W1->>Twilio: messages.create × N (Bottleneck @ 3 MPS)

    Note over W1: After ~480s of work,<br/>shouldYield() returns true

    W1->>FS: Release lease + bump continuationNonce
    W1->>W1: Return cleanly (no error)

    FS->>T: doc updated (nonce changed)
    T->>W2: Fire
    W2->>FS: Tx: claim new lease (old expired)
    W2->>FS: Read processedCursor → resume from contact #X
    W2->>Twilio: messages.create × N

    Note over W2: 480s later... self-yield again
    W2->>FS: Bump nonce
    Note over W2,WN: ... repeat for as many chunks as needed ...

    FS->>T: doc updated
    T->>WN: Fire (final chunk)
    WN->>Twilio: messages.create × N (last batch)
    WN->>FS: status: 'scheduled' (if scheduledAt) or 'sending'<br/>+ release lease, clear nonce
```

Crash semantics:
- If a worker invocation crashes mid-chunk (timeout, OOM, unhandled exception), the lease (`workerLeaseExpiresAt`) eventually expires (~9 minutes after claim).
- `retry: true` on the Eventarc trigger causes Eventarc to redeliver the event with exponential backoff. The retry's worker tries to claim the lease; once expired, it succeeds and resumes from `processedCursor`.
- Cursor is per-page, so at most 500 contacts could be retried — but each Twilio call uses the contact's stable doc ID as the cursor key, and the `recipients/{messageSid}` doc would already exist for already-processed contacts. Duplicate `messages.create` is prevented by the cursor advancing past completed pages.

---

## 8. Authentication flow

How a user's credentials become a backend-authenticated request.

```mermaid
sequenceDiagram
    actor User
    participant UI as Browser
    participant Auth as Firebase Auth
    participant API as api Function

    User->>UI: Enter email + password
    UI->>Auth: signInWithEmailAndPassword(email, pw)
    Auth-->>UI: User object (auth state changes)
    UI->>UI: Stored ID token in IndexedDB (scoped to origin)

    Note over UI,API: For every backend call from now on

    UI->>Auth: getIdToken() (refreshes if near expiry)
    Auth-->>UI: JWT (signed by Google)
    UI->>API: Authorization: Bearer <ID token>
    API->>API: verifyIdToken(token) — checks signature, expiry, audience, revocation
    API->>API: req.user = { uid, email }

    Note over API: Every Firestore op in the request uses<br/>tenantRef(req.user.uid) — no cross-tenant access
```

ID tokens expire after 1 hour. The Firebase JS SDK auto-refreshes them before expiry. Server-side verification calls Google's public-key cache.

---

## 9. Twilio webhook signature validation

Why an attacker can't forge status callbacks.

```mermaid
sequenceDiagram
    participant T as Twilio
    participant H as Firebase Hosting
    participant API as api Function
    participant FS as Firestore

    T->>T: Sign request:<br/>HMAC-SHA1(authToken, full_url + sorted_params)
    T->>H: POST https://app.web.app/webhooks/twilio/status/{tenantId}/{sendId}<br/>Body: MessageSid, MessageStatus, ErrorCode, ...<br/>Header: X-Twilio-Signature: <base64 hmac>
    H->>API: rewrite to /webhooks/...

    API->>FS: Read tenants/{tenantId}
    alt Tenant not found OR no Twilio token stored
        API-->>T: 403 forbidden
    end
    API->>API: Decrypt twilioAuthToken (AES-256-GCM)
    API->>API: twilio.validateRequest(authToken, signature, PUBLIC_BASE_URL + req.originalUrl, params)
    alt Signature invalid
        API-->>T: 403 invalid signature
    end
    API->>FS: Transactional state update
    API-->>T: 200 ok
```

**Why this is safe even with the URL containing public IDs:**

- An attacker would need to compute a valid HMAC-SHA1 over the request, which requires the tenant's Twilio Auth Token.
- The Auth Token is AES-256-GCM-encrypted in Firestore. Decryption requires the `MASTER_ENCRYPTION_KEY` Firebase Secret, which only the Cloud Functions runtime has access to.
- Without the Auth Token, every forged request returns 403.
- If an attacker did compromise the customer's Twilio account, they already have far more than just webhook access.

---

## 10. Encryption flow for stored Twilio credentials

Each tenant's Twilio Auth Token is AES-256-GCM-encrypted using a single master key.

```mermaid
flowchart LR
    Token["Plaintext Auth Token<br/>e.g. abc123…"]
    Master["MASTER_ENCRYPTION_KEY<br/>32 bytes / 256 bits"]
    IV["Random 12-byte IV<br/>(per encryption)"]
    Cipher["AES-256-GCM cipher"]
    CT["Ciphertext + Auth Tag"]

    Token --> Cipher
    Master --> Cipher
    IV --> Cipher
    Cipher --> CT
    CT -->|stored in Firestore as bytes| FS[("tenants/{uid}<br/>twilioAuthTokenCiphertext<br/>twilioAuthTokenIv<br/>twilioAuthTokenAuthTag")]

    classDef secret fill:#fef3c7,color:#92400e,stroke:#d97706
    classDef key fill:#fee2e2,color:#991b1b,stroke:#b91c1c
    class Token,Master,IV secret
    class CT,FS key
```

- The master key never leaves the Cloud Functions runtime memory.
- Decryption only happens at the moment a Twilio API call is needed (signature validation, fan-out, cancel).
- The Auth Tag (GCM's MAC) ensures tampering with the stored ciphertext or IV is detected — `decipher.final()` throws.

---

## How to update these diagrams

Edit this file. Mermaid blocks are plain text — no rendering toolchain required. GitHub renders them natively in this README; locally use `npx @mermaid-js/mermaid-cli@latest -i architecture.md -o architecture.svg` to produce SVGs if you want to drop them into a presentation or doc.
