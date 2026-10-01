import { describe, it, expect } from 'vitest';
import {
  EVENT_FIELDS,
  MemoryEventLog,
  NullEventLog,
  passesLevel,
  safeEmit,
  EVENT_KIND,
  LEVEL_ORDER,
  LOG_EVENT_NAMES,
  LOG_SCHEMA_VERSION,
  MAX_LINE_BYTES,
  SECURITY_PREFIX,
  eventLevel,
  formatLine,
  isoTimestamp,
  newRunId,
  renderEvent,
  toRecord,
} from '../../src/core/log/index.js';
import { FAIL2BAN_FAILREGEX } from '../../src/core/security/events.js';
import type { EventLog, LogEvent, RunContext } from '../../src/core/log/index.js';

const APP_EVENTS = [
  'command.start',
  'command.finish',
  'error.unexpected',
  'log.truncated',
  'doctor.check',
  'discover.finish',
  'audit.write-failed',
  'account.add',
  'account.test',
  'account.password-update',
  'account.remove',
] as const;
const SECURITY_EVENTS = [
  'auth.login',
  'auth.login-failed',
  'auth.logout',
  'imap.login',
  'imap.login-failed',
  'login-guard.challenge',
  'login-guard.block',
] as const;

const FIXED = Date.UTC(2026, 8, 23, 10, 15, 2, 123);
const CTX: RunContext = { run: '5f3a9c1e2b7d4a60', ver: '0.5.0', now: () => FIXED, level: 'info' };

const START: LogEvent = {
  event: 'command.start',
  cmd: 'discover',
  opts: ['email'],
  ver: '0.5.0',
  node: '22.13.0',
  os: 'linux',
};
const FINISH: LogEvent = {
  event: 'command.finish',
  cmd: 'discover',
  outcome: 'ok',
  exit: 0,
  ms: 5,
};
const UNEXPECTED: LogEvent = {
  event: 'error.unexpected',
  errClass: 'TypeError',
  code: 'ERR_X',
  stack: ['foo (src/a.js:1:2)'],
};
const TRUNCATED: LogEvent = { event: 'log.truncated' };

const ALL: LogEvent[] = [START, FINISH, UNEXPECTED, TRUNCATED];

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

describe('constants', () => {
  it('pins the schema version, line cap and security prefix', () => {
    expect(LOG_SCHEMA_VERSION).toBe(1);
    expect(MAX_LINE_BYTES).toBe(4096);
    expect(SECURITY_PREFIX).toBe('mm-security ');
  });

  it('lists exactly the M1b-4a, M1b-4b, M1b-4d and M1c-1 events', () => {
    expect([...LOG_EVENT_NAMES].sort()).toEqual([...APP_EVENTS, ...SECURITY_EVENTS].sort());
  });

  it('pins the field order of every event', () => {
    expect(EVENT_FIELDS['command.start']).toEqual(['cmd', 'opts', 'ver', 'node', 'os']);
    expect(EVENT_FIELDS['command.finish']).toEqual(['cmd', 'outcome', 'exit', 'ms']);
    expect(EVENT_FIELDS['error.unexpected']).toEqual(['errClass', 'code', 'stack']);
    expect(EVENT_FIELDS['log.truncated']).toEqual([]);
    expect(EVENT_FIELDS['doctor.check']).toEqual(['check', 'status']);
    expect(EVENT_FIELDS['audit.write-failed']).toEqual(['action', 'reason']);
    for (const name of [
      'account.add',
      'account.test',
      'account.password-update',
      'account.remove',
    ] as const) {
      expect(EVENT_FIELDS[name]).toEqual(['acct', 'provider', 'outcome', 'reason']);
    }
    expect(EVENT_FIELDS['discover.finish']).toEqual([
      'outcome',
      'source',
      'provider',
      'domainProblem',
      'choice',
    ]);
    expect(EVENT_FIELDS['auth.login']).toEqual(['user']);
    expect(EVENT_FIELDS['auth.login-failed']).toEqual(['reason', 'target']);
    expect(EVENT_FIELDS['auth.logout']).toEqual(['outcome']);
    expect(EVENT_FIELDS['imap.login']).toEqual(['acct', 'provider', 'ip', 'target']);
    expect(EVENT_FIELDS['imap.login-failed']).toEqual([
      'acct',
      'provider',
      'reason',
      'counted',
      'ip',
      'target',
    ]);
    expect(EVENT_FIELDS['login-guard.challenge']).toEqual(['ip', 'attempts', 'target']);
    expect(EVENT_FIELDS['login-guard.block']).toEqual([
      'kind',
      'reason',
      'ip',
      'addr',
      'attempts',
      'until',
      'target',
    ]);
  });

  it('command, doctor, discover, audit and account events are app events; auth, imap and guard events are security', () => {
    for (const name of APP_EVENTS) expect(EVENT_KIND[name]).toBe('app');
    for (const name of SECURITY_EVENTS) expect(EVENT_KIND[name]).toBe('security');
  });

  it('orders levels debug < info < warn < error', () => {
    expect(LEVEL_ORDER.debug).toBeLessThan(LEVEL_ORDER.info);
    expect(LEVEL_ORDER.info).toBeLessThan(LEVEL_ORDER.warn);
    expect(LEVEL_ORDER.warn).toBeLessThan(LEVEL_ORDER.error);
  });
});

