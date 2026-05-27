import Bottleneck from 'bottleneck';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { buildClientForTenant } from '../twilioClient.js';
import {
  SHARD_COUNT,
  pickShardId,
  shardRef,
  initCounterShards,
} from '../counterShards.js';
import {
  PUBLIC_BASE_URL,
  TWILIO_SEND_RATE_PER_SECOND,
} from '../config.js';
import { renderTemplate } from '../template.js';

const PAGE_SIZE = 500;

// How long we let the worker run before voluntarily yielding. The Cloud
// Functions timeout is 540s; we yield at 480s to leave headroom for the
// graceful shutdown writes (cursor + nonce) to complete.
const WORKER_BUDGET_MS = 480 * 1000;

// How long a worker holds the lease before it auto-expires. Longer than
// WORKER_BUDGET_MS so the lease is always valid while a worker runs, but
// not so long that a crashed worker blocks resumption for too long.
const LEASE_DURATION_MS = 9 * 60 * 1000; // 9 minutes

/**
 * Returns true when the worker has used its time budget and should yield
 * (persist cursor, schedule a continuation, exit cleanly).
 *
 * Exported for tests.
 */
export function shouldYield(startedAtMs, now = Date.now(), budgetMs = WORKER_BUDGET_MS) {
  return now - startedAtMs >= budgetMs;
}

