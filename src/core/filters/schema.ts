import { z } from 'zod';

// The filter model, version 1 (M3a): what a search asks for, as plain data. A filter is a tree:
// `all` / `any` / `not` around leaves, each leaf one criterion. Every value is typed by the user,
// so each one is checked here at the boundary; values are never logged — only the names of the
// kinds are (`CRITERIA`). No IMAP and no clock here: the compiler (compile.ts) turns a filter
// into a server search.

export const FILTER_VERSION = 1;
export const MAX_FILTER_TEXT = 200; // code points of one text value
export const MAX_FILTER_VALUES = 20; // values of one from / to / cc leaf
export const MAX_FILTER_NODES = 50; // nodes of one filter, the root included
export const MAX_FILTER_DEPTH = 6; // the root is depth 1
export const MAX_FILTER_BYTES = 1_099_511_627_776; // 1024^4

export type AddressField = 'from' | 'to' | 'cc';
export type AgeUnit = 'd' | 'w' | 'm' | 'y';
export type AddressClass = 'address' | 'domain' | 'part';

/** Every node kind except `all`, in the fixed order logs and texts use. */
export const CRITERIA = [
  'from',
  'to',
  'cc',
  'subject',
  'body',
  'text',
  'word',
  'since',
  'before',
  'olderThan',
  'newerThan',
  'larger',
  'smaller',
  'seen',
  'flagged',
  'answered',
  'hasAttachments',
  'any',
  'not',
] as const;
export type Criterion = (typeof CRITERIA)[number];

export type FilterNode =
  | { kind: AddressField; values: string[] }
  | { kind: 'subject' | 'body' | 'text' | 'word'; value: string }
  | { kind: 'since' | 'before'; day: string } // 'YYYY-MM-DD'
  | { kind: 'olderThan' | 'newerThan'; age: string } // '30d' '2w' '6m' '2y'
  | { kind: 'larger' | 'smaller'; bytes: number }
  | { kind: 'seen' | 'flagged' | 'answered' | 'hasAttachments'; value: boolean }
  | { kind: 'all' | 'any'; of: FilterNode[] }
  | { kind: 'not'; of: FilterNode };

export interface Filter {
  version: 1;
  where: FilterNode;
}

/** Matches every mail. */
export const EMPTY_FILTER: Filter = { version: 1, where: { kind: 'all', of: [] } };

const DOMAIN_RE = /^@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const AGE_RE = /^([1-9]\d{0,3})([dwmy])$/;
const AGE_UNITS: readonly AgeUnit[] = ['d', 'w', 'm', 'y'];

/** `@shop.example` is a domain, `a@shop.example` an address, anything else a plain word. */
export function addressClass(value: string): AddressClass {
  if (DOMAIN_RE.test(value)) return 'domain';
  if (ADDRESS_RE.test(value)) return 'address';
  return 'part';
}

/** A real calendar day with a year 1970..2100, or null. */
export function parseDay(day: string): { y: number; m: number; d: number } | null {
  const match = DAY_RE.exec(day);
  if (match === null) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1970 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  const real =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return real ? { y, m, d } : null;
}

/** `30d`, `2w`, `6m`, `2y`: a count of 1..9999 and one unit, or null. */
export function parseAge(age: string): { n: number; unit: AgeUnit } | null {
  const match = AGE_RE.exec(age);
  if (match === null) return null;
  const unit = AGE_UNITS.find((u) => u === match[2]);
  return unit === undefined ? null : { n: Number(match[1]), unit };
}

/** A text value: trimmed, 1..MAX_FILTER_TEXT code points, no control character, no quote. */
function isText(value: string): boolean {
  const length = [...value].length;
  return (
    value === value.trim() &&
    length >= 1 &&
    length <= MAX_FILTER_TEXT &&
    !/\p{Cc}/u.test(value) &&
    !value.includes('"')
  );
}

/** Either only plain words, or addresses and domains: never a mix of the two. */
function sameKind(values: string[]): boolean {
  const words = values.filter((v) => addressClass(v) === 'part').length;
  return words === 0 || words === values.length;
}

const text = z.string().refine(isText);
const addressValues = z.array(text).min(1).max(MAX_FILTER_VALUES).refine(sameKind);

const node: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.strictObject({ kind: z.enum(['from', 'to', 'cc']), values: addressValues }),
    z.strictObject({ kind: z.enum(['subject', 'body', 'text', 'word']), value: text }),
    z.strictObject({
      kind: z.enum(['since', 'before']),
      day: z.string().refine((day) => parseDay(day) !== null),
    }),
    z.strictObject({
      kind: z.enum(['olderThan', 'newerThan']),
      age: z.string().refine((age) => parseAge(age) !== null),
    }),
    z.strictObject({
      kind: z.enum(['larger', 'smaller']),
      bytes: z.number().int().min(1).max(MAX_FILTER_BYTES),
    }),
    z.strictObject({
      kind: z.enum(['seen', 'flagged', 'answered', 'hasAttachments']),
      value: z.boolean(),
    }),
    z.strictObject({ kind: z.literal('all'), of: z.array(node) }),
    z.strictObject({ kind: z.literal('any'), of: z.array(node).min(1) }),
    z.strictObject({ kind: z.literal('not'), of: node }),
  ]),
);

const filterSchema: z.ZodType<Filter> = z.strictObject({
  version: z.literal(FILTER_VERSION),
  where: node,
});

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * False when the raw input has more than MAX_FILTER_NODES nodes or a node deeper than
 * MAX_FILTER_DEPTH. Walked with an explicit stack: a deeply nested input must not overflow it.
 */
function withinLimits(input: unknown): boolean {
  const stack: { node: unknown; depth: number }[] = [
    { node: plainObject(input)?.['where'], depth: 1 },
  ];
  let count = 0;
  for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
    count += 1;
    if (count > MAX_FILTER_NODES || step.depth > MAX_FILTER_DEPTH) return false;
    const of = plainObject(step.node)?.['of'];
    if (Array.isArray(of)) {
      for (const child of of) stack.push({ node: child, depth: step.depth + 1 });
    } else if (plainObject(of) !== null) {
      stack.push({ node: of, depth: step.depth + 1 });
    }
  }
  return true;
}

/** The validated filter (a fresh object), or null when `input` is not one. Never throws. */
export function parseFilter(input: unknown): Filter | null {
  if (!withinLimits(input)) return null;
  try {
    const parsed = filterSchema.safeParse(input);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
