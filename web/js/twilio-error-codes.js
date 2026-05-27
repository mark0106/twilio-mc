// Client-side mirror of functions/twilioErrorCodes.js. Kept in sync manually —
// the list is small and grows slowly so duplication is cheaper than a build
// step. If you add a code here, add it on the server too (the CSV export uses
// the server-side copy).

export const TWILIO_ERROR_CODES = {
  20003: 'Authentication error',
  21211: 'Invalid To phone number',
  21212: 'Invalid From phone number',
  21408: 'Permission to send an SMS has not been enabled for the region',
  21610: 'Recipient has opted out — STOP received',
  21611: 'Maximum SMS queue size exceeded',
  21612: 'Phone number not capable of receiving SMS',
  21614: "'To' number is not a valid mobile number",
  21617: 'Concatenated message body exceeds the 1600 character limit',
  21635: 'Phone number is not SMS-capable',
  30001: 'Queue overflow',
  30002: 'Account suspended',
  30003: 'Unreachable destination handset',
  30004: 'Message blocked (filtered)',
  30005: 'Unknown destination handset',
  30006: 'Landline or unreachable carrier',
  30007: 'Carrier violation (likely flagged as spam)',
  30008: 'Unknown error',
  30009: 'Missing inbound segment',
  30010: 'Message price exceeds max price',
  30032: 'Toll-Free Number Has Not Been Verified',
  30034: 'A2P 10DLC — message from an unregistered number',
  30035: 'A2P 10DLC — campaign not active',
  30036: 'A2P 10DLC — campaign sample rate exceeded',
  30037: 'A2P 10DLC — message blocked by carrier policy',
  30038: 'A2P 10DLC — campaign mismatch',
};

export function describeError(code) {
  if (code == null) return '';
  const n = Number(code);
  return TWILIO_ERROR_CODES[n] || `Error ${n}`;
}
