import { randomBytes } from 'node:crypto';
import type { LogLevel } from '../config.js';
import { EVENT_FIELDS, EVENT_KIND, eventLevel, type LogEvent, type LogKind } from './events.js';

export const LOG_SCHEMA_VERSION = 1;
/** Lines stay under this, so parallel O_APPEND writes from two runs never interleave. */
export const MAX_LINE_BYTES = 4096;
/** Prefix of security lines (the login guard's fail2ban filter matches on it). */
export const SECURITY_PREFIX = 'mm-security ';

/** One `mm` invocation. */
export interface RunContext {
  /** 16 lowercase hex characters; ties command.start → command.finish. */
  run: string;
  ver: string;
  now: () => number;
  /** Threshold for app lines; security lines are always written. */
  level: LogLevel;
}

export interface LogRecord {
  ts: string;
  event: string;
  level: LogLevel;
  run: string;
  v: number;
  [field: string]: unknown;
}

export interface RenderedEvent {
  kind: LogKind;
  record: LogRecord;
  line: string;
}

export function newRunId(): string {
  return randomBytes(8).toString('hex');
}

/** UTC ISO-8601 with ms; an invalid clock value falls back to the real clock. */
export function isoTimestamp(now: () => number): string {
  const t = now();
  const date = new Date(Number.isFinite(t) ? t : Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/** Envelope + fields in a fixed key order: ts, event, the event's fields, level, run, v. */
export function toRecord(event: LogEvent, ctx: RunContext): LogRecord {
  const ordered: Record<string, unknown> = { ts: isoTimestamp(ctx.now), event: event.event };
  const values = event as unknown as Record<string, unknown>;
  for (const field of EVENT_FIELDS[event.event] as readonly string[]) {
    if (values[field] !== undefined) ordered[field] = values[field];
  }
  ordered['level'] = eventLevel(event);
  ordered['run'] = ctx.run;
  ordered['v'] = LOG_SCHEMA_VERSION;
  return ordered as LogRecord;
}

/** One line; JSON.stringify escapes newlines, so input can't forge a second line. */
export function formatLine(record: LogRecord, kind: LogKind): string {
  const json = JSON.stringify(record);
  return kind === 'security' ? `${SECURITY_PREFIX}${json}` : json;
}

export function lineBytes(line: string): number {
  return Buffer.byteLength(line, 'utf8');
}

/**
 * Builds the record and its line. An over-long `error.unexpected` loses frames from the end
 * until it fits (the event itself is kept); any other over-long event returns null.
 */
export function renderEvent(event: LogEvent, ctx: RunContext): RenderedEvent | null {
  const kind = EVENT_KIND[event.event];
  let current = event;
  for (;;) {
    const record = toRecord(current, ctx);
    const line = formatLine(record, kind);
    if (lineBytes(line) <= MAX_LINE_BYTES) return { kind, record, line };
    if (current.event !== 'error.unexpected' || current.stack.length === 0) return null;
    current = { ...current, stack: current.stack.slice(0, -1) };
  }
}
