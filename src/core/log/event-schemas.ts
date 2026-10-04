import { z } from 'zod';
import { LOG_LEVELS } from '../config.js';
import { AUDIT_ACTIONS } from '../db/repos.js';
import type { CheckStatus } from '../doctor.js';
import { IMAP_FAILURE_REASONS } from '../imap/errors.js';
import { FALLBACK_OF, type FallbackFeature, type FallbackKind } from '../mailbox/folders.js';
import type { DiscoverySource, DomainProblem } from '../providers/discover.js';
import type { BlockKind } from '../security/events.js';
import {
  EVENT_FIELDS,
  EVENT_KIND,
  eventLevel,
  type AccountFailureReason,
  type AccountOutcome,
  type AuditFailureReason,
  type AuthFailureReason,
  type AuthLogoutEvent,
  type BrowseOutcome,
  type CommandOutcome,
  type DiscoverChoice,
  type DiscoverOutcome,
  type LogEvent,
  type LogEventName,
  type LogKind,
} from './events.js';
import { LOG_SCHEMA_VERSION, type LogRecord } from './record.js';
import type { ParsedLogLine } from './schema.js';

// One source of truth for what a field may hold: the builders clean their input to these
// allowlists, and the reader (`mm logs`) accepts only records inside them. A log file is
// untrusted input, so a line is re-validated field by field before anything is printed.

// ---- Allowlists (Records over the union, so the compiler keeps them complete) ----

export const CHECK_STATUSES: Record<CheckStatus, true> = { ok: true, warn: true, fail: true };
export const COMMAND_OUTCOMES: Record<CommandOutcome, true> = {
  ok: true,
  failed: true,
  interrupted: true,
};
export const DISCOVER_OUTCOMES: Record<DiscoverOutcome, true> = {
  found: true,
  'needs-host': true,
  blocked: true,
  manual: true,
  invalid: true,
};
export const DISCOVERY_SOURCES: Record<DiscoverySource, true> = {
  'preset-domain': true,
  'preset-mx': true,
  ispdb: true,
  autoconfig: true,
  srv: true,
};
export const DOMAIN_PROBLEMS: Record<DomainProblem, true> = {
  'not-exist': true,
  'dns-error': true,
  'dns-unreachable': true,
};
export const DISCOVER_CHOICES: Record<DiscoverChoice, true> = {
  picked: true,
  'host-entered': true,
  manual: true,
  cancelled: true,
};
export const AUTH_FAILURE_REASONS: Record<AuthFailureReason, true> = {
  'invalid-credentials': true,
  unreachable: true,
  unknown: true,
  unexpected: true,
};
export const LOGOUT_OUTCOMES: Record<AuthLogoutEvent['outcome'], true> = {
  'logged-out': true,
  'not-logged-in': true,
};
export const BLOCK_KINDS: Record<BlockKind, true> = {
  'too-many-attempts': true,
  'ip-blocked': true,
  permanent: true,
};
export const AUDIT_FAILURE_REASONS: Record<AuditFailureReason, true> = {
  forbidden: true,
  unavailable: true,
  conflict: true,
  'not-found': true,
  unknown: true,
  invalid: true,
};
export const IMAP_FAILURE_REASON_SET: ReadonlySet<string> = new Set<string>(IMAP_FAILURE_REASONS);
export const ACCOUNT_OUTCOMES: Record<AccountOutcome, true> = { ok: true, failed: true };
export const BROWSE_OUTCOMES: Record<BrowseOutcome, true> = {
  ok: true,
  interrupted: true,
  failed: true,
};
/** IMAP reasons plus the account/storage problems an account action can fail with. */
export const ACCOUNT_FAILURE_REASONS: Record<AccountFailureReason, true> = {
  ...(Object.fromEntries(IMAP_FAILURE_REASONS.map((r) => [r, true])) as Record<
    (typeof IMAP_FAILURE_REASONS)[number],
    true
  >),
  blocked: true,
  duplicate: true,
  'not-found': true,
  'secret-unreadable': true,
  unsupported: true,
  database: true,
  'list-failed': true,
  'connection-lost': true,
  'folder-unavailable': true,
  'folder-not-found': true,
  'gmail-all-hidden': true,
  unexpected: true,
};
export const FALLBACK_FEATURES: Record<FallbackFeature, true> = {
  'status-size': true,
  quota: true,
  'list-status': true,
};
export const FALLBACK_KINDS: Record<FallbackKind, true> = {
  'fetch-size-sum': true,
  'folder-sum': true,
  'status-per-folder': true,
};
export const AUDIT_ACTION_SET: ReadonlySet<string> = new Set<string>(AUDIT_ACTIONS);

