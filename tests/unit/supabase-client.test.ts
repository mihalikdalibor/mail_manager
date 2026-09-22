import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '../../src/core/auth.js';
import { RepoError } from '../../src/core/db/repos.js';
import { fetchWithTimeout } from '../../src/core/db/supabase/client.js';
import { isUnreachable } from '../../src/core/db/supabase/auth-service.js';
import { createSupabaseServices, MemorySessionStorage } from '../../src/core/db/supabase/index.js';

const ENV = {
  SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_TESTKEY123',
};

/** A server that never answers: resolves only by rejecting when the request is aborted. */
function hangingFetch() {
  return vi.fn<typeof globalThis.fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // would hang forever — the test times out and fails
        signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
      }),
  );
}

function seededStorage(expiresInSeconds = 3600): MemorySessionStorage {
  // A stored, unexpired session: getSession() returns it without a network call,
  // so currentUser() must reach getUser() — which then hangs.
  const storage = new MemorySessionStorage();
  const now = Math.floor(Date.now() / 1000);
  storage.setItem(
    'sb-abcdefghijklmnop-auth-token',
    JSON.stringify({
      access_token: 'fake-access',
      refresh_token: 'fake-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: now + expiresInSeconds,
      user: {
        id: 'u1',
        email: 'a@x.sk',
        aud: 'authenticated',
        app_metadata: {},
        user_metadata: {},
      },
    }),
  );
  return storage;
}

describe('fetchWithTimeout', () => {
  it('aborts a request that exceeds the timeout with a TimeoutError', async () => {
    const base = hangingFetch();
    const start = Date.now();
    await expect(fetchWithTimeout(20, base)('https://x.example/')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("still honours the caller's own abort signal", async () => {
    const base = hangingFetch();
    const controller = new AbortController();
    const pending = fetchWithTimeout(10_000, base)('https://x.example/', {
      signal: controller.signal,
    });
    controller.abort(new Error('caller aborted'));
    await expect(pending).rejects.toThrow('caller aborted');
  });

  it("keeps a Request object's own signal when no init.signal is given", async () => {
    const base = hangingFetch();
    const controller = new AbortController();
    const request = new Request('https://x.example/', { signal: controller.signal });
    const pending = fetchWithTimeout(10_000, base)(request);
    controller.abort(new Error('request aborted'));
    await expect(pending).rejects.toThrow('request aborted');
  });

  it('passes requests through when they finish in time', async () => {
    const base = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response('ok')));
    const res = await fetchWithTimeout(1000, base)('https://x.example/', { method: 'POST' });
    expect(await res.text()).toBe('ok');
    expect(base.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(base.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('Supabase services time out instead of hanging', () => {
  it('login rejects with AuthError(unreachable)', async () => {
    const services = createSupabaseServices(ENV, new MemorySessionStorage(), {
      timeoutMs: 20,
      fetch: hangingFetch(),
    });
    const err: unknown = await services.auth.login('a@x.sk', 'pw').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('unreachable');
  });

  it('currentUser rejects with AuthError(unreachable) when the auth server hangs', async () => {
    const fetch = hangingFetch();
    const services = createSupabaseServices(ENV, seededStorage(), { timeoutMs: 20, fetch });
    await expect(services.auth.currentUser()).rejects.toMatchObject({
      name: 'AuthError',
      code: 'unreachable',
    });
    expect(fetch).toHaveBeenCalled();
  });

  // auth-js retries a token refresh with backoff for ~30 s; the whole operation must still
  // respect the budget.
  it('currentUser gives up within the budget when an expired session needs a refresh', async () => {
    const fetch = hangingFetch();
    const services = createSupabaseServices(ENV, seededStorage(-100), { timeoutMs: 50, fetch });
    const start = Date.now();
    await expect(services.auth.currentUser()).rejects.toMatchObject({ code: 'unreachable' });
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('login gives up within the budget while an expired stored session is refreshing', async () => {
    const services = createSupabaseServices(ENV, seededStorage(-100), {
      timeoutMs: 50,
      fetch: hangingFetch(),
    });
    const start = Date.now();
    await expect(services.auth.login('a@x.sk', 'pw')).rejects.toMatchObject({
      code: 'unreachable',
    });
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('logout still clears the local session when the server hangs', async () => {
    const storage = seededStorage(-100);
    const services = createSupabaseServices(ENV, storage, { timeoutMs: 50, fetch: hangingFetch() });
    await services.auth.logout();
    expect(storage.getItem('sb-abcdefghijklmnop-auth-token')).toBeNull();
  });

  it('repository calls reject with RepoError(unavailable)', async () => {
    const services = createSupabaseServices(ENV, new MemorySessionStorage(), {
      timeoutMs: 20,
      fetch: hangingFetch(),
    });
    const err: unknown = await services.accounts.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoError);
    expect((err as RepoError).code).toBe('unavailable');
  });
});

describe('isUnreachable', () => {
  it.each([
    ['fetch failed TypeError', new TypeError('fetch failed')],
    ['TypeError with a network cause', new TypeError('boom', { cause: { code: 'ECONNREFUSED' } })],
    ['timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    ['status 0 auth error', { status: 0 }],
  ])('treats %s as unreachable', (_label, err) => {
    expect(isUnreachable(err)).toBe(true);
  });

  it.each([
    ['programming TypeError', new TypeError('x is not a function')],
    ['TypeError with a non-network cause', new TypeError('bad', { cause: { code: 'EACCES' } })],
    ['plain Error', new Error('corrupt session')],
    ['400 auth error', { status: 400 }],
    ['null', null],
  ])('does not treat %s as unreachable', (_label, err) => {
    expect(isUnreachable(err)).toBe(false);
  });
});
