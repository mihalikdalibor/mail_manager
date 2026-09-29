import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { runDoctor } from '../../src/core/doctor.js';
import type { CheckResult, DoctorDeps } from '../../src/core/doctor.js';
import { checkLogs } from '../../src/core/log/index.js';

const NOW = Date.UTC(2026, 8, 23, 10, 0, 0);
const posixOnly = process.platform === 'win32' ? it.skip : it;

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mm-loghealth-'));
  dir = join(root, 'logs');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function check(
  env: Record<string, string> = {},
  posix = process.platform !== 'win32',
): CheckResult {
  const result = checkLogs(dir, env, { now: () => NOW, posix });
  expect(result.name).toBe('logs');
  expect(result.detail).not.toContain(dir);
  expect(result.detail).not.toContain(root);
  return result;
}

/** A log file with the given size and mode, its mtime set to the date in its name. */
function logFile(name: string, size: number, fileMode = 0o600): void {
  const path = join(dir, name);
  writeFileSync(path, 'x'.repeat(size));
  chmodSync(path, fileMode);
  const date = /(\d{4}-\d{2}-\d{2})/.exec(name)?.[1];
  if (date !== undefined) {
    const t = new Date(`${date}T12:00:00Z`);
    utimesSync(path, t, t);
  }
}

function healthyDir(): void {
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
}

describe('checkLogs', () => {
  it('warns when the folder is missing', () => {
    const r = check();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
  });

  it('warns when the folder is a regular file', () => {
    writeFileSync(dir, 'x');
    const r = check();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
  });

  posixOnly('warns about a 755 folder', () => {
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const r = check();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('755');
  });

  posixOnly('warns about a log file that is not mode 600', () => {
    healthyDir();
    logFile('app-2026-09-20.log', 100, 0o644);
    const r = check();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not mode 600');
  });

  it('skips mode checks when not POSIX', () => {
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    logFile('app-2026-09-20.log', 100, 0o644);
    expect(check({}, false).status).toBe('ok');
  });

  it('warns about an invalid MM_LOG_LEVEL in a healthy folder', () => {
    healthyDir();
    const r = check({ MM_LOG_LEVEL: 'verbose' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('MM_LOG_LEVEL');
  });

  posixOnly('reports an invalid MM_LOG_LEVEL together with other issues', () => {
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const r = check({ MM_LOG_LEVEL: 'off' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('755');
    expect(r.detail).toContain('MM_LOG_LEVEL');
  });

  it('reports an invalid MM_LOG_LEVEL when the folder is missing', () => {
    const r = check({ MM_LOG_LEVEL: 'off' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
    expect(r.detail).toContain('MM_LOG_LEVEL');
  });

  it('accepts a valid MM_LOG_LEVEL in any case', () => {
    healthyDir();
    expect(check({ MM_LOG_LEVEL: ' WARN ' }).status).toBe('ok');
  });

  it('is ok for a healthy folder and summarises files, size and the oldest date', () => {
    healthyDir();
    logFile('app-2026-09-20.log', 1500);
    logFile('security-2026-09-01.log', 2048);
    const r = check();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/\b2 files\b/);
    expect(r.detail).toMatch(/\d+(\.\d+)? KB/);
    expect(r.detail).toContain('oldest 2026-09-01');
  });

  it('is ok for an empty folder', () => {
    healthyDir();
    const r = check();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/\b0 files\b/);
  });
});

describe('checkLogs: review fixes', () => {
  const TODAY_FILE = 'app-2026-09-23.log';

  it.each(['warn', 'error', 'WARN'])(
    'a missing folder is ok at MM_LOG_LEVEL=%s (nothing to write yet)',
    (level) => {
      const r = check({ MM_LOG_LEVEL: level });
      expect(r.status).toBe('ok');
      expect(r.detail).toContain('no logs yet');
    },
  );

  it.each([{}, { MM_LOG_LEVEL: 'info' }, { MM_LOG_LEVEL: 'debug' }])(
    'a missing folder still warns at %j',
    (env) => {
      const r = check(env);
      expect(r.status).toBe('warn');
      expect(r.detail).toContain('not being written');
    },
  );

  posixOnly("warns when today's app file is a symlink", () => {
    healthyDir();
    const target = join(root, 'elsewhere.log');
    writeFileSync(target, '');
    symlinkSync(target, join(dir, TODAY_FILE));
    const r = check();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
  });

  posixOnly("warns when today's app file is a directory", () => {
    healthyDir();
    mkdirSync(join(dir, TODAY_FILE));
    const r = check();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not being written');
  });
});

describe('runDoctor logs dependency', () => {
  const offline = (() =>
    Promise.reject(new TypeError('fetch failed'))) as unknown as typeof globalThis.fetch;

  function deps(extra: Partial<DoctorDeps> = {}): DoctorDeps {
    return { env: {}, fetch: offline, nodeVersion: '22.22.1', timeoutMs: 100, ...extra };
  }

  it('appends the logs result last, after session', async () => {
    const logs: CheckResult = { name: 'logs', status: 'warn', detail: 'not being written' };
    const results = await runDoctor(deps({ logs: () => logs }));
    expect(results.at(-1)).toEqual(logs);
    const names = results.map((r) => r.name);
    expect(names.indexOf('session')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('session')).toBeLessThan(names.indexOf('logs'));
    expect(names.filter((n) => n === 'logs')).toHaveLength(1);
  });

  it('has no logs result without the dependency', async () => {
    const results = await runDoctor(deps());
    expect(results.map((r) => r.name)).not.toContain('logs');
  });
});
