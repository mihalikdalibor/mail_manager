import { describe, it, expect } from 'vitest';
import { formatBytes } from '../../src/cli/folders-text.js';
import { searchJson, searchLines, type SearchTextOptions } from '../../src/cli/search-text.js';
import { mailLines } from '../../src/cli/stats-text.js';
import type { FolderTree } from '../../src/core/mailbox/folders.js';
import type {
  FolderMatches,
  MailboxSearch,
  SampleRow,
} from '../../src/core/mailbox/search-mailbox.js';
import type { Match } from '../../src/core/mailbox/search.js';

// M3b `mm search` text report and JSON over hand-built MailboxSearch values (spec): the report's
// line order and texts, the notes, the sections, the sanitising of every server string and the
// JSON shape. The time zone is explicit (UTC). Setup follows stats-text.test.ts.

const TZ = 'UTC';
const FILTER = 'from:@shop.example older:1y';
const NONE = { messages: 0, bytes: 0 };
const NO_MATCH_TEXT = 'No mails match.';
const BODY_WARNING =
  'Body search is done by the mail server — some servers are slow at it or search only part of a mail.';
const SENT_SUFFIX = ' — dates are sent dates (the Date: header)';

function tree(truncated = false): FolderTree {
  return {
    folders: [],
    totals: null,
    quota: null,
    truncated,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
  };
}

/** `count` matches, UIDs descending (as the search returns them). */
function matches(count: number): Match[] {
  return Array.from({ length: count }, (_v, i) => ({ uid: count - i, bytes: 100, received: null }));
}

function matched(path: string, count: number, bytes: number): FolderMatches {
  return { path, snapshot: null, reason: null, matches: matches(count), bytes, missing: 0 };
}

function failedFolder(path: string): FolderMatches {
  return { path, snapshot: null, reason: 'search-failed', matches: [], bytes: 0, missing: 0 };
}

function search(over: Partial<MailboxSearch> = {}): MailboxSearch {
  return {
    folders: [],
    notSearched: 0,
    totals: NONE,
    failed: 0,
    missing: 0,
    senders: [],
    sendersOthers: NONE,
    samples: [],
    samplesGone: 0,
    ...over,
  };
}

const SAMPLE_NEW: SampleRow = {
  folder: 'INBOX',
  uid: 9,
  received: new Date('2024-06-15T12:00:00Z'),
  from: 'Alice A',
  subject: 'Quarterly report',
  bytes: 1_048_576,
  attachment: false,
};

const SAMPLE_OLD: SampleRow = {
  folder: 'Work',
  uid: 4,
  received: new Date('2023-02-01T09:00:00Z'),
  from: 'bob@shop.example',
  subject: 'Invoice 1',
  bytes: 1024,
  attachment: true,
};

function options(over: Partial<SearchTextOptions> = {}): SearchTextOptions {
  return { filter: FILTER, body: null, sent: false, order: 'newest', timeZone: TZ, ...over };
}

function report(
  over: Partial<MailboxSearch> = {},
  o: Partial<SearchTextOptions> = {},
  t: FolderTree = tree(),
): string[] {
  return searchLines(search(over), t, options(o));
}

/** The lines of the blank-line separated block whose first line starts with `heading`. */
function block(lines: string[], heading: string): string[] {
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) throw new Error(`no block ${heading}`);
  const end = lines.indexOf('', start);
  return lines.slice(start, end < 0 ? undefined : end);
}

/** A table row: key, a count and a size, separated by spaces. */
function rowRe(key: string, n: string, size: string): RegExp {
  return new RegExp(`^${esc(key)}\\s+${esc(n)}\\s+${esc(size)}\\s*$`);
}

