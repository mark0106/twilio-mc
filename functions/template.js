// Message-body template rendering for personalization.
//
// Supported tokens (case-insensitive):
//   {name} / {firstName} / {first_name}  → contact.firstName
//   {lastName} / {last_name}             → contact.lastName
//   {<key>}                              → contact.customFields[<key>]
//
// Unknown tokens render as empty string so a missing name doesn't leak "{name}"
// into the SMS. Tokens are matched as ASCII word characters only — Twilio
// segment math is computed on the final rendered string at send time.

const TOKEN_RE = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

function lookup(contact, key) {
  const k = key.toLowerCase();
  if (k === 'name' || k === 'firstname' || k === 'first_name') {
    return contact?.firstName || '';
  }
  if (k === 'lastname' || k === 'last_name') {
    return contact?.lastName || '';
  }
  // Custom field lookup is case-sensitive on the original key first, then
  // a case-insensitive fallback for convenience.
  if (contact?.customFields) {
    if (contact.customFields[key] != null) return String(contact.customFields[key]);
    const ci = Object.keys(contact.customFields).find(
      (f) => f.toLowerCase() === k
    );
    if (ci) return String(contact.customFields[ci]);
  }
  return '';
}

export function renderTemplate(template, contact) {
  if (!template) return '';
  return String(template).replace(TOKEN_RE, (_match, key) => lookup(contact, key));
}

// Test sends don't have a real contact; substitute friendly placeholders so
// the message reads naturally on the recipient's phone.
const TEST_PLACEHOLDERS = {
  name: 'there',
  firstname: 'there',
  first_name: 'there',
  lastname: '',
  last_name: '',
};

export function renderTemplateForTest(template) {
  if (!template) return '';
  return String(template).replace(TOKEN_RE, (_match, key) => {
    const k = key.toLowerCase();
    return TEST_PLACEHOLDERS[k] ?? '';
  });
}