// ---- Field shapes ----

export const MAX_CMD_CHARS = 100;
export const MAX_OPTS = 30;
export const MAX_OPT_CHARS = 40;
export const MAX_FRAMES = 10;
export const MAX_FRAME_BYTES = 200;

/** Characters a command path may keep (`account add`). */
export const CMD_STRIP = /[^a-z0-9 -]/g;
export const CMD_RE = /^[a-z0-9 -]{0,100}$/;
export const OPT_NAME_RE = /^[A-Za-z0-9-]{1,40}$/;
/** Characters a version (`0.6.0`, `22.22.1`) may keep. */
export const VERSION_STRIP = /[^0-9A-Za-z.+-]/g;
export const VERSION_RE = /^[0-9A-Za-z.+-]{0,40}$/;
export const OS_STRIP = /[^a-z0-9]/g;
export const OS_RE = /^[a-z0-9]{0,20}$/;
/** Frame text: printable ASCII without `"` and `\` (1 byte each in JSON). */
export const FRAME_STRIP = /[^\x20-\x7e]|["\\]/g;
export const FRAME_TEXT_RE = /^[\x20\x21\x23-\x5b\x5d-\x7e]{0,200}$/;
export const CLASS_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
export const CODE_RE = /^[A-Z0-9_]{1,40}$/;
/** A doctor check's fixed name, or `other`. */
export const CHECK_RE = /^[a-z0-9-]{1,40}$/;
/** Preset id (`websupport`) or `custom`. */
export const PROVIDER_RE = /^[a-z0-9-]{1,40}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** normalizeIp buckets: IPv4, IPv6 /64 (`h:h:h:h::/64`), `local`, `invalid`. */
export const IP_BUCKET_RE =
  /^(?:local|invalid|(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{1,4}:){4}:\/64)$/;
/** eventAddress output: IPv4 or a full 8-hextet IPv6 address. */
export const ADDR_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4})$/;
/** The writer's timestamp format (`Date#toISOString`). */
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** An HMAC (mailbox or typed e-mail). */
export const HMAC_RE = /^[0-9a-f]{64}$/;
/** A `target` field: an HMAC, or `invalid` when there was nothing valid to hash. */
export const TARGET_RE = /^(?:[0-9a-f]{64}|invalid)$/;
export const RUN_RE = /^[0-9a-f]{16}$/;

/** A real instant written in the writer's exact format (`2026-02-30T…` is not). */
export function isWriterTimestamp(ts: string): boolean {
  if (!ISO_RE.test(ts)) return false;
  const ms = Date.parse(ts);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === ts;
}

// ---- Per-event record schemas ----

function keys<T extends string>(allowed: Record<T, true>): [T, ...T[]] {
  return Object.keys(allowed) as [T, ...T[]];
}

const nonNegative = z.number().int().nonnegative();
const provider = z.string().regex(PROVIDER_RE);
const uuid = z.string().regex(UUID_RE);
const ip = z.string().regex(IP_BUCKET_RE);
const target = z.string().regex(TARGET_RE);
const imapReason = z.string().refine((r) => IMAP_FAILURE_REASON_SET.has(r));
const accountFields = {
  acct: uuid.optional(),
  provider,
  outcome: z.enum(keys(ACCOUNT_OUTCOMES)),
  reason: z.enum(keys(ACCOUNT_FAILURE_REASONS)).optional(),
};

type FieldsOf<E> = Exclude<keyof E, 'event'>;

