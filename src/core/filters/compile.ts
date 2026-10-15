import type { SearchObject } from 'imapflow';
import { hasAttachment, receivedDate } from '../mailbox/messages.js';
import {
  CRITERIA,
  addressClass,
  parseAge,
  parseDay,
  parseFilter,
  type AddressField,
  type Criterion,
  type Filter,
  type FilterNode,
} from './schema.js';

// The filter compiler (M3a): a filter becomes one imapflow SearchObject, which the server uses to
// narrow the mails, and checks, which run on every mail the server returned and decide. Dates
// are checked to the instant on our side (the server's day or second terms depend on its
// WITHIN support), on the received date or, with `dates: 'sent'` (M3b), on the Date: header;
// addresses by exact address or domain; attachments by the body structure.
// Nothing here talks to a server or logs anything.

// CRITERIA and Criterion are defined in schema.ts (the log core imports them from there, so it
// doesn't pull in the compiler).

const DAY = 86_400_000;
/**
 * A `sent` narrowing term is widened by this much on each side: imapflow sends the UTC day, and
 * the server compares the day of the Date: header in that header's own time zone (up to 14 h off).
 */
const SENT_MARGIN = 2 * DAY;
/** A narrowing date this close to now (or later) is not sent: its check decides alone. */
const PAST_MARGIN = 60_000;

/** Which date the date leaves check: the received date (INTERNALDATE) or the Date: header. */
export type DateField = 'received' | 'sent';

/** Run on every candidate the server search returned; all must pass. */
export type Check =
  /** `addresses` / `domains` lower-case, domains without `@`. */
  | { kind: 'address'; field: AddressField; addresses: string[]; domains: string[]; want: boolean }
  /** In range = (fromMs === null || t >= fromMs) && (beforeMs === null || t < beforeMs). */
  | { kind: 'received'; fromMs: number | null; beforeMs: number | null; want: boolean }
  /** As `received`, on the Date: header (envelope.date). */
  | { kind: 'sent'; fromMs: number | null; beforeMs: number | null; want: boolean }
  | { kind: 'attachment'; want: boolean };

export interface CompiledFilter {
  query: SearchObject;
  checks: Check[];
  /** The kinds used anywhere in the filter except `all`, without duplicates, in CRITERIA order. */
  criteria: Criterion[];
  needs: { envelope: boolean; structure: boolean };
}

export type FilterErrorCode = 'invalid' | 'unsupported';

const FILTER_ERROR_MESSAGES: Record<FilterErrorCode, string> = {
  invalid: 'The filter is not valid',
  unsupported: 'This combination of criteria is not supported yet',
};

export class FilterError extends Error {
  readonly code: FilterErrorCode;

  constructor(code: FilterErrorCode) {
    super(FILTER_ERROR_MESSAGES[code]);
    this.name = 'FilterError';
    this.code = code;
  }
}

export interface CompileOptions {
  now: Date;
  /** Start of a calendar day as an instant; default: local midnight, `new Date(y, m - 1, d)`. */
  dayStart?: (y: number, m: number, d: number) => Date;
  /** Default 'received'. */
  dates?: DateField;
}

/** One checked leaf: its check (positive polarity) and the narrowing term sent, if any. */
interface Leaf {
  check: Check;
  term: SearchObject | null;
}

interface Env {
  now: Date;
  /** Start of a day as an instant (`CompileOptions.dayStart`). */
  startOf: (day: string) => number;
  /** The date the date leaves check (`CompileOptions.dates`). */
  dates: DateField;
}

export function compileFilter(filter: Filter, opts: CompileOptions): CompiledFilter {
  const parsed = parseFilter(filter);
  if (parsed === null) throw new FilterError('invalid');
  const dayStart = opts.dayStart ?? ((y: number, m: number, d: number) => new Date(y, m - 1, d));
  const env: Env = {
    now: opts.now,
    startOf: (day) => {
      const parts = parseDay(day);
      if (parts === null) throw new FilterError('invalid');
      return dayStart(parts.y, parts.m, parts.d).getTime();
    },
    dates: opts.dates ?? 'received',
  };

  const top = parsed.where.kind === 'all' ? flatten(parsed.where.of) : [parsed.where];
  const checks: Check[] = [];
  const parts: SearchObject[] = [];
  for (const t of top) {
    if (isPure(t)) {
      parts.push(toQuery(t));
    } else if (isChecked(t)) {
      const leaf = checkedLeaf(t, env);
      checks.push(leaf.check);
      if (leaf.term !== null) parts.push(leaf.term);
    } else if (t.kind === 'not' && isChecked(t.of)) {
      // No narrowing term: a negated server term would drop mails the check keeps.
      checks.push(flipped(checkedLeaf(t.of, env).check));
    } else {
      throw new FilterError('unsupported');
    }
  }

  const used = new Set<Criterion>();
  kindsOf(parsed.where, used);
  const criteria = CRITERIA.filter((c) => used.has(c));
  return {
    query: parts.length === 0 ? { all: true } : and(parts),
    checks,
    criteria,
    needs: {
      envelope: checks.some((c) => c.kind === 'address' || c.kind === 'sent'),
      structure: checks.some((c) => c.kind === 'attachment'),
    },
  };
}

