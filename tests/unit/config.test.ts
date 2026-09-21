import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  ConfigError,
  getConfig,
  loadEnvFiles,
  projectRoot,
  validateMasterKeyEnv,
  validateSupabaseEnv,
} from '../../src/core/config.js';
import type { EnvIssue, EnvSource } from '../../src/core/config.js';
import { generateMasterKey } from '../../src/core/master-key.js';

const URL_OK = 'https://abcdefghijklmnop.supabase.co';
const KEY_OK = 'sb_publishable_TESTKEY123';

function validEnv(extra: EnvSource = {}): EnvSource {
  return { SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: KEY_OK, ...extra };
}

function issueFor(issues: EnvIssue[], variable: string): EnvIssue | undefined {
  return issues.find((i) => i.variable === variable);
}

describe('validateSupabaseEnv', () => {
  it('returns typed values for a valid env', () => {
    const result = validateSupabaseEnv(validEnv());
    expect(result).toEqual({ ok: true, value: { url: URL_OK, publishableKey: KEY_OK } });
  });

  it('names SUPABASE_URL when it is missing', () => {
    const result = validateSupabaseEnv({ SUPABASE_PUBLISHABLE_KEY: KEY_OK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(issueFor(result.issues, 'SUPABASE_URL')?.problem).toMatch(/missing/i);
    }
  });

  it('names SUPABASE_PUBLISHABLE_KEY when it is missing', () => {
    const result = validateSupabaseEnv({ SUPABASE_URL: URL_OK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(issueFor(result.issues, 'SUPABASE_PUBLISHABLE_KEY')?.problem).toMatch(/missing/i);
    }
  });

  it('reports both variables when both are missing', () => {
    const result = validateSupabaseEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(issueFor(result.issues, 'SUPABASE_URL')).toBeDefined();
      expect(issueFor(result.issues, 'SUPABASE_PUBLISHABLE_KEY')).toBeDefined();
    }
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('treats %s strings as missing', (_label, blank) => {
    const result = validateSupabaseEnv({ SUPABASE_URL: blank, SUPABASE_PUBLISHABLE_KEY: blank });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(issueFor(result.issues, 'SUPABASE_URL')?.problem).toMatch(/missing/i);
      expect(issueFor(result.issues, 'SUPABASE_PUBLISHABLE_KEY')?.problem).toMatch(/missing/i);
    }
  });

  it.each([
    ['http:// URL', 'http://abcdefghijklmnop.supabase.co'],
    ['malformed URL', 'not a url'],
    ['URL with credentials', 'https://user:LEAKCANARY@abcdefghijklmnop.supabase.co'],
  ])('rejects a %s with a non-"missing" problem', (_label, url) => {
    const result = validateSupabaseEnv(validEnv({ SUPABASE_URL: url }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      const issue = issueFor(result.issues, 'SUPABASE_URL');
      expect(issue).toBeDefined();
      expect(issue?.problem).not.toMatch(/missing/i);
    }
  });

  it('hints at VITE_SUPABASE_URL when SUPABASE_URL is missing but the VITE_ name exists', () => {
    const result = validateSupabaseEnv({
      VITE_SUPABASE_URL: URL_OK,
      SUPABASE_PUBLISHABLE_KEY: KEY_OK,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(issueFor(result.issues, 'SUPABASE_URL')?.problem).toContain('VITE_SUPABASE_URL');
    }
  });

  it('hints at VITE_SUPABASE_ANON_KEY when the publishable key is missing but the VITE_ name exists', () => {
    const result = validateSupabaseEnv({ SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: KEY_OK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(issueFor(result.issues, 'SUPABASE_PUBLISHABLE_KEY')?.problem).toContain(
        'VITE_SUPABASE_ANON_KEY',
      );
    }
  });

  it('does not mention VITE_ names when they are absent', () => {
    const result = validateSupabaseEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const issue of result.issues) expect(issue.problem).not.toContain('VITE_');
    }
  });

  it('ignores master-key variables (validators are independent)', () => {
    const result = validateSupabaseEnv(
      validEnv({ MM_MASTER_KEY: 'garbage!!', MM_MASTER_KEY_VERSION: 'abc' }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('validateMasterKeyEnv', () => {
  it('is ok with masterKey undefined and version 1 when MM_MASTER_KEY is absent', () => {
    expect(validateMasterKeyEnv({})).toEqual({
      ok: true,
      value: { masterKey: undefined, masterKeyVersion: 1 },
    });
  });

  it('treats an empty MM_MASTER_KEY as absent', () => {
    const result = validateMasterKeyEnv({ MM_MASTER_KEY: '' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.masterKey).toBeUndefined();
  });

  it('decodes a valid MM_MASTER_KEY to a 32-byte Buffer', () => {
    const key = generateMasterKey();
    const result = validateMasterKeyEnv({ MM_MASTER_KEY: key });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.masterKey).toBeInstanceOf(Buffer);
      expect(result.value.masterKey?.equals(Buffer.from(key, 'base64'))).toBe(true);
      expect(result.value.masterKeyVersion).toBe(1);
    }
  });

  it('reports an issue for a malformed MM_MASTER_KEY', () => {
    const result = validateMasterKeyEnv({ MM_MASTER_KEY: 'not base64!!' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(issueFor(result.issues, 'MM_MASTER_KEY')).toBeDefined();
  });

  it('reports an issue for a wrong-length MM_MASTER_KEY', () => {
    const result = validateMasterKeyEnv({
      MM_MASTER_KEY: Buffer.alloc(16, 7).toString('base64'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(issueFor(result.issues, 'MM_MASTER_KEY')).toBeDefined();
  });

  it.each([
    ['2', 2],
    ['17', 17],
    ['', 1],
  ])('accepts MM_MASTER_KEY_VERSION=%j as %d', (raw, expected) => {
    const result = validateMasterKeyEnv({ MM_MASTER_KEY_VERSION: raw });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.masterKeyVersion).toBe(expected);
  });

  it.each(['0', '-1', 'abc', '1.5'])('rejects MM_MASTER_KEY_VERSION=%j', (raw) => {
    const result = validateMasterKeyEnv({ MM_MASTER_KEY_VERSION: raw });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(issueFor(result.issues, 'MM_MASTER_KEY_VERSION')).toBeDefined();
  });

  it('ignores Supabase variables (validators are independent)', () => {
    expect(validateMasterKeyEnv({ SUPABASE_URL: 'not a url' }).ok).toBe(true);
  });
});

describe('getConfig', () => {
  it('returns the combined config for a valid env', () => {
    const key = generateMasterKey();
    const config = getConfig(validEnv({ MM_MASTER_KEY: key, MM_MASTER_KEY_VERSION: '3' }));
    expect(config.supabaseUrl).toBe(URL_OK);
    expect(config.supabasePublishableKey).toBe(KEY_OK);
    expect(config.masterKey?.equals(Buffer.from(key, 'base64'))).toBe(true);
    expect(config.masterKeyVersion).toBe(3);
  });

  it('defaults masterKey to undefined and version to 1', () => {
    const config = getConfig(validEnv());
    expect(config.masterKey).toBeUndefined();
    expect(config.masterKeyVersion).toBe(1);
  });

  it('throws a ConfigError collecting issues from both validators', () => {
    let caught: unknown;
    try {
      getConfig({ SUPABASE_URL: 'http://x.example', MM_MASTER_KEY_VERSION: '0' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught).toBeInstanceOf(Error);
    const issues = (caught as ConfigError).issues;
    const vars = issues.map((i) => i.variable);
    expect(vars).toEqual(
      expect.arrayContaining(['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'MM_MASTER_KEY_VERSION']),
    );
  });

  it('never leaks env values into the error message or issues', () => {
    const secretUrl = 'http://LEAKCANARYURL.example.com';
    const secretKey = 'LEAKCANARYMASTERKEY!!';
    const secretVersion = 'LEAKCANARYVERSION';
    const viteKey = 'sb_publishable_LEAKCANARYVITE';
    const env: EnvSource = {
      SUPABASE_URL: secretUrl,
      VITE_SUPABASE_ANON_KEY: viteKey,
      MM_MASTER_KEY: secretKey,
      MM_MASTER_KEY_VERSION: secretVersion,
    };
    let caught: unknown;
    try {
      getConfig(env);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.issues.length).toBeGreaterThanOrEqual(4);
    const serialized = `${error.message}\n${JSON.stringify(error.issues)}`;
    expect(serialized).not.toContain('LEAKCANARY');
  });

  it('does not leak the publishable key when only the master key is bad', () => {
    let caught: unknown;
    try {
      getConfig(validEnv({ MM_MASTER_KEY: Buffer.alloc(16, 1).toString('base64') }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    const serialized = `${error.message}\n${JSON.stringify(error.issues)}`;
    expect(serialized).not.toContain(KEY_OK);
    expect(serialized).not.toContain(Buffer.alloc(16, 1).toString('base64'));
  });
});

describe('loadEnvFiles', () => {
  const dirs: string[] = [];

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mm-config-test-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Root ignores file permissions, and chmod has no effect on Windows.
  const canTestPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.skipIf(!canTestPermissions)('throws when .env.local exists but is unreadable', () => {
    const dir = makeDir();
    writeFileSync(join(dir, '.env.local'), 'SECRET_VALUE=LEAKCANARY\n');
    chmodSync(join(dir, '.env.local'), 0o000);
    try {
      expect(() => loadEnvFiles(dir, {})).toThrow(/\.env\.local.*EACCES/);
      expect(() => loadEnvFiles(dir, {})).not.toThrow(/LEAKCANARY/);
    } finally {
      chmodSync(join(dir, '.env.local'), 0o600);
    }
  });

  it('applies precedence: existing target > .env.local > .env', () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, '.env.local'),
      'PRESET=from-local\nSHARED=from-local\nLOCAL_ONLY=local-value\n',
    );
    writeFileSync(join(dir, '.env'), 'PRESET=from-env\nSHARED=from-env\nENV_ONLY=env-value\n');
    const target: EnvSource = { PRESET: 'from-target' };

    loadEnvFiles(dir, target);

    expect(target).toEqual({
      PRESET: 'from-target',
      SHARED: 'from-local',
      LOCAL_ONLY: 'local-value',
      ENV_ONLY: 'env-value',
    });
  });

  it('keeps a pre-set empty string in target', () => {
    const dir = makeDir();
    writeFileSync(join(dir, '.env'), 'EMPTY_PRESET=from-env\n');
    const target: EnvSource = { EMPTY_PRESET: '' };
    loadEnvFiles(dir, target);
    expect(target.EMPTY_PRESET).toBe('');
  });

  it('loads only .env when .env.local is missing', () => {
    const dir = makeDir();
    writeFileSync(join(dir, '.env'), 'ENV_ONLY=env-value\n');
    const target: EnvSource = {};
    loadEnvFiles(dir, target);
    expect(target).toEqual({ ENV_ONLY: 'env-value' });
  });

  it('does not throw and leaves target unchanged when both files are missing', () => {
    const dir = makeDir();
    const target: EnvSource = { KEEP: 'me' };
    expect(() => loadEnvFiles(dir, target)).not.toThrow();
    expect(target).toEqual({ KEEP: 'me' });
  });
});

describe('projectRoot', () => {
  it('returns an absolute directory containing package.json', () => {
    const root = projectRoot();
    expect(isAbsolute(root)).toBe(true);
    expect(existsSync(join(root, 'package.json'))).toBe(true);
  });
});
