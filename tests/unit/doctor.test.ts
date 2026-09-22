import { describe, it, expect, vi } from 'vitest';
import { AuthError } from '../../src/core/auth.js';
import { hasFailures, runDoctor } from '../../src/core/doctor.js';
import type { CheckResult, DoctorDeps } from '../../src/core/doctor.js';
import type { EnvSource } from '../../src/core/config.js';
import { generateMasterKey } from '../../src/core/master-key.js';

const URL_OK = 'https://abcdefghijklmnop.supabase.co';
const KEY_OK = 'sb_publishable_TESTKEY123';
const HEALTH_URL = 'https://abcdefghijklmnop.supabase.co/auth/v1/health';
const HEALTH_PATH = '/auth/v1/health';
const DB_PATH = '/rest/v1/mail_accounts';
const SETTINGS_PATH = '/auth/v1/settings';

type FetchArgs = [input: string | URL | Request, init?: RequestInit];
type FetchImpl = (...args: FetchArgs) => Promise<Response>;

function makeFetch(impl: FetchImpl) {
  const mock = vi.fn<FetchImpl>(impl);
  return { mock, fetch: mock as unknown as typeof globalThis.fetch };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return new URL(input).href;
  if (input instanceof URL) return input.href;
  return new URL(input.url).href;
}

function pathOf(input: string | URL | Request): string {
  return new URL(requestUrl(input)).pathname;
}

const healthOk: FetchImpl = () =>
  Promise.resolve(jsonResponse({ version: 'v2.197.0', name: 'GoTrue' }));

/** RLS working as intended: anon is refused on the table. */
const dbAnonBlocked: FetchImpl = () =>
  Promise.resolve(
    jsonResponse({ code: '42501', message: 'permission denied for table mail_accounts' }, 401),
  );

/** Invite-only project: public signups disabled. */
const settingsInviteOnly: FetchImpl = () =>
  Promise.resolve(jsonResponse({ disable_signup: true, external: { email: true } }));

/** Fake fetch that routes by pathname: health endpoint, the mail_accounts probe, auth settings. */
function routedFetch(routes: { health?: FetchImpl; db?: FetchImpl; settings?: FetchImpl } = {}) {
  const health = routes.health ?? healthOk;
  const db = routes.db ?? dbAnonBlocked;
  const settings = routes.settings ?? settingsInviteOnly;
  return makeFetch((input, init) => {
    const path = pathOf(input);
    if (path === HEALTH_PATH) return health(input, init);
    if (path === DB_PATH) return db(input, init);
    if (path === SETTINGS_PATH) return settings(input, init);
    return Promise.reject(new Error(`unexpected fetch to ${path}`));
  });
}

function okFetch() {
  return routedFetch();
}

/** Route only the health endpoint to `impl`; the database probe stays healthy. */
function apiFetch(impl: FetchImpl) {
  return routedFetch({ health: impl });
}

/** Route only the database probe to `impl`; the health endpoint stays healthy. */
function dbFetch(impl: FetchImpl) {
  return routedFetch({ db: impl });
}

const loggedIn = () => Promise.resolve({ email: 'a@x.sk' });

function validEnv(extra: EnvSource = {}): EnvSource {
  return {
    SUPABASE_URL: URL_OK,
    SUPABASE_PUBLISHABLE_KEY: KEY_OK,
    MM_MASTER_KEY: generateMasterKey(),
    ...extra,
  };
}

function deps(overrides: Partial<DoctorDeps> & Pick<DoctorDeps, 'fetch'>): DoctorDeps {
  return {
    env: validEnv(),
    nodeVersion: '22.22.1',
    timeoutMs: 5000,
    session: loggedIn,
    ...overrides,
  };
}

function depsWithoutSession(
  overrides: Partial<DoctorDeps> & Pick<DoctorDeps, 'fetch'>,
): DoctorDeps {
  const d = deps(overrides);
  delete d.session;
  return d;
}

