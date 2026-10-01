import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

interface Spawned {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/**
 * Async run of bin.ts with its stdout (and optionally stderr) pipe destroyed on our side right
 * after the spawn: tsx start-up takes hundreds of ms, so the child's first write hits EPIPE.
 * Not `sh -c '… | true'`: /bin/sh has no pipefail, so the status would be `true`'s.
 * Waits for 'close' (all stdio ended); a hard timeout kills a hung child and fails the test.
 */
function mmWithClosedPipes(args: string[], closed: ('stdout' | 'stderr')[]): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/bin.ts', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, MM_CONFIG_DIR: tmp, MM_LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    // Our end of the pipe may report errors itself once destroyed; they are irrelevant here.
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    for (const name of closed) child[name].destroy();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('child did not exit within 30 s'));
    }, 30_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

/** Lines of today's (or, across midnight UTC, yesterday's) app log in the temp config dir. */
function logLines(before: string): string[] {
  const file = [before, today()]
    .map((d) => join(tmp, 'logs', `app-${d}.log`))
    .find((f) => existsSync(f));
  expect(file).toBeDefined();
  return readFileSync(file ?? '', 'utf8')
    .split('\n')
    .filter((l) => l !== '');
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

  describe('a closed output pipe ends the command quietly', () => {
    it.each<[string, ('stdout' | 'stderr')[]]>([
      ['stdout closed (mm keygen | true)', ['stdout']],
      ['stdout and stderr closed', ['stdout', 'stderr']],
    ])(
      'keygen with %s: real exit 0, nothing unexpected',
      async (_label, closed) => {
        const before = today();
        const r = await mmWithClosedPipes(['keygen'], closed);
        expect(r.signal).toBeNull();
        expect(r.code).toBe(0);
        expect(r.stderr).not.toContain('Unexpected error');

        const records = logLines(before).map((l) => parseLogLine(l)?.record);
        expect(records.map((rec) => rec?.event)).toEqual(['command.start', 'command.finish']);
        expect(records[1]).toMatchObject({ cmd: 'keygen', outcome: 'ok', exit: 0 });
      },
      60_000,
    );

    it('keygen > file: the file holds exactly one key line', () => {
      const file = join(tmp, 'key.txt');
      const fd = openSync(file, 'w');
      try {
        const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/bin.ts', 'keygen'], {
          cwd: REPO_ROOT,
          env: { ...process.env, MM_CONFIG_DIR: tmp, MM_LOG_LEVEL: 'info' },
          stdio: ['ignore', fd, 'pipe'],
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(r.status).toBe(0);
        expect(r.stderr).not.toContain('Unexpected error');
      } finally {
        closeSync(fd);
      }
      const text = readFileSync(file, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      const lines = text.split('\n').filter((l) => l !== '');
      expect(lines).toHaveLength(1);
      expect(validateMasterKey(lines[0] ?? '').ok).toBe(true);
    }, 60_000);
  });
});
