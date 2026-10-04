import { describe, it, expect } from 'vitest';
import { statsLines } from '../../src/cli/stats-text.js';
import type { FolderTree } from '../../src/core/mailbox/folders.js';
import type { LargestMail, MailboxStats, RankedRow } from '../../src/core/mailbox/stats.js';

// M2c-1 `mm stats` text over hand-built MailboxStats, with an explicit time zone: per-list
// "(approximate)", "(no domain)", the LARGEST sender and date columns, long keys cut.

const TZ = 'UTC';
const NONE_YET = { messages: 0, bytes: 0 };

function tree(): FolderTree {
  return {
    folders: [],
    totals: null,
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
  };
}

function ranked(key: string | null, messages = 1, bytes = 100): RankedRow {
  return { key, messages, bytes };
}

function stats(over: Partial<MailboxStats> = {}): MailboxStats {
  return {
    folders: [{ path: 'INBOX', messages: 1, bytes: 100, partial: false }],
    notScanned: 0,
    totals: { messages: 1, bytes: 100 },
    years: [],
    senders: { byCount: [], bySize: [], others: NONE_YET },
    domains: { byCount: [], bySize: [], others: NONE_YET },
    largest: [],
    approximate: false,
    unreadable: 0,
    partial: 0,
    ...over,
  };
}

function largest(over: Partial<LargestMail> = {}): LargestMail {
  return {
    folder: 'INBOX',
    received: new Date('2024-06-15T12:00:00Z'),
    from: 'Alice',
    subject: 'Report',
    bytes: 2048,
    ...over,
  };
}

function lines(s: MailboxStats): string[] {
  return statsLines(s, tree(), { wholeMailbox: true, timeZone: TZ });
}

/** The lines of the section whose heading starts with `heading` (heading included). */
function section(s: MailboxStats, heading: string): string[] {
  const all = lines(s);
  const start = all.findIndex((l) => l.startsWith(heading));
  if (start < 0) throw new Error(`no section ${heading}`);
  const end = all.indexOf('', start);
  return all.slice(start, end < 0 ? undefined : end);
}

function headings(s: MailboxStats): string[] {
  return lines(s).filter((l) => l.startsWith('TOP '));
}

function largestRow(mail: LargestMail): string {
  return section(stats({ largest: [mail] }), 'LARGEST MAILS')[1] ?? '';
}

describe('statsLines — "(approximate)" per list', () => {
  it('only the senders overflowed: the sender lists say approximate, the domain lists do not', () => {
    const s = stats({
      approximate: true,
      senders: {
        byCount: [ranked('a@x.test')],
        bySize: [ranked('a@x.test')],
        others: { messages: 5, bytes: 500 },
      },
      domains: { byCount: [ranked('x.test')], bySize: [ranked('x.test')], others: NONE_YET },
    });
    expect(headings(s)).toEqual([
      'TOP SENDERS BY MESSAGES (approximate)',
      'TOP SENDERS BY SIZE (approximate)',
      'TOP DOMAINS BY MESSAGES',
      'TOP DOMAINS BY SIZE',
    ]);
    expect(section(s, 'TOP SENDERS BY MESSAGES').at(-1)).toMatch(/^others\s+5\s+500 B$/);
    expect(section(s, 'TOP DOMAINS BY MESSAGES').join('\n')).not.toContain('others');
  });

  it('only the domains overflowed: the domain lists say approximate, the sender lists do not', () => {
    const s = stats({
      approximate: true,
      senders: { byCount: [ranked('a@x.test')], bySize: [ranked('a@x.test')], others: NONE_YET },
      domains: {
        byCount: [ranked('x.test')],
        bySize: [ranked('x.test')],
        others: { messages: 2, bytes: 20 },
      },
    });
    expect(headings(s)).toEqual([
      'TOP SENDERS BY MESSAGES',
      'TOP SENDERS BY SIZE',
      'TOP DOMAINS BY MESSAGES (approximate)',
      'TOP DOMAINS BY SIZE (approximate)',
    ]);
    expect(section(s, 'TOP DOMAINS BY SIZE').at(-1)).toMatch(/^others\s+2\s+20 B$/);
  });

  it('no overflow: no heading says approximate', () => {
    const s = stats({
      senders: { byCount: [ranked('a@x.test')], bySize: [ranked('a@x.test')], others: NONE_YET },
      domains: { byCount: [ranked('x.test')], bySize: [ranked('x.test')], others: NONE_YET },
    });
    expect(lines(s).join('\n')).not.toContain('approximate');
  });
});

