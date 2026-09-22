import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { ChosenSettings } from '../../src/cli/prompts/imap-settings.js';
import type {
  DiscoveryDeps,
  DiscoveryResult,
  ProviderInfo,
} from '../../src/core/providers/discover.js';
import { DiscoveryInputError, parseEmail } from '../../src/core/providers/email.js';

const { discover, chooseImapSettings } = vi.hoisted(() => ({
  discover: vi.fn<(input: string, deps: DiscoveryDeps) => Promise<DiscoveryResult>>(),
  chooseImapSettings: vi.fn<(...args: unknown[]) => Promise<ChosenSettings | null>>(),
}));

vi.mock('../../src/core/providers/discover.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/providers/discover.js')>();
  return { ...actual, discover };
});
vi.mock('../../src/cli/prompts/imap-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/prompts/imap-settings.js')>();
  return { ...actual, chooseImapSettings };
});

const { buildProgram } = await import('../../src/cli/index.js');
const { SOURCE_LABEL } = await import('../../src/core/providers/discover.js');

const EMAIL = 'someone@example-test-domain.eu';
const email = parseEmail(EMAIL);

const websupport: ProviderInfo = {
  id: 'websupport',
  name: 'Websupport',
  verified: true,
  auth: ['password'],
  helpUrl: 'https://example.com/help',
};
const wedos: ProviderInfo = {
  id: 'wedos',
  name: 'WEDOS',
  verified: true,
  auth: ['password'],
  hostHint: 'Find the server name in the WEDOS admin',
};

let out: string[];
let err: string[];
let raw: string[];
const originalExitCode = process.exitCode;
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalOutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

// Prompts need both ends to be a terminal; `stdout` controls the piped case separately.
function setTTY(value: boolean | undefined, stdout: boolean | undefined = value): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: stdout,
    configurable: true,
    writable: true,
  });
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
  setTTY(true);
});

