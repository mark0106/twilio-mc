// Local development entrypoint. In production, Cloud Functions wraps
// `app` via index.js — this file is only used for `npm start` / `npm run dev`.
//
// _load-env must be the FIRST import: ES module side effects run in order,
// so env vars need to be populated before app.js triggers Firebase Admin init.
import './_load-env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(__dirname, '..', 'web');

const app = buildApp({ serveStatic: true, webDir });

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`sms-campaigns server listening on http://localhost:${port}`);
});
