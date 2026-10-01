import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { CheckStatus } from '../../src/core/doctor.js';
import { IMAP_FAILURE_REASONS, type ImapFailureReason } from '../../src/core/imap/errors.js';
import { AUDIT_ACTIONS } from '../../src/core/db/repos.js';
import type { DiscoverySource, DomainProblem } from '../../src/core/providers/discover.js';
import type { BlockKind } from '../../src/core/security/events.js';
import {
  EVENT_FIELDS,
  EVENT_KIND,
  LOG_EVENT_NAMES,
  LOG_SCHEMA_VERSION,
  SECURITY_PREFIX,
  TARGET_RE,
  accountEvent,
  auditWriteFailed,
  authLogin,
  authLoginFailed,
  authLogout,
  commandFinish,
  commandStart,
  discoverFinish,
  doctorCheck,
  formatLine,
  guardBlock,
  guardChallenge,
  imapLogin,
  imapLoginFailed,
  parseLogLine,
  renderEvent,
  toRecord,
  unexpectedError,
  validateRecord,
} from '../../src/core/log/index.js';
import type {
  AuditFailureReason,
  AuthFailureReason,
  AuthLogoutEvent,
  DiscoverChoice,
  DiscoverOutcome,
  LogEvent,
  LogEventName,
  LogKind,
  LogRecord,
  ParsedLogLine,
  RunContext,
} from '../../src/core/log/index.js';

// M1b-4c: per-event schemas over the log catalog (spec). Log lines are untrusted input: a line
// is accepted only when it is something the builders could have written.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = Date.UTC(2026, 8, 29, 8, 0, 0, 123);
const DATE = '2026-09-29';
const CTX: RunContext = { run: '0123456789abcdef', ver: '0.6.0', now: () => NOW, level: 'debug' };
const RT = { ver: '0.6.0', node: '22.13.0', os: 'linux' };

const IP = '203.0.113.7';
const IP6 = '2001:db8:1:2::/64';
const ADDR6 = '2001:db8:1:2:0:0:0:1';
const TARGET = 'b2'.repeat(32);
const UNTIL = '2026-09-29T08:15:00.000Z';
const USER = randomUUID();
const ACCT = randomUUID();

const PASSWORD = 'hunter2-ÄŠť';
const EMAIL = 'canary@secret-domain.example';
const HOST = 'imap.example-test-domain.eu';
const SUBJECT = 'CANARY-SUBJECT Invoice 2026';
const HUGE = 'x'.repeat(10_000);

/** A value of the wrong type, passed where the builder's type says string/number/enum. */
function cast<T>(value: unknown): T {
  return value as T;
}

function canonicalKeys(record: LogRecord): string[] {
  const fields = (EVENT_FIELDS[record.event as LogEventName] as readonly string[]).filter((f) =>
    Object.hasOwn(record, f),
  );
  return ['ts', 'event', ...fields, 'level', 'run', 'v'];
}

/** renderEvent → parseLogLine → validateRecord gives back the rendered record, same key order. */
function roundTrip(event: LogEvent, ctx: RunContext = CTX): LogRecord {
  const rendered = renderEvent(event, ctx);
  expect(rendered).not.toBeNull();
  if (rendered === null) throw new Error('not rendered');
  const parsed = parseLogLine(rendered.line);
  expect(parsed).not.toBeNull();
  if (parsed === null) throw new Error('not parsed');
  const result = validateRecord(parsed, EVENT_KIND[event.event], rendered.record.ts.slice(0, 10));
  expect(result).toEqual({ record: rendered.record });
  if (!('record' in result)) throw new Error('rejected');
  expect(Object.keys(result.record)).toEqual(Object.keys(rendered.record));
  expect(Object.keys(result.record)).toEqual(canonicalKeys(rendered.record));
  return result.record;
}

function recordOf(event: LogEvent, ctx: RunContext = CTX): LogRecord {
  const rendered = renderEvent(event, ctx);
  if (rendered === null) throw new Error('not rendered');
  return rendered.record;
}

/** A ParsedLogLine built directly (the envelope check may already reject some tampering). */
function line(record: Record<string, unknown>, kind: LogKind): ParsedLogLine {
  return { kind, record: record as LogRecord };
}

function check(
  record: Record<string, unknown>,
  kind: LogKind,
  fileKind: LogKind = kind,
  fileDate: string | undefined = DATE,
): ReturnType<typeof validateRecord> {
  return validateRecord(line(record, kind), fileKind, fileDate);
}

const UNREADABLE = { skipped: 'unreadable' };
const UNKNOWN = { skipped: 'unknown' };

const START = (): Record<string, unknown> => ({ ...recordOf(commandStart('keygen', [], RT)) });
const FINISH = (exit = 0): Record<string, unknown> => ({
  ...recordOf(commandFinish('keygen', exit, 12)),
});
const AUTH_FAILED = (): Record<string, unknown> => ({
  ...recordOf(authLoginFailed('invalid-credentials', TARGET)),
});

