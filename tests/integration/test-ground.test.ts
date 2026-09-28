import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ImapSession } from '../../src/core/imap/session.js';
import { errorText } from '../support/test-ground/cli.js';
import { FolderGuardError } from '../support/test-ground/errors.js';
import { TestFolder } from '../support/test-ground/folder.js';
import { buildTestGround, type TestGround } from '../support/test-ground/generator.js';
import {
  openTestSession,
  readLiveImapEnv,
  resolveLiveSettings,
} from '../support/test-ground/live-env.js';
import { seedTestGround, type SeedReport } from '../support/test-ground/seed.js';

// The test ground on the dedicated test mailbox: seeds the mm-test folder (the first run
// uploads ~28 MB, later runs nothing), checks that a second seed changes nothing and that the
// server holds exactly the manifest, and that the folder guard refuses other folders — live,
// only with read-only operations (create/remove refusals are unit-tested, never tried here).
// One login, correct password only. Never enable vitest `retry` here.

const live = readLiveImapEnv();
const REFUSED = ['INBOX', 'Trash', 'mm-test/x', 'MM-TEST', 'mm-test2', '*'];

/**
 * Raw imapflow errors carry server text and the sent command; vitest would print them (and any
 * `cause`). Only the user-facing text may reach the output, so the original is deliberately
 * not attached — the same pattern as `throw mapImapError(err)` in src/core/imap/session.ts.
 */
function userFacing(err: unknown): Error {
  return err instanceof FolderGuardError ? err : new Error(errorText(err));
}

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw userFacing(err);
  }
}

describe.skipIf(live === null)('test ground (live)', () => {
  const captured: string[] = [];
  let session: ImapSession | undefined;
  let folder: TestFolder;
  let ground: TestGround;
  let first: SeedReport | undefined;
  let second: SeedReport | undefined;

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
    await mapped(async () => {
      if (live === null) return;
      const settings = await resolveLiveSettings(live.address, live.fallbackHost);
      session = await openTestSession(settings, live.password);
      folder = TestFolder.fromSession(session);
      ground = await buildTestGround();
      first = await seedTestGround(folder, ground);
    });
  }, 20 * 60_000);

  afterAll(async () => {
    await session?.logout();
    vi.restoreAllMocks();
    const everything = [
      ...captured,
      inspect(first, { depth: 10 }),
      inspect(second, { depth: 10 }),
      JSON.stringify({ first, second }),
    ].join('\n');
    // Checked last so a leak anywhere in the run fails the suite.
    expect(everything.includes(live?.password ?? '\u0000no-password')).toBe(false);
  });

  it('seeds once, then a second seed changes nothing', async () => {
    expect(first?.total).toBe(150);
    second = await mapped(() => seedTestGround(folder, ground));
    expect(second).toEqual({ created: false, appended: 0, flagsReset: 0, total: 150 });
  }, 120_000);

  it('holds exactly the manifest: count, sizes, internal dates, flags, Message-IDs', async () => {
    const server = await mapped(async () => {
      const open = await folder.open();
      try {
        return await open.fetchMessages();
      } finally {
        open.release();
      }
    });
    // Plain numbers: a failing diff must not print the messages (foreign mail could be there).
    expect(server.length).toBe(ground.messages.length);
    const bySeedId = new Map(server.map((m) => [m.seedId, m]));
    for (const { facts } of ground.messages) {
      const message = bySeedId.get(facts.seedId);
      expect(message, facts.seedId).toBeDefined();
      if (message === undefined) continue;
      expect(message.size, facts.seedId).toBe(facts.size);
      expect(message.internalDate.getTime(), facts.seedId).toBe(Date.parse(facts.internalDate));
      expect(message.flags, facts.seedId).toEqual([...facts.flags].sort());
      expect(message.messageId, facts.seedId).toBe(facts.messageId);
    }
  }, 120_000);

  it('the guard refuses other folders (read-only operations only) and selects nothing', async () => {
    const before = folder.selectedPath();
    for (const path of REFUSED) {
      // Mapped: if the guard ever broke, vitest must not print a raw imapflow error.
      await expect(
        folder.open(path).catch((e: unknown) => Promise.reject(userFacing(e))),
        path,
      ).rejects.toBeInstanceOf(FolderGuardError);
      await expect(
        folder.exists(path).catch((e: unknown) => Promise.reject(userFacing(e))),
        path,
      ).rejects.toBeInstanceOf(FolderGuardError);
    }
    expect(folder.selectedPath()).toBe(before);
  });
});
