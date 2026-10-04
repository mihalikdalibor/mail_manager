import { describe, it, expect } from 'vitest';
import {
  folderLines,
  foldersJson,
  footerLines,
  formatBytes,
  quotaLine,
  sizeText,
  totalsLine,
} from '../../src/cli/folders-text.js';
import { sanitize } from '../../src/cli/log-text.js';
import type { FolderInfo, FolderRole, FolderTree } from '../../src/core/mailbox/folders.js';

// M2a `mm folders` text + JSON output (spec), over hand-built FolderTrees.

const ACCT = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';

function folder(path: string, over: Partial<FolderInfo> = {}): FolderInfo {
  const parts = path.split('/');
  return {
    path,
    name: parts[parts.length - 1] ?? path,
    parentPath: parts.length > 1 ? parts.slice(0, -1).join('/') : null,
    depth: parts.length - 1,
    delimiter: '/',
    role: null,
    roleSource: null,
    selectable: true,
    subscribed: true,
    messages: 42,
    unseen: 7,
    bytes: 1536,
    sizeSource: 'server',
    overlapping: false,
    ...over,
  };
}

function tree(folders: FolderInfo[], over: Partial<FolderTree> = {}): FolderTree {
  return {
    folders,
    totals: { messages: 15, unseen: 3, bytes: 1536, sizeSource: 'server' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
    ...over,
  };
}

function onlyLine(f: FolderInfo, sizes = true): string {
  const lines = folderLines(tree([f]), { sizes });
  expect(lines).toHaveLength(1);
  return lines[0] ?? '';
}

const ESC = '\u001b';
const RLO = '‮';

describe('formatBytes / sizeText', () => {
  it.each<[number, string]>([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [Math.round(12.3 * 1024 * 1024), '12.3 MB'],
    [1024 ** 3, '1.0 GB'],
    [2 * 1024 ** 4, '2.0 TB'],
  ])('formatBytes(%i) → %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it('sizeText: null → "—"; added up by us → "~" + formatBytes; from the server → exact', () => {
    expect(sizeText(null)).toBe('—');
    expect(sizeText(1536)).toBe('~1.5 KB');
    expect(sizeText(0)).toBe('~0 B');
    expect(sizeText(1536, 'sum')).toBe('~1.5 KB');
    expect(sizeText(1536, 'server')).toBe('1.5 KB');
    expect(sizeText(null, 'server')).toBe('—');
  });
});

