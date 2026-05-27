import {
  canTransition,
  mapTwilioStatus,
  TERMINAL_STATES,
  INTERNAL_STATUSES,
} from '../sendsStateMachine.js';

describe('canTransition', () => {
  test('queued can advance to any non-queued status', () => {
    expect(canTransition('queued', 'sent')).toBe(true);
    expect(canTransition('queued', 'delivered')).toBe(true);
    expect(canTransition('queued', 'failed')).toBe(true);
    expect(canTransition('queued', 'undelivered')).toBe(true);
    expect(canTransition('queued', 'blocked')).toBe(true);
    expect(canTransition('queued', 'canceled')).toBe(true);
  });

  test('sent cannot transition to canceled (already in flight)', () => {
    expect(canTransition('sent', 'canceled')).toBe(false);
  });

  test('canceled is terminal', () => {
    expect(canTransition('canceled', 'delivered')).toBe(false);
    expect(canTransition('canceled', 'sent')).toBe(false);
  });

  test('delivered → read is allowed (RCS receipt)', () => {
    expect(canTransition('delivered', 'read')).toBe(true);
  });

  test('delivered cannot go to anything except read', () => {
    expect(canTransition('delivered', 'sent')).toBe(false);
    expect(canTransition('delivered', 'failed')).toBe(false);
    expect(canTransition('delivered', 'delivered')).toBe(false);
  });

  test('read is terminal', () => {
    expect(canTransition('read', 'delivered')).toBe(false);
    expect(canTransition('read', 'sent')).toBe(false);
  });

  test('queued can go straight to read (instant RCS delivery)', () => {
    expect(canTransition('queued', 'read')).toBe(true);
  });

  test('sent can only advance to terminal states', () => {
    expect(canTransition('sent', 'delivered')).toBe(true);
    expect(canTransition('sent', 'failed')).toBe(true);
    expect(canTransition('sent', 'undelivered')).toBe(true);
    expect(canTransition('sent', 'blocked')).toBe(true);
    expect(canTransition('sent', 'queued')).toBe(false);
  });

  test('terminal states never transition', () => {
    for (const term of TERMINAL_STATES) {
      for (const next of INTERNAL_STATUSES) {
        expect(canTransition(term, next)).toBe(false);
      }
    }
  });

  test('same-state transitions are no-ops', () => {
    expect(canTransition('queued', 'queued')).toBe(false);
    expect(canTransition('sent', 'sent')).toBe(false);
  });

  test('falsy from-state returns false', () => {
    expect(canTransition(null, 'sent')).toBe(false);
    expect(canTransition(undefined, 'sent')).toBe(false);
    expect(canTransition('', 'sent')).toBe(false);
  });
});

describe('mapTwilioStatus', () => {
  test('delivered passes through', () => {
    expect(mapTwilioStatus('delivered')).toBe('delivered');
  });

  test('sent passes through', () => {
    expect(mapTwilioStatus('sent')).toBe('sent');
  });

  test('read maps to its own status (RCS read receipt)', () => {
    expect(mapTwilioStatus('read')).toBe('read');
  });

  test('failed with 30007 maps to blocked (opt-out)', () => {
    expect(mapTwilioStatus('failed', 30007)).toBe('blocked');
  });

  test('failed with 21610 maps to blocked (STOP keyword)', () => {
    expect(mapTwilioStatus('failed', 21610)).toBe('blocked');
  });

  test('failed with unknown code maps to failed', () => {
    expect(mapTwilioStatus('failed', 30001)).toBe('failed');
    expect(mapTwilioStatus('failed', null)).toBe('failed');
  });

  test('undelivered with 30003/30004/30005 stays undelivered', () => {
    expect(mapTwilioStatus('undelivered', 30003)).toBe('undelivered');
    expect(mapTwilioStatus('undelivered', 30004)).toBe('undelivered');
    expect(mapTwilioStatus('undelivered', 30005)).toBe('undelivered');
  });

  test('undelivered with 21610 maps to blocked', () => {
    expect(mapTwilioStatus('undelivered', 21610)).toBe('blocked');
  });

  test('error code passed as string still maps correctly', () => {
    expect(mapTwilioStatus('failed', '30007')).toBe('blocked');
  });

  test('twilio canceled maps to canceled', () => {
    expect(mapTwilioStatus('canceled')).toBe('canceled');
  });

  test('non-tracked statuses return null', () => {
    expect(mapTwilioStatus('accepted')).toBeNull();
    expect(mapTwilioStatus('queued')).toBeNull();
    expect(mapTwilioStatus('whatever')).toBeNull();
  });
});
