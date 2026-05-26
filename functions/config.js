// Runtime configuration. Values come from process.env which is populated by
// dotenv locally (root .env) or by Firebase from functions/.env.<projectId>
// at deploy time. Defaults match production (twilio-mc).

export const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || 'https://twilio-mc.web.app'
).replace(/\/$/, '');

export const TWILIO_SEND_RATE_PER_SECOND = (() => {
  const n = parseInt(process.env.TWILIO_SEND_RATE_PER_SECOND, 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();
