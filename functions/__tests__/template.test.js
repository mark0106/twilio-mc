import { renderTemplate, renderTemplateForTest } from '../template.js';

describe('renderTemplate', () => {
  test('replaces {name} with firstName', () => {
    expect(renderTemplate('Hi {name}!', { firstName: 'Alice' })).toBe('Hi Alice!');
  });

  test('case-insensitive tokens', () => {
    expect(renderTemplate('Hi {Name}!', { firstName: 'Alice' })).toBe('Hi Alice!');
    expect(renderTemplate('Hi {FIRSTNAME}!', { firstName: 'Alice' })).toBe('Hi Alice!');
  });

  test('{firstName} and {first_name} also map to firstName', () => {
    expect(renderTemplate('Hi {firstName}', { firstName: 'Alice' })).toBe('Hi Alice');
    expect(renderTemplate('Hi {first_name}', { firstName: 'Alice' })).toBe('Hi Alice');
  });

  test('{lastName} maps to lastName', () => {
    expect(renderTemplate('Mr. {lastName}', { lastName: 'Smith' })).toBe('Mr. Smith');
  });

  test('unknown tokens render as empty', () => {
    expect(renderTemplate('Hello {missing}!', { firstName: 'Alice' })).toBe('Hello !');
  });

  test('missing field renders as empty (no literal {name})', () => {
    expect(renderTemplate('Hi {name}!', {})).toBe('Hi !');
  });

  test('customFields lookup', () => {
    expect(
      renderTemplate('Tier: {tier}', { customFields: { tier: 'Gold' } })
    ).toBe('Tier: Gold');
  });

  test('multiple tokens in one template', () => {
    expect(
      renderTemplate('Hi {name}, your tier is {tier}', {
        firstName: 'Alice',
        customFields: { tier: 'Gold' },
      })
    ).toBe('Hi Alice, your tier is Gold');
  });

  test('empty / null template returns empty string', () => {
    expect(renderTemplate('', { firstName: 'A' })).toBe('');
    expect(renderTemplate(null, { firstName: 'A' })).toBe('');
    expect(renderTemplate(undefined, { firstName: 'A' })).toBe('');
  });

  test('numeric-only tokens are NOT replaced (the regex requires a letter start)', () => {
    expect(renderTemplate('Code is {123}', {})).toBe('Code is {123}');
  });
});

describe('renderTemplateForTest', () => {
  test('substitutes {name} with "there"', () => {
    expect(renderTemplateForTest('Hi {name}!')).toBe('Hi there!');
  });

  test('substitutes {firstName} with "there"', () => {
    expect(renderTemplateForTest('Hi {firstName}!')).toBe('Hi there!');
  });

  test('unknown tokens render as empty', () => {
    expect(renderTemplateForTest('Code: {foo}')).toBe('Code: ');
  });
});
