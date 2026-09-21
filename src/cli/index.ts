import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerDoctor } from './commands/doctor.js';
import { registerKeygen } from './commands/keygen.js';

// Same relative path from src/cli (tsx) and dist/cli (built).
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

export interface BuildOptions {
  /** Throw CommanderError instead of calling process.exit (for tests). */
  exitOverride?: boolean;
}

export function buildProgram(options: BuildOptions = {}): Command {
  const program = new Command();
  // Must be set before subcommands are added so they inherit it.
  if (options.exitOverride) program.exitOverride();
  program
    .name('mm')
    .description('Mail Manager — manage IMAP mailboxes: insight, filters, safe delete, backup')
    .version(pkg.version);
  registerKeygen(program);
  registerDoctor(program);
  return program;
}
