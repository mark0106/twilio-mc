import { shouldYield } from '../jobs/sendCampaign.js';

describe('shouldYield', () => {
  test('false when well under the budget', () => {
    const start = 1_000_000;
    expect(shouldYield(start, start + 1_000)).toBe(false);
    expect(shouldYield(start, start + 60_000)).toBe(false);
  });

  test('true at or past the default 480s budget', () => {
    const start = 1_000_000;
    expect(shouldYield(start, start + 480_000)).toBe(true);
    expect(shouldYield(start, start + 540_000)).toBe(true);
  });

  test('honors a custom budget', () => {
    const start = 0;
    expect(shouldYield(start, 99, 100)).toBe(false);
    expect(shouldYield(start, 100, 100)).toBe(true);
    expect(shouldYield(start, 500, 100)).toBe(true);
  });
});
