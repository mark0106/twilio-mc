// Per-recipient status state machine for SMS campaigns.
//
// Twilio status callbacks can arrive out of order and may be delivered more
// than once. To keep the counter shards consistent we only ever advance the
// state forward; any other transition (duplicate, backwards, terminal-to-X)
// is a silent no-op.

export const INTERNAL_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'failed',
  'undelivered',
  'blocked',
];

export const TERMINAL_STATES = new Set([
  'delivered',
  'failed',
  'undelivered',
  'blocked',
]);

const ALLOWED = {
  queued: new Set(['sent', 'delivered', 'failed', 'undelivered', 'blocked']),
  sent: new Set(['delivered', 'failed', 'undelivered', 'blocked']),
};

export function canTransition(from, to) {
  if (!from) return false;
  if (from === to) return false;
  if (TERMINAL_STATES.has(from)) return false;
  return ALLOWED[from]?.has(to) === true;
}

// Twilio MessageStatus → our internal status. Returns null for statuses we
// don't model (e.g. 'accepted', 'sending', 'queued' on the way in — those
// don't fire a state change in our system).
//
// Error code mapping per the build plan:
//   30007 / 21610 → blocked (recipient opted out or carrier blocked)
//   30003 / 30004 / 30005 → undelivered (unreachable / unknown destination)
//   else        → failed / undelivered as-is
export function mapTwilioStatus(twilioStatus, errorCode) {
  const code = errorCode == null ? null : Number(errorCode);
  switch (twilioStatus) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'failed':
      if (code === 30007 || code === 21610) return 'blocked';
      return 'failed';
    case 'undelivered':
      if (code === 21610) return 'blocked';
      if (code === 30003 || code === 30004 || code === 30005) return 'undelivered';
      return 'undelivered';
    case 'read':
      // Treat 'read' the same as delivered — it's a post-delivery refinement
      // that arrives only on platforms that send read receipts.
      return 'delivered';
    default:
      // accepted, sending, scheduled, canceled, queued — no state advance.
      return null;
  }
}
