import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { AuthError, type LogoutResult } from '../../src/core/auth.js';
import { ConfigError } from '../../src/core/config.js';

// Mock the core + prompts so the CLI wiring is tested without Supabase, env files or a TTY.
const PASSWORD = 'hunter2-ÄŠť';

// vi.hoisted: vi.mock factories are hoisted above the static imports, so the fakes must be too.
const { fakeAuth, createSupabaseServices, loadEnvFiles, input, password, clearSession, session } =
  vi.hoisted(() => ({
    fakeAuth: {
      login:
        vi.fn<(email: string, password: string) => Promise<{ email: string; userId: string }>>(),
      logout: vi.fn<() => Promise<LogoutResult>>(),
      currentUser: vi.fn<() => Promise<{ email: string; userId: string } | null>>(),
    },
    createSupabaseServices: vi.fn<(...args: unknown[]) => unknown>(),
    loadEnvFiles: vi.fn(),
    input: vi.fn<(...args: unknown[]) => Promise<string>>(),
    password: vi.fn<(...args: unknown[]) => Promise<string>>(),
    clearSession: vi.fn(),
    // Whether the mocked local session file is empty (per test).
    session: { empty: true },
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
  sessionDir: vi.fn(() => '/nonexistent/mm-test-config'),
}));
vi.mock('@inquirer/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inquirer/prompts')>();
  return { ...actual, input, password };
});

const { buildProgram } = await import('../../src/cli/index.js');

let out: string[];
let err: string[];
let raw: string[];
const originalExitCode = process.exitCode;
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
}

beforeEach(() => {
  out = [];
  err = [];
  raw = [];
  process.exitCode = undefined;
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
  if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks();
  fakeAuth.login.mockReset();
  fakeAuth.logout.mockReset();
  fakeAuth.currentUser.mockReset();
  createSupabaseServices.mockReset();
  loadEnvFiles.mockReset();
  input.mockReset();
  password.mockReset();
});

async function runCli(...args: string[]): Promise<void> {
  await buildProgram({ exitOverride: true }).parseAsync(args, { from: 'user' });
}

function allOutput(): string {
  return [...out, ...err, ...raw].join('\n');
}

describe('mm login', () => {
  it('refuses without an interactive terminal', async () => {
    setTTY(undefined);
    await runCli('login', '--email', 'a@x.sk');
    expect(err.join('\n')).toContain('interactive terminal');
    expect(process.exitCode).toBe(1);
    expect(fakeAuth.login).not.toHaveBeenCalled();
    expect(password).not.toHaveBeenCalled();
  });

  it('refuses when isTTY is false', async () => {
    setTTY(false);
    await runCli('login');
    expect(err.join('\n')).toContain('interactive terminal');
    expect(process.exitCode).toBe(1);
    expect(fakeAuth.login).not.toHaveBeenCalled();
  });

  it('uses --email without prompting for it, prompts for the password', async () => {
    password.mockResolvedValue(PASSWORD);
    fakeAuth.login.mockResolvedValue({ email: 'a@x.sk', userId: 'u1' });
    await runCli('login', '--email', 'a@x.sk');
    expect(input).not.toHaveBeenCalled();
    expect(password).toHaveBeenCalledTimes(1);
    expect(fakeAuth.login).toHaveBeenCalledWith('a@x.sk', PASSWORD);
    expect(out.join('\n')).toContain('Logged in as a@x.sk');
    expect(process.exitCode).toBeUndefined();
    expect(allOutput()).not.toContain(PASSWORD);
  });

  it('prompts for the email when --email is not given', async () => {
    input.mockResolvedValue('a@x.sk');
    password.mockResolvedValue(PASSWORD);
    fakeAuth.login.mockResolvedValue({ email: 'a@x.sk', userId: 'u1' });
    await runCli('login');
    expect(input).toHaveBeenCalledTimes(1);
    expect(fakeAuth.login).toHaveBeenCalledWith('a@x.sk', PASSWORD);
    expect(out.join('\n')).toContain('Logged in as a@x.sk');
  });

  it('reports invalid credentials without echoing the password', async () => {
    password.mockResolvedValue(PASSWORD);
    fakeAuth.login.mockRejectedValue(
      new AuthError('invalid_credentials', 'Invalid email or password'),
    );
    await runCli('login', '--email', 'a@x.sk');
    expect(err.join('\n')).toContain('Invalid email or password');
    expect(process.exitCode).toBe(1);
    expect(allOutput()).not.toContain(PASSWORD);
  });

  it.each([
    ['email', 'input'],
    ['password', 'password'],
  ] as const)('exits 130 when the %s prompt is cancelled', async (_label, which) => {
    const cancel = new Error('User force closed the prompt with SIGINT');
    cancel.name = 'ExitPromptError';
    if (which === 'input') input.mockRejectedValue(cancel);
    else {
      input.mockResolvedValue('a@x.sk');
      password.mockRejectedValue(cancel);
    }
    await runCli('login');
    expect(process.exitCode).toBe(130);
    expect(fakeAuth.login).not.toHaveBeenCalled();
    for (const line of [...err, ...raw]) expect(line.trim()).toMatch(/^(Cancelled\.?)?$/i);
  });

  it('reports a config error naming the variable', async () => {
    createSupabaseServices.mockImplementation(() => {
      throw new ConfigError([{ variable: 'SUPABASE_URL', problem: 'is missing' }]);
    });
    input.mockResolvedValue('a@x.sk');
    password.mockResolvedValue(PASSWORD);
    await runCli('login', '--email', 'a@x.sk');
    expect(err.join('\n')).toContain('SUPABASE_URL');
    expect(process.exitCode).toBe(1);
    expect(allOutput()).not.toContain(PASSWORD);
  });
});

