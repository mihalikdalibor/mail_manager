import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addAccount,
  createLocalGuard,
  removeAccount,
  testAccount,
  updatePassword,
  type AccountDeps,
} from '../../src/core/accounts.js';
import { createLocalCredentialProvider } from '../../src/core/credentials.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import {
  createSupabaseServices,
  MemorySessionStorage,
  type SupabaseServices,
} from '../../src/core/db/supabase/index.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import { validateMasterKeyEnv } from '../../src/core/config.js';
import type { ImapSettings } from '../../src/core/providers/settings.js';
import { readLiveImapEnv, resolveLiveSettings } from '../support/test-ground/live-env.js';

// M1c-1: the account flow end to end — real Supabase (test user A) + the real test mailbox,
// through the core functions the CLI uses. The address, host and password come from env and
// are never printed; assertions compare single fields so a failing diff can't show them.
//
// NO wrong-password attempt here: the suite's one per run lives in imap-session.test.ts
// (providers ban IPs after repeated failures). "A wrong password saves nothing" is proven with
// a fake opener in tests/unit/accounts.test.ts. Three successful logins per run; never loop it.

const env = process.env;
const SUPABASE = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'MM_MASTER_KEY',
  'MM_TEST_SUPABASE_A_EMAIL',
  'MM_TEST_SUPABASE_A_PASSWORD',
] as const;
const live = readLiveImapEnv();
const enabled = live !== null && SUPABASE.every((name) => (env[name] ?? '').trim() !== '');

describe.skipIf(!enabled)('account commands (live Supabase + test mailbox)', () => {
  const runId = randomBytes(8).toString('hex');
  const log = new MemoryEventLog({
    run: runId,
    ver: 'integration-test',
    now: Date.now,
    level: 'debug',
  });
  const captured: string[] = [];
  let services: SupabaseServices;
  let userId: string;
  let settings: ImapSettings;
  let deps: AccountDeps;
  let added: MailAccount | undefined;

  async function leftovers(): Promise<MailAccount[]> {
    if (live === null) return [];
    const host = settings.host.toLowerCase();
    return (await services.accounts.findByEmail(live.address)).filter(
      (a) => a.host.toLowerCase() === host,
    );
  }

  beforeAll(async () => {
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => inspect(arg, { depth: 10 })).join(' '));
      });
    }
    if (live === null) return;
    services = createSupabaseServices(env, new MemorySessionStorage());
    const user = await services.auth.login(
      env['MM_TEST_SUPABASE_A_EMAIL'] ?? '',
      env['MM_TEST_SUPABASE_A_PASSWORD'] ?? '',
    );
    userId = user.userId;
    settings = await resolveLiveSettings(live.address, live.fallbackHost);
    const masterKey = validateMasterKeyEnv(env);
    deps = {
      repo: services.accounts,
      audit: services.audit,
      log,
      runId,
      credentials: createLocalCredentialProvider(env),
      guard: createLocalGuard(masterKey.ok ? masterKey.value.masterKey : undefined, log),
      clientVersion: 'integration-test',
      onChallenge: () => Promise.resolve(),
    };
    // A run that died half-way may have left the account behind.
    for (const old of await leftovers()) await services.accounts.remove(old.id);
  });

  afterAll(async () => {
    if (enabled) {
      for (const old of await leftovers()) await services.accounts.remove(old.id);
      await services.auth.logout();
    }
    vi.restoreAllMocks();
    if (live === null) return;
    // Checked last so a leak anywhere in the run fails the suite.
    const everything = [...captured, ...log.lines, inspect(added, { depth: 10 })].join('\n');
    expect(everything.includes(live.password)).toBe(false);
    expect(log.lines.join('\n').includes(live.address)).toBe(false);
    expect(log.lines.join('\n').toLowerCase().includes(settings.host.toLowerCase())).toBe(false);
  });

  it('add → list → test → update-password → remove', async () => {
    if (live === null) return;
    added = await addAccount(deps, {
      userId,
      email: live.address,
      settings,
      provider: 'custom',
      password: live.password,
    });
    expect(added.host).toBe(settings.host.toLowerCase());
    expect(added.secret.ciphertext.includes(live.password)).toBe(false);

    expect((await services.accounts.list()).map((a) => a.id)).toContain(added.id);

    const { features } = await testAccount(deps, added);
    expect(features.uidplus).toBe(true);
    expect((await services.accounts.get(added.id))?.lastCheckedAt).toBeInstanceOf(Date);

    const before = (await services.accounts.get(added.id))?.secret.ciphertext;
    await updatePassword(deps, added, live.password);
    const after = await services.accounts.get(added.id);
    expect(after?.secret.ciphertext).not.toBe(before); // re-encrypted (fresh IV)
    if (after === null || after === undefined) throw new Error('account missing');
    expect(deps.credentials.decryptPassword(after) === live.password).toBe(true);

    await removeAccount(deps, added);
    expect(await services.accounts.get(added.id)).toBeNull();
  });

  it("writes exactly this run's audit rows, provider only", async () => {
    const { records } = await services.audit.listRecent(50);
    const rows = records.filter((r) => r.runId === runId).sort((x, y) => x.id - y.id);
    expect(rows.map((r) => `${r.action}:${r.result}`)).toEqual([
      'account.add:ok',
      'account.password-update:ok',
      'account.remove:ok',
    ]);
    for (const row of rows) {
      expect(row.details).toEqual({ provider: 'custom' });
      // The account is gone: set null on delete, and the remove row never had one.
      expect(row.accountId).toBeUndefined();
    }
  });

  it('logged the account and IMAP events (ids and codes only)', () => {
    const events = log.records.map(
      (r) => `${r.event}:${typeof r['outcome'] === 'string' ? r['outcome'] : ''}`,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        'imap.login:',
        'account.add:ok',
        'account.test:ok',
        'account.password-update:ok',
        'account.remove:ok',
      ]),
    );
    expect(log.records.filter((r) => r.event === 'imap.login')).toHaveLength(3);
  });
});
