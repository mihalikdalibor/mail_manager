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
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  FileRememberedUsers,
  MAX_REMEMBERED,
  MemoryRememberedUsers,
  REMEMBERED_FILE,
  normalizeEmail,
} from '../../src/core/remembered-users.js';
import type { RememberedUsers } from '../../src/core/remembered-users.js';

// M2d-1 remembered users: the e-mail addresses of earlier sign-ins in <config dir>/users.json.
// Addresses are placeholders on a reserved-looking test domain; hostile characters are written
// as escapes.

// vi.hoisted: the vi.mock factory is hoisted above the static imports, so its switch must be too.
const failing = vi.hoisted(() => ({ write: false, rename: false }));

// The real node:fs, except that a write or a rename can be made to fail (a full or read-only
// disk) - the only way to stop a write half way without being another user.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const refuse = (): never => {
    throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
  };
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>): void => {
      if (failing.write) refuse();
      actual.writeFileSync(...args);
    },
    renameSync: (from: string, to: string): void => {
      if (failing.rename) refuse();
      actual.renameSync(from, to);
    },
  };
});

const ANNA = 'anna@example-test-domain.eu';
const BEN = 'ben@example-test-domain.eu';
const CYRIL = 'cyril@example-test-domain.eu';

const posixOnly = process.platform === 'win32' ? it.skip : it;
const posixNonRoot = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;

/** Text that must never be stored: not an address, or an address carrying invisible characters. */
const NOT_ADDRESSES: [string, string][] = [
  ['empty', ''],
  ['spaces only', '   '],
  ['no @', 'anna.example-test-domain.eu'],
  ['no name before @', '@example-test-domain.eu'],
  ['no domain after @', 'anna@'],
  ['a one-label domain', 'anna@localhost'],
  ['an IP address as the domain', 'anna@127.0.0.1'],
  ['a space in the name', 'an na@example-test-domain.eu'],
  ['a password typed into the e-mail field', 'CANARY-Passw0rd!'],
  ['a NUL in the name', 'an\u0000na@example-test-domain.eu'],
  ['an escape sequence in the name', '\u001b[31manna@example-test-domain.eu'],
  ['a bidi override in the name', 'an\u202ena@example-test-domain.eu'],
  ['a zero-width space in the name', 'an\u200bna@example-test-domain.eu'],
  ['a line break in the domain', 'anna@example-test-\ndomain.eu'],
  ['a path after the domain', 'anna@example-test-domain.eu/x'],
  ['longer than an address can be', `${'a'.repeat(250)}@example-test-domain.eu`],
];

