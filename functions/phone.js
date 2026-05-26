import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Headers we accept as the phone column (case-insensitive, after transformHeader strips/lowers).
export const PHONE_HEADERS = [
  'phone',
  'phonenumber',
  'phone_number',
  'mobile',
  'mobile_phone',
  'cell',
  'cellphone',
  'number',
  'tel',
  'telephone',
];

export const FIRST_NAME_HEADERS = ['firstname', 'first_name', 'first', 'given_name', 'givenname'];
export const LAST_NAME_HEADERS = ['lastname', 'last_name', 'last', 'family_name', 'familyname', 'surname'];

export function normalizePhone(raw, defaultRegion = 'US') {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  try {
    const phone = parsePhoneNumberFromString(str, defaultRegion);
    if (!phone || !phone.isValid()) return null;
    return phone.number;
  } catch {
    return null;
  }
}

// Picks the phone column value out of a parsed CSV row (object keyed by lowered/trimmed header).
export function pickPhoneField(row) {
  for (const key of PHONE_HEADERS) {
    if (row[key] != null && String(row[key]).trim() !== '') return row[key];
  }
  return null;
}

export function pickFirstName(row) {
  for (const key of FIRST_NAME_HEADERS) {
    if (row[key] != null && String(row[key]).trim() !== '') return String(row[key]).trim();
  }
  return null;
}

export function pickLastName(row) {
  for (const key of LAST_NAME_HEADERS) {
    if (row[key] != null && String(row[key]).trim() !== '') return String(row[key]).trim();
  }
  return null;
}

const RESERVED_HEADERS = new Set([
  ...PHONE_HEADERS,
  ...FIRST_NAME_HEADERS,
  ...LAST_NAME_HEADERS,
]);

export function pickCustomFields(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (RESERVED_HEADERS.has(key)) continue;
    if (value == null) continue;
    const v = String(value).trim();
    if (!v) continue;
    out[key] = v;
  }
  return out;
}
