import type { LogLevel } from '../core/config.js';
import type { InterruptedRun, LogEventName, LogRecord, ReadResult } from '../core/log/index.js';

// Plain text for `mm logs`. Records come from the reader already validated field by field;
// every printed string still goes through sanitize() — a log file is untrusted input, and a
// control or bidi character must never reach the terminal. Text is built from the record's
// real fields only; ids, IPs and targets are never shown.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const CMD_WIDTH = 12;
const CMD_WIDTH_MAX = 32;

// C0/C1 controls and DEL, soft hyphen, the Arabic letter mark, the Mongolian vowel separator,
// zero-width and bidi marks/embeddings/overrides/isolates, line/paragraph separators, word
// joiner … deprecated format controls, BOM, interlinear annotation marks, tag characters and
// lone surrogates.
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u180e\u2060-\u206f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu;

/** Removes every character that could change how the terminal shows the text. */
export function sanitize(text: string): string {
  return text.replace(UNSAFE, '');
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  return value;
}

/** The record with every string (also inside arrays) sanitized; key order kept. */
export function sanitizeRecord(record: LogRecord): LogRecord {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = sanitizeValue(value);
  return out as LogRecord;
}

function str(record: LogRecord, field: string): string {
  const value = record[field];
  return typeof value === 'string' ? value : '';
}

function num(record: LogRecord, field: string): number {
  const value = record[field];
  return typeof value === 'number' ? value : 0;
}

function words(code: string): string {
  return code.replace(/-/g, ' ');
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string | undefined, kind: 'time' | 'date'): Intl.DateTimeFormat {
  const key = `${kind} ${timeZone ?? ''}`;
  let f = formatters.get(key);
  if (f === undefined) {
    const options: Intl.DateTimeFormatOptions =
      kind === 'time'
        ? { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }
        : { year: 'numeric', month: '2-digit', day: '2-digit' };
    f = new Intl.DateTimeFormat('en-GB', {
      ...options,
      ...(timeZone !== undefined && { timeZone }),
    });
    formatters.set(key, f);
  }
  return f;
}

/** `HH:MM:SS` in the given zone (local when undefined). */
function clock(ts: string, timeZone?: string): string {
  const ms = Date.parse(ts);
  // The schema checks the shape of time fields such as `until`, not that the date exists.
  return Number.isNaN(ms) ? '--:--:--' : formatter(timeZone, 'time').format(ms);
}

/** `YYYY-MM-DD` of the instant in the given zone. */
function localDate(ms: number, timeZone?: string): string {
  if (Number.isNaN(ms)) return '----------';
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone, 'date').formatToParts(ms)) parts[p.type] = p.value;
  return `${parts['year'] ?? ''}-${parts['month'] ?? ''}-${parts['day'] ?? ''}`;
}

const DISCOVER_OUTCOME_TEXT: Record<string, string> = {
  found: 'settings found',
  'needs-host': 'IMAP server needed',
  blocked: 'stopped',
  manual: 'settings entered by hand',
  invalid: 'address not valid',
};
const DOMAIN_PROBLEM_TEXT: Record<string, string> = {
  'not-exist': "domain doesn't exist",
  'dns-error': 'DNS error at the domain',
  'dns-unreachable': 'DNS unreachable',
};
const CHOICE_TEXT: Record<string, string> = {
  picked: 'provider picked',
  'host-entered': 'IMAP server entered',
  manual: 'settings entered by hand',
  cancelled: 'cancelled',
};
const AUTH_REASON_TEXT: Record<string, string> = {
  'invalid-credentials': 'invalid credentials',
  unreachable: 'server unreachable',
  unknown: 'unknown error',
  unexpected: 'unexpected error',
};
const CHECK_STATUS_TEXT: Record<string, string> = { ok: 'ok', warn: 'warning', fail: 'failed' };

function discoverText(r: LogRecord): string {
  const source = str(r, 'source');
  const provider = str(r, 'provider');
  const problem = DOMAIN_PROBLEM_TEXT[str(r, 'domainProblem')];
  const choice = CHOICE_TEXT[str(r, 'choice')];
  let text = `provider lookup: ${DISCOVER_OUTCOME_TEXT[str(r, 'outcome')] ?? 'done'}`;
  if (source !== '') text += ` via ${source}`;
  if (provider !== '') text += ` (${provider})`;
  if (problem !== undefined) text += `; ${problem}`;
  if (choice !== undefined) text += `; ${choice}`;
  return text;
}