/** Every field of every event must have a schema: the compiler checks this map is complete. */
const FIELD_SCHEMAS: {
  [N in LogEventName]: { [F in FieldsOf<Extract<LogEvent, { event: N }>>]-?: z.ZodType };
} = {
  'command.start': {
    cmd: z.string().regex(CMD_RE),
    opts: z.array(z.string().regex(OPT_NAME_RE)).max(MAX_OPTS),
    ver: z.string().regex(VERSION_RE),
    node: z.string().regex(VERSION_RE),
    os: z.string().regex(OS_RE),
  },
  'command.finish': {
    cmd: z.string().regex(CMD_RE),
    outcome: z.enum(keys(COMMAND_OUTCOMES)),
    exit: z.number().int(),
    ms: nonNegative,
  },
  'error.unexpected': {
    errClass: z.string().regex(CLASS_RE),
    code: z.string().regex(CODE_RE).optional(),
    stack: z.array(z.string().regex(FRAME_TEXT_RE)).max(MAX_FRAMES),
  },
  'log.truncated': {},
  'doctor.check': {
    check: z.string().regex(CHECK_RE),
    status: z.enum(keys(CHECK_STATUSES)),
  },
  'discover.finish': {
    outcome: z.enum(keys(DISCOVER_OUTCOMES)),
    source: z.enum(keys(DISCOVERY_SOURCES)).optional(),
    provider: provider.optional(),
    domainProblem: z.enum(keys(DOMAIN_PROBLEMS)).optional(),
    choice: z.enum(keys(DISCOVER_CHOICES)).optional(),
  },
  'auth.login': { user: uuid.optional() },
  'auth.login-failed': { reason: z.enum(keys(AUTH_FAILURE_REASONS)), target },
  'auth.logout': { outcome: z.enum(keys(LOGOUT_OUTCOMES)) },
  'imap.login': { acct: uuid.optional(), provider, ip, target },
  'imap.login-failed': {
    acct: uuid.optional(),
    provider,
    reason: z.union([z.literal('blocked'), imapReason]),
    counted: z.boolean(),
    ip,
    target,
  },
  'login-guard.challenge': { ip, attempts: nonNegative, target },
  'login-guard.block': {
    kind: z.enum(keys(BLOCK_KINDS)),
    reason: imapReason,
    ip,
    addr: z.string().regex(ADDR_RE).nullable(),
    attempts: nonNegative,
    until: z.string().refine(isWriterTimestamp).nullable(),
    target,
  },
  'audit.write-failed': {
    action: z.string().refine((a) => a === 'other' || AUDIT_ACTION_SET.has(a)),
    reason: z.enum(keys(AUDIT_FAILURE_REASONS)),
  },
  'account.add': accountFields,
  'account.test': accountFields,
  'account.password-update': accountFields,
  'account.remove': accountFields,
  'folders.list': {
    acct: uuid.optional(),
    folders: nonNegative,
    ms: nonNegative,
    outcome: z.enum(keys(ACCOUNT_OUTCOMES)),
    reason: z.enum(keys(ACCOUNT_FAILURE_REASONS)).optional(),
  },
  'imap.capability-fallback': {
    feature: z.enum(keys(FALLBACK_FEATURES)),
    fallback: z.enum(keys(FALLBACK_KINDS)),
  },
  'browse.finish': {
    acct: uuid.optional(),
    folders: nonNegative,
    mails: nonNegative,
    marked: nonNegative,
    bytes: nonNegative,
    reconnects: nonNegative,
    ms: nonNegative,
    outcome: z.enum(keys(BROWSE_OUTCOMES)),
    reason: z.enum(keys(ACCOUNT_FAILURE_REASONS)).optional(),
  },
  'stats.finish': {
    acct: uuid.optional(),
    folders: nonNegative,
    messages: nonNegative,
    bytes: nonNegative,
    ms: nonNegative,
    outcome: z.enum(keys(ACCOUNT_OUTCOMES)),
    reason: z.enum(keys(ACCOUNT_FAILURE_REASONS)).optional(),
  },
};