afterEach(() => {
  process.exitCode = originalExitCode;
  if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (originalOutIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalOutIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks();
  discover.mockReset();
  chooseImapSettings.mockReset();
});

async function runCli(result: DiscoveryResult | Error): Promise<void> {
  if (result instanceof Error) discover.mockRejectedValue(result);
  else discover.mockResolvedValue(result);
  await buildProgram({ exitOverride: true }).parseAsync(['discover', EMAIL], { from: 'user' });
}

const stdout = (): string => out.join('\n');
const all = (): string => [...out, ...err, ...raw].join('\n');
const geoLine = (): boolean => [...out, ...err, ...raw].some((l) => l.includes('GeoIP'));

const base = { email, notices: [], tried: [] };

describe('mm discover', () => {
  it('passes the email and deps (with onProgress) to discover', async () => {
    await runCli({
      ...base,
      status: 'found',
      source: 'preset-domain',
      provider: websupport,
      imap: { host: 'imap.m1.websupport.sk', port: 993, username: EMAIL },
      altHosts: [],
    });
    expect(discover).toHaveBeenCalledTimes(1);
    const [input, deps] = discover.mock.calls[0] ?? [];
    expect(input).toBe(EMAIL);
    expect(typeof deps?.onProgress).toBe('function');
    expect(typeof deps?.resolveMx).toBe('function');
    expect(typeof deps?.fetch).toBe('function');
  });

  it('found with provider prints provider, host:993, username (no GeoIP hint before connecting)', async () => {
    await runCli({
      ...base,
      status: 'found',
      source: 'preset-mx',
      via: 'mx10.websupport.sk',
      provider: websupport,
      imap: { host: 'imap.m1.websupport.sk', port: 993, username: EMAIL },
      altHosts: [],
    });
    const text = stdout();
    expect(text).toContain('Websupport');
    expect(text).toContain('imap.m1.websupport.sk:993');
    expect(text).toContain(EMAIL);
    expect(geoLine()).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
    expect(chooseImapSettings).not.toHaveBeenCalled();
  });

  it('prints notices on lines starting with "! "', async () => {
    await runCli({
      ...base,
      notices: ['Settings come from the ISPDB, not a built-in preset.'],
      status: 'found',
      source: 'ispdb',
      via: 'autoconfig.thunderbird.net',
      imap: { host: 'imap.example-test-domain.eu', port: 993, username: EMAIL },
      altHosts: [],
    });
    const notice = [...out, ...err].find((l) => l.includes('not a built-in preset'));
    expect(notice?.trimStart().startsWith('! ')).toBe(true);
  });

  it('found without provider prints host, exit 0 (no GeoIP hint)', async () => {
    await runCli({
      ...base,
      status: 'found',
      source: 'ispdb',
      via: 'autoconfig.thunderbird.net',
      imap: { host: 'imap.example-test-domain.eu', port: 993, username: EMAIL },
      altHosts: [],
    });
    expect(stdout()).toContain('imap.example-test-domain.eu:993');
    expect(geoLine()).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('blocked prints provider and reason, exit 1, no prompt', async () => {
    await runCli({
      ...base,
      status: 'blocked',
      source: 'preset-domain',
      provider: { id: 'outlook', name: 'Outlook.com', verified: true, auth: ['oauth2'] },
      reason: 'Password IMAP is disabled; OAuth2 is not supported yet',
    });
    expect(all()).toContain('Outlook.com');
    expect(all()).toContain('Password IMAP is disabled; OAuth2 is not supported yet');
    expect(process.exitCode).toBe(1);
    expect(chooseImapSettings).not.toHaveBeenCalled();
  });

  it('needs-host in a TTY asks via chooseImapSettings and prints the choice', async () => {
    chooseImapSettings.mockResolvedValue({
      settings: { host: 'imap.wedos.example.com', port: 993, username: EMAIL },
      source: 'picked',
      provider: wedos,
    });
    await runCli({ ...base, status: 'needs-host', source: 'preset-mx', provider: wedos });
    expect(chooseImapSettings).toHaveBeenCalledTimes(1);
    expect(stdout()).toContain('imap.wedos.example.com:993');
    expect(stdout()).toContain('Chosen from list');
    expect(geoLine()).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('needs-host without a TTY prints the hint, no prompt, exit 0', async () => {
    setTTY(false);
    await runCli({ ...base, status: 'needs-host', source: 'preset-mx', provider: wedos });
    expect(chooseImapSettings).not.toHaveBeenCalled();
    expect(all()).toContain('Find the server name in the WEDOS admin');
    expect(geoLine()).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  describe('manual', () => {
    const manual: DiscoveryResult = {
      ...base,
      status: 'manual',
      tried: [
        { source: 'preset-domain', outcome: 'no-match' },
        { source: 'preset-mx', outcome: 'no-match', detail: 'mx1.other.example.com' },
        { source: 'ispdb', outcome: 'not-found' },
        { source: 'autoconfig', outcome: 'insecure-only' },
        { source: 'srv', outcome: 'timeout' },
      ],
    };

    function expectOneLinePerTriedSource(): void {
      const lines = [...out, ...err];
      const hits = new Set<number>();
      for (const t of manual.tried) {
        const i = lines.findIndex((l, idx) => !hits.has(idx) && l.includes(SOURCE_LABEL[t.source]));
        expect(i, `line for ${t.source}`).toBeGreaterThanOrEqual(0);
        hits.add(i);
      }
    }

    it('reports what was tried and asks in a TTY (picked)', async () => {
      chooseImapSettings.mockResolvedValue({
        settings: { host: 'imap.sk1.example.com', port: 993, username: EMAIL },
        source: 'picked',
        provider: websupport,
      });
      await runCli(manual);
      expect(all()).toContain(`No IMAP settings found for ${email.displayDomain}`);
      expectOneLinePerTriedSource();
      expect(chooseImapSettings).toHaveBeenCalledTimes(1);
      expect(stdout()).toContain('Chosen from list');
      expect(stdout()).toContain('imap.sk1.example.com:993');
      expect(geoLine()).toBe(false);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it('manual entry prints "Entered manually"', async () => {
      chooseImapSettings.mockResolvedValue({
        settings: { host: 'imap.x.sk', port: 993, username: 'login-1' },
        source: 'manual',
      });
      await runCli(manual);
      expect(stdout()).toContain('Entered manually');
      expect(stdout()).toContain('imap.x.sk:993');
      expect(stdout()).toContain('login-1');
      expect(geoLine()).toBe(false);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it('Cancel → exit 1', async () => {
      chooseImapSettings.mockResolvedValue(null);
      await runCli(manual);
      expect(process.exitCode).toBe(1);
    });

    it('Ctrl+C → exit 130, nothing on console.error', async () => {
      const cancel = new Error('User force closed the prompt with SIGINT');
      cancel.name = 'ExitPromptError';
      chooseImapSettings.mockRejectedValue(cancel);
      await runCli(manual);
      expect(process.exitCode).toBe(130);
      expect(err).toEqual([]);
    });

    it('without a TTY tells the user to run in a terminal, exit 1', async () => {
      setTTY(false);
      await runCli(manual);
      expect(chooseImapSettings).not.toHaveBeenCalled();
      // Spec says "containing 'run in a terminal'"; the wording may carry a word in between.
      expect(all()).toMatch(/run (this )?in a terminal/i);
      expect(process.exitCode).toBe(1);
    });
  });

  it('DiscoveryInputError → message on stderr, exit 1, no stack', async () => {
    await runCli(new DiscoveryInputError('That is not a valid email address.'));
    expect(err.join('\n')).toContain('That is not a valid email address.');
    expect(process.exitCode).toBe(1);
    expect(all()).not.toMatch(/^\s+at /m);
  });

  it('progress goes to stderr, never stdout', async () => {
    discover.mockImplementation((_input, deps) => {
      deps.onProgress?.('preset-mx');
      deps.onProgress?.('ispdb');
      deps.onProgress?.('autoconfig');
      deps.onProgress?.('srv');
      return Promise.resolve({ ...base, status: 'manual' });
    });
    setTTY(false);
    await buildProgram({ exitOverride: true }).parseAsync(['discover', EMAIL], { from: 'user' });
    expect(out.some((l) => /checking/i.test(l))).toBe(false);
    expect([...err, ...raw].join('\n').length).toBeGreaterThan(0);
  });
});

describe('mm discover — output details', () => {
  const found = (provider: ProviderInfo, altHosts: string[] = []): DiscoveryResult => ({
    ...base,
    status: 'found',
    source: 'preset-mx',
    via: 'mx10.websupport.sk',
    provider,
    imap: { host: 'imap.m1.websupport.sk', port: 993, username: EMAIL },
    altHosts,
  });

  it('prints hint and help URL', async () => {
    await runCli(found({ ...websupport, hint: 'Use the full address.' }));
    expect(out.some((l) => l.startsWith('Hint') && l.includes('Use the full address.'))).toBe(true);
    expect(out.some((l) => l.startsWith('Help') && l.includes('https://example.com/help'))).toBe(
      true,
    );
  });

  it('labels an unverified provider', async () => {
    await runCli(found({ ...websupport, verified: false }));
    expect(out.some((l) => l.startsWith('Provider') && l.includes('(unverified preset)'))).toBe(
      true,
    );
  });

  it('lists alternative hosts under "Also try"', async () => {
    await runCli(found(websupport, ['imap.websupport.sk', 'imap2.example.com']));
    expect(
      out.some(
        (l) => l.startsWith('Also try') && l.includes('imap.websupport.sk, imap2.example.com'),
      ),
    ).toBe(true);
  });

  it('blocked prints its notices and the reason, exit 1', async () => {
    await runCli({
      ...base,
      notices: ['preset notice'],
      status: 'blocked',
      source: 'preset-domain',
      provider: { ...websupport, name: 'Outlook' },
      reason: 'OAuth2 only',
    });
    expect(out).toContain('! preset notice');
    expect(out.some((l) => l.startsWith('! ') && l.includes('OAuth2 only'))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('needs-host without TTY prints the host hint and help URL, exit 0', async () => {
    setTTY(false);
    await runCli({
      ...base,
      status: 'needs-host',
      source: 'preset-mx',
      provider: { ...wedos, helpUrl: 'https://example.com/wedos' },
    });
    expect(out.some((l) => l.includes(wedos.hostHint ?? '-'))).toBe(true);
    expect(out.some((l) => l.startsWith('Help') && l.includes('https://example.com/wedos'))).toBe(
      true,
    );
    expect(process.exitCode ?? 0).toBe(0);
    expect(chooseImapSettings).not.toHaveBeenCalled();
  });

  it('needs-host in a TTY labels the typed host and does not repeat the provider line', async () => {
    chooseImapSettings.mockResolvedValue({
      settings: { host: 'wes1-imap.example.com', port: 993, username: EMAIL },
      source: 'host-entered',
      provider: wedos,
    });
    await runCli({ ...base, status: 'needs-host', source: 'preset-mx', provider: wedos });
    expect(out.some((l) => l.startsWith('Found via') && l.includes('Host entered manually'))).toBe(
      true,
    );
    expect(out.filter((l) => l.startsWith('Provider')).length).toBe(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('does not prompt when stdout is piped even if stdin is a terminal', async () => {
    setTTY(true, false);
    await runCli({ ...base, status: 'manual' });
    expect(chooseImapSettings).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('prints a generic message for unexpected errors (no err.message)', async () => {
    await runCli(new Error('secret internal detail'));
    expect(all()).not.toContain('secret internal detail');
    expect(err).toContain('Unexpected error');
    expect(process.exitCode).toBe(1);
  });

  it('still prints DiscoveryInputError messages', async () => {
    await runCli(new DiscoveryInputError('Email address must contain "@"'));
    expect(err).toContain('Email address must contain "@"');
  });
});

describe('mm discover — domain problems in plain language', () => {
  it('not-exist: typo / expired-domain hint, still offers the picker in a TTY', async () => {
    chooseImapSettings.mockResolvedValue({
      settings: { host: 'imap.example.com', port: 993, username: EMAIL },
      source: 'picked',
    });
    await runCli({ ...base, status: 'manual', domainProblem: 'not-exist' });
    expect(stdout()).toContain('does not exist');
    expect(stdout()).toContain('typos');
    expect(stdout()).toContain('expired');
    expect(chooseImapSettings).toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('not-exist without TTY: hint and exit 1', async () => {
    setTTY(false);
    await runCli({ ...base, status: 'manual', domainProblem: 'not-exist' });
    expect(stdout()).toContain('does not exist');
    expect(process.exitCode).toBe(1);
  });

  it('dns-error: says the domain DNS answered with an error', async () => {
    setTTY(false);
    await runCli({ ...base, status: 'manual', domainProblem: 'dns-error' });
    expect(stdout()).toContain('answered with an error');
  });

  it('dns-unreachable: points at the internet connection', async () => {
    setTTY(false);
    await runCli({ ...base, status: 'manual', domainProblem: 'dns-unreachable' });
    expect(stdout()).toContain('internet connection');
  });
});

describe('mm discover — review fixes', () => {
  const picked: ChosenSettings = {
    settings: { host: 'imap.example.com', port: 993, username: EMAIL },
    source: 'picked',
  };

  it('found + dns-error prints the plain-language warning', async () => {
    await runCli({
      ...base,
      domainProblem: 'dns-error',
      status: 'found',
      source: 'ispdb',
      via: 'autoconfig.thunderbird.net',
      imap: { host: 'imap.example.com', port: 993, username: EMAIL },
      altHosts: [],
    });
    expect(out.some((l) => l.startsWith('! ') && l.includes('answered with an error'))).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each([['dns-error' as const], ['dns-unreachable' as const]])(
    '%s in a TTY still opens the picker; exit 0 after a pick',
    async (domainProblem) => {
      chooseImapSettings.mockResolvedValue(picked);
      await runCli({ ...base, status: 'manual', domainProblem });
      expect(chooseImapSettings).toHaveBeenCalledTimes(1);
      expect(process.exitCode ?? 0).toBe(0);
    },
  );

  it('not-exist wording works without a TTY (no "below")', async () => {
    setTTY(false);
    await runCli({ ...base, status: 'manual', domainProblem: 'not-exist' });
    expect(stdout()).not.toContain('below');
    expect(stdout()).toContain('you can still choose the provider');
  });

  it('no GeoIP text for blocked, needs-host (TTY and not) or a picked result', async () => {
    await runCli({
      ...base,
      status: 'blocked',
      source: 'preset-domain',
      provider: websupport,
      reason: 'OAuth2 only',
    });
    expect(geoLine()).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    setTTY(false);
    await runCli({ ...base, status: 'needs-host', source: 'preset-mx', provider: wedos });
    expect(geoLine()).toBe(false);

    setTTY(true);
    chooseImapSettings.mockResolvedValue({ ...picked, source: 'host-entered', provider: wedos });
    await runCli({ ...base, status: 'needs-host', source: 'preset-mx', provider: wedos });
    expect(geoLine()).toBe(false);

    chooseImapSettings.mockResolvedValue(picked);
    await runCli({ ...base, status: 'manual' });
    expect(geoLine()).toBe(false);
  });
});