function byName(results: CheckResult[], name: string): CheckResult {
  const found = results.find((r) => r.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

function callTo(mock: ReturnType<typeof makeFetch>['mock'], path: string): FetchArgs {
  const call = mock.mock.calls.find(([input]) => pathOf(input) === path);
  if (!call) throw new Error(`fetch was not called for ${path}`);
  return call;
}

function callsTo(mock: ReturnType<typeof makeFetch>['mock'], path: string): FetchArgs[] {
  return mock.mock.calls.filter(([input]) => pathOf(input) === path);
}

describe('runDoctor', () => {
  it('returns exactly 7 checks in order and all ok on the happy path', async () => {
    const { fetch, mock } = okFetch();
    const results = await runDoctor(deps({ fetch }));
    expect(results.map((r) => r.name)).toEqual([
      'node',
      'supabase-env',
      'master-key',
      'supabase-api',
      'database',
      'signup',
      'session',
    ]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(callsTo(mock, HEALTH_PATH)).toHaveLength(1);
    expect(callsTo(mock, DB_PATH)).toHaveLength(1);
    expect(callsTo(mock, SETTINGS_PATH)).toHaveLength(1);
    expect(byName(results, 'supabase-api').detail).toContain('v2.197.0');
    expect(hasFailures(results)).toBe(false);
    for (const r of results) expect(typeof r.detail).toBe('string');
  });

  describe('node check', () => {
    it.each([
      ['22.22.1', 'ok'],
      ['22.13.0', 'ok'],
      ['24.0.0', 'ok'],
      ['22.12.0', 'fail'],
      ['22.11.0', 'fail'],
      ['20.19.0', 'fail'],
      ['22.13.0-rc.1', 'fail'],
    ] as const)('node %s -> %s', async (nodeVersion, expected) => {
      const { fetch } = okFetch();
      const results = await runDoctor(deps({ fetch, nodeVersion }));
      expect(byName(results, 'node').status).toBe(expected);
    });
  });

  describe('supabase-env check', () => {
    it('fails naming the missing variable', async () => {
      const { fetch } = okFetch();
      const env = validEnv();
      delete env.SUPABASE_PUBLISHABLE_KEY;
      const results = await runDoctor(deps({ fetch, env }));
      const check = byName(results, 'supabase-env');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('SUPABASE_PUBLISHABLE_KEY');
    });

    it('fails naming an invalid SUPABASE_URL', async () => {
      const { fetch } = okFetch();
      const results = await runDoctor(
        deps({ fetch, env: validEnv({ SUPABASE_URL: 'http://abcdefghijklmnop.supabase.co' }) }),
      );
      const check = byName(results, 'supabase-env');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('SUPABASE_URL');
    });

    it('names both variables when both are missing', async () => {
      const { fetch } = okFetch();
      const results = await runDoctor(deps({ fetch, env: {} }));
      const check = byName(results, 'supabase-env');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('SUPABASE_URL');
      expect(check.detail).toContain('SUPABASE_PUBLISHABLE_KEY');
    });
  });

  describe('master-key check', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
    ])('warns when %s and mentions mm keygen', async (_label, value) => {
      const { fetch } = okFetch();
      const env = validEnv();
      if (value === undefined) delete env.MM_MASTER_KEY;
      else env.MM_MASTER_KEY = value;
      const results = await runDoctor(deps({ fetch, env }));
      const check = byName(results, 'master-key');
      expect(check.status).toBe('warn');
      expect(check.detail).toContain('mm keygen');
      expect(hasFailures(results)).toBe(false);
    });

    it('fails when malformed, and the API check still runs', async () => {
      const { fetch, mock } = okFetch();
      const results = await runDoctor(
        deps({ fetch, env: validEnv({ MM_MASTER_KEY: 'not base64!!' }) }),
      );
      expect(byName(results, 'master-key').status).toBe('fail');
      expect(byName(results, 'supabase-env').status).toBe('ok');
      expect(callsTo(mock, HEALTH_PATH)).toHaveLength(1);
      expect(byName(results, 'supabase-api').status).toBe('ok');
    });

    it('is evaluated independently of the supabase-env check', async () => {
      const { fetch } = okFetch();
      const results = await runDoctor(deps({ fetch, env: { MM_MASTER_KEY: generateMasterKey() } }));
      expect(byName(results, 'supabase-env').status).toBe('fail');
      expect(byName(results, 'master-key').status).toBe('ok');
    });
  });

  describe('supabase-api check', () => {
    it('is skipped (fail, fetch not called) when supabase-env failed', async () => {
      const { fetch, mock } = okFetch();
      const results = await runDoctor(deps({ fetch, env: {} }));
      const check = byName(results, 'supabase-api');
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/skipped/i);
      expect(mock).not.toHaveBeenCalled();
      expect(results).toHaveLength(7);
    });

    it.each([
      ['without trailing slash', URL_OK],
      ['with trailing slash', `${URL_OK}/`],
    ])('calls the health endpoint %s with apikey header and a signal', async (_label, url) => {
      const { fetch, mock } = okFetch();
      await runDoctor(deps({ fetch, env: validEnv({ SUPABASE_URL: url }) }));
      expect(callsTo(mock, HEALTH_PATH)).toHaveLength(1);
      const [input, init] = callTo(mock, HEALTH_PATH);
      const href = requestUrl(input);
      expect(href).toBe(HEALTH_URL);
      expect(href).not.toContain('//auth');
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBe(KEY_OK);
      expect(headers.has('authorization')).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('is ok on 200 without a version in the body', async () => {
      const { fetch } = apiFetch(() => Promise.resolve(new Response('OK', { status: 200 })));
      const results = await runDoctor(deps({ fetch }));
      expect(byName(results, 'supabase-api').status).toBe('ok');
    });

    it.each([401, 403])('fails with "rejected" on %d', async (status) => {
      const { fetch } = apiFetch(() =>
        Promise.resolve(jsonResponse({ message: 'Invalid API key' }, status)),
      );
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'supabase-api');
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/rejected/i);
    });

    it('fails with the status number on other non-2xx', async () => {
      const { fetch } = apiFetch(() => Promise.resolve(new Response('boom', { status: 500 })));
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'supabase-api');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('500');
    });

    it('does not follow redirects (the apikey header must not reach another origin)', async () => {
      const { mock, fetch } = okFetch();
      await runDoctor(deps({ fetch }));
      const [, init] = callTo(mock, HEALTH_PATH);
      expect(init?.redirect).toBe('manual');
    });

    it('fails on a redirect response', async () => {
      const { fetch } = apiFetch(() =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
        ),
      );
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'supabase-api');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('redirect');
    });

    it('fails with "timeout" when fetch rejects with a TimeoutError', async () => {
      const { fetch } = apiFetch(() => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        return Promise.reject(err);
      });
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'supabase-api');
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/timeout/i);
    });

    it('fails with "unreachable" and the cause code on network errors', async () => {
      const { fetch } = apiFetch(() =>
        Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })),
      );
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'supabase-api');
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/unreachable/i);
      expect(check.detail).toContain('ENOTFOUND');
      expect(check.detail).not.toContain('fetch failed');
    });

    it('times out for real when fetch never resolves', async () => {
      const { fetch } = apiFetch(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return; // never settles; the test would time out
            signal.addEventListener('abort', () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            });
          }),
      );
      const started = Date.now();
      const results = await runDoctor(deps({ fetch, timeoutMs: 20 }));
      const check = byName(results, 'supabase-api');
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/timeout/i);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  describe('database check', () => {
    it('probes mail_accounts with select=id&limit=1, apikey header, manual redirect and a signal', async () => {
      const { fetch, mock } = okFetch();
      await runDoctor(deps({ fetch }));
      expect(callsTo(mock, DB_PATH)).toHaveLength(1);
      const [input, init] = callTo(mock, DB_PATH);
      const url = new URL(requestUrl(input));
      expect(url.origin).toBe(URL_OK);
      expect(url.pathname).toBe(DB_PATH);
      expect(url.searchParams.get('select')).toBe('id');
      expect(url.searchParams.get('limit')).toBe('1');
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBe(KEY_OK);
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('does not produce a double slash with a trailing-slash SUPABASE_URL', async () => {
      const { fetch, mock } = okFetch();
      await runDoctor(deps({ fetch, env: validEnv({ SUPABASE_URL: `${URL_OK}/` }) }));
      const [input] = callTo(mock, DB_PATH);
      expect(requestUrl(input)).not.toContain('//rest');
    });

    it.each([401, 403])('is ok ("anon blocked") on %d with code 42501', async (status) => {
      const { fetch } = dbFetch(() =>
        Promise.resolve(
          jsonResponse(
            { code: '42501', message: 'permission denied for table mail_accounts' },
            status,
          ),
        ),
      );
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'database');
      expect(check.status).toBe('ok');
      expect(check.detail).toContain('anon blocked');
    });

    it('fails pointing at db:push when the table is missing (404 PGRST205)', async () => {
      const { fetch } = dbFetch(() =>
        Promise.resolve(
          jsonResponse(
            { code: 'PGRST205', message: "Could not find the table 'public.mail_accounts'" },
            404,
          ),
        ),
      );
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'database');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('db:push');
      expect(hasFailures(results)).toBe(true);
    });

    it('fails ("anon can read") when anon gets 200', async () => {
      const { fetch } = dbFetch(() => Promise.resolve(jsonResponse([], 200)));
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'database');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('anon can read');
    });

    it('fails with the status number on 500', async () => {
      const { fetch } = dbFetch(() => Promise.resolve(new Response('boom', { status: 500 })));
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'database');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('500');
    });

    it('fails with "timeout" when fetch rejects with a TimeoutError', async () => {
      const { fetch } = dbFetch(() => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        return Promise.reject(err);
      });
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'database');
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/timeout/i);
    });

    it('fails with "unreachable" on network errors', async () => {
      const { fetch } = dbFetch(() =>
        Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })),
      );
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'database');
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/unreachable/i);
    });

    it('is skipped (fail) and no endpoint is fetched when supabase-env failed', async () => {
      const { fetch, mock } = okFetch();
      const results = await runDoctor(deps({ fetch, env: {} }));
      const check = byName(results, 'database');
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/skipped/i);
      expect(mock).not.toHaveBeenCalled();
    });
  });

  describe('signup check', () => {
    function settingsFetch(impl: FetchImpl) {
      return routedFetch({ settings: impl });
    }

    it('is ok when public signups are disabled (invite-only)', async () => {
      const { fetch, mock } = okFetch();
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'signup');
      expect(check.status).toBe('ok');
      expect(check.detail).toContain('invite-only');
      const call = callsTo(mock, SETTINGS_PATH)[0];
      if (!call) throw new Error('settings endpoint not called');
      const init = call[1];
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('apikey')).toBe(KEY_OK);
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
    });

    it('fails when public signups are enabled', async () => {
      const { fetch } = settingsFetch(() =>
        Promise.resolve(jsonResponse({ disable_signup: false })),
      );
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'signup');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('public signups enabled');
      expect(hasFailures(results)).toBe(true);
      expect(check.detail).not.toContain(KEY_OK);
    });

    it('fails on a response without disable_signup', async () => {
      const { fetch } = settingsFetch(() => Promise.resolve(jsonResponse({})));
      const check = byName(await runDoctor(deps({ fetch })), 'signup');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('unexpected');
    });

    it('fails with the status on a non-2xx response', async () => {
      const { fetch } = settingsFetch(() => Promise.resolve(new Response('no', { status: 500 })));
      const check = byName(await runDoctor(deps({ fetch })), 'signup');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('500');
    });

    it('fails as unreachable on a network error', async () => {
      const { fetch } = settingsFetch(() =>
        Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })),
      );
      const check = byName(await runDoctor(deps({ fetch })), 'signup');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('unreachable');
    });

    it('fails with "timeout" when the settings request times out', async () => {
      const { fetch } = settingsFetch(() =>
        Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
      );
      const check = byName(await runDoctor(deps({ fetch })), 'signup');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('timeout');
    });

    it('reports a rejected key on 401', async () => {
      const { fetch } = settingsFetch(() =>
        Promise.resolve(jsonResponse({ message: 'Invalid API key' }, 401)),
      );
      const check = byName(await runDoctor(deps({ fetch })), 'signup');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('key rejected');
    });

    it('is skipped without calling fetch when supabase-env failed', async () => {
      const { fetch, mock } = okFetch();
      const results = await runDoctor(deps({ fetch, env: { MM_MASTER_KEY: generateMasterKey() } }));
      const check = byName(results, 'signup');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('skipped');
      expect(callsTo(mock, SETTINGS_PATH)).toHaveLength(0);
    });
  });

  describe('session check', () => {
    it('warns "not checked" when no session function is given', async () => {
      const { fetch } = okFetch();
      const results = await runDoctor(depsWithoutSession({ fetch }));
      const check = byName(results, 'session');
      expect(check.status).toBe('warn');
      expect(check.detail).toContain('not checked');
      expect(hasFailures(results)).toBe(false);
    });

    it('warns "skipped" and does not call session when supabase-env failed', async () => {
      const { fetch } = okFetch();
      const session = vi.fn(loggedIn);
      const results = await runDoctor(deps({ fetch, env: {}, session }));
      const check = byName(results, 'session');
      expect(check.status).toBe('warn');
      expect(check.detail).toMatch(/skipped/i);
      expect(session).not.toHaveBeenCalled();
    });

    it('is ok and names the user when logged in', async () => {
      const { fetch } = okFetch();
      const session = vi.fn(loggedIn);
      const results = await runDoctor(deps({ fetch, session }));
      const check = byName(results, 'session');
      expect(check.status).toBe('ok');
      expect(check.detail).toContain('a@x.sk');
      expect(session).toHaveBeenCalledTimes(1);
    });

    it('warns with an mm login hint when not logged in', async () => {
      const { fetch } = okFetch();
      const results = await runDoctor(deps({ fetch, session: () => Promise.resolve(null) }));
      const check = byName(results, 'session');
      expect(check.status).toBe('warn');
      expect(check.detail).toContain('mm login');
      expect(hasFailures(results)).toBe(false);
    });

    it('warns (and doctor does not throw) when the session check rejects', async () => {
      const { fetch } = okFetch();
      const results = await runDoctor(
        deps({ fetch, session: () => Promise.reject(new Error('boom')) }),
      );
      const check = byName(results, 'session');
      expect(check.status).toBe('warn');
      expect(results).toHaveLength(7);
      expect(hasFailures(results)).toBe(false);
    });

    it('says Supabase is unreachable (not "not logged in") on a network failure', async () => {
      const { fetch } = okFetch();
      const results = await runDoctor(
        deps({
          fetch,
          session: () => Promise.reject(new AuthError('unreachable', 'Supabase unreachable')),
        }),
      );
      const check = byName(results, 'session');
      expect(check.status).toBe('warn');
      expect(check.detail).toContain('unreachable');
      expect(check.detail).not.toContain('mm login');
    });
  });

  it('never includes the publishable key or master key in any detail', async () => {
    const masterKey = generateMasterKey();
    const scenarios: Array<{ env: EnvSource; fetch: typeof globalThis.fetch }> = [
      { env: validEnv({ MM_MASTER_KEY: masterKey }), fetch: okFetch().fetch },
      { env: validEnv({ MM_MASTER_KEY: 'LEAKMASTERKEY!!' }), fetch: okFetch().fetch },
      {
        env: validEnv({ MM_MASTER_KEY: masterKey }),
        fetch: makeFetch(() => Promise.resolve(jsonResponse({ message: 'no' }, 401))).fetch,
      },
      {
        env: validEnv({ MM_MASTER_KEY: masterKey }),
        fetch: makeFetch(() => Promise.resolve(new Response('x', { status: 500 }))).fetch,
      },
      {
        env: { SUPABASE_URL: 'http://x.example', SUPABASE_PUBLISHABLE_KEY: KEY_OK },
        fetch: okFetch().fetch,
      },
      {
        env: validEnv({ MM_MASTER_KEY: masterKey }),
        fetch: dbFetch(() => Promise.resolve(jsonResponse([], 200))).fetch,
      },
      {
        env: validEnv({ MM_MASTER_KEY: masterKey }),
        fetch: dbFetch(() => Promise.resolve(jsonResponse({ code: 'PGRST205' }, 404))).fetch,
      },
    ];
    for (const s of scenarios) {
      const results = await runDoctor(deps(s));
      for (const r of results) {
        expect(r.detail).not.toContain(KEY_OK);
        expect(r.detail).not.toContain(masterKey);
        expect(r.detail).not.toContain('LEAKMASTERKEY');
      }
    }
  });
});

describe('hasFailures', () => {
  const mk = (status: CheckResult['status']): CheckResult => ({ name: 'x', status, detail: '' });

  it('is false for an empty list', () => {
    expect(hasFailures([])).toBe(false);
  });

  it('is false when all ok or warn', () => {
    expect(hasFailures([mk('ok'), mk('warn'), mk('ok')])).toBe(false);
  });

  it('is true when any check failed', () => {
    expect(hasFailures([mk('ok'), mk('warn'), mk('fail')])).toBe(true);
  });
});
