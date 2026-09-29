import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { hostFromUserInput, parseEmail } from '../providers/email.js';

/**
 * Key for hashing login targets (host + username) in guard stores and block records. Derived
 * from MM_MASTER_KEY so records from different runs can be matched without a new secret; a
 * random per-process key when no master key is set (records then only match within one run).
 */
export function guardTargetKey(masterKey: Buffer | undefined): Buffer {
  if (masterKey === undefined) return randomBytes(32);
  // hkdfSync returns an ArrayBuffer, not a Buffer.
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'mm-login-guard-v1', 32));
}

/**
 * Key for `auth.login-failed` targets (the e-mail typed into `mm login`). Its own HKDF info,
 * so these hashes never match mailbox targets; random per process without a master key.
 */
export function authTargetKey(masterKey: Buffer | undefined): Buffer {
  if (masterKey === undefined) return randomBytes(32);
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'mm-auth-target-v1', 32));
}

/**
 * Log target for a typed login e-mail: HMAC of the normalised address, or `invalid` when the
 * input isn't an address. People type their password into the e-mail field; hashing that
 * would make it guessable offline by anyone who can read both the log and the key.
 */
export function authEmailTarget(key: Buffer, input: string): string {
  let address: string;
  try {
    const parsed = parseEmail(input);
    address = `${parsed.localPart.toLowerCase()}@${parsed.domain}`;
  } catch {
    return 'invalid';
  }
  return createHmac('sha256', key).update(address).digest('hex');
}

/** HMAC of the normalised mailbox: stores and logs never hold the plain address or host. */
export function hmacTarget(key: Buffer, host: string, username: string): string {
  // Same host normalisation as openSession (case, trailing dot, IDN → ASCII).
  const normalizedHost = hostFromUserInput(host) ?? host.toLowerCase();
  return createHmac('sha256', key)
    .update(JSON.stringify([normalizedHost, username.trim().toLowerCase()]))
    .digest('hex');
}

export type BlockKind = 'too-many-attempts' | 'ip-blocked' | 'permanent';

/**
 * fail2ban `failregex` for `login-guard.block` lines (rendered by the log core with the
 * `mm-security ` prefix; key order fixed by EVENT_FIELDS, envelope fields after `target`).
 * Block lines only. Matches only IP-level blocks (ip-blocked, permanent):
 * a firewall ban after a single mailbox lock would be stricter than the app's own policy.
 * Uses `<ADDR>` (IP addresses only, fail2ban ≥ 0.10) on the `addr` field: lines without a
 * bannable address (`addr: null` — the CLI's `local`, invalid input) never match.
 */
export const FAIL2BAN_FAILREGEX =
  '^.*mm-security \\{"ts":"[^"]+","event":"login-guard\\.block","kind":"(?:ip-blocked|permanent)","reason":"[a-z-]+","ip":"[^"]+","addr":"<ADDR>"';
