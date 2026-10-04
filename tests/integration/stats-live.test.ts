import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ImapSession } from '../../src/core/imap/session.js';
import { listFolders } from '../../src/core/mailbox/folders.js';
import { STATS_TOP_N, collectStats, type MailboxStats } from '../../src/core/mailbox/stats.js';
import { errorText } from '../support/test-ground/cli.js';
import { TestFolder } from '../support/test-ground/folder.js';
import { buildTestGround } from '../support/test-ground/generator.js';
import {
  openTestSession,
  readLiveImapEnv,
  resolveLiveSettings,
} from '../support/test-ground/live-env.js';
import type { Manifest } from '../support/test-ground/manifest.js';

// M2c-1 against the seeded test mailbox: collectStats over mm-test (`--folder`) equals the
// manifest — totals, per year (UTC, like the manifest), per domain, per sender, the largest
// size. The listing is LIST + quota only; only mm-test is EXAMINEd and fetched. One login,
// correct password only, read-only. Never enable vitest `retry` here. Seed first with
// `npm run test:seed`. Assertions compare plain numbers and maps built here, and nothing is
// printed: a failing diff must not show addresses or folder names beyond the test ground's.

const live = readLiveImapEnv();

/** Raw imapflow errors carry server text: only the user-facing text may reach the output. */
function userFacing(err: unknown): Error {
  return new Error(errorText(err));
}

describe.skipIf(live === null)('mm stats core (live)', () => {
  const captured: string[] = [];
  let session: ImapSession | undefined;
  let stats: MailboxStats | undefined;
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
      const testPath = TestFolder.fromSession(session).path;
      const tree = await listFolders(session, { sizes: false, only: () => false });
      // Missing mm-test: the tests skip (collectStats would say folder-not-found).
      if (!tree.folders.some((f) => f.path === testPath && f.selectable)) return;
      stats = await collectStats(session, tree, { folder: testPath, timeZone: 'UTC' });
    } catch (err) {
      throw userFacing(err);
    }
  }, 5 * 60_000);

  afterAll(async () => {
    await session?.logout();
    vi.restoreAllMocks();
    expect(captured.join('\n').includes(live?.password ?? '\u0000no-password')).toBe(false);
  });

  function read(ctx: { skip: (note: string) => void }): MailboxStats | null {
    if (stats === undefined) {
      ctx.skip('mm-test is missing — run npm run test:seed');
      return null;
    }
    return stats;
  }

  it('totals: messages and bytes equal the manifest; one folder, read fully', (ctx) => {
    const s = read(ctx);
    if (s === null) return;
    expect(s.folders).toHaveLength(1);
    expect(s.totals.messages).toBe(manifest.count);
    expect(s.totals.bytes).toBe(manifest.totalBytes);
    expect(s.unreadable).toBe(0);
    expect(s.partial).toBe(0);
    expect(s.notScanned).toBe(0);
  });

  it('per year (UTC): equal to the manifest', (ctx) => {
    const s = read(ctx);
    if (s === null) return;
    const years = Object.fromEntries(s.years.map((y) => [y.year, y.messages]));
    expect(years).toEqual(manifest.byYear);
  });

  it('per domain: all of them in the top list, equal to the manifest; nothing approximate', (ctx) => {
    const s = read(ctx);
    if (s === null) return;
    // The test ground has exactly STATS_TOP_N domains, so the top list is complete.
    expect(Object.keys(manifest.byDomain)).toHaveLength(STATS_TOP_N);
    const domains = Object.fromEntries(
      s.domains.byCount.map((r) => [r.key ?? '(no address)', r.messages]),
    );
    expect(domains).toEqual(manifest.byDomain);
    expect(s.domains.others.messages).toBe(0);
    expect(s.senders.others.messages).toBe(0);
    expect(s.approximate).toBe(false);
  });

  it('every listed sender has its manifest count', (ctx) => {
    const s = read(ctx);
    if (s === null) return;
    const bySender = new Map<string, number>();
    for (const m of manifest.messages) {
      const key = m.from.address.toLowerCase();
      bySender.set(key, (bySender.get(key) ?? 0) + 1);
    }
    expect(s.senders.byCount.length).toBeGreaterThan(0);
    for (const r of s.senders.byCount) {
      expect(r.key).not.toBeNull();
      expect(r.messages).toBe(bySender.get(r.key ?? '') ?? -1);
    }
  });

  it('the largest mail has the manifest largest size', (ctx) => {
    const s = read(ctx);
    if (s === null) return;
    const largest = Math.max(...manifest.messages.map((m) => m.size));
    expect(s.largest[0]?.bytes).toBe(largest);
    expect(s.largest).toHaveLength(Math.min(STATS_TOP_N, manifest.count));
  });
});
