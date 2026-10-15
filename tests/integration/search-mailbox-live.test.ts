import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compileFilter } from '../../src/core/filters/compile.js';
import type { Filter } from '../../src/core/filters/schema.js';
import { parseFilterLine } from '../../src/core/filters/line.js';
import type { ImapSession } from '../../src/core/imap/session.js';
import { listFolders, type FolderTree } from '../../src/core/mailbox/folders.js';
import { searchMailbox, type MailboxSearch } from '../../src/core/mailbox/search-mailbox.js';
import { errorText } from '../support/test-ground/cli.js';
import { TestFolder } from '../support/test-ground/folder.js';
import { buildTestGround } from '../support/test-ground/generator.js';
import {
  openTestSession,
  readLiveImapEnv,
  resolveLiveSettings,
} from '../support/test-ground/live-env.js';
import type { Manifest, MessageFacts } from '../support/test-ground/manifest.js';

// M3b mailbox search against the seeded test mailbox: searchMailbox over mm-test returns, for
// three filters, the count and the byte sum of the manifest messages the same filter selects,
// plus the top samples and the sender counts. Read-only. One login, correct password only. Never
// enable vitest `retry` here. Seed first with `npm run test:seed`. Assertions compare plain
// numbers, and nothing is printed: a failing diff must not show addresses or subjects.

const live = readLiveImapEnv();
const NOW = new Date('2026-10-12T12:00:00Z');
const SAMPLE_LIMIT = 5;
const HUNDRED_KB = 100 * 1024;

/** Raw imapflow errors carry server text: only the user-facing text may reach the output. */
function userFacing(err: unknown): Error {
  return new Error(errorText(err));
}

function dayStartUtc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function sumSizes(messages: readonly MessageFacts[]): number {
  return messages.reduce((total, m) => total + m.size, 0);
}

function parse(text: string): Filter {
  const parsed = parseFilterLine(text);
  if (!parsed.ok) throw new Error('a test filter line does not parse');
  return parsed.filter;
}

describe.skipIf(live === null)('mail search core (live)', () => {
  const captured: string[] = [];
  let session: ImapSession | undefined;
  let testPath = '';
  let tree: FolderTree | undefined;
  let present = false;
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
      tree = await listFolders(session, { sizes: false, only: (p) => p === testPath });
      present = tree.folders.some((f) => f.path === testPath && f.selectable);
    } catch (err) {
      throw userFacing(err);
    }
  }, 5 * 60_000);

  afterAll(async () => {
    await session?.logout();
    vi.restoreAllMocks();
    expect(captured.join('\n').includes(live?.password ?? '\u0000no-password')).toBe(false);
  });

  function ready(ctx: { skip: (note: string) => void }): boolean {
    if (present) return true;
    ctx.skip('mm-test is missing - run npm run test:seed');
    return false;
  }

  /** The domain with the most messages (ties: the one listed first). */
  function topDomain(): string {
    const [domain] = Object.entries(manifest.byDomain).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (domain === undefined) throw new Error('the manifest has no domain');
    return domain;
  }

  /** The most messages from one sender address (case-folded), over `messages`. */
  function largestSenderCount(messages: readonly MessageFacts[]): number {
    const counts = new Map<string, number>();
    for (const m of messages) {
      const address = m.from.address.toLowerCase();
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
    return Math.max(0, ...counts.values());
  }

  async function run(
    text: string,
    dates: 'received' | 'sent' = 'received',
  ): Promise<MailboxSearch> {
    if (session === undefined || tree === undefined) throw new Error('no session');
    const compiled = compileFilter(parse(text), { now: NOW, dayStart: dayStartUtc, dates });
    const result = await searchMailbox(session, tree, compiled, {
      folder: testPath,
      order: 'largest',
      limit: SAMPLE_LIMIT,
    }).catch((err: unknown) => {
      throw userFacing(err);
    });
    // A short read or a refused folder would make the counts below meaningless.
    expect(result.failed).toBe(0);
    expect(result.missing).toBe(0);
    expect(result.samplesGone).toBe(0);
    return result;
  }

  it('sender domain: the count and bytes of the top domain, the largest samples, the top sender', async (ctx) => {
    if (!ready(ctx)) return;
    const domain = topDomain();
    const want = manifest.messages.filter((m) => m.from.domain === domain);
    const got = await run(`from:@${domain}`);

    expect(got.totals.messages).toBe(want.length);
    expect(got.totals.bytes).toBe(sumSizes(want));
    const largest = want
      .map((m) => m.size)
      .sort((a, b) => b - a)
      .slice(0, SAMPLE_LIMIT);
    expect(got.samples.map((s) => s.bytes)).toEqual(largest);
    expect(got.senders[0]?.messages).toBe(largestSenderCount(want));
  });

  it('age and size: older:1y larger:100kb, count and bytes', async (ctx) => {
    if (!ready(ctx)) return;
    // The same calendar step as ageCutoff: one year back, same day and time, in UTC.
    const cutoff = Date.UTC(NOW.getUTCFullYear() - 1, NOW.getUTCMonth(), NOW.getUTCDate(), 12);
    const want = manifest.messages.filter(
      (m) => Date.parse(m.internalDate) < cutoff && m.size > HUNDRED_KB,
    );
    const got = await run('older:1y larger:100kb');

    expect(got.totals.messages).toBe(want.length);
    expect(got.totals.bytes).toBe(sumSizes(want));
  });

  it('sent year: date:2023 with sent dates, count and bytes of the mails sent in 2023', async (ctx) => {
    if (!ready(ctx)) return;
    const from = Date.UTC(2023, 0, 1);
    const to = Date.UTC(2024, 0, 1);
    const want = manifest.messages.filter((m) => {
      const sent = Date.parse(m.sentDate);
      return sent >= from && sent < to;
    });
    const got = await run('date:2023', 'sent');

    expect(got.totals.messages).toBe(want.length);
    expect(got.totals.bytes).toBe(sumSizes(want));
  });
});
