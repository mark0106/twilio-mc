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

const PAGE_SIZE = 500;
const PROGRESS_BATCH_SIZE = 100;

// Fans out a Single Send to Twilio. Called by the Eventarc Firestore trigger
// when singleSends/{sendId}.status transitions to 'sending'. Designed to be
// idempotent on restart: re-running picks up from `processedCursor`.
export async function runSendCampaign({ tenantId, sendId, log = console }) {
  const tenantRef = db.collection('tenants').doc(tenantId);
  const sendRef = tenantRef.collection('singleSends').doc(sendId);
  const recipientsRef = sendRef.collection('recipients');

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

  const { client } = await buildClientForTenant(tenantId);

  // statusCallback URL — must be the publicly-reachable one (Hosting rewrites
  // → this same `api` HTTP function via the /webhooks/twilio/status/** route).
  const statusCallback = `${PUBLIC_BASE_URL}/webhooks/twilio/status/${tenantId}/${sendId}`;

  // Scheduled-send args. Twilio requires sendAt + scheduleType:'fixed' with a
  // Messaging Service (which we already enforce in the composer schema).
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
    { tenantId, sendId, resumeFrom: lastDocId, rate: TWILIO_SEND_RATE_PER_SECOND },
    'send campaign starting'
  );

  while (true) {
    let q = contactsRef.orderBy('__name__').limit(PAGE_SIZE);
    if (lastDocId) q = q.startAfter(lastDocId);

    const snap = await q.get();
    if (snap.empty) break;

    // Schedule all page sends through the limiter, then await the page so we
    // get natural backpressure between pages instead of buffering 300K
    // promises in memory at once.
    const tasks = snap.docs.map((doc) => {
      const contactId = doc.id;
      const phone = doc.data().phone;

      return limiter.schedule(async () => {
        let msg;
        try {
          msg = await client.messages.create({
            to: phone,
            messagingServiceSid: send.messagingServiceSid,
            body: send.body,
            statusCallback,
            ...scheduleArgs,
          });
        } catch (err) {
          // messages.create failed — record a synthetic recipient row so the
          // counters reflect the failure. The doc ID is auto-generated since
          // there's no MessageSid to key on.
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

        // Twilio accepted the message — record recipient + bump queued shard.
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

    // Persist cursor after each page so a restarted worker resumes from here.
    await sendRef.update({
      processedCursor: lastDocId,
      processedQueued: totalQueued,
      processedFailed: totalFailed,
    });

    if (snap.docs.length < PAGE_SIZE) break;
  }

  await sendRef.update({
    status: 'sent',
    sentAt: FieldValue.serverTimestamp(),
    processedQueued: totalQueued,
    processedFailed: totalFailed,
  });

  log.info?.(
    { tenantId, sendId, queued: totalQueued, failed: totalFailed },
    'send campaign complete'
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

  // Initialize 50 zeroed counter shards.
  await initCounterShards(tenantId, sendId);

  // Re-read the list count in case it changed between draft creation and
  // confirm (more contacts uploaded, deleted, etc.). Update recipientCount.
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