function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Control characters (but not the line break) and the bidi controls: never on a terminal. */
function unsafeChars(text: string): string[] {
  return [...text].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return (
      (code < 0x20 && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
}

/** Every string inside a JSON value, at any depth. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('searchLines — report with matches', () => {
  it('report with matches: filter, found line, folder table, top senders, newest samples', () => {
    const lines = report({
      folders: [matched('INBOX', 30, 30_000), matched('Work', 7, 7_000)],
      totals: { messages: 37, bytes: 37_000 },
      senders: [
        { key: 'alice@example-sender.test', messages: 20, bytes: 20_000 },
        { key: null, messages: 17, bytes: 17_000 },
      ],
      samples: [SAMPLE_NEW, SAMPLE_OLD],
    });
    expect(lines[0]).toBe(`Filter: ${FILTER}`);
    expect(lines[1]).toBe(
      `Found 37 mails, ${formatBytes(37_000)} in 2 folders — sizes are approx. (message sizes)`,
    );
    expect(lines[2]).toBe('');

    const folders = block(lines, 'FOLDER');
    expect(folders[0]).toMatch(/^FOLDER +MAILS +SIZE$/);
    expect(folders[1]).toMatch(rowRe('INBOX', '30', formatBytes(30_000)));
    expect(folders[2]).toMatch(rowRe('Work', '7', formatBytes(7_000)));
    expect(folders).toHaveLength(3);

    const senders = block(lines, 'TOP SENDERS');
    expect(senders[0]).toBe('TOP SENDERS');
    expect(senders[1]).toMatch(rowRe('alice@example-sender.test', '20', formatBytes(20_000)));
    expect(senders[2]).toMatch(rowRe('(no address)', '17', formatBytes(17_000)));
    expect(senders).toHaveLength(3);

    expect(block(lines, 'NEWEST')).toEqual([
      'NEWEST 2 OF 37',
      ...mailLines([SAMPLE_NEW, SAMPLE_OLD], TZ),
    ]);
    for (const heading of ['FOLDER', 'TOP SENDERS', 'NEWEST']) {
      expect(lines[lines.findIndex((l) => l.startsWith(heading)) - 1]).toBe('');
    }
  });
});

describe('searchLines — no match', () => {
  it('no match: exactly the filter line and "No mails match."', () => {
    expect(report()).toEqual([`Filter: ${FILTER}`, NO_MATCH_TEXT]);
  });
});

describe('searchLines — notes', () => {
  it('notes in order: failed, missing, not searched, truncated, body; the failed row is marked', () => {
    const lines = report(
      {
        folders: [matched('INBOX', 5, 500), failedFolder('Broken')],
        totals: { messages: 5, bytes: 500 },
        failed: 1,
        missing: 3,
        notSearched: 2,
      },
      { filter: 'older:1y', body: 'invoice' },
      tree(true),
    );
    expect(lines.slice(0, lines.indexOf(''))).toEqual([
      'Filter: older:1y body:"invoice"',
      `Found 5 mails, ${formatBytes(500)} in 1 folder — sizes are approx. (message sizes)`,
      "1 folder couldn't be searched — the result may be incomplete.",
      "3 mails couldn't be read — the result may be incomplete (run it again).",
      'Not searched: 2 folders (Gmail labels or virtual folders; their mail is in the folders above)',
      'First 5,000 folders only.',
      BODY_WARNING,
    ]);

    const folders = block(lines, 'FOLDER');
    const broken = folders.find((l) => l.startsWith('Broken')) ?? '';
    expect(broken).toMatch(/^Broken\s+—\s+—/);
    expect(broken.endsWith(" (couldn't be searched)")).toBe(true);
    const inbox = folders.find((l) => l.startsWith('INBOX')) ?? '';
    expect(inbox).toMatch(rowRe('INBOX', '5', formatBytes(500)));
  });
});

describe('searchLines — filter line', () => {
  it('sent and body in the filter line', () => {
    const lines = report({}, { filter: 'older:1y', body: 'invoice', sent: true });
    expect(lines[0]).toBe(`Filter: older:1y body:"invoice"${SENT_SUFFIX}`);
  });
});

describe('searchLines — sample headings and gone rows', () => {
  it('order headings: OLDEST and LARGEST name the list and its total', () => {
    const oldest = report(
      {
        folders: [matched('Work', 5, 500)],
        totals: { messages: 5, bytes: 500 },
        samples: [SAMPLE_OLD],
      },
      { order: 'oldest' },
    );
    expect(oldest).toContain('OLDEST 1 OF 5');
    expect(oldest.join('\n')).not.toContain("couldn't be shown");

    const largest = report(
      {
        folders: [matched('INBOX', 5, 500)],
        totals: { messages: 5, bytes: 500 },
        samples: [SAMPLE_NEW],
        samplesGone: 2,
      },
      { order: 'largest' },
    );
    expect(largest).toContain('LARGEST 1 OF 5');
    expect(largest).toContain(
      "2 mails of this list couldn't be shown — gone from the server or not readable now.",
    );
  });

  it('gone rows: singular "1 mail"', () => {
    const lines = report(
      {
        folders: [matched('INBOX', 5, 500)],
        totals: { messages: 5, bytes: 500 },
        samples: [SAMPLE_NEW],
        samplesGone: 1,
      },
      { order: 'newest' },
    );
    expect(lines).toContain(
      "1 mail of this list couldn't be shown — gone from the server or not readable now.",
    );
  });

  it('no samples: no sample heading at all', () => {
    const lines = report({
      folders: [matched('INBOX', 5, 500)],
      totals: { messages: 5, bytes: 500 },
      samples: [],
    });
    expect(lines.join('\n')).not.toMatch(/^(NEWEST|OLDEST|LARGEST) /m);
  });

  it('sent with samples: the received-dates note; sent without samples: no note', () => {
    const withSamples = report(
      {
        folders: [matched('Work', 5, 500)],
        totals: { messages: 5, bytes: 500 },
        samples: [SAMPLE_OLD],
      },
      { sent: true },
    );
    expect(withSamples).toContain('Dates in the list are received dates.');

    const withoutSamples = report(
      { folders: [matched('Work', 5, 500)], totals: { messages: 5, bytes: 500 } },
      { sent: true },
    );
    expect(withoutSamples.join('\n')).not.toContain('Dates in the list are received dates.');
  });

  it('every sample gone: the note stands alone, after a blank line, with no sample heading', () => {
    const lines = report({
      folders: [matched('INBOX', 5, 500)],
      totals: { messages: 5, bytes: 500 },
      samples: [],
      samplesGone: 3,
    });
    expect(lines.some((l) => /^(NEWEST|OLDEST|LARGEST) /.test(l))).toBe(false);
    expect(lines.at(-1)).toBe(
      "3 mails of this list couldn't be shown — gone from the server or not readable now.",
    );
    expect(lines.at(-2)).toBe('');
  });

  it('singular: "Found 1 mail" in "1 folder"', () => {
    const lines = report({
      folders: [matched('INBOX', 1, 100)],
      totals: { messages: 1, bytes: 100 },
    });
    expect(lines[1]).toBe(
      `Found 1 mail, ${formatBytes(100)} in 1 folder — sizes are approx. (message sizes)`,
    );
  });
});

describe('searchLines — senders', () => {
  it('approximate senders: the heading says so and an "others" row closes the list', () => {
    const lines = report({
      folders: [matched('INBOX', 14, 1400)],
      totals: { messages: 14, bytes: 1400 },
      senders: [{ key: 'alice@example-sender.test', messages: 10, bytes: 1000 }],
      sendersOthers: { messages: 4, bytes: 400 },
    });
    expect(lines).toContain('TOP SENDERS (approximate)');
    const senders = block(lines, 'TOP SENDERS');
    expect(senders.at(-1)).toMatch(rowRe('others', '4', formatBytes(400)));
  });
});

describe('searchLines — sanitising', () => {
  const HOSTILE_PATH = 'Evil\x1b[31mRed\u202eFolder';
  const HOSTILE_KEY = 'sender\x1b@hostile.example\u202e';
  const HOSTILE_FROM = 'Name\x1b[2J\u202eEvil';
  const HOSTILE_SUBJECT = 'Sub\x1b[31mject\u202e';
  const HOSTILE_FILTER = 'from:@hostile.example\x1b[31m\u202e';
  const HOSTILE_BODY = 'x\x1b\u202e';

  const hostile = search({
    folders: [matched(HOSTILE_PATH, 2, 200)],
    totals: { messages: 2, bytes: 200 },
    senders: [{ key: HOSTILE_KEY, messages: 2, bytes: 200 }],
    sendersOthers: { messages: 1, bytes: 1 },
    samples: [
      { ...SAMPLE_OLD, folder: HOSTILE_PATH, from: HOSTILE_FROM, subject: HOSTILE_SUBJECT },
    ],
    samplesGone: 0,
  });

  it('sanitised: no ESC or bidi character in any text line or JSON string', () => {
    const o = options({ filter: HOSTILE_FILTER, body: HOSTILE_BODY, sent: true, order: 'newest' });
    const lines = searchLines(hostile, tree(), o);
    for (const line of lines) expect(unsafeChars(line)).toEqual([]);
    expect(lines.join('\n')).toContain('Evil[31mRedFolder');
    expect(lines.join('\n')).toContain('hostile.example');

    const j = searchJson(hostile, tree(), 'a1b2c3d4', {
      filter: HOSTILE_FILTER,
      body: HOSTILE_BODY,
      sent: true,
      order: 'newest',
      folder: null,
      gmail: false,
    });
    for (const s of strings(j)) expect(unsafeChars(s)).toEqual([]);
  });
});

describe('searchJson', () => {
  it('json: version, dates, every folder incl. a failed one, ISO dates, sample order and gone count', () => {
    const j = searchJson(
      search({
        folders: [matched('INBOX', 2, 300), failedFolder('Broken')],
        totals: { messages: 2, bytes: 300 },
        failed: 1,
        notSearched: 3,
        senders: [{ key: 'alice@example-sender.test', messages: 2, bytes: 300 }],
        samples: [SAMPLE_OLD],
        samplesGone: 2,
      }),
      tree(true),
      'a1b2c3d4',
      { filter: 'older:1y', body: null, sent: true, order: 'oldest', folder: null, gmail: false },
    );
    expect(j.v).toBe(1);
    expect(j.account).toBe('a1b2c3d4');
    expect(j.filter).toBe('older:1y');
    expect(j.body).toBeNull();
    expect(j.dates).toBe('sent');
    expect(j.scope).toEqual({ folder: null, gmail: false });
    expect(j.totals).toEqual({ messages: 2, bytes: 300 });
    expect(j.folders).toEqual([
      { path: 'INBOX', messages: 2, bytes: 300, missing: 0, failed: false },
      { path: 'Broken', messages: null, bytes: null, missing: 0, failed: true },
    ]);
    expect(j.notSearched).toBe(3);
    expect(j.failed).toBe(1);
    expect(j.missing).toBe(0);
    expect(j.truncated).toBe(true);
    expect(j.senders).toEqual({
      rows: [{ key: 'alice@example-sender.test', messages: 2, bytes: 300 }],
      others: { messages: 0, bytes: 0 },
    });
    expect(j.samples).toEqual({
      order: 'oldest',
      rows: [
        {
          folder: 'Work',
          uid: 4,
          received: '2023-02-01T09:00:00.000Z',
          from: 'bob@shop.example',
          subject: 'Invoice 1',
          bytes: 1024,
          attachment: true,
        },
      ],
      gone: 2,
    });
  });

  it('json: received when not sent, a sample without a date is null, scope.folder is the folder searched', () => {
    const j = searchJson(
      search({
        folders: [matched('Work', 1, 10)],
        totals: { messages: 1, bytes: 10 },
        samples: [{ ...SAMPLE_OLD, received: null }],
      }),
      tree(),
      'a1b2c3d4',
      {
        filter: 'older:1y',
        body: null,
        sent: false,
        order: 'newest',
        folder: 'Work',
        gmail: false,
      },
    );
    expect(j.dates).toBe('received');
    expect(j.scope).toEqual({ folder: 'Work', gmail: false });
    expect(j.samples).toMatchObject({ rows: [{ received: null }] });
  });
});
