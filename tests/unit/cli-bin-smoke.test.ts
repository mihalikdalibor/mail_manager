import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { parseLogLine } from '../../src/core/log/index.js';
import { validateMasterKey } from '../../src/core/master-key.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const posixNonRoot = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mm-binsmoke-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function mm(args: string[], configDir = tmp) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/bin.ts', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, MM_CONFIG_DIR: configDir, MM_LOG_LEVEL: 'info' },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('src/cli/bin.ts', () => {
  it('keygen prints one key and logs start + finish', () => {
    const before = today();
    const r = mm(['keygen']);
    expect(r.status).toBe(0);
    const out = r.stdout.trim().split('\n');
    expect(out).toHaveLength(1);
    expect(validateMasterKey(out[0] ?? '').ok).toBe(true);

    // A run across midnight UTC may land in either day's file.
    const file = [before, today()]
      .map((d) => join(tmp, 'logs', `app-${d}.log`))
      .find((f) => existsSync(f));
    expect(file).toBeDefined();
    const lines = readFileSync(file ?? '', 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    expect(lines).toHaveLength(2);
    const [start, finish] = lines.map((l) => parseLogLine(l)?.record);
    expect(start).toMatchObject({ event: 'command.start', cmd: 'keygen', opts: [] });
    expect(finish).toMatchObject({
      event: 'command.finish',
      cmd: 'keygen',
      outcome: 'ok',
      exit: 0,
    });
    expect(start?.run).toBe(finish?.run);
    expect(lines.join('\n')).not.toContain(out[0] ?? '<no key>');
  }, 60_000);

  posixNonRoot(
    'creates the log folder 700 and the log file 600',
    () => {
      expect(mm(['keygen']).status).toBe(0);
      const dir = join(tmp, 'logs');
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      const file = join(dir, `app-${today()}.log`);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
    60_000,
  );

  it('--help writes no log', () => {
    const r = mm(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('keygen');
    expect(existsSync(join(tmp, 'logs'))).toBe(false);
  }, 60_000);

  it('still works when MM_CONFIG_DIR is a regular file', () => {
    const file = join(tmp, 'not-a-dir');
    writeFileSync(file, 'x');
    const r = mm(['keygen'], file);
    expect(r.status).toBe(0);
    expect(validateMasterKey(r.stdout.trim()).ok).toBe(true);
    expect(r.stderr).not.toContain('Unexpected error');
    expect(readFileSync(file, 'utf8')).toBe('x');
  }, 60_000);
});
