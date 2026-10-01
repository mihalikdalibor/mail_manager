import { describe, it, expect, vi } from 'vitest';
import { hasFailures, runDoctor } from '../../src/core/doctor.js';
import type { CheckResult, DoctorDeps } from '../../src/core/doctor.js';
import { generateMasterKey } from '../../src/core/master-key.js';

// M1b-4d: the doctor 'database' check probes mail_accounts, then audit_log, as anon.

const URL_OK = 'https://abcdefghijklmnop.supabase.co';
const KEY_OK = 'sb_publishable_TESTKEY123';
const HEALTH_PATH = '/auth/v1/health';
const SETTINGS_PATH = '/auth/v1/settings';
const ACCOUNTS_PATH = '/rest/v1/mail_accounts';
const AUDIT_PATH = '/rest/v1/audit_log';
const OK_DETAIL = 'mail_accounts and audit_log present, anon blocked';

type FetchArgs = [input: string | URL | Request, init?: RequestInit];
type FetchImpl = (...args: FetchArgs) => Promise<Response>;

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

const settingsInviteOnly: FetchImpl = () =>
  Promise.resolve(jsonResponse({ disable_signup: true, external: { email: true } }));

function blocked(table: string, status = 401): FetchImpl {
  return () =>
    Promise.resolve(
      jsonResponse({ code: '42501', message: `permission denied for table ${table}` }, status),
    );
}

const missing: FetchImpl = () =>
  Promise.resolve(
    jsonResponse({ code: 'PGRST205', message: "Could not find the table 'public.x'" }, 404),
  );

const anonCanRead: FetchImpl = () => Promise.resolve(jsonResponse([], 200));

const networkError: FetchImpl = () =>
  Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));

const timeoutError: FetchImpl = () =>
  Promise.reject(
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
  );

/** Routes by pathname; anything else is an unexpected request. */
function routedFetch(routes: { accounts?: FetchImpl; audit?: FetchImpl } = {}) {
  const accounts = routes.accounts ?? blocked('mail_accounts');
  const audit = routes.audit ?? blocked('audit_log');
  const mock = vi.fn<FetchImpl>((input, init) => {
    const path = pathOf(input);
    if (path === HEALTH_PATH) return healthOk(input, init);
    if (path === SETTINGS_PATH) return settingsInviteOnly(input, init);
    if (path === ACCOUNTS_PATH) return accounts(input, init);
    if (path === AUDIT_PATH) return audit(input, init);
    return Promise.reject(new Error(`unexpected fetch to ${path}`));
  });
  return { mock, fetch: mock as unknown as typeof globalThis.fetch };
}

type Mock = ReturnType<typeof routedFetch>['mock'];

function callsTo(mock: Mock, path: string): FetchArgs[] {
  return mock.mock.calls.filter(([input]) => pathOf(input) === path);
}

function callIndex(mock: Mock, path: string): number {
  return mock.mock.calls.findIndex(([input]) => pathOf(input) === path);
}

function deps(fetch: typeof globalThis.fetch, env?: DoctorDeps['env']): DoctorDeps {
  return {
    env: env ?? {
      SUPABASE_URL: URL_OK,
      SUPABASE_PUBLISHABLE_KEY: KEY_OK,
      MM_MASTER_KEY: generateMasterKey(),
    },
    nodeVersion: '22.22.1',
    timeoutMs: 5000,
    fetch,
    session: () => Promise.resolve({ email: 'a@x.sk' }),
  };
}

function database(results: CheckResult[]): CheckResult {
  const found = results.find((r) => r.name === 'database');
  if (!found) throw new Error('no database check');
  return found;
}

async function run(routes: Parameters<typeof routedFetch>[0] = {}) {
  const { fetch, mock } = routedFetch(routes);
  const results = await runDoctor(deps(fetch));
  return { results, check: database(results), mock };
}

