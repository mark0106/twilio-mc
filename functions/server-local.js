// Local development entrypoint. In production, Cloud Functions wraps
// `app` via index.js — this file is only used for `npm start` / `npm run dev`.
import 'dotenv/config';
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
