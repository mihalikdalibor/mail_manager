import { Command } from 'commander';
import { NullEventLog, type EventLog } from '../core/log/index.js';
import { registerAccount } from './commands/account.js';
import { registerAuth } from './commands/auth.js';
import { registerDiscover } from './commands/discover.js';
import { registerDoctor } from './commands/doctor.js';
import { registerFolders } from './commands/folders.js';
import { registerKeygen } from './commands/keygen.js';
import { registerLogs } from './commands/logs.js';
import { registerStats } from './commands/stats.js';
import { VERSION } from './version.js';

export { VERSION };

export interface BuildOptions {
  /** Throw CommanderError instead of calling process.exit (for tests). */
  exitOverride?: boolean;
  /** Where commands send events (default: nothing is recorded). */
  log?: EventLog;
  /** Id of the current run (`mm logs` leaves its own lines out). */
  run?: string;
  /** Called before every command's action with its path and the option names given. */
  onCommandStart?: (cmd: string, opts: string[]) => void;
}

/** What every command gets from the program. */
export interface CliContext {
  log: EventLog;
  /** Id of the current run, when it is logged. */
  run?: string;
}

/** `account add` style path of a command, without the root program name. */
export function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c?.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/** Names (never values) of the options given on the command line. */
export function givenOptionNames(command: Command): string[] {
  const names = new Set<string>();
  for (const option of command.options) {
    if (command.getOptionValueSource(option.attributeName()) !== 'cli') continue;
    // --x and --no-x share one attribute: log the positive name once.
    const flag = option.long ?? option.short ?? '';
    names.add(flag.replace(/^--?(no-)?/, ''));
  }
  return [...names];
}

export function buildProgram(options: BuildOptions = {}): Command {
  const program = new Command();
  // Must be set before subcommands are added so they inherit it.
  if (options.exitOverride) program.exitOverride();
  program
    .name('mm')
    .description('Mail Manager — manage IMAP mailboxes: insight, filters, safe delete, backup')
    .version(VERSION);
  const { onCommandStart } = options;
  // Runs only when a command's action is about to run: --help, --version and parse errors
  // never reach it, so they leave no log lines.
  if (onCommandStart) {
    program.hook('preAction', (_root, actionCommand) => {
      try {
        onCommandStart(commandPath(actionCommand), givenOptionNames(actionCommand));
      } catch {
        // Logging never stops a command from running.
      }
    });
  }
  const ctx: CliContext = {
    log: options.log ?? new NullEventLog(),
    ...(options.run !== undefined && { run: options.run }),
  };
  registerAuth(program, ctx);
  registerKeygen(program);
  registerDoctor(program, ctx);
  registerDiscover(program, ctx);
  registerAccount(program, ctx);
  registerFolders(program, ctx);
  registerStats(program, ctx);
  registerLogs(program, ctx);
  program.addHelpText(
    'after',
    [
      '',
      'Getting started:',
      '  1. mm login                  sign in to Mail Manager',
      '  2. mm discover <email>       find your mailbox settings (no password needed)',
      '  3. mm account add <email>    connect the mailbox (asks for its password)',
      '  4. mm account test <id>      check the login any time (ids: mm account list)',
      '  5. mm folders [id]           see the folders: messages, unread, size, quota',
      '  6. mm stats [id]             where the space goes: senders, years, largest mails',
    ].join('\n'),
  );
  return program;
}