describe('folderLines', () => {
  it('one line per folder, in tree order', () => {
    const folders = [folder('INBOX'), folder('INBOX/Sub'), folder('Zeta')];
    const lines = folderLines(tree(folders), { sizes: true });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('INBOX');
    expect(lines[1]).toContain('Sub');
    expect(lines[2]).toContain('Zeta');
  });

  it('indents two spaces per depth', () => {
    const folders = [
      folder('Alpha', { messages: 1, unseen: 1 }),
      folder('Alpha/Beta', { messages: 1, unseen: 1 }),
      folder('Alpha/Beta/Gamma', { messages: 1, unseen: 1 }),
    ];
    const lines = folderLines(tree(folders), { sizes: false });
    const at = (i: number, name: string): number => (lines[i] ?? '').indexOf(name);
    expect(at(0, 'Alpha')).toBeGreaterThanOrEqual(0);
    expect(at(1, 'Beta') - at(0, 'Alpha')).toBe(2);
    expect(at(2, 'Gamma') - at(0, 'Alpha')).toBe(4);
  });

  it('shows the name sanitised (control chars, ANSI escapes, bidi)', () => {
    const name = `Evil${ESC}[31mRed${RLO}gnp.exe\u0007bell`;
    const line = onlyLine(folder(name, { name, path: name }));
    expect(line).toContain(sanitize(name));
    expect(line).not.toContain(ESC);
    expect(line).not.toContain(RLO);
    expect(line).not.toContain('\u0007');
  });

  it('cuts the name to at most 200 characters', () => {
    const name = 'a'.repeat(300);
    const line = onlyLine(folder(name, { name, path: name }));
    expect(line).toContain('a'.repeat(200));
    expect(line).not.toContain('a'.repeat(201));
  });

  it.each<[FolderRole, string]>([
    ['inbox', '[Inbox]'],
    ['sent', '[Sent]'],
    ['trash', '[Trash]'],
    ['drafts', '[Drafts]'],
    ['archive', '[Archive]'],
    ['all', '[All Mail]'],
    ['junk', '[Junk]'],
    ['flagged', '[Flagged]'],
  ])('role %s → %s', (role, tag) => {
    expect(onlyLine(folder('Box', { role, roleSource: 'extension' }))).toContain(tag);
  });

  it('no role → no role tag', () => {
    const line = onlyLine(folder('Box'));
    for (const tag of ['[Inbox]', '[Sent]', '[Trash]', '[All Mail]', '[Junk]']) {
      expect(line).not.toContain(tag);
    }
  });

  it('flags: hidden, overlapping, not selectable', () => {
    const plain = onlyLine(folder('Box'));
    expect(plain).not.toContain('(hidden)');
    expect(plain).not.toContain('(overlapping)');
    expect(plain).not.toContain('(not selectable)');
    expect(onlyLine(folder('Box', { subscribed: false }))).toContain('(hidden)');
    expect(onlyLine(folder('Box', { overlapping: true }))).toContain('(overlapping)');
    expect(
      onlyLine(folder('Box', { selectable: false, messages: null, unseen: null, bytes: null })),
    ).toContain('(not selectable)');
  });

  it('message and unread counts; "—" for null', () => {
    const line = onlyLine(folder('Box', { messages: 42, unseen: 7 }));
    expect(line).toContain('42');
    expect(line).toContain('7');
    const nulls = onlyLine(folder('Box', { messages: null, unseen: null, bytes: null }));
    expect(nulls).toContain('—');
    expect(nulls).not.toContain('42');
  });

  it('sizes: true → the size ("~" only when added up by us); "—" for null bytes', () => {
    expect(onlyLine(folder('Box', { bytes: 1536, sizeSource: 'sum' }), true)).toContain('~1.5 KB');
    const exact = onlyLine(folder('Box', { bytes: 1536, sizeSource: 'server' }), true);
    expect(exact).toContain('1.5 KB');
    expect(exact).not.toContain('~');
    const line = onlyLine(folder('Box', { bytes: null, sizeSource: null }), true);
    expect(line).toContain('—');
    expect(line).not.toContain('~');
  });

  it('sizes: false → no size text at all', () => {
    const line = onlyLine(folder('Box', { bytes: 1536 }), false);
    expect(line).not.toContain('~');
    expect(line).not.toContain('1.5 KB');
    expect(line).not.toContain('KB');
  });
});

describe('totalsLine', () => {
  it('total messages, unread and (with sizes) the size', () => {
    const t = tree([folder('INBOX')]);
    const line = totalsLine(t, { sizes: true });
    expect(line).toContain('15');
    expect(line).toContain('3');
    expect(line).toContain('1.5 KB'); // the fixture total comes from the server: exact, no "~"
    expect(line).not.toContain('~');
    const summed = tree([folder('INBOX')], {
      totals: { messages: 15, unseen: 3, bytes: 1536, sizeSource: 'sum' },
    });
    expect(totalsLine(summed, { sizes: true })).toContain('~1.5 KB');
  });

  it('no size without sizes', () => {
    const line = totalsLine(tree([folder('INBOX')]), { sizes: false });
    expect(line).toContain('15');
    expect(line).not.toContain('~');
    expect(line).not.toContain('KB');
  });

  it('Gmail All Mail hidden → tells the user to show it in IMAP', () => {
    const line = totalsLine(tree([folder('INBOX')], { totals: null, gmailAllHidden: true }), {
      sizes: true,
    });
    expect(line).toContain('All Mail is hidden from IMAP');
    expect(line).toContain('Show in IMAP');
  });

  it('totals null otherwise → unknown', () => {
    const line = totalsLine(tree([folder('INBOX')], { totals: null }), { sizes: true });
    expect(line).toContain('unknown');
    expect(line).not.toContain('Show in IMAP');
  });
});

