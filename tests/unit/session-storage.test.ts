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
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  FileSessionStorage,
  MemorySessionStorage,
  sessionDir,
} from '../../src/core/db/supabase/session-storage.js';
import type { SessionStorage } from '../../src/core/db/supabase/session-storage.js';

const TOKEN = '{"access_token":"fake-access-TESTTOKEN","refresh_token":"fake-refresh"}';
const posixOnly = process.platform === 'win32' ? it.skip : it;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('sessionDir', () => {
  it('prefers MM_CONFIG_DIR', () => {
    expect(sessionDir({ MM_CONFIG_DIR: '/tmp/mm-a', XDG_CONFIG_HOME: '/tmp/xdg' })).toBe(
      '/tmp/mm-a',
    );
  });

  it('falls back to XDG_CONFIG_HOME/mail-manager', () => {
    expect(sessionDir({ MM_CONFIG_DIR: '', XDG_CONFIG_HOME: '/tmp/xdg' })).toBe(
      join('/tmp/xdg', 'mail-manager'),
    );
  });

  it('falls back to ~/.config/mail-manager', () => {
    expect(sessionDir({})).toBe(join(homedir(), '.config', 'mail-manager'));
    expect(sessionDir({ MM_CONFIG_DIR: '', XDG_CONFIG_HOME: '' })).toBe(
      join(homedir(), '.config', 'mail-manager'),
    );
  });
});

function contractTests(name: string, make: () => SessionStorage): void {
  describe(`${name} (SessionStorage contract)`, () => {
    it('returns null for a missing key', () => {
      expect(make().getItem('nope')).toBeNull();
    });

    it('stores, overwrites and removes values', () => {
      const s = make();
      s.setItem('a', TOKEN);
      s.setItem('b', 'two');
      expect(s.getItem('a')).toBe(TOKEN);
      s.setItem('a', 'one');
      expect(s.getItem('a')).toBe('one');
      s.removeItem('a');
      expect(s.getItem('a')).toBeNull();
      expect(s.getItem('b')).toBe('two');
    });

    it('removeItem of an unknown key does not throw', () => {
      const s = make();
      expect(() => s.removeItem('nope')).not.toThrow();
    });

    it('clear removes everything and is idempotent', () => {
      const s = make();
      s.setItem('a', '1');
      s.setItem('b', '2');
      s.clear();
      expect(s.getItem('a')).toBeNull();
      expect(s.getItem('b')).toBeNull();
      expect(() => s.clear()).not.toThrow();
    });

    it('isEmpty: true initially, false after setItem, true after clear', () => {
      const s = make();
      expect(s.isEmpty()).toBe(true);
      s.setItem('a', TOKEN);
      expect(s.isEmpty()).toBe(false);
      s.clear();
      expect(s.isEmpty()).toBe(true);
    });

    it('isEmpty: true after removeItem of the last key', () => {
      const s = make();
      s.setItem('a', '1');
      s.setItem('b', '2');
      s.removeItem('a');
      expect(s.isEmpty()).toBe(false);
      s.removeItem('b');
      expect(s.isEmpty()).toBe(true);
    });
  });
}

contractTests('MemorySessionStorage', () => new MemorySessionStorage());

