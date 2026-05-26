import twilio from 'twilio';
import { db } from './firebase.js';
import { decrypt } from './crypto.js';

export function buildClient(accountSid, authToken) {
  return twilio(accountSid, authToken);
}

export async function validateCredentials(accountSid, authToken) {
  const client = buildClient(accountSid, authToken);
  const account = await client.api.v2010.accounts(accountSid).fetch();
  return { friendlyName: account.friendlyName, status: account.status };
}

// Throws TwilioNotConnectedError if the tenant hasn't connected Twilio yet.
export class TwilioNotConnectedError extends Error {
  constructor() {
    super('twilio_not_connected');
    this.code = 'twilio_not_connected';
  }
}

export async function buildClientForTenant(tenantId) {
  const snap = await db.collection('tenants').doc(tenantId).get();
  if (!snap.exists) throw new TwilioNotConnectedError();
  const data = snap.data();
  if (
    !data.twilioAccountSid ||
    !data.twilioAuthTokenCiphertext ||
    !data.twilioAuthTokenIv ||
    !data.twilioAuthTokenAuthTag
  ) {
    throw new TwilioNotConnectedError();
  }
  const authToken = decrypt({
    ciphertext: data.twilioAuthTokenCiphertext,
    iv: data.twilioAuthTokenIv,
    authTag: data.twilioAuthTokenAuthTag,
  });
  return { client: buildClient(data.twilioAccountSid, authToken), accountSid: data.twilioAccountSid };
}