describe('validateRecord: round trip over every builder', () => {
  it('command.start: normal, garbage and canary inputs', () => {
    roundTrip(commandStart('keygen', [], RT));
    roundTrip(commandStart('account add', ['email', 'json', 'no-color'], RT));
    roundTrip(
      commandStart(
        `LOGIN; rm -rf / ${EMAIL} ${HOST} ${'a'.repeat(500)}`,
        [
          `--password=${PASSWORD}`,
          EMAIL,
          HOST,
          SUBJECT,
          'x'.repeat(300),
          ...Array.from({ length: 50 }, (_, i) => `opt${String(i)}`),
        ],
        { ver: `v1.0.0 "evil"\\${HUGE}`, node: '22.13.0\u202e\u0000', os: 'Linux x86_64 ÄŠť' },
      ),
    );
    roundTrip(commandStart('', [], { ver: '', node: '', os: '' }));
    roundTrip(commandStart(PASSWORD, [PASSWORD], { ver: PASSWORD, node: EMAIL, os: HOST }));
  });

  it('command.finish: every outcome, garbage exit codes and durations', () => {
    roundTrip(commandFinish('keygen', 0, 12.4));
    roundTrip(commandFinish('login', 1, 1500));
    roundTrip(commandFinish('login', 130, 3));
    roundTrip(commandFinish('login', 2, 0));
    roundTrip(commandFinish('login', 255, 1e9));
    roundTrip(commandFinish('login', -1, 1));
    roundTrip(commandFinish('login', 1.5, -5));
    roundTrip(commandFinish('login', Number.NaN, Number.NaN));
    roundTrip(commandFinish('login', 0, Number.POSITIVE_INFINITY));
    roundTrip(commandFinish(`${EMAIL} ${SUBJECT} ${HUGE}`, 0, 3.7));
  });

  // Garbage that the builder still writes as-is: the validator must accept what was written.
  it('command.finish: a huge but finite duration (builder output range)', () => {
    roundTrip(commandFinish('login', 0, 1e300));
  });

  it('command.finish: a huge integer exit code (builder output range)', () => {
    roundTrip(commandFinish('login', 2 ** 60, 1));
  });

  it('error.unexpected: errors, codes, non-errors, huge and forged stacks', () => {
    roundTrip(unexpectedError(new Error(`${EMAIL} ${PASSWORD}`), REPO_ROOT));
    roundTrip(unexpectedError(Object.assign(new Error('x'), { code: 'ECONNRESET' }), REPO_ROOT));
    roundTrip(unexpectedError(new TypeError(''), REPO_ROOT));
    roundTrip(unexpectedError('a string with a password', REPO_ROOT));
    roundTrip(unexpectedError(null, REPO_ROOT));
    roundTrip(unexpectedError(undefined, REPO_ROOT));
    roundTrip(unexpectedError({ code: 'EPIPE', message: EMAIL }, REPO_ROOT));
    roundTrip(unexpectedError({ code: `${HOST} ${HUGE}` }, REPO_ROOT));
    const weird = new Error('m');
    weird.name = `Bad Name ${EMAIL}`;
    roundTrip(unexpectedError(weird, REPO_ROOT));

    const forged = new Error('secret');
    forged.stack = [
      'Error: secret',
      `    at ${'f'.repeat(500)} (${REPO_ROOT}/src/x.ts:1:2)`,
      `    at "quoted\\slash" (${REPO_ROOT}/src/y.ts:3:4)`,
      `    at fnÄŠť (${REPO_ROOT}/src/z.ts:5:6)`,
      `    at ${SUBJECT} (/home/someone/${EMAIL}/file.js:1:1)`,
      `    at file:///home/someone/${HOST}/x.js:1:1`,
      '    at native',
      '    at eval at <anonymous> (x)',
      ...Array.from({ length: 20 }, (_, i) => `    at fn${String(i)} (node:internal/x:1:1)`),
    ].join('\n');
    roundTrip(unexpectedError(forged, REPO_ROOT));

    // A deep real stack: capped at 10 frames by the builder.
    const deep = (n: number): Error => (n === 0 ? new Error('deep') : deep(n - 1));
    const saved = Error.stackTraceLimit;
    Error.stackTraceLimit = 50;
    try {
      roundTrip(unexpectedError(deep(30), REPO_ROOT));
    } finally {
      Error.stackTraceLimit = saved;
    }
  });

  it('log.truncated: valid in an app file and in a security file', () => {
    const record = toRecord({ event: 'log.truncated' }, CTX);
    for (const kind of ['app', 'security'] as const) {
      const text = formatLine(record, kind);
      expect(text.startsWith(SECURITY_PREFIX)).toBe(kind === 'security');
      const parsed = parseLogLine(text);
      expect(parsed).not.toBeNull();
      if (parsed === null) return;
      const result = validateRecord(parsed, kind, DATE);
      expect(result).toEqual({ record });
      if ('record' in result) expect(Object.keys(result.record)).toEqual(Object.keys(record));
    }
    roundTrip({ event: 'log.truncated' });
  });

  it('doctor.check: statuses and the other/warn fallbacks', () => {
    for (const status of ['ok', 'warn', 'fail'] as const) {
      roundTrip(doctorCheck('master-key', status));
    }
    roundTrip(doctorCheck('supabase-env', 'ok'));
    roundTrip(doctorCheck(`Bad Check ${EMAIL}`, cast<CheckStatus>('great')));
    roundTrip(doctorCheck(HUGE, cast<CheckStatus>(42)));
    roundTrip(doctorCheck(HOST, cast<CheckStatus>(null)));
  });

  it('doctor.check: non-string check names cast through unknown', () => {
    roundTrip(doctorCheck(cast<string>(42), 'ok'));
    roundTrip(doctorCheck(cast<string>(true), 'ok'));
    roundTrip(doctorCheck(cast<string>(null), 'ok'));
  });

  it('discover.finish: every outcome, optional fields omitted, garbage dropped', () => {
    for (const outcome of ['found', 'needs-host', 'blocked', 'manual', 'invalid'] as const) {
      roundTrip(discoverFinish({ outcome }));
    }
    for (const source of ['preset-domain', 'preset-mx', 'ispdb', 'autoconfig', 'srv'] as const) {
      roundTrip(discoverFinish({ outcome: 'found', source, provider: 'websupport' }));
    }
    for (const domainProblem of ['not-exist', 'dns-error', 'dns-unreachable'] as const) {
      for (const choice of ['picked', 'host-entered', 'manual', 'cancelled'] as const) {
        roundTrip(discoverFinish({ outcome: 'needs-host', domainProblem, choice }));
      }
    }
    roundTrip(discoverFinish({ outcome: 'found', source: 'srv', provider: 'custom' }));
    roundTrip(
      discoverFinish({
        outcome: cast<DiscoverOutcome>('exploded'),
        source: cast<DiscoverySource>(HOST),
        provider: EMAIL,
        domainProblem: cast<DomainProblem>(SUBJECT),
        choice: cast<DiscoverChoice>(PASSWORD),
      }),
    );
    roundTrip(
      discoverFinish({
        outcome: cast<DiscoverOutcome>(1),
        source: cast<DiscoverySource>({}),
        provider: cast<string>(7),
        domainProblem: cast<DomainProblem>([]),
        choice: cast<DiscoverChoice>(false),
      }),
    );
    roundTrip(discoverFinish({ outcome: 'found', provider: HOST }));
    roundTrip(discoverFinish({ outcome: 'found', provider: HUGE }));
  });

  it('auth.login: with and without a user id', () => {
    roundTrip(authLogin(USER));
    roundTrip(authLogin(USER.toUpperCase()));
    roundTrip(authLogin('u1'));
    roundTrip(authLogin(EMAIL));
    roundTrip(authLogin(cast<string>(null)));
  });

  it('auth.login-failed: every reason, invalid targets and reasons', () => {
    for (const reason of ['invalid-credentials', 'unreachable', 'unknown', 'unexpected'] as const) {
      roundTrip(authLoginFailed(reason, TARGET));
      roundTrip(authLoginFailed(reason, 'invalid'));
    }
    roundTrip(authLoginFailed(cast<AuthFailureReason>('bogus'), EMAIL));
    roundTrip(authLoginFailed(cast<AuthFailureReason>(42), cast<string>({})));
    roundTrip(authLoginFailed('unknown', TARGET.toUpperCase()));
    roundTrip(authLoginFailed('unknown', PASSWORD));
  });

  it('auth.logout: both outcomes and the fallback', () => {
    roundTrip(authLogout('logged-out'));
    roundTrip(authLogout('not-logged-in'));
    roundTrip(authLogout(cast<AuthLogoutEvent['outcome']>(EMAIL)));
  });

  it('imap.login: accounts, ip buckets, fallbacks', () => {
    roundTrip(imapLogin({ provider: 'websupport', acct: ACCT, ip: IP, target: TARGET }));
    roundTrip(imapLogin({ provider: 'custom', ip: 'local', target: TARGET }));
    roundTrip(imapLogin({ provider: 'custom', ip: IP6, target: TARGET }));
    roundTrip(imapLogin({ provider: 'custom', acct: ACCT.toUpperCase(), ip: IP, target: TARGET }));
    roundTrip(
      imapLogin({ provider: HOST, acct: EMAIL, ip: `${IP}; DROP TABLE`, target: PASSWORD }),
    );
    roundTrip(
      imapLogin({
        provider: cast<string>(5),
        acct: cast<string>({}),
        ip: cast<string>(7),
        target: cast<string>(null),
      }),
    );
  });

  it('imap.login-failed: every reason incl. blocked, counted, fallbacks', () => {
    const reasons: (ImapFailureReason | 'blocked')[] = [...IMAP_FAILURE_REASONS, 'blocked'];
    for (const reason of reasons) {
      roundTrip(
        imapLoginFailed(
          { provider: 'websupport', acct: ACCT, ip: IP, target: TARGET },
          reason,
          true,
        ),
      );
      roundTrip(
        imapLoginFailed({ provider: 'custom', ip: 'local', target: TARGET }, reason, false),
      );
    }
    roundTrip(
      imapLoginFailed(
        { provider: HOST, acct: EMAIL, ip: 'garbage', target: EMAIL },
        cast<ImapFailureReason>(SUBJECT),
        cast<boolean>('yes'),
      ),
    );
    roundTrip(
      imapLoginFailed(
        { provider: 'custom', ip: IP6, target: TARGET },
        cast<ImapFailureReason>(3),
        cast<boolean>(1),
      ),
    );
  });

  it('login-guard.challenge: attempts and fallbacks', () => {
    roundTrip(guardChallenge(IP, 3, TARGET));
    roundTrip(guardChallenge(IP6, 0, TARGET));
    roundTrip(guardChallenge('local', Number.MAX_SAFE_INTEGER, TARGET));
    roundTrip(guardChallenge(EMAIL, -1, HOST));
    roundTrip(guardChallenge(IP, 1.5, TARGET));
    roundTrip(guardChallenge(IP, Number.NaN, TARGET));
    roundTrip(guardChallenge(cast<string>(1), cast<number>('7'), cast<string>(2)));
  });

  it('login-guard.block: every kind, null addr/until, fallbacks', () => {
    const kinds: BlockKind[] = ['too-many-attempts', 'ip-blocked', 'permanent'];
    for (const kind of kinds) {
      for (const reason of IMAP_FAILURE_REASONS) {
        roundTrip(
          guardBlock({ kind, reason, ip: IP, addr: IP, attempts: 5, until: UNTIL, target: TARGET }),
        );
      }
      roundTrip(
        guardBlock({
          kind,
          reason: 'auth-failed',
          ip: IP6,
          addr: ADDR6,
          attempts: 3,
          until: null,
          target: TARGET,
        }),
      );
      roundTrip(
        guardBlock({
          kind,
          reason: 'timeout',
          ip: 'local',
          addr: null,
          attempts: 0,
          until: null,
          target: 'invalid',
        }),
      );
    }
    roundTrip(
      guardBlock({
        kind: cast<BlockKind>('forever'),
        reason: cast<ImapFailureReason>('blocked'),
        ip: HOST,
        addr: EMAIL,
        attempts: -3,
        until: 'tomorrow',
        target: PASSWORD,
      }),
    );
    roundTrip(
      guardBlock({
        kind: cast<BlockKind>(1),
        reason: cast<ImapFailureReason>(null),
        ip: cast<string>(2),
        addr: cast<string>(3),
        attempts: cast<number>('4'),
        until: cast<string>(5),
        target: cast<string>(6),
      }),
    );
  });

  it('audit.write-failed: every action and reason, fallbacks', () => {
    const reasons: AuditFailureReason[] = [
      'forbidden',
      'unavailable',
      'conflict',
      'not-found',
      'unknown',
      'invalid',
    ];
    for (const action of AUDIT_ACTIONS) {
      for (const reason of reasons) roundTrip(auditWriteFailed(action, reason));
    }
    roundTrip(auditWriteFailed('mail.delete-everything', cast<AuditFailureReason>('weird')));
    roundTrip(auditWriteFailed(SUBJECT, cast<AuditFailureReason>(1)));
    roundTrip(auditWriteFailed(cast<string>(null), cast<AuditFailureReason>(null)));
  });

  it('a record without a file date still validates (fileDate is optional)', () => {
    const rendered = renderEvent(commandStart('keygen', [], RT), CTX);
    const parsed = rendered === null ? null : parseLogLine(rendered.line);
    expect(parsed).not.toBeNull();
    if (parsed === null || rendered === null) return;
    expect(validateRecord(parsed, 'app')).toEqual({ record: rendered.record });
  });

  it('every catalog event round-trips (one sample each; the map is compiler-checked)', () => {
    const samples: { [N in LogEventName]: Extract<LogEvent, { event: N }> } = {
      'command.start': commandStart('keygen', [], RT),
      'command.finish': commandFinish('keygen', 0, 5),
      'error.unexpected': unexpectedError(new TypeError('x'), REPO_ROOT),
      'log.truncated': { event: 'log.truncated' },
      'doctor.check': doctorCheck('env', 'ok'),
      'discover.finish': discoverFinish({ outcome: 'found', source: 'ispdb' }),
      'auth.login': authLogin(USER),
      'auth.login-failed': authLoginFailed('invalid-credentials', TARGET),
      'auth.logout': authLogout('logged-out'),
      'imap.login': imapLogin({ provider: 'gmail', ip: IP, target: TARGET }),
      'imap.login-failed': imapLoginFailed(
        { provider: 'gmail', ip: IP, target: TARGET },
        'timeout',
        true,
      ),
      'login-guard.challenge': guardChallenge(IP, 3, TARGET),
      'login-guard.block': guardBlock({
        kind: 'ip-blocked',
        reason: 'auth-failed',
        ip: IP,
        addr: IP,
        attempts: 5,
        until: UNTIL,
        target: TARGET,
      }),
      'audit.write-failed': auditWriteFailed('mail.trash', 'forbidden'),
      'account.add': accountEvent('account.add', { acct: ACCT, provider: 'gmail', outcome: 'ok' }),
      'account.test': accountEvent('account.test', {
        acct: ACCT,
        provider: 'custom',
        outcome: 'failed',
        reason: 'auth-failed',
      }),
      'account.password-update': accountEvent('account.password-update', {
        acct: ACCT,
        provider: 'gmail',
        outcome: 'ok',
      }),
      'account.remove': accountEvent('account.remove', { provider: 'gmail', outcome: 'ok' }),
    };
    expect(Object.keys(samples).sort()).toEqual([...LOG_EVENT_NAMES].sort());
    expect(LOG_EVENT_NAMES).toHaveLength(18);
    for (const name of LOG_EVENT_NAMES) roundTrip(samples[name]);
  });
});

