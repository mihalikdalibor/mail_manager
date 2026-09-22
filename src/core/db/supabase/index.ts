import type { AuthService } from '../../auth.js';
import { validateSupabaseEnv, ConfigError, type EnvSource } from '../../config.js';
import type { AccountsRepo } from '../repos.js';
import { SupabaseAccountsRepo } from './accounts-repo.js';
import { SupabaseAuthService } from './auth-service.js';
import { createSupabase, DEFAULT_TIMEOUT_MS, type ClientOptions } from './client.js';
import type { SessionStorage } from './session-storage.js';

export interface SupabaseServices {
  auth: AuthService;
  accounts: AccountsRepo;
}

/** The only entry point callers use; supabase-js never leaks outside src/core/db/supabase. */
export function createSupabaseServices(
  env: EnvSource,
  storage: SessionStorage,
  opts: ClientOptions = {},
): SupabaseServices {
  const cfg = validateSupabaseEnv(env);
  if (!cfg.ok) throw new ConfigError(cfg.issues);
  const client = createSupabase(cfg.value, storage, opts);
  return {
    auth: new SupabaseAuthService(client, storage, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    accounts: new SupabaseAccountsRepo(client),
  };
}

export { FileSessionStorage, MemorySessionStorage, sessionDir } from './session-storage.js';
export type { SessionStorage } from './session-storage.js';
export { DEFAULT_TIMEOUT_MS, type ClientOptions } from './client.js';
