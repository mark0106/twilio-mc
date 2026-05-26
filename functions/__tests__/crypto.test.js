import { randomBytes } from 'node:crypto';
import { jest } from '@jest/globals';

import {
  encrypt,
  decrypt,
  _resetKeyCacheForTests,
} from '../crypto.js';

const TEST_KEY = randomBytes(32).toString('base64');

beforeEach(() => {
  process.env.MASTER_ENCRYPTION_KEY = TEST_KEY;
  _resetKeyCacheForTests();
});

describe('AES-256-GCM crypto helpers', () => {
  test('round-trips a plaintext string', () => {
    const plaintext = 'super-secret-twilio-auth-token-abc123';
    const blob = encrypt(plaintext);
    expect(Buffer.isBuffer(blob.ciphertext)).toBe(true);
    expect(blob.iv.length).toBe(12);
    expect(blob.authTag.length).toBe(16);
    expect(decrypt(blob)).toBe(plaintext);
  });

  test('produces a different IV each call', () => {
    const a = encrypt('hello');
    const b = encrypt('hello');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  test('throws when ciphertext is tampered with', () => {
    const blob = encrypt('hello world');
    const tampered = Buffer.from(blob.ciphertext);
    tampered[0] = tampered[0] ^ 0xff;
    expect(() =>
      decrypt({ ...blob, ciphertext: tampered })
    ).toThrow();
  });

  test('throws when authTag is tampered with', () => {
    const blob = encrypt('hello world');
    const tampered = Buffer.from(blob.authTag);
    tampered[0] = tampered[0] ^ 0xff;
    expect(() =>
      decrypt({ ...blob, authTag: tampered })
    ).toThrow();
  });

  test('throws when iv is the wrong length', () => {
    const blob = encrypt('hello world');
    expect(() =>
      decrypt({ ...blob, iv: Buffer.alloc(8) })
    ).toThrow(/iv must be/);
  });

  test('throws when MASTER_ENCRYPTION_KEY is missing', () => {
    delete process.env.MASTER_ENCRYPTION_KEY;
    _resetKeyCacheForTests();
    expect(() => encrypt('x')).toThrow(/MASTER_ENCRYPTION_KEY/);
  });

  test('throws when MASTER_ENCRYPTION_KEY is the wrong length', () => {
    process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    _resetKeyCacheForTests();
    expect(() => encrypt('x')).toThrow(/32 bytes/);
  });

  test('decryption fails when a different key is used', () => {
    const blob = encrypt('cross-key plaintext');
    process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    expect(() => decrypt(blob)).toThrow();
  });

  test('round-trips unicode and long strings', () => {
    const plaintext = '🔐 ' + 'x'.repeat(2048);
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });
});