describe('validateRecord: rejected as unreadable', () => {
  it('accepts the unmodified base records (sanity for the mutations below)', () => {
    expect(check(START(), 'app')).toHaveProperty('record');
    expect(check(FINISH(), 'app')).toHaveProperty('record');
    expect(check(AUTH_FAILED(), 'security')).toHaveProperty('record');
  });

  it('an extra field (e.g. a subject)', () => {
    expect(check({ ...START(), subject: SUBJECT }, 'app')).toEqual(UNREADABLE);
    expect(check({ ...AUTH_FAILED(), email: EMAIL }, 'security')).toEqual(UNREADABLE);
    expect(check({ ...recordOf({ event: 'log.truncated' }), note: 'x' }, 'app', 'app')).toEqual(
      UNREADABLE,
    );
  });

  it('an extra field survives parseLogLine but not validateRecord', () => {
    const parsed = parseLogLine(JSON.stringify({ ...START(), subject: SUBJECT }));
    expect(parsed).not.toBeNull();
    if (parsed !== null) expect(validateRecord(parsed, 'app', DATE)).toEqual(UNREADABLE);
  });

  it('a missing required field', () => {
    const noOpts = START();
    delete noOpts['opts'];
    expect(check(noOpts, 'app')).toEqual(UNREADABLE);
    const noTarget = AUTH_FAILED();
    delete noTarget['target'];
    expect(check(noTarget, 'security')).toEqual(UNREADABLE);
    const noExit = FINISH();
    delete noExit['exit'];
    expect(check(noExit, 'app')).toEqual(UNREADABLE);
    const noCounted: Record<string, unknown> = {
      ...recordOf(imapLoginFailed({ provider: 'custom', ip: IP, target: TARGET }, 'timeout', true)),
    };
    delete noCounted['counted'];
    expect(check(noCounted, 'security')).toEqual(UNREADABLE);
  });

  it.each<[string, () => Record<string, unknown>, LogKind]>([
    ['exit as a string', () => ({ ...FINISH(), exit: '0' }), 'app'],
    ['opts as a string', () => ({ ...START(), opts: 'json' }), 'app'],
    ['opts with a number', () => ({ ...START(), opts: [1] }), 'app'],
    ['cmd as a number', () => ({ ...START(), cmd: 1 }), 'app'],
    [
      'stack as a string',
      () => ({ ...recordOf(unexpectedError(null, REPO_ROOT)), stack: 'x' }),
      'app',
    ],
    [
      'counted as a string',
      () => ({
        ...recordOf(
          imapLoginFailed({ provider: 'custom', ip: IP, target: TARGET }, 'timeout', true),
        ),
        counted: 'true',
      }),
      'security',
    ],
    [
      'attempts as a string',
      () => ({ ...recordOf(guardChallenge(IP, 3, TARGET)), attempts: '3' }),
      'security',
    ],
    ['target as null', () => ({ ...AUTH_FAILED(), target: null }), 'security'],
    ['user as a number', () => ({ ...recordOf(authLogin(USER)), user: 5 }), 'security'],
  ])('a wrong type: %s', (_name, build, kind) => {
    expect(check(build(), kind)).toEqual(UNREADABLE);
  });

  it.each<[string, () => Record<string, unknown>, LogKind]>([
    ['doctor status', () => ({ ...recordOf(doctorCheck('node', 'ok')), status: 'great' }), 'app'],
    ['finish outcome', () => ({ ...FINISH(), outcome: 'maybe' }), 'app'],
    ['auth reason', () => ({ ...AUTH_FAILED(), reason: 'wrong-password' }), 'security'],
    ['logout outcome', () => ({ ...recordOf(authLogout('logged-out')), outcome: 'x' }), 'security'],
    [
      'discover outcome',
      () => ({ ...recordOf(discoverFinish({ outcome: 'found' })), outcome: 'lost' }),
      'app',
    ],
    [
      'imap reason',
      () => ({
        ...recordOf(
          imapLoginFailed({ provider: 'custom', ip: IP, target: TARGET }, 'timeout', true),
        ),
        reason: 'hacked',
      }),
      'security',
    ],
    [
      'audit action',
      () => ({ ...recordOf(auditWriteFailed('backup', 'unknown')), action: 'mail.nuke' }),
      'app',
    ],
  ])('a wrong enum value: %s', (_name, build, kind) => {
    expect(check(build(), kind)).toEqual(UNREADABLE);
  });

  it('a level that is not eventLevel(record)', () => {
    expect(check({ ...START(), level: 'warn' }, 'app')).toEqual(UNREADABLE);
    expect(check({ ...START(), level: 'debug' }, 'app')).toEqual(UNREADABLE);
    expect(check({ ...FINISH(1), level: 'info' }, 'app')).toEqual(UNREADABLE);
    expect(check({ ...FINISH(0), level: 'warn' }, 'app')).toEqual(UNREADABLE);
    expect(check({ ...AUTH_FAILED(), level: 'error' }, 'security')).toEqual(UNREADABLE);
    const block = recordOf(
      guardBlock({
        kind: 'permanent',
        reason: 'auth-failed',
        ip: IP,
        addr: IP,
        attempts: 5,
        until: null,
        target: TARGET,
      }),
    );
    expect(check({ ...block, level: 'warn' }, 'security')).toEqual(UNREADABLE);
  });

  it('a line kind (prefix) different from the file kind', () => {
    expect(check(START(), 'app', 'security')).toEqual(UNREADABLE);
    expect(check(AUTH_FAILED(), 'security', 'app')).toEqual(UNREADABLE);
    const truncated = { ...recordOf({ event: 'log.truncated' }) };
    expect(check(truncated, 'app', 'security')).toEqual(UNREADABLE);
    expect(check(truncated, 'security', 'app')).toEqual(UNREADABLE);
  });

  it('an app event in a security file and a security event in an app file', () => {
    expect(check(START(), 'security', 'security')).toEqual(UNREADABLE);
    expect(check(AUTH_FAILED(), 'app', 'app')).toEqual(UNREADABLE);
    // Through the real line format too.
    const parsedApp = parseLogLine(formatLine(START() as LogRecord, 'security'));
    expect(parsedApp).not.toBeNull();
    if (parsedApp !== null) expect(validateRecord(parsedApp, 'security', DATE)).toEqual(UNREADABLE);
    const parsedSec = parseLogLine(formatLine(AUTH_FAILED() as LogRecord, 'app'));
    expect(parsedSec).not.toBeNull();
    if (parsedSec !== null) expect(validateRecord(parsedSec, 'app', DATE)).toEqual(UNREADABLE);
  });

  it.each([
    ['no millis', '2026-09-29T08:00:00Z'],
    ['+00:00 offset', '2026-09-29T08:00:00.000+00:00'],
    ['+02:00 offset', '2026-09-29T10:00:00.000+02:00'],
    ['4 fraction digits', '2026-09-29T08:00:00.0000Z'],
    ['1 fraction digit', '2026-09-29T08:00:00.0Z'],
    ['space separator', '2026-09-29 08:00:00.000Z'],
    ['lowercase z', '2026-09-29T08:00:00.000z'],
    ['no zone', '2026-09-29T08:00:00.000'],
    ['date only', '2026-09-29'],
    ['garbage', 'yesterday'],
    ['hour 24', '2026-09-29T24:00:00.000Z'],
  ])('a ts not in the writer format: %s', (_name, ts) => {
    expect(check({ ...START(), ts }, 'app', 'app', DATE)).toEqual(UNREADABLE);
  });

  it('an impossible date in the writer format', () => {
    const ts = '2026-02-30T08:00:00.000Z';
    expect(check({ ...START(), ts }, 'app', 'app', '2026-02-30')).toEqual(UNREADABLE);
    expect(check({ ...START(), ts }, 'app', 'app')).toEqual(UNREADABLE);
    expect(check({ ...START(), ts: '2026-09-29T08:61:00.000Z' }, 'app', 'app')).toEqual(UNREADABLE);
  });

  it('a ts whose UTC date is not the file date', () => {
    const start = START();
    expect(check({ ...start, ts: '2026-09-29T23:59:59.999Z' }, 'app', 'app', '2026-09-30')).toEqual(
      UNREADABLE,
    );
    expect(check({ ...start, ts: '2026-09-30T00:00:00.000Z' }, 'app', 'app', '2026-09-29')).toEqual(
      UNREADABLE,
    );
    expect(
      check({ ...start, ts: '2026-09-29T23:59:59.999Z' }, 'app', 'app', '2026-09-29'),
    ).toHaveProperty('record');
  });

  it.each<[number, string, string]>([
    [0, 'failed', 'warn'],
    [0, 'interrupted', 'warn'],
    [1, 'ok', 'info'],
    [1, 'interrupted', 'warn'],
    [130, 'failed', 'warn'],
    [130, 'ok', 'info'],
    [2, 'interrupted', 'warn'],
  ])('command.finish exit %d with outcome %s', (exit, outcome, level) => {
    expect(check({ ...FINISH(), exit, outcome, level }, 'app')).toEqual(UNREADABLE);
  });

  it('command.finish with matching outcomes is accepted', () => {
    for (const [exit, outcome, level] of [
      [0, 'ok', 'info'],
      [130, 'interrupted', 'warn'],
      [1, 'failed', 'warn'],
      [-1, 'failed', 'warn'],
      [255, 'failed', 'warn'],
    ] as const) {
      expect(check({ ...FINISH(), exit, outcome, level }, 'app')).toHaveProperty('record');
    }
  });

  describe('error.unexpected stack frames', () => {
    const base = (): Record<string, unknown> => ({ ...recordOf(unexpectedError(null, REPO_ROOT)) });

    it('accepts 10 frames of 200 printable ASCII chars', () => {
      const stack = Array.from({ length: 10 }, (_, i) => `${String(i)}`.padEnd(200, 'a'));
      expect(check({ ...base(), stack }, 'app')).toHaveProperty('record');
      expect(check({ ...base(), stack: [] }, 'app')).toHaveProperty('record');
    });

    it.each([
      ['11 frames', Array.from({ length: 11 }, () => 'fn (src/x.ts:1:1)')],
      ['a frame with "', ['fn "x" (src/x.ts:1:1)']],
      ['a frame with \\', ['fn (C:\\x.ts:1:1)']],
      ['a non-ASCII frame', ['fné (src/x.ts:1:1)']],
      ['a frame with ESC', ['fn \u001b[31m (src/x.ts:1:1)']],
      ['a frame with a newline', ['fn\n (src/x.ts:1:1)']],
      ['a 201-char frame', ['a'.repeat(201)]],
      ['a non-string frame', [1]],
    ])('rejects %s', (_name, stack) => {
      expect(check({ ...base(), stack }, 'app')).toEqual(UNREADABLE);
    });
  });

  it.each([
    ['ver', 'v1 "x"'],
    ['ver', 'a'.repeat(41)],
    ['ver', '1.0.0 beta'],
    ['ver', '1.0_0'],
    ['node', '22.13.0\u202e'],
    ['node', 'ž'],
    ['os', 'Linux'],
    ['os', 'a'.repeat(21)],
    ['os', 'linux-x64'],
    ['cmd', 'Login'],
    ['cmd', 'a'.repeat(101)],
    ['cmd', 'a_b'],
    ['cmd', `login ${EMAIL}`],
    ['cmd', 'login\u001b'],
  ])('command.start %s = %j', (field, value) => {
    expect(check({ ...START(), [field]: value }, 'app')).toEqual(UNREADABLE);
  });

  it('command.start boundary values are accepted', () => {
    expect(
      check({ ...START(), ver: 'A'.repeat(40), node: '22.13.0-rc.1+b', os: 'a'.repeat(20) }, 'app'),
    ).toHaveProperty('record');
    expect(check({ ...START(), cmd: 'a'.repeat(100) }, 'app')).toHaveProperty('record');
    expect(check({ ...START(), cmd: 'account add' }, 'app')).toHaveProperty('record');
    expect(check({ ...START(), cmd: '', ver: '', node: '', os: '' }, 'app')).toHaveProperty(
      'record',
    );
  });

  it('negative or non-integer ms and attempts', () => {
    for (const ms of [-1, 1.5, -0.5]) {
      expect(check({ ...FINISH(), ms }, 'app')).toEqual(UNREADABLE);
    }
    const challenge = { ...recordOf(guardChallenge(IP, 3, TARGET)) };
    for (const attempts of [-1, 2.5]) {
      expect(check({ ...challenge, attempts }, 'security')).toEqual(UNREADABLE);
    }
    const block = {
      ...recordOf(
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
    };
    expect(check({ ...block, attempts: -5 }, 'security')).toEqual(UNREADABLE);
    expect(check({ ...block, attempts: 0.5 }, 'security')).toEqual(UNREADABLE);
  });

  describe('target must be 64 lowercase hex or invalid', () => {
    const bad = ['B2'.repeat(32), 'b2'.repeat(31), `${'b2'.repeat(32)}0`, EMAIL, '', 'Invalid'];
    const builders: [string, () => Record<string, unknown>][] = [
      ['auth.login-failed', AUTH_FAILED],
      [
        'imap.login',
        () => ({ ...recordOf(imapLogin({ provider: 'custom', ip: IP, target: TARGET })) }),
      ],
      [
        'imap.login-failed',
        () => ({
          ...recordOf(
            imapLoginFailed({ provider: 'custom', ip: IP, target: TARGET }, 'timeout', true),
          ),
        }),
      ],
      ['login-guard.challenge', () => ({ ...recordOf(guardChallenge(IP, 3, TARGET)) })],
      [
        'login-guard.block',
        () => ({
          ...recordOf(
            guardBlock({
              kind: 'too-many-attempts',
              reason: 'auth-failed',
              ip: IP,
              addr: null,
              attempts: 5,
              until: UNTIL,
              target: TARGET,
            }),
          ),
        }),
      ],
    ];
    it.each(builders)('%s', (_name, build) => {
      for (const target of bad) {
        expect(check({ ...build(), target }, 'security')).toEqual(UNREADABLE);
      }
      expect(check({ ...build(), target: 'invalid' }, 'security')).toHaveProperty('record');
    });
  });

  it('TARGET_RE: 64 lowercase hex or invalid', () => {
    expect(TARGET_RE.test(TARGET)).toBe(true);
    expect(TARGET_RE.test('invalid')).toBe(true);
    expect(TARGET_RE.test(TARGET.toUpperCase())).toBe(false);
    expect(TARGET_RE.test(EMAIL)).toBe(false);
  });

  it('a malformed ip, provider or acct', () => {
    const login = (): Record<string, unknown> => ({
      ...recordOf(imapLogin({ provider: 'custom', acct: ACCT, ip: IP, target: TARGET })),
    });
    expect(check({ ...login(), ip: HOST }, 'security')).toEqual(UNREADABLE);
    expect(check({ ...login(), acct: EMAIL }, 'security')).toEqual(UNREADABLE);
    expect(check({ ...login(), acct: ACCT.toUpperCase() }, 'security')).toEqual(UNREADABLE);
    expect(check({ ...login(), provider: 'Bad Provider!' }, 'security')).toEqual(UNREADABLE);
    expect(check({ ...recordOf(authLogin(USER)), user: EMAIL }, 'security')).toEqual(UNREADABLE);
  });
});

describe('validateRecord: skipped as unknown', () => {
  it('a newer schema version', () => {
    expect(check({ ...START(), v: 2 }, 'app')).toEqual(UNKNOWN);
    expect(check({ ...AUTH_FAILED(), v: LOG_SCHEMA_VERSION + 1 }, 'security')).toEqual(UNKNOWN);
  });

  it('an event name this version does not know', () => {
    const envelope = {
      ts: '2026-09-29T08:00:00.123Z',
      event: 'mailbox.frobnicate',
      level: 'info',
      run: CTX.run,
      v: LOG_SCHEMA_VERSION,
    };
    const parsed = parseLogLine(JSON.stringify(envelope));
    expect(parsed).not.toBeNull();
    if (parsed !== null) expect(validateRecord(parsed, 'app', DATE)).toEqual(UNKNOWN);
    expect(check({ ...envelope, count: 3 }, 'app')).toEqual(UNKNOWN);
    expect(check(envelope, 'security')).toEqual(UNKNOWN);
  });
});

describe('validateRecord never throws', () => {
  // Deterministic PRNG so a failure is reproducible.
  function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  function randomValue(rand: () => number, depth: number): unknown {
    const pick = Math.floor(rand() * (depth > 2 ? 6 : 9));
    switch (pick) {
      case 0:
        return null;
      case 1:
        return rand() < 0.5;
      case 2:
        return Math.floor(rand() * 1e6) - 5e5;
      case 3:
        return rand() * 1e20;
      case 4:
        return ['', 'x', 'invalid', TARGET, '\u202e', 'ok', 'warn', '2026-09-29T08:00:00.000Z'][
          Math.floor(rand() * 8)
        ];
      case 5:
        return LOG_EVENT_NAMES[Math.floor(rand() * LOG_EVENT_NAMES.length)];
      case 6:
        return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(rand, depth + 1));
      default: {
        const obj: Record<string, unknown> = {};
        const keys = ['ts', 'event', 'level', 'run', 'v', 'cmd', 'opts', 'stack', 'target', 'x'];
        for (const k of keys) if (rand() < 0.5) obj[k] = randomValue(rand, depth + 1);
        return obj;
      }
    }
  }

  it('on random records, envelopes with random fields and JSON-only oddities', () => {
    const rand = prng(20260929);
    const inputs: unknown[] = [];
    for (let i = 0; i < 2000; i++) inputs.push(randomValue(rand, 0));
    for (const name of LOG_EVENT_NAMES) {
      for (let i = 0; i < 50; i++) {
        const rec: Record<string, unknown> = {
          ts: '2026-09-29T08:00:00.000Z',
          event: name,
          level: ['debug', 'info', 'warn', 'error'][i % 4],
          run: CTX.run,
          v: 1,
        };
        for (const f of EVENT_FIELDS[name] as readonly string[]) {
          if (rand() < 0.8) rec[f] = randomValue(rand, 1);
        }
        inputs.push(rec);
      }
    }
    inputs.push(JSON.parse('{"__proto__":{"event":"command.start"},"event":"command.start"}'));
    inputs.push(JSON.parse('{"constructor":{"prototype":{}},"toString":1}'));
    inputs.push([], 'string', 42, undefined);

    for (const input of inputs) {
      for (const kind of ['app', 'security'] as const) {
        for (const date of [DATE, undefined, 'not-a-date']) {
          let result: ReturnType<typeof validateRecord> | undefined;
          expect(() => {
            result = validateRecord({ kind, record: input as LogRecord }, kind, date);
          }).not.toThrow();
          expect(result === undefined ? false : 'record' in result || 'skipped' in result).toBe(
            true,
          );
        }
      }
    }
  });
});

