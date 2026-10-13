import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  FileRememberedUsers,
  MAX_REMEMBERED,
  MemoryRememberedUsers,
  REMEMBERED_FILE,
} from '../../src/core/remembered-users.js';
import type { RememberedUsers } from '../../src/core/remembered-users.js';

// M2d-1 remembered sign-in addresses (spec AC5): `<dir>/users.json` = {"v":1,"emails":[...]},
// newest first, at most 10, never throws. Written from the acceptance criteria only.

const posixOnly = process.platform === 'win32' ? it.skip : it;
// Permission-denied cases cannot be provoked as root.
const notRoot = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function addresses(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `user${String(i + 1)}@example.com`);
}

function contract(name: string, make: () => RememberedUsers): void {
  describe(`${name}: the RememberedUsers contract`, () => {
    it('a new store lists nothing', () => {
      expect(make().list()).toEqual([]);
    });

    it('add puts the newest address first', () => {
      const r = make();
      r.add('a@example.com');
      r.add('b@example.com');
      r.add('c@example.com');
      expect(r.list()).toEqual(['c@example.com', 'b@example.com', 'a@example.com']);
    });

    it('add of a known address moves it to the front, without a duplicate', () => {
      const r = make();
      r.add('a@example.com');
      r.add('b@example.com');
      r.add('c@example.com');
      r.add('a@example.com');
      expect(r.list()).toEqual(['a@example.com', 'c@example.com', 'b@example.com']);
    });

    it('add keeps at most MAX_REMEMBERED (10), dropping the oldest', () => {
      expect(MAX_REMEMBERED).toBe(10);
      const r = make();
      for (const a of addresses(12)) r.add(a);
      const list = r.list();
      expect(list).toHaveLength(10);
      expect(list[0]).toBe('user12@example.com');
      expect(list[9]).toBe('user3@example.com');
      expect(list).not.toContain('user1@example.com');
      expect(list).not.toContain('user2@example.com');
    });

    it('remove deletes one address and keeps the order of the rest', () => {
      const r = make();
      r.add('a@example.com');
      r.add('b@example.com');
      r.add('c@example.com');
      r.remove('b@example.com');
      expect(r.list()).toEqual(['c@example.com', 'a@example.com']);
    });

    it('remove of an unknown address changes nothing and does not throw', () => {
      const r = make();
      r.add('a@example.com');
      expect(() => r.remove('nobody@example.com')).not.toThrow();
      expect(r.list()).toEqual(['a@example.com']);
    });

    it('remove on an empty store does not throw', () => {
      expect(() => make().remove('a@example.com')).not.toThrow();
    });

    it('add stores the address normalised (trimmed, lower-case), and a duplicate in another case is one entry', () => {
      const r = make();
      r.add('  Alice@Example.COM ');
      expect(r.list()).toEqual(['alice@example.com']);
      r.add('ALICE@example.com');
      expect(r.list()).toEqual(['alice@example.com']);
    });
  });
}

contract('MemoryRememberedUsers', () => new MemoryRememberedUsers());

describe('MemoryRememberedUsers: initial list', () => {
  it('starts with the given addresses, newest first', () => {
    const r = new MemoryRememberedUsers(['b@example.com', 'a@example.com']);
    expect(r.list()).toEqual(['b@example.com', 'a@example.com']);
    r.add('c@example.com');
    expect(r.list()).toEqual(['c@example.com', 'b@example.com', 'a@example.com']);
  });
});