function blockText(r: LogRecord, timeZone?: string): string {
  const after = `after ${plural(num(r, 'attempts'), 'failed attempt', 'failed attempts')}`;
  const until = Date.parse(str(r, 'until'));
  const untilText = Number.isNaN(until)
    ? ''
    : ` until ${localDate(until, timeZone)} ${clock(str(r, 'until'), timeZone)}`;
  switch (str(r, 'kind')) {
    case 'ip-blocked':
      return `login guard: logins from this connection blocked ${after}${untilText}`;
    case 'permanent':
      return `login guard: this connection blocked permanently ${after}`;
    default:
      return `login guard: mailbox locked ${after}${untilText}`;
  }
}

const ACCOUNT_ACTION_TEXT: Record<string, { ok: string; failed: string }> = {
  'account.add': { ok: 'mailbox added', failed: 'mailbox add failed' },
  'account.test': { ok: 'mailbox test: login works', failed: 'mailbox test failed' },
  'account.password-update': {
    ok: 'mailbox password updated',
    failed: 'mailbox password update failed',
  },
  'account.remove': { ok: 'mailbox removed', failed: 'mailbox remove failed' },
};

/** `mailbox added (gmail)`, `mailbox add failed (custom): auth failed` — never the account id. */
function accountText(r: LogRecord): string {
  const texts = ACCOUNT_ACTION_TEXT[r.event] ?? { ok: r.event, failed: r.event };
  const provider = `(${str(r, 'provider')})`;
  if (str(r, 'outcome') === 'ok') return `${texts.ok} ${provider}`;
  return `${texts.failed} ${provider}: ${words(str(r, 'reason'))}`;
}

/** One event in plain words, from its real fields only (never ids, IPs or targets). */
function rawEventText(r: LogRecord, timeZone?: string): string {
  const event = r.event as LogEventName;
  switch (event) {
    case 'command.start':
      return 'started';
    case 'command.finish': {
      const ms = duration(num(r, 'ms'));
      switch (str(r, 'outcome')) {
        case 'ok':
          return `finished in ${ms}`;
        case 'interrupted':
          return `interrupted after ${ms}`;
        default:
          return `failed (exit ${num(r, 'exit')}) after ${ms}`;
      }
    }
    case 'error.unexpected': {
      const code = str(r, 'code');
      return `unexpected error (${str(r, 'errClass')}${code === '' ? '' : `, ${code}`})`;
    }
    case 'log.truncated':
      return 'log file for this day is full — later lines were not written';
    case 'doctor.check':
      return `doctor check ${str(r, 'check')}: ${CHECK_STATUS_TEXT[str(r, 'status')] ?? 'unknown'}`;
    case 'discover.finish':
      return discoverText(r);
    case 'auth.login':
      return 'Mail Manager login';
    case 'auth.login-failed':
      return `Mail Manager login failed: ${AUTH_REASON_TEXT[str(r, 'reason')] ?? 'unexpected error'}`;
    case 'auth.logout':
      return str(r, 'outcome') === 'logged-out'
        ? 'Mail Manager logout'
        : 'Mail Manager logout (was not logged in)';
    case 'imap.login':
      return `mailbox login (${str(r, 'provider')})`;
    case 'imap.login-failed': {
      const provider = str(r, 'provider');
      if (str(r, 'reason') === 'blocked') {
        return `mailbox login refused by the login guard (${provider})`;
      }
      const counted = r['counted'] === true ? ' — counted by the login guard' : '';
      return `mailbox login failed (${provider}): ${words(str(r, 'reason'))}${counted}`;
    }
    case 'login-guard.challenge':
      return `login guard: confirmation asked after ${plural(num(r, 'attempts'), 'failed attempt', 'failed attempts')}`;
    case 'login-guard.block':
      return blockText(r, timeZone);
    case 'audit.write-failed':
      return `audit record not saved for ${str(r, 'action')} (${words(str(r, 'reason'))})`;
    case 'account.add':
    case 'account.test':
    case 'account.password-update':
    case 'account.remove':
      return accountText(r);
    default:
      return unknownEvent(event);
  }
}

/** Exhaustiveness: a new catalog event without text fails to compile. */
function unknownEvent(event: never): string {
  return `event ${String(event)}`;
}

export function eventText(record: LogRecord, timeZone?: string): string {
  return sanitize(rawEventText(record, timeZone));
}

/**
 * `HH:MM:SS  <cmd>  <text>` in the given zone (local when undefined). The command is
 * sanitized first, then padded to `width` (longer names are not cut).
 */
export function timelineLine(
  record: LogRecord,
  cmd: string,
  timeZone?: string,
  width: number = CMD_WIDTH,
): string {
  return sanitize(
    `${clock(record.ts, timeZone)}  ${sanitize(cmd).padEnd(width)}  ${eventText(record, timeZone)}`,
  );
}

function interruptedLine(
  run: InterruptedRun,
  timeZone?: string,
  width: number = CMD_WIDTH,
): string {
  const cmd = run.cmd === '' ? '-' : run.cmd;
  return sanitize(
    `${clock(run.ts, timeZone)}  ${sanitize(cmd).padEnd(width)}  interrupted or still running`,
  );
}

