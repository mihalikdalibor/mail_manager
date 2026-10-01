import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  eventText,
  formatReport,
  reportFooters,
  sanitize,
  sanitizeRecord,
  timelineLine,
} from '../../src/cli/log-text.js';
import type { ReportOptions } from '../../src/cli/log-text.js';
import {
  LOG_EVENT_NAMES,
  accountEvent,
  auditWriteFailed,
  authLogin,
  authLoginFailed,
  authLogout,
  commandFinish,
  commandStart,
  discoverFinish,
  doctorCheck,
  guardBlock,
  guardChallenge,
  imapLogin,
  imapLoginFailed,
  renderEvent,
  toRecord,
  unexpectedError,
} from '../../src/core/log/index.js';
import type {
  LogEvent,
  LogEventName,
  LogRecord,
  ReadResult,
  RunContext,
  RunInfo,
} from '../../src/core/log/index.js';

// M1b-4c log text (spec): every printed string is sanitized; the text per event uses only the
// record's real fields and never shows ip, addr, target, user, acct or the run id.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUN = '0123456789abcdef';
const OTHER_RUN = 'fedcba9876543210';
const RT = { ver: '0.6.0', node: '22.13.0', os: 'linux' };
const IP = '203.0.113.77';
const IP6 = '2001:db8:1:2::/64';
const ADDR6 = '2001:db8:1:2:0:0:0:1';
const TARGET = 'd4'.repeat(32);
const USER = randomUUID();
const ACCT = randomUUID();
const UNTIL = '2026-09-29T08:15:00.000Z';

const BRATISLAVA = 'Europe/Bratislava';
const NEW_YORK = 'America/New_York';
const TIME_RE = /^\d{2}:\d{2}:\d{2} {2}/;

function ctx(at: number, run = RUN): RunContext {
  return { run, ver: '0.6.0', now: () => at, level: 'debug' };
}

function rec(event: LogEvent, at = Date.UTC(2026, 8, 29, 8, 0, 0), run = RUN): LogRecord {
  const rendered = renderEvent(event, ctx(at, run));
  if (rendered === null) throw new Error('not rendered');
  return rendered.record;
}

function result(records: LogRecord[], extra: Partial<ReadResult> = {}): ReadResult {
  return {
    folder: 'ok',
    runsCapped: false,
    records,
    runs: new Map<string, RunInfo>(),
    interrupted: [],
    unreadable: 0,
    unknown: 0,
    omitted: 0,
    skippedFiles: 0,
    ...extra,
  };
}

/** Control, bidi or invisible characters that must never reach the terminal. */
function hasUnsafe(text: string): boolean {
  return [...text].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x2069)
    );
  });
}

function runInfo(cmd: string, lastTs: string): RunInfo {
  return { cmd, started: true, finished: true, lastTs, truncatedDay: false };
}

