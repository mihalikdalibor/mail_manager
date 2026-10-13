import { readFileSync } from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildProgram } from '../../src/cli/index.js';
import { validateMasterKey } from '../../src/core/master-key.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

function captured() {
  const out = { stdout: '', stderr: '' };
  const program = buildProgram({ exitOverride: true });
  program.configureOutput({
    writeOut: (s) => {
      out.stdout += s;
    },
    writeErr: (s) => {
      out.stderr += s;
    },
  });
  return { program, out };
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildProgram', () => {
  it('is named mm', () => {
    expect(buildProgram({ exitOverride: true }).name()).toBe('mm');
  });

  it('prints the package.json version on --version', async () => {
    const { program, out } = captured();
    await expect(program.parseAsync(['--version'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.version',
    });
    expect(out.stdout.trim()).toBe(pkg.version);
  });

  it('lists keygen and doctor in --help', async () => {
    const { program, out } = captured();
    await expect(program.parseAsync(['--help'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
    });
    expect(out.stdout).toContain('keygen');
    expect(out.stdout).toContain('doctor');
  });

  it('lists app in --help and says that plain mm opens it', async () => {
    const { program, out } = captured();
    await expect(program.parseAsync(['--help'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
    });
    expect(out.stdout).toMatch(/^ {2}app\b/m);
    expect(out.stdout).toContain('Open the Mail Manager app');
    const footer =
      'In a terminal, plain `mm` opens the app (sign in, your mailboxes). The commands above also work in scripts.';
    expect(out.stdout).toContain(`\n${footer}\n\nGetting started:\n`);
    // The getting-started block itself is as it was.
    for (const step of [
      '  1. mm login                  sign in to Mail Manager',
      '  2. mm discover <email>       find your mailbox settings (no password needed)',
      '  3. mm account add <email>    connect the mailbox (asks for its password)',
      '  4. mm account test <id>      check the login any time (ids: mm account list)',
      '  5. mm folders [id]           see the folders: messages, unread, size, quota',
      '  6. mm stats [id]             where the space goes: senders, years, largest mails',
    ]) {
      expect(out.stdout).toContain(`${step}\n`);
    }
  });

  it('registers app as the first command, without arguments or options', () => {
    const app = buildProgram({ exitOverride: true }).commands[0];
    expect(app?.name()).toBe('app');
    expect(app?.registeredArguments).toEqual([]);
    expect(app?.options).toEqual([]);
  });

  it('registers keygen and doctor subcommands', () => {
    const names = buildProgram({ exitOverride: true }).commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['keygen', 'doctor']));
  });

  it('keygen prints only a valid master key line to stdout', async () => {
    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += chunkToString(chunk);
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout += `${args.map(chunkToString).join(' ')}\n`;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += chunkToString(chunk);
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr += `${args.map(chunkToString).join(' ')}\n`;
    });

    const { program } = captured();
    await program.parseAsync(['keygen'], { from: 'user' });

    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const key = lines[0] ?? '';
    expect(validateMasterKey(key).ok).toBe(true);
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stderr).not.toContain(key);
  });

  it('keygen produces a different key each run', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
      let stdout = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        stdout += chunkToString(chunk);
        return true;
      });
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        stdout += `${args.map(chunkToString).join(' ')}\n`;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { program } = captured();
      await program.parseAsync(['keygen'], { from: 'user' });
      keys.push(stdout.trim());
      vi.restoreAllMocks();
    }
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('keygen hint', () => {
  it('writes a usage hint mentioning MM_MASTER_KEY to stderr', async () => {
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += chunkToString(chunk);
      return true;
    });
    const { program } = captured();
    await program.parseAsync(['keygen'], { from: 'user' });
    expect(stderr).toContain('MM_MASTER_KEY');
  });
});
