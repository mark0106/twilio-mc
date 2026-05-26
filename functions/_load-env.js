// Imported FIRST by server-local.js so env vars are populated before any
// other module (firebase-admin, etc.) reads process.env at top level.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(__dirname, '..', '.env') });
