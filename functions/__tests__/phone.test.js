import {
  normalizePhone,
  pickPhoneField,
  pickFirstName,
  pickLastName,
  pickCustomFields,
} from '../phone.js';

describe('normalizePhone', () => {
  test('normalizes a US 10-digit number with default region US', () => {
    expect(normalizePhone('(415) 555-2671', 'US')).toBe('+14155552671');
  });

  test('normalizes a US number written with dashes', () => {
    expect(normalizePhone('415-555-2671', 'US')).toBe('+14155552671');
  });

  test('passes through an already-E.164 number', () => {
    expect(normalizePhone('+14155552671', 'US')).toBe('+14155552671');
  });

  test('handles a UK number with default region GB', () => {
    expect(normalizePhone('020 7946 0958', 'GB')).toBe('+442079460958');
  });

  test('returns null for empty / whitespace input', () => {
    expect(normalizePhone('', 'US')).toBeNull();
    expect(normalizePhone('   ', 'US')).toBeNull();
    expect(normalizePhone(null, 'US')).toBeNull();
    expect(normalizePhone(undefined, 'US')).toBeNull();
  });

  test('returns null for obviously invalid input', () => {
    expect(normalizePhone('not a phone', 'US')).toBeNull();
    expect(normalizePhone('123', 'US')).toBeNull();
  });

  test('accepts numeric input', () => {
    expect(normalizePhone(4155552671, 'US')).toBe('+14155552671');
  });
});

describe('row field picking', () => {
  test('pickPhoneField finds phone across common header names', () => {
    expect(pickPhoneField({ phone: '+14155552671' })).toBe('+14155552671');
    expect(pickPhoneField({ mobile: '415-555-2671' })).toBe('415-555-2671');
    expect(pickPhoneField({ phone_number: '4155552671' })).toBe('4155552671');
    expect(pickPhoneField({ random: 'x' })).toBeNull();
  });

  test('pickFirstName / pickLastName trim values', () => {
    expect(pickFirstName({ firstname: '  Alice ' })).toBe('Alice');
    expect(pickLastName({ last_name: ' Smith ' })).toBe('Smith');
    expect(pickFirstName({ noname: 'x' })).toBeNull();
  });

  test('"name" column maps to firstName', () => {
    expect(pickFirstName({ name: 'Alice' })).toBe('Alice');
  });

  test('pickCustomFields excludes the reserved columns', () => {
    const row = {
      phone: '+14155552671',
      firstname: 'Alice',
      lastname: 'Smith',
      city: 'SF',
      tier: 'gold',
      empty: '   ',
    };
    expect(pickCustomFields(row)).toEqual({ city: 'SF', tier: 'gold' });
  });
});