describe('FileRememberedUsers', () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mm-m2d1-users-'));
    dir = join(root, 'config');
  });

  afterEach(() => {
    // A test may have made the directory read-only.
    for (const p of [dir, join(dir, REMEMBERED_FILE)]) {
      if (existsSync(p)) chmodSync(p, 0o700);
    }
    rmSync(root, { recursive: true, force: true });
  });

  let counter = 0;
  contract('FileRememberedUsers', () => {
    counter += 1;
    return new FileRememberedUsers(join(root, `contract-${String(counter)}`));
  });

  function users(): FileRememberedUsers {
    return new FileRememberedUsers(dir);
  }

  function raw(content: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, REMEMBERED_FILE), content);
  }

  describe('storage', () => {
    it('REMEMBERED_FILE is users.json and `file` is <dir>/users.json', () => {
      expect(REMEMBERED_FILE).toBe('users.json');
      expect(users().file).toBe(join(dir, 'users.json'));
    });

    it('nothing is created before the first add', () => {
      users().list();
      expect(existsSync(dir)).toBe(false);
    });

    it('add writes {"v":1,"emails":[...]} (newest first) to users.json, creating the directory', () => {
      const r = users();
      r.add('a@example.com');
      r.add('b@example.com');
      const parsed: unknown = JSON.parse(readFileSync(r.file, 'utf8'));
      expect(parsed).toEqual({ v: 1, emails: ['b@example.com', 'a@example.com'] });
    });

    it('a second instance over the same directory sees what the first stored', () => {
      users().add('a@example.com');
      expect(users().list()).toEqual(['a@example.com']);
    });

    posixOnly('the directory is mode 700 and the file mode 600', () => {
      const r = users();
      r.add('a@example.com');
      expect(mode(dir)).toBe(0o700);
      expect(mode(r.file)).toBe(0o600);
      r.add('b@example.com');
      expect(mode(r.file)).toBe(0o600);
    });

    it('writes go through a temp file + rename: no other file is left in the directory', () => {
      const r = users();
      r.add('a@example.com');
      r.add('b@example.com');
      r.remove('a@example.com');
      expect(readdirSync(dir)).toEqual([REMEMBERED_FILE]);
    });

    it('remove of the last address deletes the file', () => {
      const r = users();
      r.add('a@example.com');
      expect(existsSync(r.file)).toBe(true);
      r.remove('a@example.com');
      expect(existsSync(r.file)).toBe(false);
      expect(r.list()).toEqual([]);
    });

    it('remove of one of two keeps the file with the other one', () => {
      const r = users();
      r.add('a@example.com');
      r.add('b@example.com');
      r.remove('b@example.com');
      const parsed: unknown = JSON.parse(readFileSync(r.file, 'utf8'));
      expect(parsed).toEqual({ v: 1, emails: ['a@example.com'] });
    });

    it('add stores at most 10 in the file', () => {
      const r = users();
      for (const a of addresses(15)) r.add(a);
      const parsed = JSON.parse(readFileSync(r.file, 'utf8')) as { emails: string[] };
      expect(parsed.emails).toHaveLength(10);
    });
  });

  describe('list: a damaged or hand-edited file', () => {
    it('a missing file lists nothing', () => {
      mkdirSync(dir, { recursive: true });
      expect(users().list()).toEqual([]);
    });

    it.each([
      ['not JSON', 'this is { not json'],
      ['empty file', ''],
      ['JSON null', 'null'],
      ['a JSON array', '["a@example.com"]'],
      ['a string', '"a@example.com"'],
      ['a wrong version', '{"v":2,"emails":["a@example.com"]}'],
      ['a missing version', '{"emails":["a@example.com"]}'],
      ['a string version', '{"v":"1","emails":["a@example.com"]}'],
      ['emails missing', '{"v":1}'],
      ['emails a string', '{"v":1,"emails":"a@example.com"}'],
      ['emails an object', '{"v":1,"emails":{"0":"a@example.com"}}'],
      ['emails null', '{"v":1,"emails":null}'],
    ])('%s -> [] and no throw', (_name, content) => {
      raw(content);
      expect(() => users().list()).not.toThrow();
      expect(users().list()).toEqual([]);
    });

    it('a corrupt file does not stop add: the next add starts a fresh valid file', () => {
      raw('this is { not json');
      const r = users();
      expect(() => {
        r.add('a@example.com');
      }).not.toThrow();
      expect(r.list()).toEqual(['a@example.com']);
    });

    it('entries that are not valid addresses are dropped, the valid ones stay in order', () => {
      raw(
        JSON.stringify({
          v: 1,
          emails: [
            'first@example.com',
            'no-at-sign',
            '',
            '   ',
            'two words@example.com',
            'user@',
            '@example.com',
            'second@example.com',
          ],
        }),
      );
      expect(users().list()).toEqual(['first@example.com', 'second@example.com']);
    });

    it('entries that are not strings: the whole file is the wrong shape -> []', () => {
      raw(
        JSON.stringify({
          v: 1,
          emails: [
            'first@example.com',
            42,
            null,
            { email: 'obj@example.com' },
            ['arr@example.com'],
            'second@example.com',
          ],
        }),
      );
      expect(users().list()).toEqual([]);
    });

    it('an entry longer than 320 characters: the whole file is the wrong shape -> []', () => {
      const tooLong = `${'x'.repeat(321 - '@example.com'.length)}@example.com`;
      expect(tooLong).toHaveLength(321);
      raw(JSON.stringify({ v: 1, emails: ['first@example.com', tooLong] }));
      expect(users().list()).toEqual([]);
    });

    it('an extra top-level key: the whole file is the wrong shape -> []', () => {
      raw(JSON.stringify({ v: 1, emails: ['first@example.com'], extra: true }));
      expect(users().list()).toEqual([]);
    });

    it('entries with control, bidi or zero-width characters are dropped', () => {
      raw(
        JSON.stringify({
          v: 1,
          emails: [
            'bel\u0007@example.com',
            'esc\u001b[31m@example.com',
            'bidi\u202e@example.com',
            'zero\u200bwidth@example.com',
            'nl\n@example.com',
            'ok@example.com',
          ],
        }),
      );
      expect(users().list()).toEqual(['ok@example.com']);
    });

    it.each([10, 11, 100])('%i valid entries -> the first 10, in file order', (n) => {
      raw(JSON.stringify({ v: 1, emails: addresses(n) }));
      expect(users().list()).toEqual(addresses(10));
    });

    it.each([101, 1000])('an oversized file (%i entries) counts as the wrong shape -> []', (n) => {
      raw(JSON.stringify({ v: 1, emails: addresses(n) }));
      expect(users().list()).toEqual([]);
    });

    it('add on top of an oversized file leaves exactly the new address', () => {
      raw(JSON.stringify({ v: 1, emails: addresses(1000) }));
      const r = users();
      r.add('new@example.com');
      expect(r.list()).toEqual(['new@example.com']);
    });
  });

  describe('never throws', () => {
    it('the directory path is a regular file: list, add and remove all stay quiet', () => {
      mkdirSync(root, { recursive: true });
      writeFileSync(dir, 'in the way');
      const r = users();
      expect(r.list()).toEqual([]);
      expect(() => {
        r.add('a@example.com');
      }).not.toThrow();
      expect(() => {
        r.remove('a@example.com');
      }).not.toThrow();
      expect(r.list()).toEqual([]);
    });

    it('users.json is a directory: list is [], add and remove do not throw', () => {
      mkdirSync(join(dir, REMEMBERED_FILE), { recursive: true });
      const r = users();
      expect(r.list()).toEqual([]);
      expect(() => {
        r.add('a@example.com');
      }).not.toThrow();
      expect(() => {
        r.remove('a@example.com');
      }).not.toThrow();
    });

    notRoot(
      'a read-only directory: add and remove do not throw, the address is just not stored',
      () => {
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o500);
        const r = users();
        expect(() => {
          r.add('a@example.com');
        }).not.toThrow();
        expect(() => {
          r.remove('a@example.com');
        }).not.toThrow();
        expect(r.list()).toEqual([]);
      },
    );

    notRoot('an unreadable users.json: list is [] and does not throw', () => {
      const r = users();
      r.add('a@example.com');
      chmodSync(r.file, 0o000);
      expect(() => r.list()).not.toThrow();
      expect(r.list()).toEqual([]);
    });
  });
});
