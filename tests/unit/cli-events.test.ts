import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { ChosenSettings } from '../../src/cli/prompts/imap-settings.js';
import { AuthError, type LogoutResult } from '../../src/core/auth.js';
import { ConfigError } from '../../src/core/config.js';
import type { CheckResult, DoctorDeps } from '../../src/core/doctor.js';
import type {
  DiscoveryDeps,
  DiscoveryResult,
  ProviderInfo,
} from '../../src/core/providers/discover.js';
import { DiscoveryInputError, parseEmail } from '../../src/core/providers/email.js';
import type { EventLog } from '../../src/core/log/index.js';
import { authEmailTarget, authTargetKey } from '../../src/core/security/events.js';

// M1b-4b: the CLI emits auth.*, doctor.check and discover.finish (spec). Core and prompts are
// mocked, as in cli-auth / cli-doctor / cli-discover; output and exit codes stay as there.

const PASSWORD = 'hunter2-ÄŠť';
const LOGIN_EMAIL = 'someone@example-test-domain.eu';
const USER_ID = '6c1f0e2a-9b3d-4c5e-8f7a-1b2c3d4e5f60';
const HEX64 = /^[0-9a-f]{64}$/;
const MASTER = Buffer.alloc(32, 0x33);

const {
  fakeAuth,
  createSupabaseServices,
  loadEnvFiles,
  input,
  password,
  clearSession,
  session,
  runDoctor,
  discover,
  chooseImapSettings,
} = vi.hoisted(() => ({
  fakeAuth: {
    login: vi.fn<(email: string, password: string) => Promise<{ email: string; userId: string }>>(),
    logout: vi.fn<() => Promise<LogoutResult>>(),
    currentUser: vi.fn<() => Promise<{ email: string; userId: string } | null>>(),
  },
  createSupabaseServices: vi.fn<(...args: unknown[]) => unknown>(),
  loadEnvFiles: vi.fn(),
  input: vi.fn<(...args: unknown[]) => Promise<string>>(),
  password: vi.fn<(...args: unknown[]) => Promise<string>>(),
  clearSession: vi.fn(),
  session: { empty: true },
  runDoctor: vi.fn<(deps: DoctorDeps) => Promise<CheckResult[]>>(),
  discover: vi.fn<(input: string, deps: DiscoveryDeps) => Promise<DiscoveryResult>>(),
  chooseImapSettings: vi.fn<(...args: unknown[]) => Promise<ChosenSettings | null>>(),
}));

vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return { ...actual, loadEnvFiles };
});
vi.mock('../../src/core/db/supabase/index.js', () => ({
  createSupabaseServices,
  FileSessionStorage: class {
    readonly file: string;
    constructor(dir: string) {
      this.file = `${dir}/session.json`;
    }
    getItem(): string | null {
      return null;
    }
    setItem(): void {}
    removeItem(): void {}
    clear(): void {
      clearSession();
    }
    isEmpty(): boolean {
      return session.empty;
    }
  },
}));
vi.mock('../../src/core/paths.js', () => ({
  configDir: vi.fn(() => '/nonexistent/mm-test-config'),
  logDir: vi.fn(() => '/nonexistent/mm-test-config/logs'),
}));
vi.mock('@inquirer/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inquirer/prompts')>();
  return { ...actual, input, password };
});
vi.mock('../../src/core/doctor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/doctor.js')>();
  return { ...actual, runDoctor };
});
vi.mock('../../src/core/providers/discover.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/providers/discover.js')>();
  return { ...actual, discover };
});
vi.mock('../../src/cli/prompts/imap-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/prompts/imap-settings.js')>();
  return { ...actual, chooseImapSettings };
});

const { buildProgram } = await import('../../src/cli/index.js');
const { MemoryEventLog } = await import('../../src/core/log/index.js');
type Log = InstanceType<typeof MemoryEventLog>;