export interface ReportOptions {
  now: number;
  sinceMs?: number;
  run?: string;
  /** `--security` was given (security events only). */
  securityOnly?: boolean;
  /** `--level` as given; only used for wording (hint, empty message). */
  level?: LogLevel;
  timeZone?: string;
}

/** `24 h`, `30 min`, `7 days`. */
function windowText(ms: number): string {
  if (ms % DAY_MS === 0 && ms > DAY_MS) return `${ms / DAY_MS} days`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} h`;
  return `${Math.round(ms / MINUTE_MS)} min`;
}

export function reportFooters(result: ReadResult, opts: ReportOptions): string[] {
  const lines: string[] = [];
  if (result.unreadable > 0) {
    lines.push(`${plural(result.unreadable, 'unreadable line', 'unreadable lines')} skipped`);
  }
  if (result.unknown > 0) {
    lines.push(
      `${plural(result.unknown, 'unknown event', 'unknown events')} skipped (newer Mail Manager?)`,
    );
  }
  if (result.omitted > 0) {
    // Only flags that would narrow further: not the ones already given.
    const flags = ['--since'];
    if (opts.level !== 'error') flags.push('--level');
    if (opts.securityOnly !== true) flags.push('--security');
    if (opts.run === undefined) flags.push('--run');
    const list =
      flags.length === 1 ? flags.join('') : `${flags.slice(0, -1).join(', ')} or ${flags.at(-1)}`;
    lines.push(
      `${plural(result.omitted, 'older line', 'older lines')} not shown — narrow with ${list}`,
    );
  }
  if (result.skippedFiles > 0) {
    lines.push(
      `${plural(result.skippedFiles, 'log file', 'log files')} skipped (not a regular file, not readable or too large)`,
    );
  }
  if (result.runsCapped) {
    lines.push('Too many runs in these files — interrupted runs are not marked');
  }
  return lines;
}

type Entry = { ms: number; cmd: string; line: (width: number) => string };

/** Fits the longest command shown: at least 12, at most 32 (longer names push the text right). */
function commandWidth(cmds: string[]): number {
  const longest = Math.max(0, ...cmds.map((cmd) => sanitize(cmd).length));
  return Math.min(CMD_WIDTH_MAX, Math.max(CMD_WIDTH, longest));
}

/** `--level warn`/`error`, `--security`, or `--run` within a window: fewer lines than the default. */
function filterActive(opts: ReportOptions): boolean {
  return (
    opts.level === 'warn' ||
    opts.level === 'error' ||
    opts.securityOnly === true ||
    (opts.run !== undefined && opts.sinceMs !== undefined)
  );
}

/**
 * The flat, time-ordered list with date headers (only when it spans days or isn't today),
 * interrupted runs merged in by time, then the footers.
 */
export function formatReport(result: ReadResult, opts: ReportOptions): string[] {
  const tz = opts.timeZone;
  const entries: Entry[] = result.records.map((record) => {
    const own = record.event === 'command.start' || record.event === 'command.finish';
    const cmd = own ? str(record, 'cmd') : (result.runs.get(record.run)?.cmd ?? '');
    const shown = cmd === '' ? '-' : cmd;
    return {
      ms: Date.parse(record.ts),
      cmd: shown,
      line: (width) => timelineLine(record, shown, tz, width),
    };
  });
  for (const run of result.interrupted) {
    entries.push({
      ms: Date.parse(run.ts),
      cmd: run.cmd === '' ? '-' : run.cmd,
      line: (width) => interruptedLine(run, tz, width),
    });
  }
  // Stable: an interrupted marker comes after the records of the same instant.
  entries.sort((a, b) => a.ms - b.ms);

  const lines: string[] = [];
  if (entries.length === 0) {
    lines.push(
      opts.run !== undefined && opts.sinceMs === undefined
        ? sanitize(`No log lines for run ${opts.run}.`)
        : `No ${filterActive(opts) ? 'matching log lines' : 'log lines'} in the last ${windowText(opts.sinceMs ?? DAY_MS)}.`,
    );
  } else {
    const days = entries.map((e) => localDate(e.ms, tz));
    const today = localDate(opts.now, tz);
    const headers = new Set(days).size > 1 || days[0] !== today;
    const width = commandWidth(entries.map((e) => e.cmd));
    let current = '';
    entries.forEach((entry, i) => {
      const day = days[i] ?? '';
      if (headers && day !== current) lines.push(`--- ${day} ---`);
      current = day;
      lines.push(entry.line(width));
    });
  }
  lines.push(...reportFooters(result, opts));
  return lines;
}
