// Cloud Functions for Firebase (Gen 2) entrypoint.
// Wraps the Express app — Firebase Hosting rewrites /tenant/** and /health to this function.
import { onRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret } from 'firebase-functions/params';
import { buildApp } from './app.js';

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