describe('eventLevel', () => {
  it.each([
    ['ok', 'info'],
    ['failed', 'warn'],
    ['interrupted', 'warn'],
  ] as const)('command.finish %s → %s', (outcome, level) => {
    expect(eventLevel({ ...FINISH, outcome })).toBe(level);
  });

  it('error.unexpected → error; start and truncated → info', () => {
    expect(eventLevel(UNEXPECTED)).toBe('error');
    expect(eventLevel(START)).toBe('info');
    expect(eventLevel(TRUNCATED)).toBe('info');
  });
});

describe('newRunId', () => {
  it('is 16 lowercase hex characters and random', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = newRunId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
  });
});

describe('isoTimestamp', () => {
  it('formats the clock as UTC ISO-8601 with milliseconds', () => {
    expect(isoTimestamp(() => FIXED)).toBe('2026-09-23T10:15:02.123Z');
    expect(isoTimestamp(() => Date.UTC(2026, 0, 1))).toBe('2026-01-01T00:00:00.000Z');
  });

  it('falls back to the real clock when the clock returns NaN', () => {
    const before = Date.now();
    const ts = isoTimestamp(() => NaN);
    const after = Date.now();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const ms = Date.parse(ts);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });
});

describe('toRecord', () => {
  it('puts ts, event first, then fields in EVENT_FIELDS order, then level, run, v', () => {
    expect(Object.keys(toRecord(START, CTX))).toEqual([
      'ts',
      'event',
      'cmd',
      'opts',
      'ver',
      'node',
      'os',
      'level',
      'run',
      'v',
    ]);
    expect(Object.keys(toRecord(FINISH, CTX))).toEqual([
      'ts',
      'event',
      'cmd',
      'outcome',
      'exit',
      'ms',
      'level',
      'run',
      'v',
    ]);
    expect(Object.keys(toRecord(UNEXPECTED, CTX))).toEqual([
      'ts',
      'event',
      'errClass',
      'code',
      'stack',
      'level',
      'run',
      'v',
    ]);
    expect(Object.keys(toRecord(TRUNCATED, CTX))).toEqual(['ts', 'event', 'level', 'run', 'v']);
  });

  it('keeps the field order even when the event object lists keys differently', () => {
    const shuffled = {
      os: 'linux',
      node: '22',
      ver: '1',
      opts: [],
      cmd: 'x',
      event: 'command.start',
    };
    expect(Object.keys(toRecord(shuffled as LogEvent, CTX))).toEqual([
      'ts',
      'event',
      'cmd',
      'opts',
      'ver',
      'node',
      'os',
      'level',
      'run',
      'v',
    ]);
  });

  it('skips undefined optional fields (error.unexpected without code)', () => {
    const rec = toRecord({ event: 'error.unexpected', errClass: 'Error', stack: [] }, CTX);
    expect(Object.keys(rec)).toEqual(['ts', 'event', 'errClass', 'stack', 'level', 'run', 'v']);
    expect('code' in rec).toBe(false);
  });

  it('fills the envelope from the context and the event', () => {
    for (const e of ALL) {
      const rec = toRecord(e, CTX);
      expect(rec.ts).toBe('2026-09-23T10:15:02.123Z');
      expect(rec.event).toBe(e.event);
      expect(rec.level).toBe(eventLevel(e));
      expect(rec.run).toBe(CTX.run);
      expect(rec.v).toBe(1);
    }
  });

  it('level comes from the event, not from the context threshold', () => {
    const rec = toRecord(UNEXPECTED, { ...CTX, level: 'debug' });
    expect(rec.level).toBe('error');
  });

  it('copies the event values', () => {
    expect(toRecord(FINISH, CTX)).toMatchObject({
      cmd: 'discover',
      outcome: 'ok',
      exit: 0,
      ms: 5,
    });
  });
});

