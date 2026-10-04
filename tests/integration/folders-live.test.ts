import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ImapSession } from '../../src/core/imap/session.js';
import { listFolders, type FolderTree } from '../../src/core/mailbox/folders.js';
import { errorText } from '../support/test-ground/cli.js';
import { TestFolder } from '../support/test-ground/folder.js';
import { buildTestGround } from '../support/test-ground/generator.js';
import {
  openTestSession,
  readLiveImapEnv,
  resolveLiveSettings,
} from '../support/test-ground/live-env.js';
import type { Manifest } from '../support/test-ground/manifest.js';

// M2a against the seeded test mailbox: listFolders' counts and size for mm-test equal the
// manifest. Only mm-test is STATUSed or sized (`only`); LIST sees the other folders, but their
// names are never asserted or printed. One login, correct password only, read-only (EXAMINE).
// Never enable vitest `retry` here. Seed first with `npm run test:seed`.

const live = readLiveImapEnv();

/** Raw imapflow errors carry server text: only the user-facing text may reach the output. */
function userFacing(err: unknown): Error {
  return new Error(errorText(err));
}

describe.skipIf(live === null)('mm folders core (live)', () => {
  const captured: string[] = [];
  let session: ImapSession | undefined;
  let tree: FolderTree | undefined;
  let testPath = '';
  let manifest: Manifest;

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
    try {
      if (live === null) return;
      manifest = (await buildTestGround()).manifest;
      const settings = await resolveLiveSettings(live.address, live.fallbackHost);
      session = await openTestSession(settings, live.password);
      testPath = TestFolder.fromSession(session).path;
      tree = await listFolders(session, { sizes: true, only: (p) => p === testPath });
    } catch (err) {
      throw userFacing(err);
    }
  }, 5 * 60_000);

  afterAll(async () => {
    await session?.logout();
    vi.restoreAllMocks();
    expect(captured.join('\n').includes(live?.password ?? '\u0000no-password')).toBe(false);
  });

  it('mm-test: messages, unseen and bytes equal the manifest', (ctx) => {
    const entry = tree?.folders.find((f) => f.path === testPath);
    if (entry === undefined) {
      ctx.skip('mm-test is missing — run npm run test:seed');
      return;
    }
    // Plain numbers only: a failing diff must not print folder data.
    expect(entry.selectable).toBe(true);
    expect(entry.messages).toBe(manifest.count);
    expect(entry.unseen).toBe(manifest.count - manifest.seen);
    if (entry.sizeSource === 'server') {
      // RFC 8438: STATUS=SIZE is at least the sum of RFC822.SIZE.
      expect(entry.bytes ?? -1).toBeGreaterThanOrEqual(manifest.totalBytes);
    } else {
      expect(entry.sizeSource).toBe('sum');
      expect(entry.bytes).toBe(manifest.totalBytes);
    }
  });

  it('nothing outside mm-test was counted or sized', () => {
    const others = (tree?.folders ?? []).filter((f) => f.path !== testPath);
    expect(others.every((f) => f.messages === null && f.bytes === null)).toBe(true);
    expect(tree?.unreadable).toBe(0);
  });
});
