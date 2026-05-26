import {
  initializeApp,
  cert,
  applicationDefault,
  getApps,
} from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function isCloudFunctionsRuntime() {
  // K_SERVICE is set by Cloud Run / Gen 2 Functions; FUNCTION_TARGET by Gen 1.
  return Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET);
}

function buildCredential() {
  if (isCloudFunctionsRuntime()) {
    // In Cloud Functions / Cloud Run the SDK auto-discovers the service account.
    return applicationDefault();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    // Fall back to ADC if the env vars are missing — useful with
    // `gcloud auth application-default login` for local dev.
    return applicationDefault();
  }

  privateKey = privateKey.replace(/\\n/g, '\n');
  return cert({ projectId, clientEmail, privateKey });
}

if (!getApps().length) {
  initializeApp({ credential: buildCredential() });
}

export const auth = getAuth();
export const db = getFirestore();
