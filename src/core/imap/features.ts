// Server capabilities are untrusted input: they come from whatever host the user typed and
// end up in `mail_accounts.capabilities` (jsonb). Everything here bounds and normalises them.

/** Sanitised capability list: upper-case name → `true` or a number (e.g. APPENDLIMIT). */
export type CapabilityRecord = Record<string, true | number>;

export const MAX_CAPABILITIES = 256;
export const MAX_CAPABILITY_NAME = 64;

const CAPABILITY_NAME = /^[A-Z0-9][A-Z0-9=+\-._/]{0,63}$/;

function validValue(value: unknown): value is true | number {
  return (
    value === true ||
    (typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER)
  );
}

/**
 * Keeps names matching CAPABILITY_NAME (after upper-casing) with a `true` or non-negative
 * integer value; at most MAX_CAPABILITIES entries, sorted by name for a deterministic result.
 */
export function sanitizeCapabilities(
  input: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>,
): CapabilityRecord {
  const entries: [string, unknown][] =
    input instanceof Map
      ? [...(input as ReadonlyMap<string, unknown>).entries()]
      : Object.entries(input);

  const valid = new Map<string, true | number>();
  for (const [rawName, value] of entries) {
    if (typeof rawName !== 'string' || rawName.length > MAX_CAPABILITY_NAME) continue;
    const name = rawName.toUpperCase();
    if (!CAPABILITY_NAME.test(name) || !validValue(value)) continue;
    valid.set(name, value);
  }

  const result: CapabilityRecord = {};
  for (const name of [...valid.keys()].sort().slice(0, MAX_CAPABILITIES)) {
    // defineProperty: never goes through a setter, whatever the name.
    Object.defineProperty(result, name, {
      value: valid.get(name),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/** What the connected server supports. Core code checks these, never raw capability strings. */
export interface ServerFeatures {
  uidplus: boolean;
  move: boolean;
  specialUse: boolean;
  quota: boolean;
  statusSize: boolean;
  condstore: boolean;
  qresync: boolean;
  esearch: boolean;
  within: boolean;
  listStatus: boolean;
  objectId: boolean;
  gmail: boolean;
  idle: boolean;
  compress: boolean;
  rev2: boolean;
  appendLimit: number | undefined;
}

/** Part of the IMAP4rev2 base (docs/IMAP.md §1) — present once rev2 is actually enabled. */
const REV2_FOLDED = new Set([
  'ESEARCH',
  'IDLE',
  'LIST-STATUS',
  'MOVE',
  'SPECIAL-USE',
  'STATUS=SIZE',
  'UIDPLUS',
]);

/**
 * Builds features from post-login capabilities + the ENABLE result. rev2 folding applies only
 * when IMAP4rev2 is advertised AND enabled: a server may advertise it and then reject ENABLE.
 */
export function buildServerFeatures(
  caps: CapabilityRecord,
  enabled: ReadonlySet<string>,
): ServerFeatures {
  const rev2 = caps.IMAP4REV2 !== undefined && enabled.has('IMAP4REV2');
  const has = (name: string): boolean =>
    caps[name] !== undefined || (rev2 && REV2_FOLDED.has(name));
  const appendLimit = caps.APPENDLIMIT;

  return {
    uidplus: has('UIDPLUS'),
    move: has('MOVE'),
    specialUse: has('SPECIAL-USE'),
    quota: has('QUOTA'),
    statusSize: has('STATUS=SIZE'),
    condstore: has('CONDSTORE') || enabled.has('CONDSTORE'),
    qresync: has('QRESYNC'),
    esearch: has('ESEARCH'),
    within: has('WITHIN'),
    listStatus: has('LIST-STATUS'),
    objectId: has('OBJECTID'),
    gmail: has('X-GM-EXT-1'),
    idle: has('IDLE'),
    compress: has('COMPRESS=DEFLATE'),
    rev2,
    appendLimit: typeof appendLimit === 'number' ? appendLimit : undefined,
  };
}

const SERVER_NAME = /^[\w .-]{1,64}$/;

/** The server's self-reported name (IMAP ID) if it's short and plain; nothing else from ID. */
export function sanitizeServerName(info: unknown): string | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  const name = (info as { name?: unknown }).name;
  return typeof name === 'string' && SERVER_NAME.test(name) ? name : undefined;
}
