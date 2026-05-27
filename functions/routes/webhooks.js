// Twilio status callback handler. PUBLIC endpoint (no Firebase auth) but
// every request is X-Twilio-Signature-validated against the per-tenant
// decrypted auth token. Mount this OUTSIDE verifyFirebaseToken in app.js.
import { Router, urlencoded } from 'express';
import twilio from 'twilio';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { decrypt } from '../crypto.js';
import {
  mapTwilioStatus,
  canTransition,
  DONE_FOR_SEND_COMPLETION,
} from '../sendsStateMachine.js';
import { shardRef, SHARD_COUNT } from '../counterShards.js';
import { PUBLIC_BASE_URL } from '../config.js';

const router = Router();

// Twilio webhooks arrive as application/x-www-form-urlencoded — Cloud
// Functions Gen 2 actually pre-parses these (req.body is already an object)
// but we attach urlencoded() here too so local-dev (where the request flows
// through Express normally) also works.
router.use(urlencoded({ extended: false, limit: '256kb' }));

// After a successful recipient transition, see if the parent send doc needs
// its own status to advance.
//
// scheduled → sending: the moment Twilio starts delivering scheduled messages
// (any queued → X transition happens), we flip the send out of 'scheduled'.
//
// sending → sent: when every recipient has reached a 'done' state (delivered,
// read, failed, undelivered, blocked, canceled — i.e. nothing in queued or
// in-flight 'sent'), we mark the send complete. Reads all 50 counter shards
// once per terminal transition; that's acceptable for our scale.
async function maybeAdvanceSendStatus({
  sendRef,
  tenantId,
  sendId,
  fromStatus,
  toStatus,
}) {
  // First: scheduled → sending (cheap — single doc read)
  if (fromStatus === 'queued') {
    const snap = await sendRef.get();
    if (snap.exists && snap.data()?.status === 'scheduled') {
      await sendRef.update({
        status: 'sending',
        deliveryStartedAt: FieldValue.serverTimestamp(),
      });
    }
  }

  // Second: maybe-completion check on terminal transitions only.
  if (!DONE_FOR_SEND_COMPLETION.has(toStatus)) return;

  const shardsRef = sendRef.collection('counterShards');
  const shardsSnap = await shardsRef.get();
  let inFlight = 0;
  for (const d of shardsSnap.docs) {
    const data = d.data();
    inFlight += (data.queued || 0) + (data.sent || 0);
  }
  if (inFlight > 0) return;

  // All recipients are done. Promote send to 'sent' if it's currently in
  // a non-terminal state (sending or scheduled). Transactional so concurrent
  // webhooks don't double-write.
  await db.runTransaction(async (tx) => {
    const sendSnap = await tx.get(sendRef);
    if (!sendSnap.exists) return;
    const status = sendSnap.data()?.status;
    if (status === 'sending' || status === 'scheduled') {
      tx.update(sendRef, {
        status: 'sent',
        sentAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

async function decryptTenantAuthToken(tenantId) {
  const snap = await db.collection('tenants').doc(tenantId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (
    !data.twilioAuthTokenCiphertext ||
    !data.twilioAuthTokenIv ||
    !data.twilioAuthTokenAuthTag
  ) {
    return null;
  }
  return decrypt({
    ciphertext: data.twilioAuthTokenCiphertext,
    iv: data.twilioAuthTokenIv,
    authTag: data.twilioAuthTokenAuthTag,
  });
}

router.post('/twilio/status/:tenantId/:sendId', async (req, res) => {
  const { tenantId, sendId } = req.params;
  const params = req.body || {};

  try {
    const authToken = await decryptTenantAuthToken(tenantId);
    if (!authToken) {
      req.log?.warn({ tenantId, sendId }, 'webhook: tenant not found or not connected');
      return res.status(403).send('forbidden');
    }

    // Reconstruct the public URL Twilio called. Behind Hosting rewrites the
    // function sees a /webhooks/... path so we prepend PUBLIC_BASE_URL.
    const callbackUrl = `${PUBLIC_BASE_URL}${req.originalUrl}`;
    const signature = req.headers['x-twilio-signature'] || '';

    const isValid = twilio.validateRequest(authToken, signature, callbackUrl, params);
    if (!isValid) {
      req.log?.warn(
        { tenantId, sendId, url: callbackUrl, msgSid: params.MessageSid },
        'webhook: invalid signature'
      );
      return res.status(403).send('invalid signature');
    }

    const messageSid = params.MessageSid;
    const twilioStatus = params.MessageStatus;
    const errorCode = params.ErrorCode || null;
    const errorMessage = params.ErrorMessage || null;

    if (!messageSid || !twilioStatus) {
      return res.status(400).send('missing required fields');
    }

    const internalStatus = mapTwilioStatus(twilioStatus, errorCode);
    if (!internalStatus) {
      // Status we don't track (accepted, queued, scheduled, canceled, ...) —
      // ack the webhook so Twilio doesn't retry.
      return res.status(200).send('ignored');
    }

    const sendRef = db
      .collection('tenants')
      .doc(tenantId)
      .collection('singleSends')
      .doc(sendId);
    const recipientRef = sendRef.collection('recipients').doc(messageSid);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(recipientRef);
      if (!snap.exists) {
        return { applied: false, reason: 'recipient_not_found' };
      }
      const recipient = snap.data();
      const fromStatus = recipient.status;

      if (!canTransition(fromStatus, internalStatus)) {
        return { applied: false, reason: 'no_transition', fromStatus, to: internalStatus };
      }

      const sRef = shardRef(tenantId, sendId, recipient.shardId);

      tx.update(recipientRef, {
        status: internalStatus,
        errorCode: errorCode ? Number(errorCode) : null,
        errorMessage,
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Move 1 unit from fromStatus → internalStatus on the same shard.
      tx.update(sRef, {
        [fromStatus]: FieldValue.increment(-1),
        [internalStatus]: FieldValue.increment(1),
      });

      return { applied: true, fromStatus, to: internalStatus };
    });

    // Send-level status transitions:
    //   queued → X on a 'scheduled' send  → flip send to 'sending'
    //   any 'done' transition + no recipients left in-flight → flip to 'sent'
    if (result.applied) {
      try {
        await maybeAdvanceSendStatus({
          sendRef,
          tenantId,
          sendId,
          fromStatus: result.fromStatus,
          toStatus: result.to,
        });
      } catch (advErr) {
        // Non-fatal — the recipient was updated successfully; the next
        // webhook can pick up the status advance.
        req.log?.warn(
          { err: advErr.message, tenantId, sendId },
          'send-level status advance failed'
        );
      }
    }

    req.log?.info(
      {
        tenantId,
        sendId,
        messageSid,
        twilioStatus,
        internalStatus,
        result,
      },
      'webhook processed'
    );

    res.status(200).send('ok');
  } catch (err) {
    req.log?.error({ err: err.message, stack: err.stack, tenantId, sendId }, 'webhook error');
    res.status(500).send('error');
  }
});

export default router;