describe('review follow-ups (M1b-4c)', () => {
  it('an extra "__proto__" key is rejected by parseLogLine (zod would drop it silently)', () => {
    const rendered = renderEvent(commandStart('keygen', [], RT), CTX);
    if (rendered === null) throw new Error('not rendered');
    const tampered = rendered.line.replace('"cmd":', '"__proto__":{"code":"EVIL"},"cmd":');
    expect(JSON.parse(tampered)).toHaveProperty('cmd', 'keygen');
    expect(parseLogLine(tampered)).toBeNull();
  });

  it('any other schema version (0, negative, fractional) is unknown, not unreadable', () => {
    for (const v of [0, -1, 1.5, 2]) {
      const record = { ...recordOf(commandStart('keygen', [], RT)), v };
      const parsed = parseLogLine(JSON.stringify(record));
      expect(parsed).not.toBeNull();
      if (parsed === null) continue;
      expect(validateRecord(parsed, 'app', DATE)).toEqual({ skipped: 'unknown' });
    }
  });

  it('login-guard.block until: an impossible date is dropped by the builder, rejected by the reader', () => {
    const fields = {
      kind: 'too-many-attempts' as const,
      reason: 'auth-failed' as const,
      ip: IP,
      addr: null,
      attempts: 5,
      target: TARGET,
    };
    expect(guardBlock({ ...fields, until: '2026-02-30T10:00:00.000Z' }).until).toBeNull();
    expect(guardBlock({ ...fields, until: UNTIL }).until).toBe(UNTIL);
    const record = {
      ...recordOf(guardBlock({ ...fields, until: UNTIL })),
      until: '2026-02-30T10:00:00.000Z',
    };
    const parsed = parseLogLine(`${SECURITY_PREFIX}${JSON.stringify(record)}`);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(validateRecord(parsed, 'security', DATE)).toEqual({ skipped: 'unreadable' });
  });
});

describe('security audit follow-ups (M1b-4c)', () => {
  it('a rewritten stack cannot put a host or an address after node:', () => {
    const err = new Error('boom');
    err.stack = [
      'Error: boom',
      '    at node:alice@victim.invalid:1:1',
      '    at fetch (node:imap.victim.invalid)',
      '    at node:203.0.113.7',
      '    at run (node:internal/process/task_queues:95:5)',
      '    at pbkdf2 (node:internal/crypto/pbkdf2:59:3)',
    ].join('\n');
    const event = unexpectedError(err, REPO_ROOT);
    expect(event.stack).toEqual([
      '<external>',
      '<fn> (<external>)',
      '<external>',
      'run (node:internal/process/task_queues:95:5)',
      'pbkdf2 (node:internal/crypto/pbkdf2:59:3)',
    ]);
    roundTrip(event);
  });
});