// Fans out a Single Send to Twilio. Called by the Eventarc Firestore trigger
// when singleSends/{sendId}.status transitions to 'sending', and again on
// every continuationNonce bump (which the worker writes when self-yielding).
//
// Concurrency safety: a transactional lease (workerLeaseExpiresAt) ensures
// only one worker processes a given send at a time. If a worker crashes the
// lease auto-expires after LEASE_DURATION_MS and the next invocation claims.
//
// Restart safety: processedCursor is the resume pointer. Re-running picks up
// where the previous left off — no duplicate Twilio calls.
export async function runSendCampaign({ tenantId, sendId, log = console }) {
  const startedAt = Date.now();
  const tenantRef = db.collection('tenants').doc(tenantId);
  const sendRef = tenantRef.collection('singleSends').doc(sendId);
  const recipientsRef = sendRef.collection('recipients');

  // --- Pre-checks ---
  const sendSnap = await sendRef.get();
  if (!sendSnap.exists) {
    log.warn?.({ tenantId, sendId }, 'send doc gone before worker started');
    return;
  }
  const send = sendSnap.data();

  if (send.status === 'sent' || send.status === 'failed') {
    log.info?.({ tenantId, sendId, status: send.status }, 'already terminal');
    return;
  }
  if (send.status !== 'sending') {
    log.warn?.({ tenantId, sendId, status: send.status }, 'unexpected status');
    return;
  }

  // --- Lease claim ---
  // Only one worker may process a send at a time. We atomically claim a
  // lease that auto-expires; a crashed worker can't deadlock the send.
  const leaseClaimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(sendRef);
    if (!snap.exists) return false;
    const d = snap.data();
    if (d.status !== 'sending') return false;
    const expiresAt = d.workerLeaseExpiresAt?.toMillis?.() || 0;
    if (expiresAt > Date.now()) return false; // someone else has it
    tx.update(sendRef, {
      workerLeaseExpiresAt: Timestamp.fromMillis(Date.now() + LEASE_DURATION_MS),
    });
    return true;
  });
  if (!leaseClaimed) {
    log.info?.({ tenantId, sendId }, 'lease held by another worker, exiting');
    return;
  }

  const { client } = await buildClientForTenant(tenantId);

  // statusCallback URL — Hosting rewrites /webhooks/twilio/status/** to the
  // api function.
  const statusCallback = `${PUBLIC_BASE_URL}/webhooks/twilio/status/${tenantId}/${sendId}`;

  // Scheduled-send args. Twilio requires sendAt + scheduleType:'fixed' with
  // a Messaging Service.
  const scheduleArgs = {};
  if (send.scheduledAt) {
    const sendAt = send.scheduledAt.toDate();
    scheduleArgs.sendAt = sendAt;
    scheduleArgs.scheduleType = 'fixed';
  }

  const limiter = new Bottleneck({
    minTime: Math.max(1, Math.round(1000 / TWILIO_SEND_RATE_PER_SECOND)),
    maxConcurrent: Math.max(1, Math.min(50, TWILIO_SEND_RATE_PER_SECOND)),
  });

  const contactsRef = tenantRef
    .collection('contactLists')
    .doc(send.contactListId)
    .collection('contacts');

  let lastDocId = send.processedCursor || null;
  let totalQueued = send.processedQueued || 0;
  let totalFailed = send.processedFailed || 0;

  log.info?.(
    {
      tenantId,
      sendId,
      resumeFrom: lastDocId,
      rate: TWILIO_SEND_RATE_PER_SECOND,
      alreadyQueued: totalQueued,
    },
    'send campaign worker started'
  );

  let yielded = false;

  while (true) {
    let q = contactsRef.orderBy('__name__').limit(PAGE_SIZE);
    if (lastDocId) q = q.startAfter(lastDocId);

    const snap = await q.get();
    if (snap.empty) break;

    // Schedule all page sends through the limiter, then await the page so we
    // get natural backpressure between pages.
    const tasks = snap.docs.map((doc) => {
      const contactId = doc.id;
      const contactData = doc.data();
      const phone = contactData.phone;
      const personalizedBody = renderTemplate(send.body, contactData);

      return limiter.schedule(async () => {
        let msg;
        try {
          msg = await client.messages.create({
            to: phone,
            messagingServiceSid: send.messagingServiceSid,
            body: personalizedBody,
            statusCallback,
            ...scheduleArgs,
          });
        } catch (err) {
          const shardId = pickShardId();
          await db.runTransaction(async (tx) => {
            const recRef = recipientsRef.doc();
            tx.set(recRef, {
              to: phone,
              contactId,
              status: 'failed',
              shardId,
              errorCode: err.code ?? null,
              errorMessage: err.message ?? null,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
            tx.update(shardRef(tenantId, sendId, shardId), {
              failed: FieldValue.increment(1),
            });
          });
          return { ok: false };
        }

        const shardId = pickShardId();
        await db.runTransaction(async (tx) => {
          tx.set(recipientsRef.doc(msg.sid), {
            to: phone,
            contactId,
            status: 'queued',
            shardId,
            messagingServiceSid: send.messagingServiceSid,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          tx.update(shardRef(tenantId, sendId, shardId), {
            queued: FieldValue.increment(1),
          });
        });
        return { ok: true };
      });
    });

    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.ok) totalQueued++;
      else totalFailed++;
    }

    lastDocId = snap.docs[snap.docs.length - 1].id;

    // Persist progress after each page.
    await sendRef.update({
      processedCursor: lastDocId,
      processedQueued: totalQueued,
      processedFailed: totalFailed,
      // Extend the lease as we work, so a slow worker doesn't lose it.
      workerLeaseExpiresAt: Timestamp.fromMillis(Date.now() + LEASE_DURATION_MS),
    });

    if (snap.docs.length < PAGE_SIZE) break;

    // Self-yield if we've used our time budget. Writing continuationNonce
    // triggers a fresh worker invocation via the Firestore trigger.
    if (shouldYield(startedAt)) {
      await sendRef.update({
        // Release the lease so the next worker can claim immediately.
        workerLeaseExpiresAt: Timestamp.fromMillis(Date.now() - 1000),
        // Bump the nonce — the Firestore trigger fires on this change and
        // a fresh worker picks up from processedCursor.
        continuationNonce: FieldValue.increment(1),
      });
      yielded = true;
      log.info?.(
        {
          tenantId,
          sendId,
          processedQueued: totalQueued,
          processedFailed: totalFailed,
          elapsedMs: Date.now() - startedAt,
        },
        'worker self-yielding for continuation'
      );
      return;
    }
  }

  // Fan-out done for this entire send (we drained the contacts).
  const isScheduled = !!send.scheduledAt;
  const updates = {
    fanOutCompletedAt: FieldValue.serverTimestamp(),
    processedQueued: totalQueued,
    processedFailed: totalFailed,
    // Release the lease — we're done.
    workerLeaseExpiresAt: FieldValue.delete(),
  };
  if (totalQueued === 0) {
    updates.status = 'sent';
    updates.sentAt = FieldValue.serverTimestamp();
  } else if (isScheduled) {
    updates.status = 'scheduled';
  }
  // Otherwise immediate-send with messages still in flight: status stays
  // 'sending' until the webhook handler confirms every recipient is done.
  await sendRef.update(updates);

  log.info?.(
    {
      tenantId,
      sendId,
      queued: totalQueued,
      failed: totalFailed,
      finalStatus: updates.status || 'sending',
    },
    'send campaign fan-out complete'
  );
}

// Used by the HTTP confirm endpoint to set up everything before flipping
// status to 'sending'. The Eventarc trigger then picks up the change.
export async function prepareSendForLaunch({ tenantId, sendId }) {
  const sendRef = db
    .collection('tenants')
    .doc(tenantId)
    .collection('singleSends')
    .doc(sendId);

  await initCounterShards(tenantId, sendId);

  const send = (await sendRef.get()).data();
  const listSnap = await db
    .collection('tenants')
    .doc(tenantId)
    .collection('contactLists')
    .doc(send.contactListId)
    .get();
  if (!listSnap.exists) {
    throw new Error('contact_list_not_found');
  }
  const listData = listSnap.data();
  const updatedRecipientCount = listData.count || 0;

  return { recipientCount: updatedRecipientCount, shardCount: SHARD_COUNT };
}
