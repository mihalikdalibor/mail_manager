import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compileFilter } from '../../src/core/filters/compile.js';
import { EMPTY_FILTER, type FilterNode } from '../../src/core/filters/schema.js';
import type { ImapSession } from '../../src/core/imap/session.js';
import { listFolders } from '../../src/core/mailbox/folders.js';
import { searchFolder, type SearchResult } from '../../src/core/mailbox/search.js';
import { errorText } from '../support/test-ground/cli.js';
import { TestFolder } from '../support/test-ground/folder.js';
import { MESSAGE_COUNT, buildTestGround } from '../support/test-ground/generator.js';
import {
  openTestSession,
  readLiveImapEnv,
  resolveLiveSettings,
} from '../support/test-ground/live-env.js';
import type { Manifest, MessageFacts } from '../support/test-ground/manifest.js';

// M3a search against the seeded test mailbox: searchFolder over mm-test returns, for each rule,
// the count and the byte sum of the manifest messages the same rule selects. The pass is
// read-only: the folder keeps its messages and \Seen flags. One login, correct password only.
// Never enable vitest `retry` here. Seed first with `npm run test:seed`. Assertions compare plain
// numbers, and nothing is printed: a failing diff must not show addresses or subjects.

const live = readLiveImapEnv();
const NOW = new Date('2026-10-12T12:00:00Z');
const JAN_1_2023 = Date.UTC(2023, 0, 1);
const TWO_YEARS_AGO = Date.UTC(2024, 9, 12, 12);
const ONE_DAY_AGO = Date.UTC(2026, 9, 11, 12);

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

/** The ASCII words (five letters or more) of a subject, in order. */
function asciiWords(subject: string): string[] {
  return subject.match(/[A-Za-z]{5,}/g) ?? [];
}

function hasWord(m: MessageFacts, word: string): boolean {
  const w = word.toLowerCase();
  return [m.subject, m.from.name, m.from.address].some((s) => s.toLowerCase().includes(w));
}

