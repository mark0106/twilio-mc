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
  'read',
  'failed',
  'undelivered',
  'blocked',
  'canceled',
];

// States from which no further forward transition is allowed.
// `delivered` is NOT here because RCS can fire a `read` receipt afterward.
export const TERMINAL_STATES = new Set([
  'read',
  'failed',
  'undelivered',
  'blocked',
  'canceled',
]);

// "Done-enough" states for send-level completion math. Once every recipient
// has reached one of these (i.e. is no longer queued or in-flight), the send
// is considered complete. We include `delivered` even though it can later
// flip to `read` — read receipts are bonus, the send is done either way.
export const DONE_FOR_SEND_COMPLETION = new Set([
  'delivered',
  'read',
  'failed',
  'undelivered',
  'blocked',
  'canceled',
]);

const ALLOWED = {
  queued: new Set(['sent', 'delivered', 'read', 'failed', 'undelivered', 'blocked', 'canceled']),
  sent: new Set(['delivered', 'read', 'failed', 'undelivered', 'blocked']),
  delivered: new Set(['read']),
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
      // RCS read receipt — a post-delivery refinement, only arrives on
      // platforms that support it. Tracked as its own status so the user
      // can see actual engagement separately from delivery.
      return 'read';
    case 'canceled':
      return 'canceled';
    default:
      // accepted, sending, scheduled, queued — no state advance.
      return null;
  }
}
