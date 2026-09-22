import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseEnv } from '../../config.js';
import type { SessionStorage } from './session-storage.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

export interface ClientOptions {
  /** Per-request timeout for every Supabase call (auth and REST). */
  timeoutMs?: number;
  /** Underlying fetch (tests inject a fake). */
  fetch?: typeof globalThis.fetch;
}

/** supabase-js has no request timeout: without this a paused project makes the CLI hang. */
export function fetchWithTimeout(
  timeoutMs: number,
  base: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}

export function createSupabase(
  cfg: SupabaseEnv,
  storage: SessionStorage,
  opts: ClientOptions = {},
): SupabaseClient {
  // No generated DB types: rows are validated with zod in the repos instead.
  return createClient<unknown>(cfg.url, cfg.publishableKey, {
    auth: {
      storage,
      persistSession: true,
      // The CLI is short-lived: getSession() refreshes on demand; no background timers.
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchWithTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.fetch) },
    // postgrest-js retries idempotent reads 3× with 1/2/4 s backoff, turning one timeout
    // into ~4× the budget plus 7 s. A CLI should fail fast; the user can simply re-run.
    db: { retry: false },
  });
}
