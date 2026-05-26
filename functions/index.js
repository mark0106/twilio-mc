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
    memory: '512MiB',
    timeoutSeconds: 60,
    secrets: [MASTER_ENCRYPTION_KEY],
    concurrency: 80,
    cors: false, // Hosting rewrites mean same-origin; no CORS preflight needed.
  },
  app
);
