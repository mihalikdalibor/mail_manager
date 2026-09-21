import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { CheckResult } from '../../src/core/doctor.js';

// Mock the core so the CLI wiring is tested without env files or network.
const runDoctor = vi.fn<() => Promise<CheckResult[]>>();
const loadEnvFiles = vi.fn();

vi.mock('../../src/core/doctor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/doctor.js')>();
  return { ...actual, runDoctor };
});
vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return { ...actual, loadEnvFiles };
});

const { buildProgram } = await import('../../src/cli/index.js');

let lines: string[];
const originalExitCode = process.exitCode;

beforeEach(() => {
  lines = [];
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  runDoctor.mockReset();
  loadEnvFiles.mockReset();
});

async function runCli(results: CheckResult[]): Promise<void> {
  runDoctor.mockResolvedValue(results);
  await buildProgram({ exitOverride: true }).parseAsync(['doctor'], { from: 'user' });
}

describe('mm doctor (CLI wiring)', () => {
  it('loads env files before running the checks', async () => {
    await runCli([{ name: 'node', status: 'ok', detail: 'v22' }]);
    expect(loadEnvFiles).toHaveBeenCalledTimes(1);
    expect(runDoctor).toHaveBeenCalledTimes(1);
    const loadOrder = loadEnvFiles.mock.invocationCallOrder[0] ?? Infinity;
    const runOrder = runDoctor.mock.invocationCallOrder[0] ?? -Infinity;
    expect(loadOrder).toBeLessThan(runOrder);
  });

  it('prints one labelled line per check', async () => {
    await runCli([
      { name: 'node', status: 'ok', detail: 'v22' },
      { name: 'master-key', status: 'warn', detail: 'not set' },
      { name: 'supabase-api', status: 'fail', detail: 'key rejected' },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^OK\s+node\s+v22$/);
    expect(lines[1]).toMatch(/^WARN\s+master-key\s+not set$/);
    expect(lines[2]).toMatch(/^FAIL\s+supabase-api\s+key rejected$/);
  });

  it('sets exit code 1 when any check fails', async () => {
    await runCli([
      { name: 'node', status: 'ok', detail: '' },
      { name: 'supabase-api', status: 'fail', detail: '' },
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('leaves the exit code alone when there are only warnings', async () => {
    await runCli([
      { name: 'node', status: 'ok', detail: '' },
      { name: 'master-key', status: 'warn', detail: '' },
    ]);
    expect(process.exitCode).toBeUndefined();
  });
});
