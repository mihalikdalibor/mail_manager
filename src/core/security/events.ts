import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { ImapFailureReason } from '../imap/errors.js';
import { hostFromUserInput } from '../providers/email.js';

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

/** HMAC of the normalised mailbox: stores and logs never hold the plain address or host. */
export function hmacTarget(key: Buffer, host: string, username: string): string {
  // Same host normalisation as openSession (case, trailing dot, IDN → ASCII).
  const normalizedHost = hostFromUserInput(host) ?? host.toLowerCase();
  return createHmac('sha256', key)
    .update(JSON.stringify([normalizedHost, username.trim().toLowerCase()]))
    .digest('hex');
}

export type BlockKind = 'too-many-attempts' | 'ip-blocked' | 'permanent';

/** One record per block. No address, host or password — the target is an HMAC. */
export interface SecurityEvent {
  ts: string;
  event: 'login-guard.block';
  kind: BlockKind;
  /** Reason of the counted failure that triggered the block. */
  reason: ImapFailureReason;
  /** Counting bucket: IPv4, IPv6 /64, `local` or `invalid`. */
  ip: string;
  /** One concrete address a firewall can ban (fail2ban `<ADDR>`), or null (`local`, invalid). */
  addr: string | null;
  attempts: number;
  until: string | null;
  target: string;
}

export interface SecurityEventSink {
  emit(event: SecurityEvent): void;
}

export class MemoryEventSink implements SecurityEventSink {
  readonly events: SecurityEvent[] = [];

  emit(event: SecurityEvent): void {
    this.events.push(event);
  }
}

/** `mm-security {json}` on one line — fixed key order, so log filters can match it. */
export function formatEventLine(e: SecurityEvent): string {
  const ordered = {
    ts: e.ts,
    event: e.event,
    kind: e.kind,
    reason: e.reason,
    ip: e.ip,
    addr: e.addr,
    attempts: e.attempts,
    until: e.until,
    target: e.target,
  };
  return `mm-security ${JSON.stringify(ordered)}`;
}

/** Writes each event as one line through the shell-provided writer (core never prints). */
export class LineEventSink implements SecurityEventSink {
  constructor(private readonly write: (line: string) => void) {}

  emit(event: SecurityEvent): void {
    this.write(formatEventLine(event));
  }
}

/**
 * fail2ban `failregex` for block lines. Matches only IP-level blocks (ip-blocked, permanent):
 * a firewall ban after a single mailbox lock would be stricter than the app's own policy.
 * Uses `<ADDR>` (IP addresses only, fail2ban ≥ 0.10) on the `addr` field: lines without a
 * bannable address (`addr: null` — the CLI's `local`, invalid input) never match.
 */
export const FAIL2BAN_FAILREGEX =
  '^.*mm-security \\{"ts":"[^"]+","event":"login-guard\\.block","kind":"(?:ip-blocked|permanent)","reason":"[a-z-]+","ip":"[^"]+","addr":"<ADDR>"';
