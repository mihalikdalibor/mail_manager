import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { generateMasterKey, validateMasterKey } from '../../src/core/master-key.js';

function keyOfLength(n: number): string {
  return randomBytes(n).toString('base64');
}

describe('generateMasterKey', () => {
  it('returns base64 that decodes to 32 bytes', () => {
    const key = generateMasterKey();
    expect(key).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
  });

  it('returns a different key on each call', () => {
    expect(generateMasterKey()).not.toBe(generateMasterKey());
  });

  it('produces a key that passes validateMasterKey', () => {
    const key = generateMasterKey();
    const result = validateMasterKey(key);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.key).toBeInstanceOf(Buffer);
      expect(result.key).toHaveLength(32);
      expect(result.key.equals(Buffer.from(key, 'base64'))).toBe(true);
    }
  });
});

describe('validateMasterKey', () => {
  const invalid: Array<[string, string]> = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['non-base64 characters', 'not base64!!'],
    ['url-safe base64 alphabet', keyOfLength(32).replace(/\+/g, '-').replace(/\//g, '_') + '-_'],
    ['16-byte key', keyOfLength(16)],
    ['31-byte key', keyOfLength(31)],
    ['33-byte key', keyOfLength(33)],
  ];

  it.each(invalid)('rejects %s', (_label, value) => {
    const result = validateMasterKey(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('rejects a base64 string with broken padding', () => {
    const key = keyOfLength(32); // 44 chars ending in one '='
    const broken = key.replace(/=$/, '');
    expect(validateMasterKey(broken).ok).toBe(false);
    expect(validateMasterKey(`${key}=`).ok).toBe(false);
  });

  it('mentions the decoded byte length in the reason for wrong-size keys', () => {
    const result = validateMasterKey(keyOfLength(16));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('16');
  });

  it('accepts a valid key with surrounding whitespace and newline', () => {
    const key = generateMasterKey();
    const result = validateMasterKey(`  ${key}\n`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.key.equals(Buffer.from(key, 'base64'))).toBe(true);
  });

  it('never includes the input value in the reason', () => {
    const inputs = [
      'not base64!!',
      'SECRETVALUEXYZ!!',
      keyOfLength(16),
      keyOfLength(31),
      keyOfLength(33),
      `${keyOfLength(32)}garbage$`,
    ];
    for (const input of inputs) {
      const result = validateMasterKey(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).not.toContain(input);
        expect(result.reason).not.toContain(input.trim());
      }
    }
  });
});