describe('formatLine', () => {
  it('app lines are plain JSON', () => {
    const rec = toRecord(START, CTX);
    const line = formatLine(rec, 'app');
    expect(line).toBe(JSON.stringify(rec));
    expect(line.startsWith('mm-security')).toBe(false);
  });

  it('security lines carry the mm-security prefix', () => {
    const rec = toRecord(START, CTX);
    expect(formatLine(rec, 'security')).toBe(`mm-security ${JSON.stringify(rec)}`);
  });

  it('escapes newlines in every string field (one physical line)', () => {
    const evil: LogEvent = {
      event: 'command.start',
      cmd: 'a\nb',
      opts: ['x\r\ny'],
      ver: '1\n{"event":"forged"}',
      node: '22\r',
      os: 'linux\n',
    };
    const line = formatLine(toRecord(evil, CTX), 'app');
    expect(line).not.toMatch(/[\r\n]/);
    const stack: LogEvent = { event: 'error.unexpected', errClass: 'Error', stack: ['a\nb'] };
    expect(formatLine(toRecord(stack, CTX), 'security')).not.toMatch(/[\r\n]/);
  });
});

describe('renderEvent', () => {
  it('returns the kind, the record and the formatted line', () => {
    for (const e of ALL) {
      const r = renderEvent(e, CTX);
      expect(r).not.toBeNull();
      expect(r?.kind).toBe('app');
      expect(r?.record).toEqual(toRecord(e, CTX));
      expect(r?.line).toBe(formatLine(toRecord(e, CTX), 'app'));
    }
  });

  it('trims frames from the end of an over-long error.unexpected until it fits', () => {
    const frames = Array.from(
      { length: 60 },
      (_, i) => `frame${i} (src/${'a'.repeat(150)}.js:1:1)`,
    );
    const r = renderEvent({ event: 'error.unexpected', errClass: 'Error', stack: frames }, CTX);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(bytes(r.line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const kept = r.record['stack'] as string[];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(frames.length);
    expect(kept).toEqual(frames.slice(0, kept.length));
    // As many frames as fit: one more would exceed the cap.
    const bigger = renderEvent(
      { event: 'error.unexpected', errClass: 'Error', stack: frames.slice(0, kept.length + 1) },
      CTX,
    );
    expect(bigger?.record['stack']).toHaveLength(kept.length);
  });

  it('measures the cap in bytes, not characters', () => {
    // 2-byte characters: under 4096 characters but over 4096 bytes in total.
    const frames = Array.from({ length: 20 }, () => 'č'.repeat(150));
    const r = renderEvent({ event: 'error.unexpected', errClass: 'Error', stack: frames }, CTX);
    expect(r).not.toBeNull();
    if (r) expect(bytes(r.line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
  });

  it('drops other over-long events', () => {
    const long: LogEvent = { ...START, cmd: 'x'.repeat(5000) };
    expect(renderEvent(long, CTX)).toBeNull();
    const manyOpts: LogEvent = {
      ...START,
      opts: Array.from({ length: 400 }, (_, i) => `option-${i}`),
    };
    expect(renderEvent(manyOpts, CTX)).toBeNull();
  });

  it('keeps a line exactly at the cap', () => {
    const base = formatLine(toRecord({ ...START, cmd: '' }, CTX), 'app');
    const cmd = 'x'.repeat(MAX_LINE_BYTES - bytes(base));
    const r = renderEvent({ ...START, cmd }, CTX);
    expect(r).not.toBeNull();
    expect(bytes(r?.line ?? '')).toBe(MAX_LINE_BYTES);
    expect(renderEvent({ ...START, cmd: `${cmd}x` }, CTX)).toBeNull();
  });
});

describe('event-log helpers', () => {
  it('passesLevel compares app levels against the threshold', () => {
    expect(passesLevel('app', 'debug', 'info')).toBe(false);
    expect(passesLevel('app', 'info', 'info')).toBe(true);
    expect(passesLevel('app', 'warn', 'info')).toBe(true);
    expect(passesLevel('app', 'warn', 'error')).toBe(false);
    expect(passesLevel('app', 'error', 'error')).toBe(true);
  });

  it('passesLevel always lets security records through', () => {
    expect(passesLevel('security', 'debug', 'error')).toBe(true);
    expect(passesLevel('security', 'info', 'error')).toBe(true);
  });

  it('safeEmit swallows errors from the builder and from emit', () => {
    const throwing = {
      emit(): void {
        throw new Error('emit');
      },
    };
    expect(() =>
      safeEmit(new NullEventLog(), () => {
        throw new Error('build');
      }),
    ).not.toThrow();
    expect(() => safeEmit(throwing, () => START)).not.toThrow();
    const log = new MemoryEventLog(CTX);
    safeEmit(log, () => START);
    expect(log.records).toHaveLength(1);
  });

  it('NullEventLog accepts events', () => {
    const log: EventLog = new NullEventLog();
    expect(() => log.emit(START)).not.toThrow();
  });

  it('MemoryEventLog renders like the file log and applies the threshold', () => {
    const log = new MemoryEventLog({ ...CTX, level: 'warn' });
    log.emit(START);
    log.emit(UNEXPECTED);
    expect(log.records).toEqual([toRecord(UNEXPECTED, CTX)]);
    expect(log.lines).toEqual([renderEvent(UNEXPECTED, CTX)?.line]);
  });
});

const TARGET = 'a'.repeat(64);

function block(over: Partial<Extract<LogEvent, { event: 'login-guard.block' }>> = {}): LogEvent {
  return {
    event: 'login-guard.block',
    kind: 'ip-blocked',
    reason: 'auth-failed',
    ip: '203.0.113.7',
    addr: '203.0.113.7',
    attempts: 3,
    until: '2026-09-24T10:15:02.123Z',
    target: TARGET,
    ...over,
  };
}

function failRegex(): RegExp {
  return new RegExp(
    FAIL2BAN_FAILREGEX.replace('<ADDR>', '((?:\\d{1,3}\\.){3}\\d{1,3}|[0-9a-fA-F:]+)'),
  );
}

describe('M1b-4b events', () => {
  it('levels: doctor.check by status, guard block by kind, failures warn', () => {
    expect(eventLevel({ event: 'doctor.check', check: 'node', status: 'ok' })).toBe('info');
    expect(eventLevel({ event: 'doctor.check', check: 'node', status: 'warn' })).toBe('warn');
    expect(eventLevel({ event: 'doctor.check', check: 'node', status: 'fail' })).toBe('warn');
    expect(eventLevel({ event: 'discover.finish', outcome: 'found' })).toBe('info');
    expect(eventLevel({ event: 'auth.login' })).toBe('info');
    expect(eventLevel({ event: 'auth.logout', outcome: 'logged-out' })).toBe('info');
    expect(
      eventLevel({ event: 'auth.login-failed', reason: 'invalid-credentials', target: TARGET }),
    ).toBe('warn');
    const ctx = { provider: 'custom', ip: 'local', target: TARGET };
    expect(eventLevel({ event: 'imap.login', ...ctx })).toBe('info');
    expect(
      eventLevel({ event: 'imap.login-failed', ...ctx, reason: 'auth-failed', counted: true }),
    ).toBe('warn');
    expect(
      eventLevel({ event: 'login-guard.challenge', ip: 'local', attempts: 2, target: TARGET }),
    ).toBe('warn');
    expect(eventLevel(block())).toBe('warn');
    expect(eventLevel(block({ kind: 'too-many-attempts' }))).toBe('warn');
    expect(eventLevel(block({ kind: 'permanent', until: null }))).toBe('error');
  });

  it('a rendered login-guard.block keeps the fail2ban key order, envelope after target', () => {
    const rendered = renderEvent(block(), CTX);
    expect(rendered?.kind).toBe('security');
    expect(rendered?.line.startsWith(SECURITY_PREFIX)).toBe(true);
    const json = JSON.parse(rendered?.line.slice(SECURITY_PREFIX.length) ?? '{}') as object;
    expect(Object.keys(json)).toEqual([
      'ts',
      'event',
      'kind',
      'reason',
      'ip',
      'addr',
      'attempts',
      'until',
      'target',
      'level',
      'run',
      'v',
    ]);
  });

  it.each<[string, string, string]>([
    ['ip-blocked', '203.0.113.7', '203.0.113.7'],
    ['permanent', '2001:db8:1:2::/64', '2001:db8:1:2:0:0:0:1'],
  ])(
    'FAIL2BAN_FAILREGEX (unchanged) matches a rendered %s line and captures %s',
    (kind, ip, addr) => {
      const event = block({
        kind: kind as 'ip-blocked' | 'permanent',
        ip,
        addr,
        until: kind === 'permanent' ? null : '2026-09-24T10:15:02.123Z',
      });
      const m = failRegex().exec(renderEvent(event, CTX)?.line ?? '');
      expect(m?.[1]).toBe(addr);
    },
  );

  it('FAIL2BAN_FAILREGEX does not match too-many-attempts or a block without addr', () => {
    expect(
      failRegex().test(renderEvent(block({ kind: 'too-many-attempts' }), CTX)?.line ?? ''),
    ).toBe(false);
    expect(failRegex().test(renderEvent(block({ ip: 'local', addr: null }), CTX)?.line ?? '')).toBe(
      false,
    );
  });
});
