import twilio from 'twilio';

export function buildClient(accountSid, authToken) {
  return twilio(accountSid, authToken);
}

export async function validateCredentials(accountSid, authToken) {
  const client = buildClient(accountSid, authToken);
  const account = await client.api.v2010.accounts(accountSid).fetch();
  return { friendlyName: account.friendlyName, status: account.status };
}