describe('statsLines — null keys', () => {
  it('"(no domain)" in the domain lists, "(no address)" in the sender lists', () => {
    const s = stats({
      senders: {
        byCount: [ranked('noat'), ranked(null)],
        bySize: [ranked(null)],
        others: NONE_YET,
      },
      domains: {
        byCount: [ranked(null, 2, 200)],
        bySize: [ranked(null, 2, 200)],
        others: NONE_YET,
      },
    });
    expect(section(s, 'TOP SENDERS BY MESSAGES')).toContain('(no address)  1  100 B');
    expect(section(s, 'TOP SENDERS BY SIZE')[1]).toMatch(/^\(no address\)\s+1\s+100 B$/);
    for (const heading of ['TOP DOMAINS BY MESSAGES', 'TOP DOMAINS BY SIZE']) {
      const rows = section(s, heading);
      expect(rows[1]).toMatch(/^\(no domain\)\s+2\s+200 B$/);
      expect(rows.join('\n')).not.toContain('(no address)');
    }
  });
});

describe('statsLines — keys sanitising leaves empty', () => {
  it('a key made only of control or bidi characters → "(unreadable)"; null keeps its own text', () => {
    const s = stats({
      senders: {
        byCount: [ranked('\u202e\u001b', 2, 200), ranked(null)],
        bySize: [ranked(' \u200f ', 2, 200)],
        others: NONE_YET,
      },
      domains: { byCount: [ranked('\u202e', 2, 200), ranked(null)], bySize: [], others: NONE_YET },
    });
    const senders = section(s, 'TOP SENDERS BY MESSAGES');
    expect(senders[1]).toMatch(/^\(unreadable\)\s+2\s+200 B$/);
    expect(senders[2]).toMatch(/^\(no address\)\s+1\s+100 B$/);
    expect(section(s, 'TOP SENDERS BY SIZE')[1]).toMatch(/^\(unreadable\)\s+2\s+200 B$/);
    const domains = section(s, 'TOP DOMAINS BY MESSAGES');
    expect(domains[1]).toMatch(/^\(unreadable\)\s+2\s+200 B$/);
    expect(domains[2]).toMatch(/^\(no domain\)\s+1\s+100 B$/);
  });
});

describe('statsLines — LARGEST MAILS sender', () => {
  it.each<[string, string | null]>([
    ['blank name and address', '   '],
    ['empty', ''],
    ['only characters sanitising removes', '\u001b‮'],
    ['null', null],
  ])('%s → "(no address)"', (_name, from) => {
    expect(largestRow(largest({ from }))).toMatch(
      /^2024-06-15\s+2\.0 KB\s+\(no address\)\s+Report\s+\(INBOX\)$/,
    );
  });

  it('surrounding spaces are trimmed', () => {
    expect(largestRow(largest({ from: '  Pad@Ex.com  ' }))).toMatch(
      /^2024-06-15\s+2\.0 KB {2}Pad@Ex\.com {2}Report {2}\(INBOX\)$/,
    );
  });

  it('a long sender is cut to 40 characters with …', () => {
    const row = largestRow(largest({ from: `  ${'n'.repeat(100)}` }));
    expect(row).toContain(`  ${'n'.repeat(39)}…  Report`);
  });
});

