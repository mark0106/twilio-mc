// Twilio status callback handler. PUBLIC endpoint (no Firebase auth) but
// every request is X-Twilio-Signature-validated against the per-tenant
// decrypted auth token. Mount this OUTSIDE verifyFirebaseToken in app.js.
import { Router, urlencoded } from 'express';
import twilio from 'twilio';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { decrypt } from '../crypto.js';
import { mapTwilioStatus, canTransition } from '../sendsStateMachine.js';
import { shardRef } from '../counterShards.js';
import { PUBLIC_BASE_URL } from '../config.js';

const router = Router();

// Twilio webhooks arrive as application/x-www-form-urlencoded — Cloud
// Functions Gen 2 actually pre-parses these (req.body is already an object)
// but we attach urlencoded() here too so local-dev (where the request flows
// through Express normally) also works.
router.use(urlencoded({ extended: false, limit: '256kb' }));

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

    const recipientRef = db
      .collection('tenants')
      .doc(tenantId)
      .collection('singleSends')
      .doc(sendId)
      .collection('recipients')
      .doc(messageSid);

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
