// Local development entrypoint. In production, Cloud Functions wraps
// `app` via index.js — this file is only used for `npm start` / `npm run dev`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { buildApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the project root. We intentionally do not keep .env under
// functions/ — the Firebase CLI rejects keys with reserved prefixes
// (FIREBASE_*, PORT) at deploy time. None of those vars are needed inside
// Cloud Functions: applicationDefault() picks up credentials in the cloud,
// and MASTER_ENCRYPTION_KEY is set via Firebase Secrets (see index.js).
loadDotenv({ path: path.join(__dirname, '..', '.env') });

const webDir = path.join(__dirname, '..', 'web');

const app = buildApp({ serveStatic: true, webDir });

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`sms-campaigns server listening on http://localhost:${port}`);
});