function numbered(n: number): string {
  return `user${String(n)}@example-test-domain.eu`;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function contractTests(name: string, make: () => RememberedUsers): void {
  describe(`${name} (RememberedUsers contract)`, () => {
    it('starts empty', () => {
      expect(make().list()).toEqual([]);
    });

    it('lists the newest first', () => {
      const users = make();
      users.add(ANNA);
      users.add(BEN);
      users.add(CYRIL);
      expect(users.list()).toEqual([CYRIL, BEN, ANNA]);
    });

    it('stores the address trimmed, the name and the domain lower-cased', () => {
      const users = make();
      users.add('  Anna@Example-Test-Domain.EU \n');
      expect(users.list()).toEqual([ANNA]);
    });

    it('stores an international domain in its ASCII form', () => {
      const users = make();
      users.add('Jana@Bücher.example');
      expect(users.list()).toEqual(['jana@xn--bcher-kva.example']);
    });

    it('adding a listed address again moves it first, without a duplicate', () => {
      const users = make();
      users.add(ANNA);
      users.add(BEN);
      users.add(CYRIL);
      users.add('ANNA@example-test-domain.eu');
      expect(users.list()).toEqual([ANNA, CYRIL, BEN]);
      users.add(ANNA);
      expect(users.list()).toEqual([ANNA, CYRIL, BEN]);
    });

    it(`keeps at most ${String(MAX_REMEMBERED)}: the oldest is dropped`, () => {
      const users = make();
      for (let n = 1; n <= MAX_REMEMBERED + 3; n++) users.add(numbered(n));
      const expected = Array.from({ length: MAX_REMEMBERED }, (_, i) =>
        numbered(MAX_REMEMBERED + 3 - i),
      );
      expect(users.list()).toEqual(expected);
      // Moving a listed one first drops nobody.
      users.add(numbered(4));
      expect(users.list()).toHaveLength(MAX_REMEMBERED);
      expect(users.list()[0]).toBe(numbered(4));
      expect(users.list()).toContain(numbered(5));
    });

    it.each(NOT_ADDRESSES)('add ignores %s', (_label, text) => {
      const users = make();
      users.add(ANNA);
      expect(() => users.add(text)).not.toThrow();
      expect(users.list()).toEqual([ANNA]);
    });

    it('remove deletes that address only, whatever its letter case', () => {
      const users = make();
      users.add(ANNA);
      users.add(BEN);
      users.add(CYRIL);
      users.remove(' BEN@Example-Test-Domain.eu ');
      expect(users.list()).toEqual([CYRIL, ANNA]);
    });

    it('remove of an address that is not listed changes nothing', () => {
      const users = make();
      users.add(ANNA);
      expect(() => users.remove(BEN)).not.toThrow();
      expect(users.list()).toEqual([ANNA]);
      expect(() => make().remove(BEN)).not.toThrow();
    });

    it.each(NOT_ADDRESSES)('remove ignores %s', (_label, text) => {
      const users = make();
      users.add(ANNA);
      expect(() => users.remove(text)).not.toThrow();
      expect(users.list()).toEqual([ANNA]);
    });

    it('list returns a copy: changing it does not change what is remembered', () => {
      const users = make();
      users.add(ANNA);
      users.list().push(BEN);
      expect(users.list()).toEqual([ANNA]);
    });
  });
}

describe('normalizeEmail', () => {
  it('gives the stored form: trimmed, the name lower-cased, the domain lower-case ASCII', () => {
    expect(normalizeEmail(ANNA)).toBe(ANNA);
    expect(normalizeEmail('  Anna@Example-Test-Domain.EU \n')).toBe(ANNA);
    expect(normalizeEmail('Jana@B\u00fccher.example')).toBe('jana@xn--bcher-kva.example');
    expect(normalizeEmail('JANA@XN--BCHER-KVA.example')).toBe('jana@xn--bcher-kva.example');
  });

  it('gives its own result back unchanged', () => {
    for (const email of [ANNA, 'Jana@B\u00fccher.example', ' Ben@Example-Test-Domain.eu']) {
      const once = normalizeEmail(email);
      expect(once).not.toBeNull();
      expect(normalizeEmail(once ?? '')).toBe(once);
    }
  });

  it.each(NOT_ADDRESSES)('%s is not an address: null, no throw', (_label, text) => {
    expect(() => normalizeEmail(text)).not.toThrow();
    expect(normalizeEmail(text)).toBeNull();
  });

  it('is the form both stores keep', () => {
    const typed = 'Jana@B\u00fccher.example';
    const memory = new MemoryRememberedUsers();
    memory.add(typed);
    expect(memory.list()).toEqual([normalizeEmail(typed)]);
    expect(new MemoryRememberedUsers([typed]).list()).toEqual([normalizeEmail(typed)]);
  });
});

describe('constants', () => {
  it('ten addresses in users.json', () => {
    expect(MAX_REMEMBERED).toBe(10);
    expect(REMEMBERED_FILE).toBe('users.json');
  });
});

contractTests('MemoryRememberedUsers', () => new MemoryRememberedUsers());

describe('MemoryRememberedUsers', () => {
  it('takes an initial list, newest first', () => {
    expect(new MemoryRememberedUsers([ANNA, BEN]).list()).toEqual([ANNA, BEN]);
    expect(new MemoryRememberedUsers().list()).toEqual([]);
  });

  it('cleans the initial list like a file: normalised, no duplicates, no non-addresses, capped', () => {
    const initial = [
      'Anna@EXAMPLE-test-domain.eu',
      'not an address',
      ANNA,
      'be\u202en@example-test-domain.eu',
      BEN,
    ];
    expect(new MemoryRememberedUsers(initial).list()).toEqual([ANNA, BEN]);
    const many = Array.from({ length: 40 }, (_, i) => numbered(i + 1));
    expect(new MemoryRememberedUsers(many).list()).toEqual(many.slice(0, MAX_REMEMBERED));
  });

  it('does not keep the array it was given', () => {
    const initial = [ANNA];
    const users = new MemoryRememberedUsers(initial);
    initial.push(BEN);
    users.add(CYRIL);
    expect(users.list()).toEqual([CYRIL, ANNA]);
    expect(initial).toEqual([ANNA, BEN]);
  });
});

describe('FileRememberedUsers', () => {
  let root: string;
  let dir: string;
  let contract = 0;

  beforeEach(() => {
    failing.write = false;
    failing.rename = false;
    root = mkdtempSync(join(tmpdir(), 'mm-users-'));
    dir = join(root, 'cfg');
  });

  afterEach(() => {
    failing.write = false;
    failing.rename = false;
    rmSync(root, { recursive: true, force: true });
  });

  function put(content: string): FileRememberedUsers {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const users = new FileRememberedUsers(dir);
    writeFileSync(users.file, content);
    return users;
  }

  function stored(users: FileRememberedUsers): unknown {
    return JSON.parse(readFileSync(users.file, 'utf8'));
  }

  contractTests('FileRememberedUsers', () => {
    contract += 1;
    return new FileRememberedUsers(join(root, `contract-${String(contract)}`));
  });

  it('exposes file = <dir>/users.json', () => {
    expect(new FileRememberedUsers(dir).file).toBe(join(dir, 'users.json'));
  });

  it('creates nothing until an address is added', () => {
    const users = new FileRememberedUsers(dir);
    expect(users.list()).toEqual([]);
    users.remove(ANNA);
    users.add('not an address');
    expect(existsSync(dir)).toBe(false);
  });

  it('writes {"v":1,"emails":[...]} and nothing else', () => {
    const users = new FileRememberedUsers(dir);
    users.add(ANNA);
    users.add('Ben@Example-Test-Domain.eu');
    expect(readFileSync(users.file, 'utf8')).toBe(JSON.stringify({ v: 1, emails: [BEN, ANNA] }));
    expect(Object.keys(stored(users) as object)).toEqual(['v', 'emails']);
  });

  it('is read by another instance on the same directory', () => {
    new FileRememberedUsers(dir).add(ANNA);
    const other = new FileRememberedUsers(dir);
    other.add(BEN);
    expect(new FileRememberedUsers(dir).list()).toEqual([BEN, ANNA]);
  });

  it('creates missing parent directories', () => {
    const users = new FileRememberedUsers(join(root, 'a', 'b', 'c'));
    users.add(ANNA);
    expect(users.list()).toEqual([ANNA]);
  });

  posixOnly('creates the directory with mode 700 and the file with mode 600', () => {
    const users = new FileRememberedUsers(dir);
    users.add(ANNA);
    expect(mode(dir)).toBe(0o700);
    expect(mode(users.file)).toBe(0o600);
    users.add(BEN);
    users.remove(ANNA);
    expect(mode(users.file)).toBe(0o600);
  });

  posixOnly('tightens an existing 755 directory and 644 file', () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const users = new FileRememberedUsers(dir);
    writeFileSync(users.file, JSON.stringify({ v: 1, emails: [ANNA] }));
    chmodSync(users.file, 0o644);
    users.add(BEN);
    expect(mode(dir)).toBe(0o700);
    expect(mode(users.file)).toBe(0o600);
    expect(users.list()).toEqual([BEN, ANNA]);
  });

  describe('atomic write', () => {
    it('leaves no temp file behind', () => {
      const users = new FileRememberedUsers(dir);
      users.add(ANNA);
      users.add(BEN);
      users.remove(ANNA);
      expect(readdirSync(dir)).toEqual(['users.json']);
    });

    posixOnly('never reuses a stale temp file', () => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const users = new FileRememberedUsers(dir);
      const stale = `${users.file}.tmp`;
      writeFileSync(stale, 'stale');
      chmodSync(stale, 0o644);
      users.add(ANNA);
      expect(mode(users.file)).toBe(0o600);
      expect(users.list()).toEqual([ANNA]);
      expect(readFileSync(stale, 'utf8')).toBe('stale');
      expect(readdirSync(dir).sort()).toEqual(['users.json', 'users.json.tmp']);
    });

    it('a rename that fails: no throw, no temp file, the list as it was', () => {
      const users = new FileRememberedUsers(dir);
      users.add(ANNA);
      users.add(BEN);
      const before = readFileSync(users.file, 'utf8');
      failing.rename = true;
      expect(() => users.add(CYRIL)).not.toThrow();
      expect(() => users.remove(ANNA)).not.toThrow();
      failing.rename = false;
      expect(readdirSync(dir)).toEqual(['users.json']);
      expect(readFileSync(users.file, 'utf8')).toBe(before);
      expect(users.list()).toEqual([BEN, ANNA]);
    });

    it('a write that fails: no throw, no temp file, the list as it was', () => {
      const users = new FileRememberedUsers(dir);
      users.add(ANNA);
      const before = readFileSync(users.file, 'utf8');
      failing.write = true;
      expect(() => users.add(BEN)).not.toThrow();
      failing.write = false;
      expect(readdirSync(dir)).toEqual(['users.json']);
      expect(readFileSync(users.file, 'utf8')).toBe(before);
      expect(users.list()).toEqual([ANNA]);
    });

    it('a first write that fails remembers nothing and leaves no file', () => {
      const users = new FileRememberedUsers(dir);
      failing.rename = true;
      expect(() => users.add(ANNA)).not.toThrow();
      failing.rename = false;
      expect(users.list()).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  describe('a file that is not a valid list reads as empty', () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => numbered(i + 1));
    it.each([
      ['an empty file', ''],
      ['invalid JSON', '{not json'],
      ['a cut-off file', '{"v":1,"emails":["anna@example-test-domain.eu"'],
      ['JSON null', 'null'],
      ['a JSON string', JSON.stringify(ANNA)],
      ['a JSON array', JSON.stringify([ANNA])],
      ['no version', JSON.stringify({ emails: [ANNA] })],
      ['another version', JSON.stringify({ v: 2, emails: [ANNA] })],
      ['the version as text', JSON.stringify({ v: '1', emails: [ANNA] })],
      ['no emails', JSON.stringify({ v: 1 })],
      ['emails not a list', JSON.stringify({ v: 1, emails: ANNA })],
      ['emails null', JSON.stringify({ v: 1, emails: null })],
      ['an entry that is not text', JSON.stringify({ v: 1, emails: [ANNA, 7] })],
      ['an entry that is a list', JSON.stringify({ v: 1, emails: [[ANNA]] })],
      ['an extra key', JSON.stringify({ v: 1, emails: [ANNA], password: 'x' })],
      ['an entry of more than 320 characters', JSON.stringify({ v: 1, emails: ['a'.repeat(321)] })],
      ['more than 100 entries', JSON.stringify({ v: 1, emails: tooMany })],
    ])('%s', (_label, content) => {
      const users = put(content);
      expect(() => users.list()).not.toThrow();
      expect(users.list()).toEqual([]);
      // Reading never rewrites the file.
      expect(readFileSync(users.file, 'utf8')).toBe(content);
    });

    it('users.json being a directory', () => {
      const users = new FileRememberedUsers(dir);
      mkdirSync(users.file, { recursive: true });
      expect(() => users.list()).not.toThrow();
      expect(users.list()).toEqual([]);
    });

    posixNonRoot('a file that may not be read', () => {
      const users = put(JSON.stringify({ v: 1, emails: [ANNA] }));
      chmodSync(users.file, 0o000);
      expect(() => users.list()).not.toThrow();
      expect(users.list()).toEqual([]);
    });
  });

  describe('a hand-edited file', () => {
    it('entries that are not addresses are dropped, the rest normalised and de-duplicated', () => {
      const users = put(
        JSON.stringify({
          v: 1,
          emails: [
            'not an address',
            'Anna@Example-Test-Domain.EU',
            '',
            'an\u202ena@example-test-domain.eu',
            '\u001b[2Jben@example-test-domain.eu',
            ANNA,
            BEN,
            'a'.repeat(320),
          ],
        }),
      );
      expect(users.list()).toEqual([ANNA, BEN]);
    });

    it(`shows the first ${String(MAX_REMEMBERED)} of a longer list`, () => {
      const many = Array.from({ length: 100 }, (_, i) => numbered(i + 1));
      const users = put(JSON.stringify({ v: 1, emails: many }));
      expect(users.list()).toEqual(many.slice(0, MAX_REMEMBERED));
    });

    it('add rewrites it clean', () => {
      const users = put(JSON.stringify({ v: 1, emails: ['not an address', 'ANNA@example.test'] }));
      users.add(BEN);
      expect(stored(users)).toEqual({ v: 1, emails: [BEN, 'anna@example.test'] });
    });

    it('add replaces a corrupt file', () => {
      const users = put('{not json');
      users.add(ANNA);
      expect(stored(users)).toEqual({ v: 1, emails: [ANNA] });
    });
  });

  describe('remove', () => {
    it('deletes the file when the list becomes empty', () => {
      const users = new FileRememberedUsers(dir);
      users.add(ANNA);
      users.add(BEN);
      users.remove(ANNA);
      expect(existsSync(users.file)).toBe(true);
      users.remove(BEN);
      expect(existsSync(users.file)).toBe(false);
      expect(users.list()).toEqual([]);
    });

    it('leaves the file alone when the address is not listed', () => {
      const content = `${JSON.stringify({ v: 1, emails: [ANNA] })}\n`;
      const users = put(content);
      users.remove(BEN);
      expect(readFileSync(users.file, 'utf8')).toBe(content);
    });

    it('does not throw without a file or a directory', () => {
      const users = new FileRememberedUsers(dir);
      expect(() => users.remove(ANNA)).not.toThrow();
      expect(existsSync(dir)).toBe(false);
    });
  });

  describe('a place that cannot be written never fails the caller', () => {
    it('the config directory is a file', () => {
      writeFileSync(dir, 'not a directory');
      const users = new FileRememberedUsers(dir);
      expect(() => users.add(ANNA)).not.toThrow();
      expect(() => users.remove(ANNA)).not.toThrow();
      expect(users.list()).toEqual([]);
      expect(readFileSync(dir, 'utf8')).toBe('not a directory');
    });

    it('users.json is a directory', () => {
      const users = new FileRememberedUsers(dir);
      mkdirSync(users.file, { recursive: true });
      expect(() => users.add(ANNA)).not.toThrow();
      expect(users.list()).toEqual([]);
      expect(readdirSync(dir)).toEqual(['users.json']);
    });

    posixNonRoot('the config directory cannot be created (read-only parent)', () => {
      chmodSync(root, 0o500);
      try {
        const users = new FileRememberedUsers(dir);
        expect(() => users.add(ANNA)).not.toThrow();
        expect(() => users.remove(ANNA)).not.toThrow();
        expect(users.list()).toEqual([]);
        expect(existsSync(dir)).toBe(false);
      } finally {
        chmodSync(root, 0o700);
      }
    });

    posixOnly('a read-only config directory', () => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o500);
      try {
        const users = new FileRememberedUsers(dir);
        expect(() => users.add(ANNA)).not.toThrow();
        expect(() => users.list()).not.toThrow();
        expect(() => users.remove(ANNA)).not.toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }
    });
  });
});