const CTX = {
  run: '0123456789abcdef',
  ver: '0.0.0',
  now: () => Date.UTC(2026, 8, 29),
  level: 'debug' as const,
};

let out: string[];
let err: string[];
let raw: string[];
const originalExitCode = process.exitCode;
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalOutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const originalMasterKey = process.env['MM_MASTER_KEY'];

function setTTY(value: boolean | undefined, stdout: boolean | undefined = value): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: stdout,
    configurable: true,
    writable: true,
  });
}

function exitPrompt(): Error {
  const cancel = new Error('User force closed the prompt with SIGINT');
  cancel.name = 'ExitPromptError';
  return cancel;
}

beforeEach(() => {
  out = [];
  err = [];
  raw = [];
  process.exitCode = undefined;
  delete process.env['MM_MASTER_KEY'];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    raw.push(String(chunk));
    return true;
  });
  createSupabaseServices.mockReturnValue({ auth: fakeAuth, accounts: {} });
  session.empty = true;
  setTTY(true);
});

afterEach(() => {
  process.exitCode = originalExitCode;
  if (originalMasterKey === undefined) delete process.env['MM_MASTER_KEY'];
  else process.env['MM_MASTER_KEY'] = originalMasterKey;
  if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (originalOutIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalOutIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks();
  for (const m of [
    fakeAuth.login,
    fakeAuth.logout,
    fakeAuth.currentUser,
    createSupabaseServices,
    loadEnvFiles,
    input,
    password,
    clearSession,
    runDoctor,
    discover,
    chooseImapSettings,
  ]) {
    m.mockReset();
  }
});

async function runLogged(...args: string[]): Promise<Log> {
  const log = new MemoryEventLog(CTX);
  await buildProgram({ exitOverride: true, log }).parseAsync(args, { from: 'user' });
  return log;
}

function eventsOf(log: Log, prefix: string): Record<string, unknown>[] {
  return log.records
    .filter((r) => r.event.startsWith(prefix))
    .map((r) =>
      Object.fromEntries(
        Object.entries(r).filter(([k]) => !['ts', 'run', 'v', 'level'].includes(k)),
      ),
    );
}

const allOutput = (): string => [...out, ...err, ...raw].join('\n');

describe('mm login events', () => {
  it('success → one auth.login with the user id, never the e-mail', async () => {
    password.mockResolvedValue(PASSWORD);
    fakeAuth.login.mockResolvedValue({ email: LOGIN_EMAIL, userId: USER_ID });
    const log = await runLogged('login', '--email', LOGIN_EMAIL);
    expect(eventsOf(log, 'auth.')).toEqual([{ event: 'auth.login', user: USER_ID }]);
    expect(out.join('\n')).toContain(`Logged in as ${LOGIN_EMAIL}`);
    expect(process.exitCode).toBeUndefined();
    const text = log.lines.join('\n');
    for (const needle of [LOGIN_EMAIL, 'example-test-domain', PASSWORD]) {
      expect(text).not.toContain(needle);
    }
    expect(log.lines.find((l) => l.includes('"auth.login"'))?.startsWith('mm-security {')).toBe(
      true,
    );
  });

  it('success with a non-UUID user id → auth.login without user', async () => {
    password.mockResolvedValue(PASSWORD);
    fakeAuth.login.mockResolvedValue({ email: LOGIN_EMAIL, userId: 'u1' });
    const log = await runLogged('login', '--email', LOGIN_EMAIL);
    expect(eventsOf(log, 'auth.')).toEqual([{ event: 'auth.login' }]);
  });

  it.each([
    ['invalid_credentials', 'invalid-credentials', 'Invalid email or password'],
    ['unreachable', 'unreachable', 'Supabase unreachable'],
    ['unknown', 'unknown', 'Something went wrong'],
  ] as const)(
    'AuthError(%s) → one auth.login-failed {%s, 64-hex target}',
    async (code, reason, message) => {
      password.mockResolvedValue(PASSWORD);
      fakeAuth.login.mockRejectedValue(new AuthError(code, message));
      const log = await runLogged('login', '--email', LOGIN_EMAIL);
      const events = eventsOf(log, 'auth.');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event: 'auth.login-failed', reason });
      expect(events[0]?.['target']).toMatch(HEX64);
      expect(err.join('\n')).toContain(message);
      expect(process.exitCode).toBe(1);
      expect(log.records.filter((r) => r.event === 'error.unexpected')).toHaveLength(0);
      const text = log.lines.join('\n');
      for (const needle of [LOGIN_EMAIL, 'example-test-domain', PASSWORD, 'someone']) {
        expect(text).not.toContain(needle);
      }
    },
  );

  it('the password typed as the e-mail → target "invalid"', async () => {
    input.mockResolvedValue(PASSWORD);
    password.mockResolvedValue(PASSWORD);
    fakeAuth.login.mockRejectedValue(
      new AuthError('invalid_credentials', 'Invalid email or password'),
    );
    const log = await runLogged('login');
    expect(eventsOf(log, 'auth.')).toEqual([
      { event: 'auth.login-failed', reason: 'invalid-credentials', target: 'invalid' },
    ]);
    expect(log.lines.join('\n')).not.toContain('hunter2');
    expect(process.exitCode).toBe(1);
  });

  it('any other error → reason unexpected plus error.unexpected', async () => {
    password.mockResolvedValue(PASSWORD);
    fakeAuth.login.mockRejectedValue(new Error(`boom ${LOGIN_EMAIL}`));
    const log = await runLogged('login', '--email', LOGIN_EMAIL);
    const events = eventsOf(log, 'auth.');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'auth.login-failed', reason: 'unexpected' });
    expect(events[0]?.['target']).toMatch(HEX64);
    expect(log.records.filter((r) => r.event === 'error.unexpected')).toHaveLength(1);
    expect(err.join('\n')).toContain('Unexpected error');
    expect(process.exitCode).toBe(1);
    expect(log.lines.join('\n')).not.toContain(LOGIN_EMAIL);
  });

  it('with MM_MASTER_KEY the target is deterministic across runs and normalised', async () => {
    process.env['MM_MASTER_KEY'] = MASTER.toString('base64');
    password.mockResolvedValue(PASSWORD);
    fakeAuth.login.mockRejectedValue(new AuthError('invalid_credentials', 'Invalid'));
    const first = await runLogged('login', '--email', LOGIN_EMAIL);
    const second = await runLogged('login', '--email', LOGIN_EMAIL);
    input.mockResolvedValue(`  ${LOGIN_EMAIL.toUpperCase()} `);
    const third = await runLogged('login');
    const target = (log: Log): unknown => eventsOf(log, 'auth.login-failed')[0]?.['target'];
    expect(target(first)).toMatch(HEX64);
    expect(target(second)).toBe(target(first));
    expect(target(third)).toBe(target(first));
    expect(target(first)).toBe(authEmailTarget(authTargetKey(MASTER), LOGIN_EMAIL));
  });

  it('different addresses give different targets with the same MM_MASTER_KEY', async () => {
    process.env['MM_MASTER_KEY'] = MASTER.toString('base64');
    password.mockResolvedValue(PASSWORD);
    fakeAuth.login.mockRejectedValue(new AuthError('invalid_credentials', 'Invalid'));
    const a = await runLogged('login', '--email', 'a@example-test-domain.eu');
    const b = await runLogged('login', '--email', 'b@example-test-domain.eu');
    const ta = eventsOf(a, 'auth.login-failed')[0]?.['target'];
    expect(ta).toMatch(HEX64);
    expect(eventsOf(b, 'auth.login-failed')[0]?.['target']).not.toBe(ta);
  });

  describe('no auth event', () => {
    it('without a TTY', async () => {
      setTTY(undefined);
      const log = await runLogged('login', '--email', LOGIN_EMAIL);
      expect(eventsOf(log, 'auth.')).toEqual([]);
      expect(err.join('\n')).toContain('interactive terminal');
      expect(process.exitCode).toBe(1);
    });

    it('for an empty e-mail', async () => {
      input.mockResolvedValue('   ');
      const log = await runLogged('login');
      expect(eventsOf(log, 'auth.')).toEqual([]);
      expect(err.join('\n')).toContain('Email is required');
      expect(process.exitCode).toBe(1);
    });

    it.each(['input', 'password'] as const)('Ctrl+C at the %s prompt', async (which) => {
      if (which === 'input') input.mockRejectedValue(exitPrompt());
      else {
        input.mockResolvedValue(LOGIN_EMAIL);
        password.mockRejectedValue(exitPrompt());
      }
      const log = await runLogged('login');
      expect(eventsOf(log, 'auth.')).toEqual([]);
      expect(process.exitCode).toBe(130);
      expect(fakeAuth.login).not.toHaveBeenCalled();
    });

    it('when authService() throws ConfigError', async () => {
      createSupabaseServices.mockImplementation(() => {
        throw new ConfigError([{ variable: 'SUPABASE_URL', problem: 'is missing' }]);
      });
      input.mockResolvedValue(LOGIN_EMAIL);
      password.mockResolvedValue(PASSWORD);
      const log = await runLogged('login', '--email', LOGIN_EMAIL);
      expect(eventsOf(log, 'auth.')).toEqual([]);
      expect(err.join('\n')).toContain('SUPABASE_URL');
      expect(process.exitCode).toBe(1);
    });
  });
});