describe('quotaLine', () => {
  it('used and limit', () => {
    const line = quotaLine(tree([], { quota: { usedBytes: 2048, limitBytes: 4096 } }));
    expect(line).toContain(formatBytes(2048));
    expect(line).toContain(formatBytes(4096));
  });

  it('used without a limit', () => {
    const line = quotaLine(tree([], { quota: { usedBytes: 3 * 1024 ** 3, limitBytes: null } }));
    expect(line).toContain('3.0 GB');
  });

  it('no quota (unsupported or no limit set) → one "not available" text', () => {
    expect(quotaLine(tree([], { quota: null }))).toBe('Quota: not available from the mail server');
  });
});

describe('footerLines', () => {
  it('nothing when not truncated and all readable', () => {
    expect(footerLines(tree([]))).toEqual([]);
  });

  it('truncated → first 5,000 folders', () => {
    const lines = footerLines(tree([], { truncated: true }));
    expect(lines.some((l) => l.includes('first 5,000 folders'))).toBe(true);
  });

  it('unreadable: plural and singular', () => {
    expect(
      footerLines(tree([], { unreadable: 3 })).some((l) =>
        l.includes('3 folders could not be read'),
      ),
    ).toBe(true);
    const one = footerLines(tree([], { unreadable: 1 }));
    expect(one.some((l) => l.includes('1 folder could not be read'))).toBe(true);
    expect(one.some((l) => l.includes('folders could not'))).toBe(false);
  });

  it('both → both lines', () => {
    const lines = footerLines(tree([], { truncated: true, unreadable: 2 }));
    expect(lines.some((l) => l.includes('first 5,000 folders'))).toBe(true);
    expect(lines.some((l) => l.includes('2 folders could not be read'))).toBe(true);
  });
});

describe('foldersJson', () => {
  const FOLDER_KEYS = [
    'bytes',
    'depth',
    'messages',
    'name',
    'overlapping',
    'parent',
    'path',
    'role',
    'roleSource',
    'selectable',
    'sizeSource',
    'subscribed',
    'unseen',
  ];

  it('v1 shape with the account id', () => {
    const t = tree(
      [
        folder('INBOX', { role: 'inbox', roleSource: 'path' }),
        folder('INBOX/Sub', { subscribed: false, bytes: null, sizeSource: null }),
      ],
      { quota: { usedBytes: 10, limitBytes: null }, truncated: true, unreadable: 1 },
    );
    const j = foldersJson(t, ACCT);
    expect(Object.keys(j).sort()).toEqual(
      ['account', 'folders', 'quota', 'totals', 'truncated', 'unreadable', 'v'].sort(),
    );
    expect(j.v).toBe(1);
    expect(j.account).toBe(ACCT);
    expect(j.totals).toEqual(t.totals);
    expect(j.quota).toEqual({ usedBytes: 10, limitBytes: null });
    expect(j.truncated).toBe(true);
    expect(j.unreadable).toBe(1);
    expect(j.folders).toHaveLength(2);
    for (const f of j.folders) expect(Object.keys(f).sort()).toEqual(FOLDER_KEYS);
    expect(j.folders[0]).toEqual({
      path: 'INBOX',
      name: 'INBOX',
      parent: null,
      depth: 0,
      role: 'inbox',
      roleSource: 'path',
      selectable: true,
      subscribed: true,
      messages: 42,
      unseen: 7,
      bytes: 1536,
      sizeSource: 'server',
      overlapping: false,
    });
    expect(j.folders[1]).toMatchObject({
      path: 'INBOX/Sub',
      parent: 'INBOX',
      depth: 1,
      subscribed: false,
      bytes: null,
    });
  });

  it('round-trips through JSON.stringify', () => {
    const j = foldersJson(tree([folder('INBOX'), folder('A/B')]), ACCT);
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });

  it('sanitises hostile names and paths', () => {
    const name = `Bad${ESC}[31m${RLO}name\u0000`;
    const path = `INBOX/${name}`;
    const j = foldersJson(tree([folder(path, { name })]), ACCT);
    expect(j.folders[0]?.name).toBe(sanitize(name));
    expect(j.folders[0]?.path).toBe(sanitize(path));
    const text = JSON.stringify(j);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain('\\u001b');
    expect(text).not.toContain(RLO);
    expect(text).not.toContain('\\u202e');
    expect(text).not.toContain('\\u0000');
  });
});
