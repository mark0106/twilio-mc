import { computeSegments } from '../segments.js';

describe('computeSegments', () => {
  test('plain ASCII under 160 chars is one GSM-7 segment', () => {
    const r = computeSegments('Hello world');
    expect(r.encoding).toBe('GSM-7');
    expect(r.segmentCount).toBe(1);
    expect(r.hasEmoji).toBe(false);
    expect(r.characterCount).toBe(11);
  });

  test('GSM-7 at the 160-char boundary stays a single segment', () => {
    const r = computeSegments('a'.repeat(160));
    expect(r.encoding).toBe('GSM-7');
    expect(r.segmentCount).toBe(1);
  });

  test('GSM-7 at 161 chars splits into two segments', () => {
    const r = computeSegments('a'.repeat(161));
    expect(r.encoding).toBe('GSM-7');
    expect(r.segmentCount).toBe(2);
  });

  test('GSM-7 extension chars count as 2 (e.g. €)', () => {
    // 79 base + 1 euro = 81 chars by count, still single segment
    const r = computeSegments('a'.repeat(79) + '€');
    expect(r.encoding).toBe('GSM-7');
    expect(r.characterCount).toBe(81);
    expect(r.segmentCount).toBe(1);
  });

  test('emoji flips to UCS-2 and counts as 2 UTF-16 code units', () => {
    const r = computeSegments('Hi 👋');
    expect(r.encoding).toBe('UCS-2');
    expect(r.segmentCount).toBe(1);
    expect(r.hasEmoji).toBe(true);
    expect(r.characterCount).toBe(5); // "Hi " (3) + emoji surrogate pair (2)
  });

  test('UCS-2 at 70 chars is single segment, 71 splits', () => {
    // 'я' is Cyrillic, not in GSM-7, so this is real UCS-2.
    expect(computeSegments('я'.repeat(70)).segmentCount).toBe(1);
    expect(computeSegments('я'.repeat(71)).segmentCount).toBe(2);
  });

  test('UCS-2 multi-segment uses 67-char chunks', () => {
    // 134 chars = exactly 2 segments of 67
    expect(computeSegments('я'.repeat(134)).segmentCount).toBe(2);
    expect(computeSegments('я'.repeat(135)).segmentCount).toBe(3);
  });

  test('empty body is zero segments', () => {
    const r = computeSegments('');
    expect(r.segmentCount).toBe(0);
    expect(r.characterCount).toBe(0);
  });

  test('null / undefined treated as empty', () => {
    expect(computeSegments(null).segmentCount).toBe(0);
    expect(computeSegments(undefined).segmentCount).toBe(0);
  });

  test('hasEmoji false when only accented latin', () => {
    const r = computeSegments('Café');
    expect(r.encoding).toBe('GSM-7');
    expect(r.hasEmoji).toBe(false);
  });
});
