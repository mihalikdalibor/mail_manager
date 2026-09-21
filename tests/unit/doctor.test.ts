import { describe, it, expect, vi } from 'vitest';
import { hasFailures, runDoctor } from '../../src/core/doctor.js';
import type { CheckResult, DoctorDeps } from '../../src/core/doctor.js';
import type { EnvSource } from '../../src/core/config.js';
import { generateMasterKey } from '../../src/core/master-key.js';

const URL_OK = 'https://abcdefghijklmnop.supabase.co';
const KEY_OK = 'sb_publishable_TESTKEY123';
const HEALTH_URL = 'https://abcdefghijklmnop.supabase.co/auth/v1/health';

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

function okFetch() {
  return makeFetch(() => Promise.resolve(jsonResponse({ version: 'v2.197.0', name: 'GoTrue' })));
}

function validEnv(extra: EnvSource = {}): EnvSource {
  return {
    SUPABASE_URL: URL_OK,
    SUPABASE_PUBLISHABLE_KEY: KEY_OK,
    MM_MASTER_KEY: generateMasterKey(),
    ...extra,
  };
}

function deps(overrides: Partial<DoctorDeps> & Pick<DoctorDeps, 'fetch'>): DoctorDeps {
  return { env: validEnv(), nodeVersion: '22.22.1', timeoutMs: 5000, ...overrides };
}

function byName(results: CheckResult[], name: string): CheckResult {
  const found = results.find((r) => r.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return new URL(input).href;
  if (input instanceof URL) return input.href;
  return new URL(input.url).href;
}

function firstCall(mock: ReturnType<typeof makeFetch>['mock']): FetchArgs {
  const call = mock.mock.calls[0];
  if (!call) throw new Error('fetch was not called');
  return call;
}

describe('runDoctor', () => {
  it('returns exactly 4 checks in order and all ok on the happy path', async () => {
    const { fetch, mock } = okFetch();
    const results = await runDoctor(deps({ fetch }));
    expect(results.map((r) => r.name)).toEqual([
      'node',
      'supabase-env',
      'master-key',
      'supabase-api',
    ]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(byName(results, 'supabase-api').detail).toContain('v2.197.0');
    expect(hasFailures(results)).toBe(false);
    for (const r of results) expect(typeof r.detail).toBe('string');
  });

  describe('node check', () => {
    it.each([
      ['22.22.1', 'ok'],
      ['22.12.0', 'ok'],
      ['24.0.0', 'ok'],
      ['22.11.0', 'fail'],
      ['20.19.0', 'fail'],
      ['22.12.0-rc.1', 'fail'],
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
      expect(mock).toHaveBeenCalledTimes(1);
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
      expect(results).toHaveLength(4);
    });

    it.each([
      ['without trailing slash', URL_OK],
      ['with trailing slash', `${URL_OK}/`],
    ])('calls the health endpoint %s with apikey header and a signal', async (_label, url) => {
      const { fetch, mock } = okFetch();
      await runDoctor(deps({ fetch, env: validEnv({ SUPABASE_URL: url }) }));
      expect(mock).toHaveBeenCalledTimes(1);
      const [input, init] = firstCall(mock);
      const href = requestUrl(input);
      expect(href).toBe(HEALTH_URL);
      expect(href).not.toContain('//auth');
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBe(KEY_OK);
      expect(headers.has('authorization')).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('is ok on 200 without a version in the body', async () => {
      const { fetch } = makeFetch(() => Promise.resolve(new Response('OK', { status: 200 })));
      const results = await runDoctor(deps({ fetch }));
      expect(byName(results, 'supabase-api').status).toBe('ok');
    });

    it.each([401, 403])('fails with "rejected" on %d', async (status) => {
      const { fetch } = makeFetch(() =>
        Promise.resolve(jsonResponse({ message: 'Invalid API key' }, status)),
      );
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'supabase-api');
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/rejected/i);
    });

    it('fails with the status number on other non-2xx', async () => {
      const { fetch } = makeFetch(() => Promise.resolve(new Response('boom', { status: 500 })));
      const results = await runDoctor(deps({ fetch }));
      const check = byName(results, 'supabase-api');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('500');
    });

    it('does not follow redirects (the apikey header must not reach another origin)', async () => {
      const { mock, fetch } = okFetch();
      await runDoctor(deps({ fetch }));
      const [, init] = firstCall(mock);
      expect(init?.redirect).toBe('manual');
    });

    it('fails on a redirect response', async () => {
      const { fetch } = makeFetch(() =>
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
      const { fetch } = makeFetch(() => {
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
      const { fetch } = makeFetch(() =>
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
      const { fetch } = makeFetch(
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
