import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { FileEventLog, commandFinish, commandStart } from '../../src/core/log/index.js';

// M1b-4c smoke (spec): `mm logs` through src/cli/bin.ts in child processes, with a temp
// MM_CONFIG_DIR — own run excluded, --json parses, tampered lines skipped, EPIPE is quiet.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TIME_LINE = /^\d{2}:\d{2}:\d{2} {2}/;
const bash = spawnSync('bash', ['-c', 'true']).status === 0;
const withBash = bash && process.platform !== 'win32' ? it : it.skip;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mm-logsmoke-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { ...process.env, MM_CONFIG_DIR: tmp, MM_LOG_LEVEL: 'info' };
}

function mm(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/bin.ts', ...args], {
    cwd: REPO_ROOT,
    env: env(),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

/** Timeline lines as [cmd, text]. */
function timeline(stdout: string): [string, string][] {
  return stdout
    .split('\n')
    .filter((l) => TIME_LINE.test(l))
    .map((l) => [l.slice(10, 22).trim(), l.slice(24)]);
}

describe('mm logs through bin.ts', () => {
  it('lists earlier runs, never its own start, nothing interrupted', () => {
    expect(mm(['keygen']).status).toBe(0);

    const first = mm(['logs']);
    expect(first.status).toBe(0);
    expect(first.stderr).not.toContain('Unexpected error');
    const lines1 = timeline(first.stdout);
    const keygen = lines1.filter(([cmd]) => cmd === 'keygen').map(([, text]) => text);
    expect(keygen).toHaveLength(2);
    expect(keygen[0]).toBe('started');
    expect(keygen[1]).toContain('finished');
    expect(lines1.filter(([cmd]) => cmd === 'logs')).toEqual([]);
    expect(first.stdout).not.toContain('interrupted or still running');

    const second = mm(['logs']);
    expect(second.status).toBe(0);
    const lines2 = timeline(second.stdout);
    // The first `logs` run: its start and finish; the current one's start is not there.
    const logsLines = lines2.filter(([cmd]) => cmd === 'logs').map(([, text]) => text);
    expect(logsLines).toHaveLength(2);
    expect(logsLines[0]).toBe('started');
    expect(logsLines[1]).toContain('finished');
    expect(second.stdout).not.toContain('interrupted or still running');
  }, 120_000);

  it('--json: every stdout line parses', () => {
    expect(mm(['keygen']).status).toBe(0);
    const r = mm(['logs', '--json']);
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      const record = JSON.parse(l) as Record<string, unknown>;
      expect(typeof record['event']).toBe('string');
    }
  }, 120_000);

  it('a tampered line is skipped and counted, never printed', () => {
    expect(mm(['keygen']).status).toBe(0);
    const file = join(tmp, 'logs', `app-${new Date().toISOString().slice(0, 10)}.log`);
    appendFileSync(file, '\u001b]0;pwn\u0007{"ts":"x"}\n');
    expect(readFileSync(file, 'utf8')).toContain('pwn');
    const r = mm(['logs']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('\u001b');
    expect(r.stdout).not.toContain('\u0007');
    expect(r.stdout).toContain('1 unreadable line skipped');
  }, 120_000);

  withBash(
    'mm logs | head -1: exit 0, no "Unexpected error"',
    () => {
      // Many valid runs in the last hour: far more output than a pipe buffer holds.
      const now = Date.now();
      const dir = join(tmp, 'logs');
      for (let i = 0; i < 3000; i++) {
        const at = now - 3_600_000 + i * 1000;
        const run = i.toString(16).padStart(16, '0');
        const log = new FileEventLog(dir, { run, ver: '0.6.0', now: () => at, level: 'info' });
        log.emit(commandStart('account add', ['email'], { ver: '0.6.0', node: '22', os: 'linux' }));
        log.emit(commandFinish('account add', 0, 5));
      }
      const errFile = join(tmp, 'stderr.txt');
      const r = spawnSync(
        'bash',
        [
          '-c',
          'set +o pipefail; node --import tsx src/cli/bin.ts logs 2>"$ERR_FILE" | head -1; ' +
            'echo "mm-exit:${PIPESTATUS[0]}"',
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...env(),
            ERR_FILE: errFile,
            PATH: `${join(process.execPath, '..')}:${process.env['PATH'] ?? ''}`,
          },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      expect(r.status).toBe(0);
      const outLines = r.stdout.split('\n').filter((l) => l !== '');
      expect(outLines).toHaveLength(2);
      expect(outLines[1]).toBe('mm-exit:0');
      const stderr = readFileSync(errFile, 'utf8');
      expect(stderr).not.toContain('Unexpected error');
      expect(stderr).not.toContain('EPIPE');
    },
    120_000,
  );

  withBash(
    'mm logs --json 2>&1 | head -1 (footer on a closed stderr): exit 0, no error.unexpected',
    () => {
      expect(mm(['keygen']).status).toBe(0);
      const day = new Date().toISOString().slice(0, 10);
      const file = join(tmp, 'logs', `app-${day}.log`);
      appendFileSync(file, 'garbage\n'); // one footer line on stderr
      const r = spawnSync(
        'bash',
        [
          '-c',
          'set +o pipefail; node --import tsx src/cli/bin.ts logs --json 2>&1 | head -1 >/dev/null; ' +
            'echo "mm-exit:${PIPESTATUS[0]}"',
        ],
        {
          cwd: REPO_ROOT,
          env: { ...env(), PATH: `${join(process.execPath, '..')}:${process.env['PATH'] ?? ''}` },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      expect(r.stdout.trim()).toBe('mm-exit:0');
      expect(readFileSync(file, 'utf8')).not.toContain('error.unexpected');
    },
    120_000,
  );
});
