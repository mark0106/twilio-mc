import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.MASTER_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('MASTER_ENCRYPTION_KEY is not set');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `MASTER_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (got ${key.length})`
    );
  }
  cachedKey = key;
  return key;
}

export function _resetKeyCacheForTests() {
  cachedKey = null;
}

export function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() requires a string');
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

export function decrypt({ ciphertext, iv, authTag }) {
  const ctBuf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
  const ivBuf = Buffer.isBuffer(iv) ? iv : Buffer.from(iv);
  const tagBuf = Buffer.isBuffer(authTag) ? authTag : Buffer.from(authTag);

  if (ivBuf.length !== IV_LENGTH) {
    throw new Error(`iv must be ${IV_LENGTH} bytes`);
  }
  if (tagBuf.length !== AUTH_TAG_LENGTH) {
    throw new Error(`authTag must be ${AUTH_TAG_LENGTH} bytes`);
  }

  const decipher = createDecipheriv(ALGORITHM, getKey(), ivBuf);
  decipher.setAuthTag(tagBuf);
  const plaintext = Buffer.concat([
    decipher.update(ctBuf),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