describe('statsLines — LARGEST MAILS subject', () => {
  it.each<[string, string | null]>([
    ['spaces only', '   '],
    ['empty', ''],
    ['only characters sanitising removes', '\u001b\u202e'],
    ['null', null],
  ])('%s → "(no subject)"', (_name, subject) => {
    expect(largestRow(largest({ subject }))).toMatch(
      /^2024-06-15\s+2\.0 KB {2}Alice {2}\(no subject\) {2}\(INBOX\)$/,
    );
  });

  it('surrounding spaces are trimmed; a long subject is cut to 80 with …', () => {
    expect(largestRow(largest({ subject: '  Report  ' }))).toMatch(
      / {2}Alice {2}Report {2}\(INBOX\)$/,
    );
    const row = largestRow(largest({ subject: ` ${'q'.repeat(200)}` }));
    expect(row).toContain(`  Alice  ${'q'.repeat(79)}…  (INBOX)`);
  });
});

describe('statsLines — LARGEST MAILS date', () => {
  it.each<[string, Date | null]>([
    ['year 0', new Date('0000-06-15T12:00:00Z')],
    ['year 1899', new Date('1899-06-15T12:00:00Z')],
    ['year 2201', new Date('2201-01-01T12:00:00Z')],
    ['an invalid date', new Date(NaN)],
    ['no date', null],
  ])('%s → "-"', (_name, received) => {
    expect(largestRow(largest({ received }))).toMatch(/^-\s+2\.0 KB\s/);
  });

  it.each<[Date, string]>([
    [new Date('1900-01-01T00:00:00Z'), '1900-01-01'],
    [new Date('2200-12-31T12:00:00Z'), '2200-12-31'],
    [new Date('2024-06-15T12:00:00Z'), '2024-06-15'],
  ])('%s → %s (inside 1900–2200)', (received, day) => {
    expect(largestRow(largest({ received }))).toMatch(new RegExp(`^${day}\\s+2\\.0 KB\\s`));
  });

  it('the day and the year range are taken in the given time zone', () => {
    const mail = largest({ received: new Date('2200-12-31T23:30:00Z') });
    const row = (timeZone: string): string | undefined => {
      const all = statsLines(stats({ largest: [mail] }), tree(), { wholeMailbox: false, timeZone });
      return all[all.indexOf('LARGEST MAILS') + 1];
    };
    expect(row('UTC')).toMatch(/^2200-12-31\s+2\.0 KB\s/);
    // 2201-01-01 in Kiritimati (UTC+14): outside the range.
    expect(row('Pacific/Kiritimati')).toMatch(/^-\s+2\.0 KB\s/);
    // 2200-12-31 in Honolulu (UTC−10), still inside.
    expect(row('Pacific/Honolulu')).toMatch(/^2200-12-31\s+2\.0 KB\s/);
  });
});

describe('statsLines — long keys', () => {
  it('a 300-character sender or domain is cut to 60 with …; the table stays narrow', () => {
    const longSender = `${'s'.repeat(290)}@x.test`;
    const longDomain = `${'d'.repeat(300)}.test`;
    const s = stats({
      senders: {
        byCount: [ranked(longSender), ranked('b@y.test')],
        bySize: [ranked(longSender)],
        others: NONE_YET,
      },
      domains: { byCount: [ranked(longDomain)], bySize: [ranked(longDomain)], others: NONE_YET },
    });
    for (const heading of [
      'TOP SENDERS BY MESSAGES',
      'TOP SENDERS BY SIZE',
      'TOP DOMAINS BY MESSAGES',
      'TOP DOMAINS BY SIZE',
    ]) {
      const rows = section(s, heading).slice(1);
      for (const row of rows) expect([...row].length).toBeLessThanOrEqual(60 + 2 + 1 + 2 + 5);
      expect(rows[0]).toMatch(/^[sd]{59}…\s+1\s+100 B$/);
    }
    const senders = section(s, 'TOP SENDERS BY MESSAGES');
    expect(senders[2]).toMatch(/^b@y\.test\s+1\s+100 B$/);
    expect(senders[2]?.length).toBe(senders[1]?.length);
  });

  it('a key of exactly 60 characters is kept whole', () => {
    const key = 'k'.repeat(60);
    const s = stats({ senders: { byCount: [ranked(key)], bySize: [], others: NONE_YET } });
    expect(section(s, 'TOP SENDERS BY MESSAGES')[1]).toBe(`${key}  1  100 B`);
  });
});
