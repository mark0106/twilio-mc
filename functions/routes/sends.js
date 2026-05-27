import { Router } from 'express';
import { z } from 'zod';
import Bottleneck from 'bottleneck';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import {
  buildClientForTenant,
  TwilioNotConnectedError,
} from '../twilioClient.js';
import { computeSegments } from '../segments.js';
import { normalizePhone } from '../phone.js';
import { prepareSendForLaunch } from '../jobs/sendCampaign.js';
import { describeError } from '../twilioErrorCodes.js';
import { renderTemplateForTest } from '../template.js';
import { shardRef } from '../counterShards.js';

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
    // Substitute template tokens with friendly placeholders for the test so
    // the recipient doesn't receive the literal "{name}" string.
    const renderedBody = renderTemplateForTest(body);
    const msg = await client.messages.create({
      to: e164,
      messagingServiceSid,
      body: renderedBody,
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

// POST /sends/:id/cancel  — cancels every still-queued Twilio message for
// this send. Only valid while the send is 'scheduled' (i.e., all messages
// were handed to Twilio with sendAt but delivery hasn't started yet).
//
// For each recipient still in 'queued' state we ask Twilio to cancel via
// messages(sid).update({ status: 'canceled' }). Already-sent messages reject
// — we count those as 'alreadyInFlight' and move on. Recipient docs + counter
// shards are updated atomically per cancellation.
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const sendRef = tenantRef(req.user.uid)
      .collection('singleSends')
      .doc(req.params.id);
    const snap = await sendRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const data = snap.data();
    if (data.status !== 'scheduled') {
      return res
        .status(400)
        .json({ error: 'not_cancelable', currentStatus: data.status });
    }

    // Claim the cancel operation so a second click can't double-process.
    await sendRef.update({ status: 'canceling' });

    let client;
    try {
      ({ client } = await buildClientForTenant(req.user.uid));
    } catch (err) {
      // Restore status if we can't even build a client.
      await sendRef.update({ status: 'scheduled' });
      if (err instanceof TwilioNotConnectedError) {
        return res.status(400).json({ error: 'twilio_not_connected' });
      }
      throw err;
    }

    const limiter = new Bottleneck({ minTime: 50, maxConcurrent: 10 });
    const recipientsRef = sendRef.collection('recipients');

    let canceledCount = 0;
    let alreadyInFlight = 0;
    let cursor = null;
    const PAGE = 500;

    while (true) {
      let q = recipientsRef
        .where('status', '==', 'queued')
        .orderBy('__name__')
        .limit(PAGE);
      if (cursor) q = q.startAfter(cursor);
      const page = await q.get();
      if (page.empty) break;

      const tasks = page.docs.map((d) =>
        limiter.schedule(async () => {
          const messageSid = d.id;
          try {
            await client.messages(messageSid).update({ status: 'canceled' });
          } catch (twErr) {
            // Twilio rejected — typically because the message has already
            // moved past 'scheduled' state. Count it and skip.
            if (twErr.status === 400 || twErr.status === 409) {
              alreadyInFlight++;
              return;
            }
            throw twErr;
          }

          // Transactional state + counter update so we don't double-count if
          // the webhook for 'canceled' races us.
          await db.runTransaction(async (tx) => {
            const fresh = await tx.get(d.ref);
            if (!fresh.exists) return;
            const recipient = fresh.data();
            if (recipient.status !== 'queued') return; // raced past us
            tx.update(d.ref, {
              status: 'canceled',
              updatedAt: FieldValue.serverTimestamp(),
            });
            tx.update(
              shardRef(req.user.uid, req.params.id, recipient.shardId),
              {
                queued: FieldValue.increment(-1),
                canceled: FieldValue.increment(1),
              }
            );
          });
          canceledCount++;
        })
      );

      await Promise.allSettled(tasks);

      cursor = page.docs[page.docs.length - 1];
      if (page.docs.length < PAGE) break;
    }

    await sendRef.update({
      status: 'canceled',
      canceledAt: FieldValue.serverTimestamp(),
    });

    res.json({ canceled: canceledCount, alreadyInFlight });
  } catch (err) {
    next(err);
  }
});

// GET /sends/:id/export.csv  — streams every recipient row as a CSV.
// Paginated cursor-read so the function memory doesn't grow with list size.
function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

router.get('/:id/export.csv', async (req, res, next) => {
  try {
    const sendRef = tenantRef(req.user.uid)
      .collection('singleSends')
      .doc(req.params.id);
    const sendSnap = await sendRef.get();
    if (!sendSnap.exists) return res.status(404).json({ error: 'not_found' });
    const send = sendSnap.data();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${(send.name || 'send').replace(/[^a-z0-9_-]/gi, '_')}-${req.params.id}.csv"`
    );

    res.write(
      'to,status,messageSid,errorCode,errorDescription,errorMessage,updatedAt\n'
    );

    const recipientsRef = sendRef.collection('recipients');
    const PAGE = 500;
    let cursor = null;
    while (true) {
      let q = recipientsRef.orderBy('__name__').limit(PAGE);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        const d = doc.data();
        const row = [
          csvEscape(d.to),
          csvEscape(d.status),
          csvEscape(doc.id),
          csvEscape(d.errorCode ?? ''),
          csvEscape(d.errorCode ? describeError(d.errorCode) : ''),
          csvEscape(d.errorMessage ?? ''),
          csvEscape(d.updatedAt?.toDate?.()?.toISOString?.() ?? ''),
        ].join(',');
        res.write(row + '\n');
      }
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < PAGE) break;
    }
    res.end();
  } catch (err) {
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