describe('FileSessionStorage', () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mm-session-'));
    dir = join(root, 'cfg');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  contractTests('FileSessionStorage', () => new FileSessionStorage(join(root, 'contract')));

  it('exposes file = <dir>/session.json', () => {
    expect(new FileSessionStorage(dir).file).toBe(join(dir, 'session.json'));
  });

  it('does not create anything until a value is set', () => {
    const s = new FileSessionStorage(dir);
    expect(s.getItem('k')).toBeNull();
    expect(existsSync(s.file)).toBe(false);
  });

  it('persists a JSON map of string values across instances', () => {
    new FileSessionStorage(dir).setItem('sb-auth-token', TOKEN);
    const other = new FileSessionStorage(dir);
    expect(other.getItem('sb-auth-token')).toBe(TOKEN);
    const parsed: unknown = JSON.parse(readFileSync(other.file, 'utf8'));
    expect(parsed).toEqual({ 'sb-auth-token': TOKEN });
  });

  it('creates missing parent directories', () => {
    const deep = join(root, 'a', 'b', 'c');
    const s = new FileSessionStorage(deep);
    s.setItem('k', 'v');
    expect(existsSync(s.file)).toBe(true);
  });

  it('returns null (no throw) for corrupt JSON', () => {
    mkdirSync(dir, { recursive: true });
    const s = new FileSessionStorage(dir);
    writeFileSync(s.file, '{not json');
    expect(() => s.getItem('k')).not.toThrow();
    expect(s.getItem('k')).toBeNull();
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a JSON array', '["a","b"]'],
    ['only non-string values', '{"a":1,"b":{"c":"d"},"e":null}'],
  ])('a corrupt file (%s) counts as empty', (_label, content) => {
    mkdirSync(dir, { recursive: true });
    const s = new FileSessionStorage(dir);
    writeFileSync(s.file, content);
    expect(s.isEmpty()).toBe(true);
  });

  it('can overwrite a corrupt file with setItem', () => {
    mkdirSync(dir, { recursive: true });
    const s = new FileSessionStorage(dir);
    writeFileSync(s.file, '{not json');
    s.setItem('k', 'v');
    expect(new FileSessionStorage(dir).getItem('k')).toBe('v');
  });

  it('deletes the file when the last key is removed', () => {
    const s = new FileSessionStorage(dir);
    s.setItem('a', '1');
    s.setItem('b', '2');
    s.removeItem('a');
    expect(existsSync(s.file)).toBe(true);
    s.removeItem('b');
    expect(existsSync(s.file)).toBe(false);
  });

  it('clear deletes the file and does not throw when absent', () => {
    const s = new FileSessionStorage(dir);
    s.setItem('a', '1');
    s.clear();
    expect(existsSync(s.file)).toBe(false);
    expect(() => s.clear()).not.toThrow();
    expect(() => new FileSessionStorage(join(root, 'never-created')).clear()).not.toThrow();
  });

  posixOnly('creates the dir with mode 700 and the file with mode 600', () => {
    const s = new FileSessionStorage(dir);
    s.setItem('k', TOKEN);
    expect(mode(dir)).toBe(0o700);
    expect(mode(s.file)).toBe(0o600);
  });

  posixOnly('tightens an existing 644 session file to 600', () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const s = new FileSessionStorage(dir);
    writeFileSync(s.file, JSON.stringify({ old: 'x' }));
    chmodSync(s.file, 0o644);
    s.setItem('k', TOKEN);
    expect(mode(s.file)).toBe(0o600);
  });

  posixOnly('tightens an existing 755 dir to 700', () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const s = new FileSessionStorage(dir);
    s.setItem('k', TOKEN);
    expect(mode(dir)).toBe(0o700);
  });

  posixOnly('a stale world-readable .tmp file does not leak into the session file mode', () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const s = new FileSessionStorage(dir);
    const tmp = `${s.file}.tmp`;
    writeFileSync(tmp, 'stale');
    chmodSync(tmp, 0o644);
    s.setItem('k', TOKEN);
    expect(mode(s.file)).toBe(0o600);
    expect(s.getItem('k')).toBe(TOKEN);
    // Writes use a unique tmp name, so the stale file is never reused and never gets the token.
    if (existsSync(tmp)) expect(readFileSync(tmp, 'utf8')).not.toContain(TOKEN);
    // And no per-write tmp files are left behind.
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp') && f !== 'session.json.tmp')).toEqual(
      [],
    );
  });

  posixOnly('keeps mode 600 after removeItem rewrites the file', () => {
    const s = new FileSessionStorage(dir);
    s.setItem('a', '1');
    s.setItem('b', '2');
    s.removeItem('a');
    expect(mode(s.file)).toBe(0o600);
  });
});
