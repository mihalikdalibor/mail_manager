import { inspect } from 'node:util';
import { z } from 'zod';
import { guardedOpenSession } from '../../../src/core/imap/guarded-session.js';
import type { ImapSession } from '../../../src/core/imap/session.js';
import {
  defaultDiscoveryDeps,
  discover,
  type DiscoveryDeps,
} from '../../../src/core/providers/discover.js';
import type { ImapSettings } from '../../../src/core/providers/settings.js';
import { MemoryAttemptStore } from '../../../src/core/security/attempt-store.js';
import { guardTargetKey } from '../../../src/core/security/events.js';
import { LoginGuard } from '../../../src/core/security/login-guard.js';
import { TestGroundError } from './errors.js';

// The dedicated test mailbox for live tests and the seed/unseed scripts. The values come from
// env (.env.local) and are never printed: this object hides them from inspect and JSON.

export interface LiveImapEnv {
  readonly address: string;
  readonly password: string;
  readonly fallbackHost: string | null;
}

const envSchema = z.object({
  MM_TEST_IMAP_USER: z.string().optional(),
  MM_TEST_IMAP_PASS: z.string().optional(),
  MM_TEST_IMAP_HOST: z.string().optional(),
});

class HiddenLiveImapEnv implements LiveImapEnv {
  readonly #address: string;
  readonly #password: string;
  readonly #fallbackHost: string | null;

  constructor(address: string, password: string, fallbackHost: string | null) {
    this.#address = address;
    this.#password = password;
    this.#fallbackHost = fallbackHost;
  }

  get address(): string {
    return this.#address;
  }

  get password(): string {
    return this.#password;
  }

  get fallbackHost(): string | null {
    return this.#fallbackHost;
  }

  toJSON(): Record<string, string> {
    return { address: '<hidden>', password: '<hidden>' };
  }

  [inspect.custom](): string {
    return 'LiveImapEnv { address: <hidden>, password: <hidden> }';
  }
}

/** null when the test mailbox isn't configured (live tests skip, scripts explain). */
export function readLiveImapEnv(
  env: Record<string, string | undefined> = process.env,
): LiveImapEnv | null {
  const parsed = envSchema.parse(env);
  const address = parsed.MM_TEST_IMAP_USER?.trim() ?? '';
  // The password is used exactly as written (never trimmed).
  const password = parsed.MM_TEST_IMAP_PASS ?? '';
  if (address === '' || password === '') return null;
  const host = parsed.MM_TEST_IMAP_HOST?.trim() ?? '';
  return new HiddenLiveImapEnv(address, password, host === '' ? null : host);
}

/** Real DNS, no HTTP: the domain is never sent to ISPDB/autoconfig. */
export function liveDiscoveryDeps(): DiscoveryDeps {
  return {
    ...defaultDiscoveryDeps(5000),
    fetch: () => Promise.reject(new Error('no HTTP in the test ground')),
  };
}

/** Host via discovery, else MM_TEST_IMAP_HOST. `deps` is for unit tests. */
export async function resolveLiveSettings(
  address: string,
  fallbackHost: string | null,
  deps: DiscoveryDeps = liveDiscoveryDeps(),
): Promise<ImapSettings> {
  const result = await discover(address, deps);
  if (result.status === 'found') return result.imap;
  if (result.status === 'blocked') {
    throw new TestGroundError(
      "The test mailbox's provider doesn't allow password (IMAP) login; use a different test mailbox.",
    );
  }
  if (fallbackHost !== null) return { host: fallbackHost, port: 993, username: address };
  throw new TestGroundError(
    'Discovery found no IMAP host for the test mailbox; set MM_TEST_IMAP_HOST in .env.local.',
  );
}

/** One login through the login guard (in-memory: counters live for this run only). */
export function openTestSession(settings: ImapSettings, password: string): Promise<ImapSession> {
  return guardedOpenSession({
    settings,
    password,
    clientVersion: 'test-ground',
    guard: new LoginGuard({
      store: new MemoryAttemptStore(),
      targetKey: guardTargetKey(undefined),
    }),
    clientIp: 'local',
    onChallenge: () => Promise.resolve(),
    // The test ground logs nothing; the preset id isn't threaded through its settings.
    provider: 'custom',
  });
}
