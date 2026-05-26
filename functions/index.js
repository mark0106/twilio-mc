// Cloud Functions for Firebase (Gen 2) entrypoint.
// - `api`: the Express app behind every HTTP route, mounted via Hosting rewrites
// - `processSend`: Firestore trigger that runs the SMS fan-out when a
//   singleSends doc transitions to status:'sending'
import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret } from 'firebase-functions/params';
import { buildApp } from './app.js';
import { runSendCampaign } from './jobs/sendCampaign.js';

const MASTER_ENCRYPTION_KEY = defineSecret('MASTER_ENCRYPTION_KEY');

setGlobalOptions({
  region: 'us-central1',
  maxInstances: 10,
});

const app = buildApp();

export const api = onRequest(
  {
    // CSV uploads (up to ~30 MB / 300K rows) buffer in memory while papaparse
    // streams and BulkWriter fans out to Firestore. 1 GiB gives comfortable
    // headroom for the buffer + parsed objects + SDK overhead.
    memory: '1GiB',
    timeoutSeconds: 600,
    secrets: [MASTER_ENCRYPTION_KEY],
    concurrency: 80,
    cors: false, // Hosting rewrites mean same-origin; no CORS preflight needed.
  },
  app
);

// Firestore trigger — fires on every update to any singleSends doc. We only
// act when status transitions to 'sending', so the typical update (e.g. the
// fan-out worker writing processedCursor on itself) is a no-op.
//
// Eventarc gives at-least-once delivery; idempotency is provided by the
// worker's cursor-based resume (processedCursor) — re-running picks up where
// the previous attempt left off rather than re-sending from scratch.
export const processSend = onDocumentUpdated(
  {
    document: 'tenants/{tenantId}/singleSends/{sendId}',
    region: 'us-central1',
    memory: '2GiB',
    // Eventarc background-trigger functions cap at 540s (vs HTTP's 3600s).
    // 540s @ 10 msg/sec = 5,400 messages comfortably; for larger sends the
    // worker resumes from processedCursor on the next trigger.
    timeoutSeconds: 540,
    secrets: [MASTER_ENCRYPTION_KEY],
    retry: false, // we handle retries ourselves via the confirm endpoint
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return;

    // Only fire when status transitions FROM something else TO 'sending'.
    // The worker writes processedCursor/processedQueued back to the same doc;
    // those self-writes also fire this trigger but status stays 'sending'
    // through them, so the guard prevents recursion.
    if (after.status !== 'sending') return;
    if (before?.status === 'sending') return;

    const { tenantId, sendId } = event.params;
    try {
      await runSendCampaign({ tenantId, sendId });
    } catch (err) {
      console.error('processSend failed', {
        tenantId,
        sendId,
        message: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }
);