const RECORD_SCHEMAS = new Map<string, z.ZodType<Record<string, unknown>>>(
  (Object.keys(FIELD_SCHEMAS) as LogEventName[]).map((name) => [
    name,
    z.strictObject({
      ts: z.string().regex(ISO_RE),
      event: z.literal(name),
      ...(FIELD_SCHEMAS[name] as Record<string, z.ZodType>),
      level: z.enum(LOG_LEVELS),
      run: z.string().regex(RUN_RE),
      v: z.literal(LOG_SCHEMA_VERSION),
    }),
  ]),
);

/** `record`: valid and in canonical key order. `unknown`: another version or a newer event. */
export type ValidatedLine = { record: LogRecord } | { skipped: 'unreadable' | 'unknown' };

/**
 * Checks a parsed line against its event's strict schema and the file it came from:
 * - the line's kind (prefix) must match the file's kind, and the event must belong in that
 *   kind of file (`log.truncated` goes into both);
 * - `level` must be the one the writer derives from the fields;
 * - `ts` must be in the writer's format and, when `fileDate` is given, on that UTC day.
 * A different schema version or an event this version doesn't know is `unknown` (a newer
 * Mail Manager wrote it); everything else that fails is `unreadable`. Never throws.
 */
export function validateRecord(
  line: ParsedLogLine,
  fileKind: LogKind,
  fileDate?: string,
): ValidatedLine {
  try {
    const { record } = line;
    if (record.v !== LOG_SCHEMA_VERSION) return { skipped: 'unknown' };
    const schema = RECORD_SCHEMAS.get(record.event);
    if (schema === undefined) return { skipped: 'unknown' };
    const name = record.event as LogEventName;
    if (line.kind !== fileKind) return { skipped: 'unreadable' };
    if (name !== 'log.truncated' && EVENT_KIND[name] !== fileKind) return { skipped: 'unreadable' };
    const parsed = schema.safeParse(record);
    if (!parsed.success) return { skipped: 'unreadable' };
    const data = parsed.data;
    const ts = data['ts'] as string;
    if (!isWriterTimestamp(ts)) return { skipped: 'unreadable' };
    if (fileDate !== undefined && ts.slice(0, 10) !== fileDate) return { skipped: 'unreadable' };
    if (name === 'command.finish' && !finishConsistent(data)) return { skipped: 'unreadable' };
    if (
      (name.startsWith('account.') ||
        name === 'folders.list' ||
        name === 'browse.finish' ||
        name === 'stats.finish') &&
      !accountConsistent(data)
    ) {
      return { skipped: 'unreadable' };
    }
    if (name === 'imap.capability-fallback' && !fallbackConsistent(data)) {
      return { skipped: 'unreadable' };
    }
    if (eventLevel(data as unknown as LogEvent) !== data['level']) {
      return { skipped: 'unreadable' };
    }
    return { record: canonical(name, data) };
  } catch {
    return { skipped: 'unreadable' };
  }
}

/** The writer derives the outcome from the exit code (0 ok, 130 interrupted, else failed). */
function finishConsistent(data: Record<string, unknown>): boolean {
  const exit = data['exit'];
  const expected = exit === 0 ? 'ok' : exit === 130 ? 'interrupted' : 'failed';
  return data['outcome'] === expected;
}

/** The builder writes a reason only for a failed action (account, listing, browser, stats), and always for one. */
function accountConsistent(data: Record<string, unknown>): boolean {
  return (data['outcome'] === 'failed') === (data['reason'] !== undefined);
}

/** Each feature has exactly one fallback (the builder derives it). */
function fallbackConsistent(data: Record<string, unknown>): boolean {
  return FALLBACK_OF[data['feature'] as FallbackFeature] === data['fallback'];
}

/** The writer's key order: ts, event, the event's fields, level, run, v. */
function canonical(name: LogEventName, data: Record<string, unknown>): LogRecord {
  const ordered: Record<string, unknown> = { ts: data['ts'], event: name };
  for (const field of EVENT_FIELDS[name] as readonly string[]) {
    if (data[field] !== undefined) ordered[field] = data[field];
  }
  ordered['level'] = data['level'];
  ordered['run'] = data['run'];
  ordered['v'] = data['v'];
  return ordered as LogRecord;
}