describe.skipIf(live === null)('mail filter search core (live)', () => {
  const captured: string[] = [];
  let session: ImapSession | undefined;
  let testPath = '';
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
      const tree = await listFolders(session, { sizes: false, only: () => false });
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

  function first(): MessageFacts {
    const f = manifest.messages[0];
    if (f === undefined) throw new Error('the manifest has no messages');
    return f;
  }

  /** The domain with the most messages (ties: the one listed first). */
  function topDomain(): string {
    const [domain] = Object.entries(manifest.byDomain).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (domain === undefined) throw new Error('the manifest has no domain');
    return domain;
  }

  function medianSize(): number {
    const sizes = manifest.messages.map((m) => m.size).sort((a, b) => a - b);
    const mid = sizes[Math.floor(sizes.length / 2)];
    if (mid === undefined) throw new Error('the manifest has no messages');
    return mid;
  }

  /** One ASCII word from the first subject that has one. */
  function firstWord(): string {
    for (const m of manifest.messages) {
      const word = asciiWords(m.subject)[0];
      if (word !== undefined) return word;
    }
    throw new Error('no subject has an ASCII word of five letters or more');
  }

  /** Two ASCII words from the first subject that has two. */
  function twoWords(): [string, string] {
    for (const m of manifest.messages) {
      const [a, b] = asciiWords(m.subject);
      if (a !== undefined && b !== undefined) return [a, b];
    }
    throw new Error('no subject has two ASCII words of five letters or more');
  }

  async function run(where: FilterNode): Promise<SearchResult> {
    if (session === undefined) throw new Error('no session');
    const compiled = compileFilter({ version: 1, where }, { now: NOW, dayStart: dayStartUtc });
    const result = await searchFolder(session, testPath, compiled).catch((err: unknown) => {
      throw userFacing(err);
    });
    // A short read is reported as missing, never shown as a complete list.
    expect(result.missing).toBe(0);
    // Matches come newest UID first.
    expect(result.matches.every((m, i, all) => i === 0 || (all[i - 1]?.uid ?? 0) > m.uid)).toBe(
      true,
    );
    return result;
  }

  /** The server search returns the count and the byte sum of the manifest messages `keep` selects. */
  async function expectRule(where: FilterNode, keep: (m: MessageFacts) => boolean): Promise<void> {
    const want = manifest.messages.filter(keep);
    const got = await run(where);
    expect(got.matches.length).toBe(want.length);
    expect(got.bytes).toBe(sumSizes(want));
  }

  it('the empty filter: every message and their bytes', async (ctx) => {
    if (!ready(ctx)) return;
    const got = await run(EMPTY_FILTER.where);
    expect(got.matches.length).toBe(MESSAGE_COUNT);
    expect(got.bytes).toBe(manifest.totalBytes);
  });

  it('from an exact domain: the top domain, and spam.test without spam.test.evil.test', async (ctx) => {
    if (!ready(ctx)) return;
    const domain = topDomain();
    await expectRule({ kind: 'from', values: [`@${domain}`] }, (m) => m.from.domain === domain);

    // The look-alike domain contains spam.test as a suffix: an exact domain must leave it out.
    const lookAlike = manifest.messages.filter((m) => m.from.domain === 'spam.test.evil.test');
    expect(lookAlike.length).toBeGreaterThan(0);
    await expectRule(
      { kind: 'from', values: ['@spam.test'] },
      (m) => m.from.domain === 'spam.test',
    );
  });

  it('from an exact address', async (ctx) => {
    if (!ready(ctx)) return;
    const address = first().from.address;
    await expectRule(
      { kind: 'from', values: [address] },
      (m) => m.from.address.toLowerCase() === address.toLowerCase(),
    );
  });

  it('not from that domain: every other message', async (ctx) => {
    if (!ready(ctx)) return;
    const domain = topDomain();
    await expectRule(
      { kind: 'not', of: { kind: 'from', values: [`@${domain}`] } },
      (m) => m.from.domain !== domain,
    );
  });

  it('larger / smaller: strictly above and strictly below the median size', async (ctx) => {
    if (!ready(ctx)) return;
    const median = medianSize();
    await expectRule({ kind: 'larger', bytes: median }, (m) => m.size > median);
    await expectRule({ kind: 'smaller', bytes: median }, (m) => m.size < median);
  });

  for (const value of [true, false]) {
    it(`seen ${value}: from the \\Seen flag`, async (ctx) => {
      if (!ready(ctx)) return;
      await expectRule({ kind: 'seen', value }, (m) => m.flags.includes('\\Seen') === value);
    });

    it(`flagged ${value}: from the \\Flagged flag`, async (ctx) => {
      if (!ready(ctx)) return;
      await expectRule({ kind: 'flagged', value }, (m) => m.flags.includes('\\Flagged') === value);
    });

    it(`hasAttachments ${value}: from the attachments of the manifest`, async (ctx) => {
      if (!ready(ctx)) return;
      await expectRule(
        { kind: 'hasAttachments', value },
        (m) => m.attachments.length > 0 === value,
      );
    });

    it(`answered ${value}: the seed sets only \\Seen and \\Flagged`, async (ctx) => {
      if (!ready(ctx)) return;
      await expectRule({ kind: 'answered', value }, () => !value);
    });
  }

  const DATE_RULES: [string, FilterNode, (t: number) => boolean][] = [
    ['since 2023-01-01', { kind: 'since', day: '2023-01-01' }, (t) => t >= JAN_1_2023],
    ['before 2023-01-01', { kind: 'before', day: '2023-01-01' }, (t) => t < JAN_1_2023],
    ['olderThan 2y', { kind: 'olderThan', age: '2y' }, (t) => t < TWO_YEARS_AGO],
    ['newerThan 2y', { kind: 'newerThan', age: '2y' }, (t) => t >= TWO_YEARS_AGO],
  ];
  for (const [name, where, inRange] of DATE_RULES) {
    it(`${name}: by the internal date instant`, async (ctx) => {
      if (!ready(ctx)) return;
      await expectRule(where, (m) => inRange(Date.parse(m.internalDate)));
    });
  }

  it('subject contains an ASCII word of five letters or more', async (ctx) => {
    if (!ready(ctx)) return;
    const word = firstWord();
    await expectRule({ kind: 'subject', value: word }, (m) =>
      m.subject.toLowerCase().includes(word.toLowerCase()),
    );
  });

  it('word: the subject, the sender name or the sender address', async (ctx) => {
    if (!ready(ctx)) return;
    const word = firstWord();
    await expectRule({ kind: 'word', value: word }, (m) => hasWord(m, word));
  });

  it('two criteria together: the top domain and larger than the median', async (ctx) => {
    if (!ready(ctx)) return;
    const domain = topDomain();
    const median = medianSize();
    await expectRule(
      {
        kind: 'all',
        of: [
          { kind: 'from', values: [`@${domain}`] },
          { kind: 'larger', bytes: median },
        ],
      },
      (m) => m.from.domain === domain && m.size > median,
    );
  });

  it('to an exact address: the messages sent to it', async (ctx) => {
    if (!ready(ctx)) return;
    const to = first().to;
    await expectRule({ kind: 'to', values: [to] }, (m) => m.to.toLowerCase() === to.toLowerCase());
  });

  it('to an address nobody sent to matches nothing', async (ctx) => {
    if (!ready(ctx)) return;
    await expectRule({ kind: 'to', values: ['nobody@example-test-domain.eu'] }, () => false);
  });

  it('a pure any on the server: seen or flagged', async (ctx) => {
    if (!ready(ctx)) return;
    await expectRule(
      {
        kind: 'any',
        of: [
          { kind: 'seen', value: true },
          { kind: 'flagged', value: true },
        ],
      },
      (m) => m.flags.includes('\\Seen') || m.flags.includes('\\Flagged'),
    );
  });

  it('a pure not on the server: 150 minus the seen ones', async (ctx) => {
    if (!ready(ctx)) return;
    await expectRule(
      { kind: 'not', of: { kind: 'seen', value: true } },
      (m) => !m.flags.includes('\\Seen'),
    );
  });

  it('two words (the not-not slot on a real server): both in the subject, name or address', async (ctx) => {
    if (!ready(ctx)) return;
    const [a, b] = twoWords();
    await expectRule(
      {
        kind: 'all',
        of: [
          { kind: 'word', value: a },
          { kind: 'word', value: b },
        ],
      },
      (m) => hasWord(m, a) && hasWord(m, b),
    );
  });

  it('olderThan 1d (no narrowing term): every message received before now minus one day', async (ctx) => {
    if (!ready(ctx)) return;
    await expectRule(
      { kind: 'olderThan', age: '1d' },
      (m) => Date.parse(m.internalDate) < ONE_DAY_AGO,
    );
  });

  it('read-only: after all the searches the folder keeps its messages and its \\Seen count', async (ctx) => {
    if (!ready(ctx)) return;
    if (session === undefined) throw new Error('no session');
    const tree = await listFolders(session, { sizes: false, only: (p) => p === testPath });
    const entry = tree.folders.find((f) => f.path === testPath);
    expect(entry?.messages).toBe(manifest.count);
    expect(entry?.unseen).toBe(manifest.count - manifest.seen);
  });
});