describe('mm whoami', () => {
  it('prints the email and user id when logged in', async () => {
    fakeAuth.currentUser.mockResolvedValue({ email: 'a@x.sk', userId: 'u1' });
    await runCli('whoami');
    const text = out.join('\n');
    expect(text).toContain('a@x.sk');
    expect(text).toContain('u1');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports not logged in with a hint and exit code 1', async () => {
    fakeAuth.currentUser.mockResolvedValue(null);
    await runCli('whoami');
    const text = err.join('\n');
    expect(text).toContain('Not logged in');
    expect(text).toContain('mm login');
    expect(process.exitCode).toBe(1);
  });

  it('reports a config error naming the variable', async () => {
    createSupabaseServices.mockImplementation(() => {
      throw new ConfigError([{ variable: 'SUPABASE_URL', problem: 'is missing' }]);
    });
    await runCli('whoami');
    expect(err.join('\n')).toContain('SUPABASE_URL');
    expect(process.exitCode).toBe(1);
  });
});

describe('mm logout', () => {
  beforeEach(() => {
    clearSession.mockClear();
  });

  it('logs out once and confirms', async () => {
    fakeAuth.logout.mockResolvedValue('logged-out');
    await runCli('logout');
    expect(fakeAuth.logout).toHaveBeenCalledTimes(1);
    expect(out.join('\n')).toContain('Logged out');
    expect(process.exitCode).toBeUndefined();
  });

  it('without a session says "Not logged in" (exit 0), never "Logged out"', async () => {
    fakeAuth.logout.mockResolvedValue('not-logged-in');
    await runCli('logout');
    expect(fakeAuth.logout).toHaveBeenCalledTimes(1);
    expect(out.join('\n')).toContain('Not logged in');
    expect(allOutput()).not.toContain('Logged out');
    expect(process.exitCode).toBeUndefined();
  });

  const brokenConfig = (): void => {
    createSupabaseServices.mockImplementation(() => {
      throw new ConfigError([{ variable: 'SUPABASE_URL', problem: 'is missing' }]);
    });
  };

  it('broken config + a local session: deletes it and says "Logged out"', async () => {
    brokenConfig();
    session.empty = false;
    await runCli('logout');
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(fakeAuth.logout).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('Logged out');
    expect(process.exitCode).toBeUndefined();
  });

  it('broken config + no session: still clears, says "Not logged in"', async () => {
    brokenConfig();
    await runCli('logout');
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(fakeAuth.logout).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('Not logged in');
    expect(allOutput()).not.toContain('Logged out');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('env loading', () => {
  it('loads env files for auth commands', async () => {
    fakeAuth.currentUser.mockResolvedValue(null);
    await runCli('whoami');
    expect(loadEnvFiles).toHaveBeenCalled();
  });
});

describe('review fixes', () => {
  afterEach(() => {
    clearSession.mockReset();
  });

  it('login refuses an empty email without calling the server', async () => {
    input.mockResolvedValue('   ');
    await runCli('login');
    expect(err.join('\n')).toContain('Email is required');
    expect(fakeAuth.login).not.toHaveBeenCalled();
    expect(password).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('login asks for the password without a mask (nothing echoed)', async () => {
    password.mockResolvedValue(PASSWORD);
    fakeAuth.login.mockResolvedValue({ email: 'a@x.sk', userId: 'u1' });
    await runCli('login', '--email', 'a@x.sk');
    const opts = password.mock.calls[0]?.[0] as { mask?: unknown } | undefined;
    expect(opts?.mask).toBeUndefined();
  });

  it('whoami reports an unreachable server instead of "not logged in"', async () => {
    fakeAuth.currentUser.mockRejectedValue(new AuthError('unreachable', 'Supabase unreachable'));
    await runCli('whoami');
    const text = err.join('\n');
    expect(text).toContain('Supabase unreachable');
    expect(text).not.toContain('Not logged in');
    expect(process.exitCode).toBe(1);
  });

  it('whoami shows a placeholder when the user has no email', async () => {
    fakeAuth.currentUser.mockResolvedValue({ email: '', userId: 'u1' });
    await runCli('whoami');
    expect(out.join('\n')).toContain('(no email) (u1)');
  });
});
