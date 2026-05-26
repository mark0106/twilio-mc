import { Router } from 'express';
import { z } from 'zod';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import {
  buildClientForTenant,
  TwilioNotConnectedError,
} from '../twilioClient.js';
import { computeSegments } from '../segments.js';
import { normalizePhone } from '../phone.js';
import { prepareSendForLaunch } from '../jobs/sendCampaign.js';

const router = Router();

const MIN_LEAD_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LEAD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function tenantRef(uid) {
  return db.collection('tenants').doc(uid);
}

const testSchema = z.object({
  messagingServiceSid: z.string().regex(/^MG[0-9a-fA-F]{32}$/, 'invalid_messaging_service_sid'),
  to: z.string().min(2),
  body: z.string().min(1).max(1600),
});

// POST /sends/test  — sends one SMS via the customer's Twilio for preview/testing.
// Does NOT create a singleSends doc.
router.post('/test', async (req, res, next) => {
  try {
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    const { messagingServiceSid, to, body } = parsed.data;

    const e164 = normalizePhone(to, 'US');
    if (!e164) return res.status(400).json({ error: 'invalid_phone_to' });

    const { client } = await buildClientForTenant(req.user.uid);
    const msg = await client.messages.create({
      to: e164,
      messagingServiceSid,
      body,
    });
    res.json({ sid: msg.sid, status: msg.status, to: e164 });
  } catch (err) {
    if (err instanceof TwilioNotConnectedError) {
      return res.status(400).json({ error: 'twilio_not_connected' });
    }
    if (err.status && err.status >= 400 && err.status < 500) {
      return res.status(400).json({
        error: 'twilio_send_failed',
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  senderName: z.string().max(120).optional().default(''),
  messagingServiceSid: z.string().regex(/^MG[0-9a-fA-F]{32}$/, 'invalid_messaging_service_sid'),
  contactListId: z.string().min(1),
  body: z.string().min(1).max(1600),
  scheduledAt: z.string().datetime().nullable().optional(),
});

// POST /sends  — creates a draft singleSends doc.
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    const {
      name,
      senderName,
      messagingServiceSid,
      contactListId,
      body,
      scheduledAt,
    } = parsed.data;

    if (scheduledAt) {
      const ts = Date.parse(scheduledAt);
      const now = Date.now();
      if (ts - now < MIN_LEAD_MS) {
        return res.status(400).json({ error: 'schedule_too_soon' });
      }
      if (ts - now > MAX_LEAD_MS) {
        return res.status(400).json({ error: 'schedule_too_far' });
      }
    }

    const listSnap = await tenantRef(req.user.uid)
      .collection('contactLists')
      .doc(contactListId)
      .get();
    if (!listSnap.exists) {
      return res.status(400).json({ error: 'contact_list_not_found' });
    }
    const listData = listSnap.data();
    if (listData.status !== 'ready') {
      return res.status(400).json({ error: 'contact_list_not_ready' });
    }

    const seg = computeSegments(body);

    const sendRef = tenantRef(req.user.uid).collection('singleSends').doc();
    await sendRef.set({
      name,
      senderName,
      messagingServiceSid,
      contactListId,
      contactListName: listData.name,
      recipientCount: listData.count || 0,
      body,
      hasEmoji: seg.hasEmoji,
      segmentCount: seg.segmentCount,
      encoding: seg.encoding,
      characterCount: seg.characterCount,
      scheduledAt: scheduledAt ? Timestamp.fromDate(new Date(scheduledAt)) : null,
      status: 'draft',
      createdAt: FieldValue.serverTimestamp(),
      sentAt: null,
    });

    res.json({
      sendId: sendRef.id,
      segmentCount: seg.segmentCount,
      encoding: seg.encoding,
      recipientCount: listData.count || 0,
    });
  } catch (err) {
    next(err);
  }
});

// POST /sends/:id/confirm  —
// 1. Verifies status === 'draft'
// 2. Re-validates schedule window if scheduledAt is set
// 3. Refreshes recipientCount from the contact list (may have changed since draft)
// 4. Initializes 50 zeroed counter shards
// 5. Flips status to 'sending' atomically — the Firestore trigger function
//    (processSend) picks up the change and runs the fan-out worker
//
// Returns 200 immediately. The actual send happens asynchronously.
router.post('/:id/confirm', async (req, res, next) => {
  try {
    const sendRef = tenantRef(req.user.uid)
      .collection('singleSends')
      .doc(req.params.id);
    const snap = await sendRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const data = snap.data();
    if (data.status !== 'draft') {
      return res
        .status(400)
        .json({ error: 'not_draft', currentStatus: data.status });
    }

    // Re-validate schedule window at confirm time (the draft could have been
    // sitting around long enough that the originally-acceptable time is now
    // either past or beyond the 7-day window).
    if (data.scheduledAt) {
      const ts = data.scheduledAt.toDate().getTime();
      const now = Date.now();
      if (ts - now < 15 * 60 * 1000) {
        return res.status(400).json({ error: 'schedule_too_soon' });
      }
      if (ts - now > 7 * 24 * 60 * 60 * 1000) {
        return res.status(400).json({ error: 'schedule_too_far' });
      }
    }

    const { recipientCount, shardCount } = await prepareSendForLaunch({
      tenantId: req.user.uid,
      sendId: req.params.id,
    });

    // Atomically flip status to 'sending'. The Eventarc trigger picks this up.
    // We also write recipientCount so the UI shows the current count even if
    // contacts were added or removed since the draft was created.
    await sendRef.update({
      status: 'sending',
      recipientCount,
      shardCount,
      confirmedAt: FieldValue.serverTimestamp(),
      // Clear any stale cursor from a previous (failed) run.
      processedCursor: null,
      processedQueued: 0,
      processedFailed: 0,
    });

    res.json({ status: 'sending', sendId: sendRef.id, recipientCount });
  } catch (err) {
    if (err.message === 'contact_list_not_found') {
      return res.status(400).json({ error: 'contact_list_not_found' });
    }
    next(err);
  }
});

// GET /sends/:id  — single draft / send doc.
router.get('/:id', async (req, res, next) => {
  try {
    const snap = await tenantRef(req.user.uid)
      .collection('singleSends')
      .doc(req.params.id)
      .get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const data = snap.data();
    res.json({
      id: snap.id,
      ...data,
      scheduledAt: data.scheduledAt?.toDate?.()?.toISOString?.() || null,
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null,
      sentAt: data.sentAt?.toDate?.()?.toISOString?.() || null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
