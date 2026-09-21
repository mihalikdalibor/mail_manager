import { randomBytes } from 'node:crypto';

export const MASTER_KEY_BYTES = 32;

// Strict standard base64 (Buffer.from is lenient and silently drops invalid chars).
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type MasterKeyValidation = { ok: true; key: Buffer } | { ok: false; reason: string };

/** A new random master key, base64-encoded (value for MM_MASTER_KEY). */
export function generateMasterKey(): string {
  return randomBytes(MASTER_KEY_BYTES).toString('base64');
}

/** Validates a base64 master key. The reason never echoes the value. */
export function validateMasterKey(value: string): MasterKeyValidation {
  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, reason: 'is empty' };
  if (!BASE64_RE.test(trimmed)) return { ok: false, reason: 'is not valid base64' };
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== MASTER_KEY_BYTES) {
    return {
      ok: false,
      reason: `must decode to ${MASTER_KEY_BYTES} bytes, got ${key.length} bytes`,
    };
  }
  return { ok: true, key };
}