/**
 * `now` minus the age: d = 24 h, w = 7 d; m / y in UTC calendar steps, the day clamped to the
 * month's length.
 */
export function ageCutoff(now: Date, age: string): Date {
  const parsed = parseAge(age);
  if (parsed === null) throw new FilterError('invalid');
  const { n, unit } = parsed;
  if (unit === 'd') return clampedDate(now.getTime() - n * DAY);
  if (unit === 'w') return clampedDate(now.getTime() - n * 7 * DAY);
  const months = unit === 'm' ? n : 12 * n;
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - months;
  const day = Math.min(now.getUTCDate(), daysInMonth(year, month));
  return clampedDate(
    Date.UTC(
      year,
      month,
      day,
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

/**
 * Every check against one fetched message (envelope / internalDate / bodyStructure as imapflow
 * gives them).
 */
export function passesChecks(
  checks: readonly Check[],
  msg: { envelope?: unknown; internalDate?: unknown; bodyStructure?: unknown },
): boolean {
  return checks.every((check) => passes(check, msg));
}

/** AND of queries as one SearchObject: a key used twice goes into a one-element `or` slot. */
function and(parts: SearchObject[]): SearchObject {
  const acc: Record<string, unknown> = {};
  const overflow: SearchObject[] = [];
  for (const p of parts) {
    if (Object.keys(p).some((k) => k in acc)) overflow.push(p);
    else Object.assign(acc, p);
  }
  if (overflow.length === 0) return acc;
  const rest = and(overflow);
  // One-element `or` is compiled inline by imapflow: an AND slot.
  if (!('or' in acc)) return { ...acc, or: [rest] };
  if (!('not' in acc)) return { ...acc, not: { not: rest } };
  return { or: [acc], not: { not: rest } };
}

/** The members of a top-level `all`, with nested `all` members flattened in place. */
function flatten(nodes: readonly FilterNode[]): FilterNode[] {
  return nodes.flatMap((node) => (node.kind === 'all' ? flatten(node.of) : [node]));
}

/** A node with no checked leaf anywhere below it: the server decides it alone. */
function isPure(node: FilterNode): boolean {
  switch (node.kind) {
    case 'all':
    case 'any':
      return node.of.every(isPure);
    case 'not':
      return isPure(node.of);
    default:
      return !isChecked(node);
  }
}

/** A leaf the server can't decide alone: its truth is read from each mail. */
function isChecked(node: FilterNode): boolean {
  switch (node.kind) {
    case 'from':
    case 'to':
    case 'cc':
      return node.values.every((v) => addressClass(v) !== 'part');
    case 'since':
    case 'before':
    case 'olderThan':
    case 'newerThan':
    case 'hasAttachments':
      return true;
    default:
      return false;
  }
}

/** The query of a pure node. */
function toQuery(node: FilterNode): SearchObject {
  switch (node.kind) {
    case 'from':
    case 'to':
    case 'cc':
      return addressTerm(node.kind, node.values);
    case 'subject':
      return { subject: node.value };
    case 'body':
      return { body: node.value };
    case 'text':
      return { text: node.value };
    case 'word':
      return { or: [{ from: node.value }, { subject: node.value }] };
    case 'larger':
      return { larger: node.bytes };
    case 'smaller':
      return { smaller: node.bytes };
    case 'seen':
      return { seen: node.value };
    case 'flagged':
      return { flagged: node.value };
    case 'answered':
      return { answered: node.value };
    case 'all':
      return node.of.length === 0 ? { all: true } : and(node.of.map(toQuery));
    case 'any': {
      const [only] = node.of;
      return node.of.length === 1 && only !== undefined
        ? toQuery(only)
        : { or: node.of.map(toQuery) };
    }
    case 'not':
      return { not: toQuery(node.of) };
    default:
      // Checked leaves are never pure (isPure).
      throw new FilterError('unsupported');
  }
}

/** One value as `{ from: v }`; several as an `or`. */
function addressTerm(field: AddressField, values: readonly string[]): SearchObject {
  const terms: SearchObject[] = values.map((value) => ({ [field]: value }));
  const [only] = terms;
  return terms.length === 1 && only !== undefined ? only : { or: terms };
}

/** The check and narrowing term of a checked leaf, positive polarity. */
function checkedLeaf(node: FilterNode, env: Env): Leaf {
  const nowMs = env.now.getTime();
  switch (node.kind) {
    case 'from':
    case 'to':
    case 'cc': {
      const addresses = node.values
        .filter((v) => addressClass(v) === 'address')
        .map((v) => v.toLowerCase());
      const domains = node.values
        .filter((v) => addressClass(v) === 'domain')
        .map((v) => v.slice(1).toLowerCase());
      return {
        check: { kind: 'address', field: node.kind, addresses, domains, want: true },
        term: addressTerm(node.kind, node.values),
      };
    }
    case 'since': {
      const from = env.startOf(node.day);
      return {
        check: { kind: env.dates, fromMs: from, beforeMs: null, want: true },
        term:
          env.dates === 'sent'
            ? sentSinceTerm(from - SENT_MARGIN, nowMs)
            : sinceTerm(from - DAY, nowMs),
      };
    }
    case 'before': {
      const to = env.startOf(node.day);
      return {
        check: { kind: env.dates, fromMs: null, beforeMs: to, want: true },
        term:
          env.dates === 'sent'
            ? sentBeforeTerm(to + SENT_MARGIN, nowMs)
            : beforeTerm(to + DAY, nowMs),
      };
    }
    case 'olderThan': {
      const cutoff = ageCutoff(env.now, node.age).getTime();
      return {
        check: { kind: env.dates, fromMs: null, beforeMs: cutoff, want: true },
        term:
          env.dates === 'sent'
            ? sentBeforeTerm(cutoff + SENT_MARGIN, nowMs)
            : beforeTerm(cutoff + DAY, nowMs),
      };
    }
    case 'newerThan': {
      const cutoff = ageCutoff(env.now, node.age).getTime();
      return {
        check: { kind: env.dates, fromMs: cutoff, beforeMs: null, want: true },
        term:
          env.dates === 'sent'
            ? sentSinceTerm(cutoff - SENT_MARGIN, nowMs)
            : sinceTerm(cutoff - DAY, nowMs),
      };
    }
    case 'hasAttachments':
      return { check: { kind: 'attachment', want: node.value }, term: null };
    default:
      throw new FilterError('unsupported');
  }
}

/** `since` term, unless its date is not clearly in the past (then the check alone decides). */
function sinceTerm(ms: number, nowMs: number): SearchObject | null {
  return ms > nowMs - PAST_MARGIN ? null : { since: new Date(ms) };
}

/** `before` term, unless its date is not clearly in the past (then the check alone decides). */
function beforeTerm(ms: number, nowMs: number): SearchObject | null {
  return ms > nowMs - PAST_MARGIN ? null : { before: new Date(ms) };
}

/** `sentSince` term (`sent` dates), unless its date is not clearly in the past. */
function sentSinceTerm(ms: number, nowMs: number): SearchObject | null {
  return ms > nowMs - PAST_MARGIN ? null : { sentSince: new Date(ms) };
}

/** `sentBefore` term (`sent` dates), unless its date is not clearly in the past. */
function sentBeforeTerm(ms: number, nowMs: number): SearchObject | null {
  return ms > nowMs - PAST_MARGIN ? null : { sentBefore: new Date(ms) };
}

function flipped(check: Check): Check {
  return { ...check, want: !check.want };
}

/** Adds the kinds of every node (`all` itself excepted) to `into`. */
function kindsOf(node: FilterNode, into: Set<Criterion>): void {
  if (node.kind !== 'all') into.add(node.kind);
  if (node.kind === 'all' || node.kind === 'any') {
    for (const member of node.of) kindsOf(member, into);
  } else if (node.kind === 'not') {
    kindsOf(node.of, into);
  }
}

/** A cut-off before 1970 is clamped: an age of thousands of years means nothing is that old. */
function clampedDate(ms: number): Date {
  return new Date(Math.max(0, ms));
}

/** Days in a month; `month` may be negative or past 11 (Date.UTC normalises it). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function passes(
  check: Check,
  msg: { envelope?: unknown; internalDate?: unknown; bodyStructure?: unknown },
): boolean {
  switch (check.kind) {
    case 'address':
      return addressHit(msg.envelope, check) === check.want;
    case 'received':
      return dateCheck(receivedDate(msg.internalDate)?.getTime(), check);
    case 'sent':
      return dateCheck(receivedDate(record(msg.envelope)?.['date'])?.getTime(), check);
    case 'attachment':
      return hasAttachment(msg.bodyStructure) === check.want;
  }
}

/** The date check of `received` or `sent`: the instant `t` (ms) is in range, as `want` says. */
function dateCheck(
  t: number | undefined,
  check: Extract<Check, { kind: 'received' | 'sent' }>,
): boolean {
  // An unknown date never matches, whatever `want` says.
  if (t === undefined) return false;
  const inRange =
    (check.fromMs === null || t >= check.fromMs) && (check.beforeMs === null || t < check.beforeMs);
  return inRange === check.want;
}

/** True when some address of the envelope field is one of the checked addresses or domains. */
function addressHit(envelope: unknown, check: Extract<Check, { kind: 'address' }>): boolean {
  const list = record(envelope)?.[check.field];
  if (!Array.isArray(list)) return false;
  return list.some((entry: unknown) => {
    const address = record(entry)?.['address'];
    if (typeof address !== 'string') return false;
    const value = address.trim().toLowerCase();
    const at = value.lastIndexOf('@');
    return (
      check.addresses.includes(value) || (at >= 0 && check.domains.includes(value.slice(at + 1)))
    );
  });
}
