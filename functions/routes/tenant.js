import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { encrypt } from '../crypto.js';
import { validateCredentials } from '../twilioClient.js';

const router = Router();

function tenantRef(uid) {
  return db.collection('tenants').doc(uid);
}

router.post('/init', async (req, res, next) => {
  try {
    const ref = tenantRef(req.user.uid);
    const snap = await ref.get();
    if (snap.exists) {
      return res.json({ tenantId: ref.id, created: false });
    }
    await ref.set({
      ownerUid: req.user.uid,
      name: req.user.email || 'My workspace',
      createdAt: FieldValue.serverTimestamp(),
    });
    res.json({ tenantId: ref.id, created: true });
  } catch (err) {
    next(err);
  }
});

router.get('/twilio', async (req, res, next) => {
  try {
    const snap = await tenantRef(req.user.uid).get();
    if (!snap.exists) {
      return res.json({ connected: false });
    }
    const data = snap.data();
    if (!data.twilioAccountSid || !data.twilioAuthTokenCiphertext) {
      return res.json({ connected: false });
    }
    res.json({
      connected: true,
      accountSid: data.twilioAccountSid,
      connectedAt: data.twilioConnectedAt?.toDate?.()?.toISOString?.() || null,
    });
  } catch (err) {
    next(err);
  }
});

const connectSchema = z.object({
  accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/, 'invalid_account_sid'),
  authToken: z.string().min(8).max(256),
});

router.post('/twilio', async (req, res, next) => {
  try {
    const parsed = connectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_request',
        details: parsed.error.flatten(),
      });
    }
    const { accountSid, authToken } = parsed.data;

    try {
      await validateCredentials(accountSid, authToken);
    } catch (err) {
      req.log?.info({ err: err.message }, 'twilio credential validation failed');
      return res.status(400).json({ error: 'twilio_validation_failed' });
    }

    const { ciphertext, iv, authTag } = encrypt(authToken);

    const ref = tenantRef(req.user.uid);
    await ref.set(
      {
        ownerUid: req.user.uid,
        twilioAccountSid: accountSid,
        twilioAuthTokenCiphertext: ciphertext,
        twilioAuthTokenIv: iv,
        twilioAuthTokenAuthTag: authTag,
        twilioConnectedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    res.json({ connected: true, accountSid });
  } catch (err) {
    next(err);
  }
});

router.delete('/twilio', async (req, res, next) => {
  try {
    const ref = tenantRef(req.user.uid);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.json({ connected: false });
    }
    await ref.update({
      twilioAccountSid: FieldValue.delete(),
      twilioAuthTokenCiphertext: FieldValue.delete(),
      twilioAuthTokenIv: FieldValue.delete(),
      twilioAuthTokenAuthTag: FieldValue.delete(),
      twilioConnectedAt: FieldValue.delete(),
    });
    res.json({ connected: false });
  } catch (err) {
    next(err);
  }
});

export default router;