describe('sanitize', () => {
  const removed: [string, string][] = [
    ['NUL', '\u0000'],
    ['BEL', '\u0007'],
    ['BS', '\u0008'],
    ['TAB', '\t'],
    ['LF', '\n'],
    ['CR', '\r'],
    ['ESC', '\u001b'],
    ['US', '\u001f'],
    ['DEL', '\u007f'],
    ['C1 start', '\u0080'],
    ['CSI (C1)', '\u009b'],
    ['C1 end', '\u009f'],
    ['soft hyphen', '\u00ad'],
    ['ALM', '\u061c'],
    ['ZWSP', '\u200b'],
    ['ZWNJ', '\u200c'],
    ['ZWJ', '\u200d'],
    ['LRM', '\u200e'],
    ['RLM', '\u200f'],
    ['LRE', '\u202a'],
    ['RLE', '\u202b'],
    ['PDF', '\u202c'],
    ['LRO', '\u202d'],
    ['RLO', '\u202e'],
    ['word joiner', '\u2060'],
    ['invisible times', '\u2062'],
    ['LRI', '\u2066'],
    ['RLI', '\u2067'],
    ['FSI', '\u2068'],
    ['PDI', '\u2069'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
    ['BOM', '\ufeff'],
    ['tag begin', '\u{e0001}'],
    ['tag A', '\u{e0041}'],
    ['cancel tag', '\u{e007f}'],
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate', '\udfff'],
  ];

  it.each(removed)('removes %s', (_name, ch) => {
    expect(sanitize(`a${ch}b`)).toBe('ab');
    expect(sanitize(`${ch}${ch}`)).toBe('');
  });

  it('ANSI and OSC sequences lose their ESC and BEL', () => {
    expect(sanitize('\u001b[31mred\u001b[0m')).toBe('[31mred[0m');
    expect(sanitize('\u001b]0;pwn\u0007{"ts":"x"}')).toBe(']0;pwn{"ts":"x"}');
    expect(sanitize('\u009b2J')).toBe('2J');
  });

  it('removes a lone surrogate but keeps a pair', () => {
    expect(sanitize('x\ud83dy')).toBe('xy');
    expect(sanitize('x\ude00y')).toBe('xy');
    expect(sanitize('\ude00\ud83d')).toBe('');
    expect(sanitize('x😀y')).toBe('x😀y');
  });

  it.each([
    'Žluťoučký kůň úpěl ďábelské ódy',
    'plain ASCII text 123 - _ . , : ; ! ? ( ) [ ] { } " \' / \\ @ # $ % ^ & * + = ~ `',
    '日本語のテキスト',
    '中文 한국어',
    'emoji 😀 🎉 👍🏽 🇸🇰',
    'Ελληνικά and Кириллица',
    'עברית ومرحبا',
  ])('keeps %s', (text) => {
    expect(sanitize(text)).toBe(text);
  });

  it('the empty string stays empty', () => {
    expect(sanitize('')).toBe('');
  });
});

describe('sanitizeRecord', () => {
  it('sanitizes every string value, also inside arrays, and keeps the key order', () => {
    const record = {
      ts: '2026-09-29T08:00:00.000Z',
      event: 'command.start',
      cmd: 'key\u001b[2Jgen',
      opts: ['js\u202eon', 'x\u0000'],
      ver: '0.6.0\u200b',
      node: '22',
      os: 'linux',
      level: 'info',
      run: RUN,
      v: 1,
    } as LogRecord;
    const clean = sanitizeRecord(record);
    expect(clean).toEqual({
      ...record,
      cmd: 'key[2Jgen',
      opts: ['json', 'x'],
      ver: '0.6.0',
    });
    expect(Object.keys(clean)).toEqual(Object.keys(record));
  });

  it('keeps numbers, booleans and null unchanged', () => {
    const record = rec(
      guardBlock({
        kind: 'too-many-attempts',
        reason: 'auth-failed',
        ip: IP,
        addr: null,
        attempts: 5,
        until: null,
        target: TARGET,
      }),
    );
    expect(sanitizeRecord(record)).toEqual(record);
    const failed = rec(
      imapLoginFailed({ provider: 'custom', ip: IP, target: TARGET }, 'timeout', true),
    );
    expect(sanitizeRecord(failed)).toEqual(failed);
    expect(Object.keys(sanitizeRecord(failed))).toEqual(Object.keys(failed));
  });
});

/** One realistic record per catalog event (plus variants), for the eventText checks. */
function samples(): Map<LogEventName, LogRecord[]> {
  const list: LogEvent[] = [
    commandStart('keygen', ['json'], RT),
    commandFinish('keygen', 0, 12),
    commandFinish('login', 2, 12),
    commandFinish('login', 130, 12),
    unexpectedError(Object.assign(new Error('boom'), { code: 'ECONNRESET' }), REPO_ROOT),
    unexpectedError('not an error', REPO_ROOT),
    { event: 'log.truncated' },
    doctorCheck('master-key', 'fail'),
    doctorCheck('node', 'ok'),
    discoverFinish({ outcome: 'found', source: 'preset-domain', provider: 'websupport' }),
    discoverFinish({ outcome: 'needs-host', domainProblem: 'not-exist', choice: 'host-entered' }),
    discoverFinish({ outcome: 'invalid' }),
    authLogin(USER),
    authLogin('not-a-uuid'),
    authLoginFailed('invalid-credentials', TARGET),
    authLoginFailed('unreachable', 'invalid'),
    authLogout('logged-out'),
    authLogout('not-logged-in'),
    imapLogin({ provider: 'websupport', acct: ACCT, ip: IP, target: TARGET }),
    imapLogin({ provider: 'custom', ip: IP6, target: TARGET }),
    imapLoginFailed(
      { provider: 'websupport', acct: ACCT, ip: IP, target: TARGET },
      'auth-failed',
      true,
    ),
    imapLoginFailed({ provider: 'custom', ip: IP6, target: TARGET }, 'blocked', false),
    guardChallenge(IP, 3, TARGET),
    guardBlock({
      kind: 'ip-blocked',
      reason: 'auth-failed',
      ip: IP,
      addr: IP,
      attempts: 5,
      until: UNTIL,
      target: TARGET,
    }),
    guardBlock({
      kind: 'permanent',
      reason: 'auth-failed',
      ip: IP6,
      addr: ADDR6,
      attempts: 9,
      until: null,
      target: TARGET,
    }),
    guardBlock({
      kind: 'too-many-attempts',
      reason: 'timeout',
      ip: 'local',
      addr: null,
      attempts: 5,
      until: UNTIL,
      target: TARGET,
    }),
    auditWriteFailed('mail.trash', 'unavailable'),
    auditWriteFailed('bogus', 'unknown'),
    accountEvent('account.add', { acct: ACCT, provider: 'gmail', outcome: 'ok' }),
    accountEvent('account.add', { provider: 'custom', outcome: 'failed', reason: 'auth-failed' }),
    accountEvent('account.test', { acct: ACCT, provider: 'websupport', outcome: 'ok' }),
    accountEvent('account.test', {
      acct: ACCT,
      provider: 'websupport',
      outcome: 'failed',
      reason: 'secret-unreadable',
    }),
    accountEvent('account.password-update', { acct: ACCT, provider: 'gmail', outcome: 'ok' }),
    accountEvent('account.remove', { acct: ACCT, provider: 'gmail', outcome: 'ok' }),
    accountEvent('account.remove', {
      acct: ACCT,
      provider: 'gmail',
      outcome: 'failed',
      reason: 'not-found',
    }),
  ];
  const map = new Map<LogEventName, LogRecord[]>();
  for (const e of list) map.set(e.event, [...(map.get(e.event) ?? []), rec(e)]);
  return map;
}

describe('eventText', () => {
  const all = samples();

  it('has samples for all 18 catalog events', () => {
    expect([...all.keys()].sort()).toEqual([...LOG_EVENT_NAMES].sort());
  });

  it.each(LOG_EVENT_NAMES)('%s: non-empty, one line, no ids or addresses', (name) => {
    for (const record of all.get(name) ?? []) {
      const text = eventText(record);
      expect(text.trim()).not.toBe('');
      expect(hasUnsafe(text)).toBe(false);
      for (const secret of [IP, IP6, ADDR6, '2001:db8', TARGET, USER, ACCT, RUN]) {
        expect(text).not.toContain(secret);
      }
      expect(text).toBe(sanitize(text));
    }
  });

  it('command.start → exactly "started"', () => {
    expect(eventText(rec(commandStart('keygen', [], RT)))).toBe('started');
    expect(eventText(rec(commandStart('account add', ['email'], RT)))).toBe('started');
  });

  it('command.finish per outcome', () => {
    expect(eventText(rec(commandFinish('keygen', 0, 12)))).toContain('finished');
    const failed = eventText(rec(commandFinish('login', 2, 12)));
    expect(failed).toContain('failed');
    expect(failed).toContain('exit 2');
    const failed1 = eventText(rec(commandFinish('login', 1, 12)));
    expect(failed1).toContain('failed');
    expect(failed1).toContain('exit 1');
    expect(eventText(rec(commandFinish('login', 130, 12)))).toContain('interrupted');
  });

  it('auth.login-failed invalid-credentials wording', () => {
    expect(eventText(rec(authLoginFailed('invalid-credentials', TARGET)))).toContain(
      'Mail Manager login failed: invalid credentials',
    );
  });

  it('other pinned words', () => {
    const lower = (e: LogEvent): string => eventText(rec(e)).toLowerCase();
    expect(
      lower(imapLoginFailed({ provider: 'custom', ip: IP, target: TARGET }, 'auth-failed', true)),
    ).toContain('mailbox login');
    expect(
      lower(
        guardBlock({
          kind: 'ip-blocked',
          reason: 'auth-failed',
          ip: IP,
          addr: IP,
          attempts: 5,
          until: UNTIL,
          target: TARGET,
        }),
      ),
    ).toContain('login guard');
    expect(eventText(rec(auditWriteFailed('mail.trash', 'unavailable')))).toContain('mail.trash');
    expect(eventText(rec(auditWriteFailed('account.add', 'forbidden')))).toContain('account.add');
    expect(eventText(rec(doctorCheck('master-key', 'fail')))).toContain('master-key');
    expect(eventText(rec(doctorCheck('supabase-env', 'ok')))).toContain('supabase-env');
    expect(lower({ event: 'log.truncated' })).toContain('full');
  });

  it('the auth user id and the mail account id are never shown', () => {
    expect(eventText(rec(authLogin(USER)))).not.toContain(USER);
    expect(
      eventText(rec(imapLogin({ provider: 'websupport', acct: ACCT, ip: IP, target: TARGET }))),
    ).not.toContain(ACCT);
  });
});

describe('timelineLine', () => {
  const at = Date.parse('2026-09-29T21:30:05.000Z');
  const record = rec(commandStart('keygen', [], RT), at);

  it('HH:MM:SS in the given zone, cmd padded to 12, then the text', () => {
    expect(timelineLine(record, 'keygen', BRATISLAVA)).toBe(
      `23:30:05  ${'keygen'.padEnd(12)}  started`,
    );
    expect(timelineLine(record, 'keygen', NEW_YORK)).toBe(
      `17:30:05  ${'keygen'.padEnd(12)}  started`,
    );
    expect(timelineLine(record, 'keygen', 'UTC')).toBe(`21:30:05  ${'keygen'.padEnd(12)}  started`);
  });

  it('24 h clock: midnight is 00, afternoon is 13+', () => {
    const midnight = rec(commandStart('keygen', [], RT), Date.parse('2026-09-29T22:00:00.000Z'));
    expect(timelineLine(midnight, 'keygen', BRATISLAVA).slice(0, 8)).toBe('00:00:00');
    const afternoon = rec(commandStart('keygen', [], RT), Date.parse('2026-09-29T13:07:09.000Z'));
    expect(timelineLine(afternoon, 'keygen', 'UTC').slice(0, 8)).toBe('13:07:09');
  });

  it('a long cmd is not cut; the text follows two spaces after it', () => {
    const long = 'account password-update';
    expect(timelineLine(record, long, 'UTC')).toBe(`21:30:05  ${long}  started`);
  });

  it('uses eventText for the text part', () => {
    const r = rec(doctorCheck('master-key', 'fail'), at);
    expect(timelineLine(r, 'doctor', 'UTC')).toBe(
      `21:30:05  ${'doctor'.padEnd(12)}  ${eventText(r)}`,
    );
  });

  it('sanitizes the cmd it is given', () => {
    const out = timelineLine(record, 'key\u001b]0;pwn\u0007gen\u202e', 'UTC');
    expect(hasUnsafe(out)).toBe(false);
  });
});

describe('formatReport', () => {
  // 2026-09-29 12:00 UTC = 14:00 in Bratislava, 08:00 in New York.
  const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
  const base: ReportOptions = { now: NOW, timeZone: BRATISLAVA };

  it('one line per record, no header when everything is today', () => {
    const a = rec(commandStart('keygen', [], RT), NOW - 2 * 3_600_000, OTHER_RUN);
    const b = rec(authLogout('logged-out'), NOW - 3_600_000, RUN);
    const c = rec(doctorCheck('node', 'ok'), NOW - 1_800_000, 'abababababababab');
    const runs = new Map<string, RunInfo>([
      [OTHER_RUN, runInfo('keygen', a.ts)],
      [RUN, runInfo('logout', b.ts)],
    ]);
    const lines = formatReport(result([a, b, c], { runs }), base);
    expect(lines).toEqual([
      timelineLine(a, 'keygen', BRATISLAVA),
      timelineLine(b, 'logout', BRATISLAVA),
      timelineLine(c, '-', BRATISLAVA),
    ]);
    expect(lines[0]).toBe(`12:00:00  ${'keygen'.padEnd(12)}  started`);
  });

  it('command.* lines use the record’s own cmd', () => {
    const a = rec(commandStart('doctor', [], RT), NOW - 3_600_000, RUN);
    const runs = new Map<string, RunInfo>([[RUN, runInfo('keygen', a.ts)]]);
    expect(formatReport(result([a], { runs }), base)).toEqual([
      timelineLine(a, 'doctor', BRATISLAVA),
    ]);
  });

  it('merges interrupted runs in by time', () => {
    const a = rec(commandStart('keygen', [], RT), NOW - 3 * 3_600_000, OTHER_RUN);
    const b = rec(authLogout('logged-out'), NOW - 3_600_000, RUN);
    const interruptedTs = new Date(NOW - 2 * 3_600_000).toISOString();
    const lines = formatReport(
      result([a, b], {
        runs: new Map([[RUN, runInfo('logout', b.ts)]]),
        interrupted: [{ run: 'abababababababab', cmd: 'login', ts: interruptedTs }],
      }),
      base,
    );
    expect(lines).toEqual([
      timelineLine(a, 'keygen', BRATISLAVA),
      `12:00:00  ${'login'.padEnd(12)}  interrupted or still running`,
      timelineLine(b, 'logout', BRATISLAVA),
    ]);
  });

  it('only interrupted runs: no empty message', () => {
    const lines = formatReport(
      result([], {
        interrupted: [{ run: RUN, cmd: 'doctor', ts: new Date(NOW - 3_600_000).toISOString() }],
      }),
      base,
    );
    expect(lines).toEqual([`13:00:00  ${'doctor'.padEnd(12)}  interrupted or still running`]);
  });

  it('date headers when the lines span two local days', () => {
    const y = rec(commandStart('keygen', [], RT), Date.UTC(2026, 8, 28, 20, 0, 0), RUN);
    const t = rec(commandFinish('keygen', 0, 1), Date.UTC(2026, 8, 29, 9, 0, 0), RUN);
    const lines = formatReport(result([y, t]), base);
    const headers = lines.filter((l) => !TIME_RE.test(l));
    expect(headers).toHaveLength(2);
    const h1 = lines.findIndex((l) => l.includes('2026-09-28'));
    const h2 = lines.findIndex((l) => l.includes('2026-09-29'));
    expect(h1).toBe(0);
    expect(lines[h1 + 1]).toBe(timelineLine(y, 'keygen', BRATISLAVA));
    expect(h2).toBe(h1 + 2);
    expect(lines[h2 + 1]).toBe(timelineLine(t, 'keygen', BRATISLAVA));
    expect(lines).toHaveLength(4);
  });

  it('a header when the only lines are from an earlier local day', () => {
    const y = rec(commandStart('keygen', [], RT), Date.UTC(2026, 8, 28, 20, 0, 0), RUN);
    const lines = formatReport(result([y]), base);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('2026-09-28');
    expect(TIME_RE.test(lines[0] ?? '')).toBe(false);
    expect(lines[1]).toBe(timelineLine(y, 'keygen', BRATISLAVA));
  });

  it('local days, not UTC days, decide the headers', () => {
    const now = Date.parse('2026-09-29T23:00:00.000Z'); // 01:00 on the 30th in Bratislava
    const r = rec(commandStart('keygen', [], RT), Date.parse('2026-09-29T22:30:00.000Z'), RUN);
    // Same local day (the 30th) in Bratislava → no header.
    expect(formatReport(result([r]), { now, timeZone: BRATISLAVA })).toEqual([
      timelineLine(r, 'keygen', BRATISLAVA),
    ]);
    // Same local day (the 29th) in New York → no header.
    expect(formatReport(result([r]), { now, timeZone: NEW_YORK })).toEqual([
      timelineLine(r, 'keygen', NEW_YORK),
    ]);
    // 23:30 on the 29th vs. now 00:30 on the 30th in Bratislava → header with the 29th.
    const late = rec(commandStart('keygen', [], RT), Date.parse('2026-09-29T21:30:00.000Z'), RUN);
    const lines = formatReport(result([late]), {
      now: Date.parse('2026-09-29T22:30:00.000Z'),
      timeZone: BRATISLAVA,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('2026-09-29');
    expect(lines[1]).toBe(timelineLine(late, 'keygen', BRATISLAVA));
  });

  it('interrupted lines count for the day headers too', () => {
    const t = rec(commandStart('keygen', [], RT), NOW - 3_600_000, RUN);
    const lines = formatReport(
      result([t], {
        interrupted: [
          {
            run: OTHER_RUN,
            cmd: 'login',
            ts: new Date(Date.UTC(2026, 8, 28, 20, 0, 0)).toISOString(),
          },
        ],
      }),
      base,
    );
    expect(lines.filter((l) => !TIME_RE.test(l))).toHaveLength(2);
    expect(lines[0]).toContain('2026-09-28');
    expect(lines[1]).toBe(`22:00:00  ${'login'.padEnd(12)}  interrupted or still running`);
  });

  describe('footers', () => {
    const one = (): LogRecord => rec(commandStart('keygen', [], RT), NOW - 3_600_000, RUN);

    it.each<[Partial<ReadResult>, string]>([
      [{ unreadable: 1 }, '1 unreadable line skipped'],
      [{ unreadable: 3 }, '3 unreadable lines skipped'],
      [{ unknown: 1 }, '1 unknown event skipped (newer Mail Manager?)'],
      [{ unknown: 2 }, '2 unknown events skipped (newer Mail Manager?)'],
      [{ omitted: 1 }, '1 older line not shown — narrow with --since or --run'],
      [{ omitted: 5 }, '5 older lines not shown — narrow with --since or --run'],
      [{ skippedFiles: 1 }, '1 log file skipped (not a regular file, not readable or too large)'],
      [{ skippedFiles: 2 }, '2 log files skipped (not a regular file, not readable or too large)'],
    ])('%j → %s', (extra, text) => {
      const r = result([one()], extra);
      expect(reportFooters(r, base)).toEqual([text]);
      const lines = formatReport(r, base);
      expect(lines).toEqual([timelineLine(one(), 'keygen', BRATISLAVA), text]);
    });

    it('none when all counts are 0', () => {
      expect(reportFooters(result([one()]), base)).toEqual([]);
    });

    it('all four, after the lines, in order', () => {
      const r = result([one()], { unreadable: 2, unknown: 1, omitted: 4, skippedFiles: 3 });
      const footers = [
        '2 unreadable lines skipped',
        '1 unknown event skipped (newer Mail Manager?)',
        '4 older lines not shown — narrow with --since or --run',
        '3 log files skipped (not a regular file, not readable or too large)',
      ];
      expect(reportFooters(r, base)).toEqual(footers);
      expect(formatReport(r, base)).toEqual([
        timelineLine(one(), 'keygen', BRATISLAVA),
        ...footers,
      ]);
    });
  });

  describe('empty', () => {
    it.each<[Partial<ReportOptions>, string]>([
      [{}, 'No log lines in the last 24 h.'],
      [{ sinceMs: 24 * 3_600_000 }, 'No log lines in the last 24 h.'],
      [{ sinceMs: 30 * 60_000 }, 'No log lines in the last 30 min.'],
      [{ sinceMs: 7 * 24 * 3_600_000 }, 'No log lines in the last 7 days.'],
      [{ run: RUN }, `No log lines for run ${RUN}.`],
    ])('%j → %s', (opts, text) => {
      expect(formatReport(result([]), { ...base, ...opts })).toEqual([text]);
    });

    it('footers still follow', () => {
      expect(formatReport(result([], { unreadable: 2, skippedFiles: 1 }), base)).toEqual([
        'No log lines in the last 24 h.',
        '2 unreadable lines skipped',
        '1 log file skipped (not a regular file, not readable or too large)',
      ]);
    });
  });

  it('sanitizes everything it prints', () => {
    const bad = {
      ...rec(doctorCheck('node', 'ok'), NOW - 3_600_000, RUN),
      check: 'node\u001b]0;pwn\u0007\u202e',
    } as LogRecord;
    const start = {
      ...rec(commandStart('keygen', [], RT), NOW - 7_200_000, OTHER_RUN),
      cmd: 'key\u001b[2Jgen\u200b',
    } as LogRecord;
    const lines = formatReport(
      result([start, bad], {
        runs: new Map([[RUN, runInfo('doc\u001btor\u2066', bad.ts)]]),
        interrupted: [
          {
            run: 'abababababababab',
            cmd: 'lo\u0000gin\u009b',
            ts: new Date(NOW - 1000).toISOString(),
          },
        ],
      }),
      base,
    );
    expect(lines.some(hasUnsafe)).toBe(false);
    expect(lines).toHaveLength(3);
  });

  it('never prints ids or addresses from the records', () => {
    const records = [...samples().values()].flat();
    const runs = new Map([[RUN, runInfo('login', records.at(-1)?.ts ?? '')]]);
    const text = formatReport(result(records, { runs }), { now: Date.UTC(2026, 8, 29, 9) }).join(
      '\n',
    );
    for (const secret of [IP, IP6, ADDR6, TARGET, USER, ACCT, RUN]) {
      expect(text).not.toContain(secret);
    }
  });

  it('log.truncated from toRecord renders too', () => {
    const r = toRecord({ event: 'log.truncated' }, ctx(NOW - 60_000));
    const lines = formatReport(result([r]), base);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.toLowerCase()).toContain('full');
  });
});

describe('sanitize: review follow-ups (M1b-4c)', () => {
  it('removes the Mongolian vowel separator, deprecated format controls and annotation marks', () => {
    const unsafe = ['᠎', '⁪', '⁯', '￹', '￻'];
    for (const ch of unsafe) expect(sanitize(`a${ch}b`)).toBe('ab');
    expect(sanitize('Žluťoučký kůň 😀')).toBe('Žluťoučký kůň 😀');
  });
});