describe('mm logout / whoami events', () => {
  it.each(['logged-out', 'not-logged-in'] as const)(
    'logout %s → one auth.logout',
    async (outcome) => {
      fakeAuth.logout.mockResolvedValue(outcome);
      const log = await runLogged('logout');
      expect(eventsOf(log, 'auth.')).toEqual([{ event: 'auth.logout', outcome }]);
      expect(out.join('\n')).toContain(outcome === 'logged-out' ? 'Logged out' : 'Not logged in');
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each([
    [false, 'logged-out', 'Logged out'],
    [true, 'not-logged-in', 'Not logged in'],
  ] as const)(
    'broken config (session empty: %s) → auth.logout %s',
    async (empty, outcome, text) => {
      createSupabaseServices.mockImplementation(() => {
        throw new ConfigError([{ variable: 'SUPABASE_URL', problem: 'is missing' }]);
      });
      session.empty = empty;
      const log = await runLogged('logout');
      expect(eventsOf(log, 'auth.')).toEqual([{ event: 'auth.logout', outcome }]);
      expect(out.join('\n')).toContain(text);
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each([
    ['logged in', { email: LOGIN_EMAIL, userId: USER_ID }],
    ['not logged in', null],
  ] as const)('whoami (%s) → no auth event', async (_label, user) => {
    fakeAuth.currentUser.mockResolvedValue(user);
    const log = await runLogged('whoami');
    expect(eventsOf(log, 'auth.')).toEqual([]);
    expect(log.lines.join('\n')).not.toContain(LOGIN_EMAIL);
  });
});

describe('mm doctor events', () => {
  it('one doctor.check per printed result, same order, names and status', async () => {
    const results: CheckResult[] = [
      { name: 'node', status: 'ok', detail: 'v22' },
      { name: 'master-key', status: 'warn', detail: 'not set' },
      { name: 'supabase-api', status: 'fail', detail: `key rejected for ${LOGIN_EMAIL}` },
      { name: 'logs', status: 'ok', detail: '0 files' },
    ];
    runDoctor.mockResolvedValue(results);
    const log = await runLogged('doctor');
    expect(out).toHaveLength(4);
    expect(eventsOf(log, 'doctor.')).toEqual(
      results.map((r) => ({ event: 'doctor.check', check: r.name, status: r.status })),
    );
    const levels = log.records.filter((r) => r.event === 'doctor.check').map((r) => r.level);
    expect(levels).toEqual(['info', 'warn', 'warn', 'info']);
    expect(process.exitCode).toBe(1);
    const text = log.lines.join('\n');
    for (const needle of ['v22', 'not set', 'key rejected', LOGIN_EMAIL, '0 files']) {
      expect(text).not.toContain(needle);
    }
  });

  it('warnings only → exit code untouched, events still written', async () => {
    runDoctor.mockResolvedValue([{ name: 'master-key', status: 'warn', detail: '' }]);
    const log = await runLogged('doctor');
    expect(eventsOf(log, 'doctor.')).toEqual([
      { event: 'doctor.check', check: 'master-key', status: 'warn' },
    ]);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('mm discover events', () => {
  const EMAIL = 'someone@example-test-domain.eu';
  const email = parseEmail(EMAIL);
  const base = { email, notices: [], tried: [] };
  const websupport: ProviderInfo = {
    id: 'websupport',
    name: 'Websupport',
    verified: true,
    auth: ['password'],
  };
  const wedos: ProviderInfo = {
    id: 'wedos',
    name: 'WEDOS',
    verified: true,
    auth: ['password'],
    hostHint: 'Find the server name in the WEDOS admin',
  };
  const outlook: ProviderInfo = {
    id: 'outlook',
    name: 'Outlook.com',
    verified: true,
    auth: ['oauth2'],
  };
  const SECRETS = [
    EMAIL,
    'example-test-domain',
    'imap.preset-host.example',
    'imap.wedos.example.com',
    'wes1-imap.example.com',
    'imap.x.sk',
    'login-1',
    'someone',
  ];

  async function run(result: DiscoveryResult | Error): Promise<Log> {
    if (result instanceof Error) discover.mockRejectedValue(result);
    else discover.mockResolvedValue(result);
    const log = await runLogged('discover', EMAIL);
    const text = log.lines.join('\n');
    for (const needle of SECRETS) expect(text, needle).not.toContain(needle);
    return log;
  }

  const finish = (log: Log): Record<string, unknown>[] => eventsOf(log, 'discover.');

  it('found with a preset → outcome, source, provider', async () => {
    const log = await run({
      ...base,
      status: 'found',
      source: 'preset-mx',
      via: 'mx10.websupport.sk',
      provider: websupport,
      imap: { host: 'imap.preset-host.example', port: 993, username: EMAIL },
      altHosts: [],
    });
    expect(finish(log)).toEqual([
      { event: 'discover.finish', outcome: 'found', source: 'preset-mx', provider: 'websupport' },
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(log.lines.join('\n')).not.toContain('mx10');
  });

  it('found without a preset, with a domain problem', async () => {
    const log = await run({
      ...base,
      domainProblem: 'dns-error',
      status: 'found',
      source: 'ispdb',
      via: 'autoconfig.thunderbird.net',
      imap: { host: 'imap.example-test-domain.eu', port: 993, username: EMAIL },
      altHosts: [],
    });
    expect(finish(log)).toEqual([
      { event: 'discover.finish', outcome: 'found', source: 'ispdb', domainProblem: 'dns-error' },
    ]);
  });

  it('blocked → outcome, source, provider; exit 1', async () => {
    const log = await run({
      ...base,
      status: 'blocked',
      source: 'preset-domain',
      provider: outlook,
      reason: 'OAuth2 only',
    });
    expect(finish(log)).toEqual([
      {
        event: 'discover.finish',
        outcome: 'blocked',
        source: 'preset-domain',
        provider: 'outlook',
      },
    ]);
    expect(process.exitCode).toBe(1);
    expect(log.lines.join('\n')).not.toContain('OAuth2 only');
  });

  it('needs-host without a TTY → no choice', async () => {
    setTTY(false);
    const log = await run({ ...base, status: 'needs-host', source: 'preset-mx', provider: wedos });
    expect(finish(log)).toEqual([
      { event: 'discover.finish', outcome: 'needs-host', source: 'preset-mx', provider: 'wedos' },
    ]);
    expect(chooseImapSettings).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each([
    ['picked', 'imap.wedos.example.com'],
    ['host-entered', 'wes1-imap.example.com'],
  ] as const)('needs-host in a TTY, %s → choice %s', async (choice, host) => {
    chooseImapSettings.mockResolvedValue({
      settings: { host, port: 993, username: EMAIL },
      source: choice,
      provider: wedos,
    });
    const log = await run({ ...base, status: 'needs-host', source: 'preset-mx', provider: wedos });
    expect(finish(log)).toEqual([
      {
        event: 'discover.finish',
        outcome: 'needs-host',
        source: 'preset-mx',
        provider: 'wedos',
        choice,
      },
    ]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  describe('manual', () => {
    const manual: DiscoveryResult = { ...base, status: 'manual' };

    it('picked a preset → provider is the picked preset id', async () => {
      chooseImapSettings.mockResolvedValue({
        settings: { host: 'imap.preset-host.example', port: 993, username: EMAIL },
        source: 'picked',
        provider: websupport,
      });
      const log = await run(manual);
      expect(finish(log)).toEqual([
        { event: 'discover.finish', outcome: 'manual', provider: 'websupport', choice: 'picked' },
      ]);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it('entered manually → choice manual, no provider', async () => {
      chooseImapSettings.mockResolvedValue({
        settings: { host: 'imap.x.sk', port: 993, username: 'login-1' },
        source: 'manual',
      });
      const log = await run(manual);
      expect(finish(log)).toEqual([
        { event: 'discover.finish', outcome: 'manual', choice: 'manual' },
      ]);
      expect(out.join('\n')).toContain('Entered manually');
      expect(process.exitCode ?? 0).toBe(0);
    });

    it('Cancel → choice cancelled, exit 1', async () => {
      chooseImapSettings.mockResolvedValue(null);
      const log = await run(manual);
      expect(finish(log)).toEqual([
        { event: 'discover.finish', outcome: 'manual', choice: 'cancelled' },
      ]);
      expect(process.exitCode).toBe(1);
    });

    it('Ctrl+C in the picker → no discover.finish, exit 130', async () => {
      chooseImapSettings.mockRejectedValue(exitPrompt());
      const log = await run(manual);
      expect(finish(log)).toEqual([]);
      expect(process.exitCode).toBe(130);
      expect(err).toEqual([]);
    });

    it('without a TTY → no choice, exit 1', async () => {
      setTTY(false);
      const log = await run({ ...manual, domainProblem: 'not-exist' });
      expect(finish(log)).toEqual([
        { event: 'discover.finish', outcome: 'manual', domainProblem: 'not-exist' },
      ]);
      expect(chooseImapSettings).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('stdout piped → no choice, exit 1', async () => {
      setTTY(true, false);
      const log = await run(manual);
      expect(finish(log)).toEqual([{ event: 'discover.finish', outcome: 'manual' }]);
      expect(process.exitCode).toBe(1);
    });

    it('domain problem + a pick in a TTY → both recorded', async () => {
      chooseImapSettings.mockResolvedValue({
        settings: { host: 'imap.x.sk', port: 993, username: EMAIL },
        source: 'picked',
      });
      const log = await run({ ...manual, domainProblem: 'dns-unreachable' });
      expect(finish(log)).toEqual([
        {
          event: 'discover.finish',
          outcome: 'manual',
          domainProblem: 'dns-unreachable',
          choice: 'picked',
        },
      ]);
    });
  });

  it('DiscoveryInputError → {outcome: invalid} only', async () => {
    const log = await run(new DiscoveryInputError('That is not a valid email address.'));
    expect(finish(log)).toEqual([{ event: 'discover.finish', outcome: 'invalid' }]);
    expect(err.join('\n')).toContain('That is not a valid email address.');
    expect(process.exitCode).toBe(1);
  });

  it('an unexpected error → no discover.finish (error.unexpected instead)', async () => {
    const log = await run(new Error(`boom ${EMAIL}`));
    expect(finish(log)).toEqual([]);
    expect(log.records.filter((r) => r.event === 'error.unexpected')).toHaveLength(1);
    expect(err).toContain('Unexpected error');
    expect(process.exitCode).toBe(1);
    expect(allOutput()).not.toContain('boom');
  });

  it('discover.finish goes to the app log (plain JSON, info)', async () => {
    setTTY(false);
    const log = await run({ ...base, status: 'manual' });
    const line = log.lines.find((l) => l.includes('"discover.finish"')) ?? '';
    expect(line.startsWith('{')).toBe(true);
    expect(log.records.find((r) => r.event === 'discover.finish')?.level).toBe('info');
  });
});

describe('a throwing EventLog never changes CLI output (review round 2)', () => {
  const broken: EventLog = {
    emit: (): void => {
      throw new Error(`disk full ${PASSWORD}`);
    },
  };

  interface Observed {
    out: string[];
    err: string[];
    raw: string[];
    exit: number | string | null | undefined;
  }

  async function observe(log: EventLog): Promise<Observed> {
    out = [];
    err = [];
    raw = [];
    process.exitCode = undefined;
    await buildProgram({ exitOverride: true, log }).parseAsync(currentArgs, { from: 'user' });
    const seen = { out: [...out], err: [...err], raw: [...raw], exit: process.exitCode };
    process.exitCode = undefined;
    return seen;
  }

  let currentArgs: string[] = [];

  const DISCOVER_EMAIL = 'someone@example-test-domain.eu';
  const websupport: ProviderInfo = {
    id: 'websupport',
    name: 'Websupport',
    verified: true,
    auth: ['password'],
  };

  const scenarios: [string, string[], () => void][] = [
    [
      'login success',
      ['login', '--email', LOGIN_EMAIL],
      () => {
        password.mockResolvedValue(PASSWORD);
        fakeAuth.login.mockResolvedValue({ email: LOGIN_EMAIL, userId: USER_ID });
      },
    ],
    [
      'login AuthError',
      ['login', '--email', LOGIN_EMAIL],
      () => {
        password.mockResolvedValue(PASSWORD);
        fakeAuth.login.mockRejectedValue(
          new AuthError('invalid_credentials', 'Invalid email or password'),
        );
      },
    ],
    ['logout', ['logout'], () => fakeAuth.logout.mockResolvedValue('logged-out')],
    [
      'doctor',
      ['doctor'],
      () =>
        runDoctor.mockResolvedValue([
          { name: 'node', status: 'ok', detail: 'v22' },
          { name: 'supabase-api', status: 'fail', detail: 'key rejected' },
        ]),
    ],
    [
      'discover found',
      ['discover', DISCOVER_EMAIL],
      () =>
        discover.mockResolvedValue({
          email: parseEmail(DISCOVER_EMAIL),
          notices: [],
          tried: [],
          status: 'found',
          source: 'preset-mx',
          provider: websupport,
          imap: { host: 'imap.preset-host.example', port: 993, username: DISCOVER_EMAIL },
          altHosts: [],
        }),
    ],
    [
      'discover DiscoveryInputError',
      ['discover', DISCOVER_EMAIL],
      () =>
        discover.mockRejectedValue(new DiscoveryInputError('That is not a valid email address.')),
    ],
  ];

  it.each(scenarios)('%s: same stdout, stderr and exit code', async (_name, args, arrange) => {
    arrange();
    currentArgs = args;
    const good = await observe(new MemoryEventLog(CTX));
    const bad = await observe(broken);
    expect(good.out.length + good.err.length).toBeGreaterThan(0);
    expect(bad).toEqual(good);
    const text = [...bad.out, ...bad.err, ...bad.raw].join('\n');
    expect(text).not.toContain('disk full');
    expect(text).not.toContain('Unexpected error');
  });
});