describe('doctor database check with audit_log', () => {
  it('is ok when anon is blocked on both tables, probing mail_accounts first', async () => {
    const { results, check, mock } = await run();
    expect(check.status).toBe('ok');
    expect(check.detail).toBe(OK_DETAIL);
    expect(callsTo(mock, ACCOUNTS_PATH)).toHaveLength(1);
    expect(callsTo(mock, AUDIT_PATH)).toHaveLength(1);
    expect(callIndex(mock, ACCOUNTS_PATH)).toBeLessThan(callIndex(mock, AUDIT_PATH));
    expect(mock).toHaveBeenCalledTimes(4);
    expect(hasFailures(results)).toBe(false);
  });

  it.each([ACCOUNTS_PATH, AUDIT_PATH])(
    'probes %s with select=id&limit=1, the apikey, manual redirect and a signal',
    async (path) => {
      const { mock } = await run();
      const call = callsTo(mock, path)[0];
      if (!call) throw new Error(`${path} not probed`);
      const [input, init] = call;
      const url = new URL(requestUrl(input));
      expect(url.origin).toBe(URL_OK);
      expect(url.searchParams.get('select')).toBe('id');
      expect(url.searchParams.get('limit')).toBe('1');
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBe(KEY_OK);
      expect(headers.has('authorization')).toBe(false);
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it('does not produce a double slash for audit_log with a trailing-slash SUPABASE_URL', async () => {
    const { fetch, mock } = routedFetch();
    await runDoctor(
      deps(fetch, {
        SUPABASE_URL: `${URL_OK}/`,
        SUPABASE_PUBLISHABLE_KEY: KEY_OK,
        MM_MASTER_KEY: generateMasterKey(),
      }),
    );
    const call = callsTo(mock, AUDIT_PATH)[0];
    if (!call) throw new Error('audit_log not probed');
    expect(requestUrl(call[0])).not.toContain('//rest');
  });

  it('is ok with 403 + 42501 on audit_log', async () => {
    const { check } = await run({ audit: blocked('audit_log', 403) });
    expect(check.status).toBe('ok');
    expect(check.detail).toBe(OK_DETAIL);
  });

  describe('audit_log fails while mail_accounts is fine', () => {
    it('missing (404 PGRST205) → fail pointing at db:push', async () => {
      const { results, check } = await run({ audit: missing });
      expect(check.status).toBe('fail');
      expect(check.detail).toBe('audit_log missing — run `npm run db:push`');
      expect(hasFailures(results)).toBe(true);
    });

    it('missing (404 without a body) → fail pointing at db:push', async () => {
      const { check } = await run({
        audit: () => Promise.resolve(new Response(null, { status: 404 })),
      });
      expect(check.status).toBe('fail');
      expect(check.detail).toBe('audit_log missing — run `npm run db:push`');
    });

    it('missing (PGRST205 on another status) → fail pointing at db:push', async () => {
      const { check } = await run({
        audit: () => Promise.resolve(jsonResponse({ code: 'PGRST205', message: 'x' }, 400)),
      });
      expect(check.status).toBe('fail');
      expect(check.detail).toBe('audit_log missing — run `npm run db:push`');
    });

    it('anon gets 200 → fail naming audit_log (security problem)', async () => {
      const { check } = await run({ audit: anonCanRead });
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('audit_log');
      expect(check.detail).toContain('anon can read');
      expect(check.detail).not.toContain('mail_accounts');
    });

    it('anon gets 206 → fail (any 2xx)', async () => {
      const { check } = await run({ audit: () => Promise.resolve(jsonResponse([], 206)) });
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('anon can read');
    });

    it.each([
      [
        '401 without 42501',
        () => Promise.resolve(jsonResponse({ message: 'Invalid API key' }, 401)),
      ],
      ['403 with another code', () => Promise.resolve(jsonResponse({ code: 'PGRST301' }, 403))],
      ['500', () => Promise.resolve(new Response('boom', { status: 500 }))],
      [
        'a redirect',
        () =>
          Promise.resolve(
            new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
          ),
      ],
      ['a network error', networkError],
      ['a timeout', timeoutError],
    ] as Array<[string, FetchImpl]>)('%s → fail', async (_label, audit) => {
      const { check, mock } = await run({ audit });
      expect(check.status).toBe('fail');
      expect(check.detail).not.toBe(OK_DETAIL);
      expect(check.detail).not.toContain(KEY_OK);
      for (const [input] of mock.mock.calls) expect(requestUrl(input)).not.toContain('evil');
    });
  });

  describe('mail_accounts fails first', () => {
    it('missing → fail naming mail_accounts, not audit_log', async () => {
      const { check } = await run({ accounts: missing });
      expect(check.status).toBe('fail');
      expect(check.detail).toBe('mail_accounts missing — run `npm run db:push`');
    });

    it('anon can read → fail naming mail_accounts, not audit_log', async () => {
      const { check } = await run({ accounts: anonCanRead });
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('mail_accounts');
      expect(check.detail).toContain('anon can read');
      expect(check.detail).not.toContain('audit_log');
    });

    it('both missing → reports mail_accounts', async () => {
      const { check } = await run({ accounts: missing, audit: missing });
      expect(check.status).toBe('fail');
      expect(check.detail).toBe('mail_accounts missing — run `npm run db:push`');
    });

    it.each([
      ['network error', networkError, /unreachable/i],
      ['timeout', timeoutError, /timeout/i],
    ] as Array<[string, FetchImpl, RegExp]>)(
      'on a %s the audit_log probe is not made',
      async (_label, accounts, pattern) => {
        const { check, mock } = await run({ accounts });
        expect(check.status).toBe('fail');
        expect(check.detail).toMatch(pattern);
        expect(callsTo(mock, ACCOUNTS_PATH)).toHaveLength(1);
        expect(callsTo(mock, AUDIT_PATH)).toHaveLength(0);
      },
    );
  });

  it('probes neither table when supabase-env failed', async () => {
    const { fetch, mock } = routedFetch();
    const results = await runDoctor(deps(fetch, {}));
    expect(database(results).status).toBe('fail');
    expect(callsTo(mock, ACCOUNTS_PATH)).toHaveLength(0);
    expect(callsTo(mock, AUDIT_PATH)).toHaveLength(0);
  });

  it('never puts the publishable key into the detail', async () => {
    for (const audit of [anonCanRead, missing, networkError, blocked('audit_log')]) {
      const { check } = await run({ audit });
      expect(check.detail).not.toContain(KEY_OK);
    }
  });
});

describe('doctor database check: unexpected status (round 2)', () => {
  const status500: FetchImpl = () => Promise.resolve(new Response('boom', { status: 500 }));

  it('names audit_log and the status', async () => {
    const { check } = await run({ audit: status500 });
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('500');
    expect(check.detail).toContain('audit_log');
  });

  it('names mail_accounts and the status', async () => {
    const { check } = await run({ accounts: status500 });
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('500');
    expect(check.detail).toContain('mail_accounts');
  });
});
