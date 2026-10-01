import { z } from 'zod';
import { LOG_LEVELS } from '../config.js';
import { RUN_RE } from './event-schemas.js';
import type { LogKind } from './events.js';
import { lineBytes, MAX_LINE_BYTES, SECURITY_PREFIX, type LogRecord } from './record.js';

// Log lines are untrusted input (anyone with file access can edit them): every line read back
// is validated; a malformed line is skipped by the caller, never printed raw.

const envelope = z.looseObject({
  ts: z.iso.datetime(),
  event: z.string().regex(/^[a-z]+(-[a-z]+)*(\.[a-z]+(-[a-z]+)*)+$/),
  level: z.enum(LOG_LEVELS),
  run: z.string().regex(RUN_RE),
  // Any number: validateRecord counts another version as "unknown" (a newer Mail Manager).
  v: z.number(),
});

export interface ParsedLogLine {
  kind: LogKind;
  record: LogRecord;
}

/** One line → kind + record, or null for anything malformed. Never throws. */
export function parseLogLine(line: string): ParsedLogLine | null {
  const security = line.startsWith(SECURITY_PREFIX);
  const json = security ? line.slice(SECURITY_PREFIX.length) : line;
  // The writer never produces more: an over-long line is rejected before JSON.parse.
  if (lineBytes(json) > MAX_LINE_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  // JSON.parse keeps `__proto__` as an own key, but zod's copy drops it: the strict per-event
  // schema would never see that extra field.
  if (data !== null && typeof data === 'object' && Object.hasOwn(data, '__proto__')) return null;
  const parsed = envelope.safeParse(data);
  if (!parsed.success) return null;
  return { kind: security ? 'security' : 'app', record: parsed.data };
}
