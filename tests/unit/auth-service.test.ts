import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, vi } from 'vitest';
import { AuthError } from '../../src/core/auth.js';
import { SupabaseAuthService, toAuthError } from '../../src/core/db/supabase/auth-service.js';
import { MemorySessionStorage } from '../../src/core/db/supabase/session-storage.js';

const PASSWORD = 'hunter2-ÄŠť';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;

function fakeClient() {
  const auth = {
    signInWithPassword: vi.fn<AsyncFn>(),
    signOut: vi.fn<AsyncFn>(),
    getSession: vi.fn<AsyncFn>(),
    getUser: vi.fn<AsyncFn>(),
  };
  const client = { auth } as unknown as SupabaseClient;
  return { auth, client };
}

function setup() {
  const { auth, client } = fakeClient();
  const storage = new MemorySessionStorage();
  const clear = vi.spyOn(storage, 'clear');
  const service = new SupabaseAuthService(client, storage);
  return { auth, storage, clear, service };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected promise to reject');
}

describe('toAuthError', () => {
  it('maps invalid_credentials', () => {
    const err = toAuthError({ code: 'invalid_credentials', status: 400, message: 'x' });
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('invalid_credentials');
    expect(err.message).toBe('Invalid email or password');
  });

  it('maps status 0 to unreachable', () => {
    const err = toAuthError({ status: 0, message: 'fetch failed' });
    expect(err.code).toBe('unreachable');
    expect(err.message).toBe('Supabase unreachable');
  });

  it.each([
    ['other code', { code: 'over_request_rate_limit', status: 429 }],
    ['plain Error', new Error('boom')],
    ['string', 'boom'],
    ['null', null],
    ['undefined', undefined],
  ])('maps %s to unknown', (_label, input) => {
    const err = toAuthError(input);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('unknown');
  });
});

describe('SupabaseAuthService.login', () => {
  it('signs in with email + password and returns the user', async () => {
    const { auth, service } = setup();
    auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'u1', email: 'a@x.sk' }, session: { access_token: 'fake' } },
      error: null,
    });
    await expect(service.login('a@x.sk', PASSWORD)).resolves.toEqual({
      email: 'a@x.sk',
      userId: 'u1',
    });
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'a@x.sk', password: PASSWORD });
  });

  it('rejects with AuthError(invalid_credentials) on bad credentials, without the password', async () => {
    const { auth, service } = setup();
    auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
    });
    const err = await rejection(service.login('a@x.sk', PASSWORD));
    expect(err).toBeInstanceOf(AuthError);
    const authErr = err as AuthError;
    expect(authErr.code).toBe('invalid_credentials');
    expect(authErr.message).not.toContain(PASSWORD);
    expect(String(authErr.stack)).not.toContain(PASSWORD);
  });

  it('wraps a thrown error from signInWithPassword in AuthError', async () => {
    const { auth, service } = setup();
    auth.signInWithPassword.mockRejectedValue(new TypeError('fetch failed'));
    const err = await rejection(service.login('a@x.sk', PASSWORD));
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).message).not.toContain(PASSWORD);
  });

  it('maps a status-0 error result to unreachable', async () => {
    const { auth, service } = setup();
    auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 0, message: 'fetch failed' },
    });
    const err = await rejection(service.login('a@x.sk', PASSWORD));
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('unreachable');
  });
});

describe('SupabaseAuthService.logout', () => {
  it('signs out locally and clears storage', async () => {
    const { auth, clear, service, storage } = setup();
    storage.setItem('sb-auth-token', 'fake');
    auth.signOut.mockResolvedValue({ error: null });
    await service.logout();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(clear).toHaveBeenCalled();
    expect(storage.getItem('sb-auth-token')).toBeNull();
  });

  it('still clears storage when signOut resolves with an error', async () => {
    const { auth, clear, service } = setup();
    auth.signOut.mockResolvedValue({ error: { status: 0, message: 'fetch failed' } });
    await expect(service.logout()).resolves.toBeUndefined();
    expect(clear).toHaveBeenCalled();
  });

  it('still clears storage and does not throw when signOut rejects (offline)', async () => {
    const { auth, clear, service, storage } = setup();
    storage.setItem('sb-auth-token', 'fake');
    auth.signOut.mockRejectedValue(new TypeError('fetch failed'));
    await expect(service.logout()).resolves.toBeUndefined();
    expect(clear).toHaveBeenCalled();
    expect(storage.getItem('sb-auth-token')).toBeNull();
  });

  it('clears storage after calling signOut', async () => {
    const { auth, clear, service } = setup();
    auth.signOut.mockResolvedValue({ error: null });
    await service.logout();
    const signOutOrder = auth.signOut.mock.invocationCallOrder[0] ?? Infinity;
    const clearOrder = clear.mock.invocationCallOrder.at(-1) ?? -Infinity;
    expect(signOutOrder).toBeLessThan(clearOrder);
  });
});

describe('SupabaseAuthService.currentUser', () => {
  it('returns null without a session', async () => {
    const { auth, service } = setup();
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(service.currentUser()).resolves.toBeNull();
  });

  it('returns the verified user when a session exists', async () => {
    const { auth, service } = setup();
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'fake', user: { id: 'u1', email: 'a@x.sk' } } },
      error: null,
    });
    auth.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@x.sk' } }, error: null });
    await expect(service.currentUser()).resolves.toEqual({ email: 'a@x.sk', userId: 'u1' });
    expect(auth.getUser).toHaveBeenCalled();
  });

  it('returns null when getUser returns an error', async () => {
    const { auth, service } = setup();
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'fake', user: { id: 'u1', email: 'a@x.sk' } } },
      error: null,
    });
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { status: 401, message: 'invalid JWT' },
    });
    await expect(service.currentUser()).resolves.toBeNull();
  });

  it('returns null when getSession returns a non-network error (invalid session)', async () => {
    const { auth, service } = setup();
    auth.getSession.mockResolvedValue({
      data: { session: null },
      error: { status: 400, message: 'invalid refresh token' },
    });
    await expect(service.currentUser()).resolves.toBeNull();
  });

  // Network failures are not "logged out": the user must not be told to log in again.
  it('rejects with AuthError(unreachable) when getSession fails on the network (status 0)', async () => {
    const { auth, service } = setup();
    auth.getSession.mockResolvedValue({
      data: { session: null },
      error: { status: 0, message: 'x' },
    });
    await expect(service.currentUser()).rejects.toMatchObject({
      name: 'AuthError',
      code: 'unreachable',
    });
  });

  it('rejects with AuthError(unreachable) when getSession throws a fetch error', async () => {
    const { auth, service } = setup();
    auth.getSession.mockRejectedValue(new TypeError('fetch failed'));
    await expect(service.currentUser()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('rejects with AuthError(unreachable) when getUser throws a fetch error', async () => {
    const { auth, service } = setup();
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'fake', user: { id: 'u1', email: 'a@x.sk' } } },
      error: null,
    });
    auth.getUser.mockRejectedValue(new TypeError('fetch failed'));
    await expect(service.currentUser()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('returns null when getSession throws a non-network error', async () => {
    const { auth, service } = setup();
    auth.getSession.mockRejectedValue(new Error('corrupt session'));
    await expect(service.currentUser()).resolves.toBeNull();
  });
});
