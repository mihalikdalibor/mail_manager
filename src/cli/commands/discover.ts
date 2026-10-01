import type { Command } from 'commander';
import {
  defaultDiscoveryDeps,
  discover,
  SOURCE_LABEL,
  type DiscoveryResult,
} from '../../core/providers/discover.js';
import { DiscoveryInputError } from '../../core/providers/email.js';
import { discoverFinish, safeEmit, type DiscoverChoice } from '../../core/log/index.js';
import type { CliContext } from '../index.js';
import {
  domainProblemText,
  foundVia,
  line,
  offDomainWarning,
  printHelp,
  printProvider,
  printSettings,
  printTried,
  warn,
} from '../discovery-text.js';
import { chooseImapSettings, inquirerPrompts } from '../prompts/imap-settings.js';
import { reportError } from '../report-error.js';

const TIMEOUT_MS = 5000;

const SOURCE_TEXT = {
  picked: 'Chosen from list',
  'host-entered': 'Host entered manually',
  manual: 'Entered manually',
} as const;

/** Prompts only when both ends are a terminal (not when piped, e.g. `mm discover x | cat`). */
function interactive(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

/** Exit code plus what the log may know about the run (no address, domain or host). */
interface Reported {
  code: number;
  choice?: DiscoverChoice;
  /** Preset id picked in the provider list. */
  provider?: string;
}

/** Tiers 2–3 (provider picker / manual host). */
async function choose(result: DiscoveryResult): Promise<Reported> {
  const chosen = await chooseImapSettings(result, inquirerPrompts);
  if (chosen === null) {
    console.log('Cancelled — no settings chosen.');
    return { code: 1, choice: 'cancelled' };
  }
  console.log('');
  // For host-entered the provider line was already printed with the discovery result.
  if (chosen.provider !== undefined && chosen.source !== 'host-entered') {
    printProvider(chosen.provider);
  }
  printSettings(chosen.settings);
  line('Found via', SOURCE_TEXT[chosen.source]);
  printHelp(chosen.provider);
  return {
    code: 0,
    choice: chosen.source,
    ...(chosen.provider !== undefined && { provider: chosen.provider.id }),
  };
}

async function report(result: DiscoveryResult): Promise<Reported> {
  switch (result.status) {
    case 'found': {
      const offDomain = offDomainWarning(result);
      if (result.provider !== undefined) printProvider(result.provider);
      printSettings(result.imap);
      line('Found via', foundVia(result.source, result.via));
      if (result.altHosts.length > 0) line('Also try', result.altHosts.join(', '));
      printHelp(result.provider);
      for (const n of result.notices) warn(n);
      if (result.domainProblem !== undefined) {
        warn(domainProblemText(result.domainProblem, result.email.displayDomain));
      }
      if (offDomain !== undefined) warn(offDomain);
      return { code: 0 };
    }
    case 'blocked':
      printProvider(result.provider);
      line('Found via', foundVia(result.source, result.via));
      printHelp(result.provider);
      for (const n of result.notices) warn(n);
      warn(`Not supported yet: ${result.reason}`);
      return { code: 1 };
    case 'needs-host':
      printProvider(result.provider);
      line('Found via', foundVia(result.source, result.via));
      for (const n of result.notices) warn(n);
      if (interactive()) return choose(result);
      warn(`The IMAP host is per mailbox: ${result.provider.hostHint ?? 'enter it manually'}`);
      printHelp(result.provider);
      return { code: 0 };
    case 'manual':
      if (result.domainProblem !== undefined) {
        console.log(domainProblemText(result.domainProblem, result.email.displayDomain));
      }
      console.log(`No IMAP settings found for ${result.email.displayDomain}.`);
      printTried(result.tried);
      for (const n of result.notices) warn(n);
      if (!interactive()) {
        console.log(
          'Run this in a terminal to choose your provider from the list or enter the IMAP host manually.',
        );
        return { code: 1 };
      }
      return choose(result);
  }
}

/** Only DiscoveryInputError messages are ours and value-free; anything else stays generic. */
function discoverErrorText(err: unknown): string {
  return err instanceof DiscoveryInputError ? err.message : 'Unexpected error';
}

export function registerDiscover(program: Command, ctx: CliContext): void {
  program
    .command('discover')
    .description('Find the IMAP settings for an email address (no login, no password)')
    .argument('<email>', 'email address')
    .action(async (email: string) => {
      try {
        const result = await discover(email, {
          ...defaultDiscoveryDeps(TIMEOUT_MS),
          // Progress goes to stderr so stdout stays the result only.
          onProgress: (source) => console.error(`checking ${SOURCE_LABEL[source]}…`),
        });
        const reported = await report(result);
        process.exitCode = reported.code;
        safeEmit(ctx.log, () =>
          discoverFinish({
            outcome: result.status,
            source: 'source' in result ? result.source : undefined,
            provider: reported.provider ?? ('provider' in result ? result.provider?.id : undefined),
            domainProblem: result.domainProblem,
            choice: reported.choice,
          }),
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'ExitPromptError') {
          process.exitCode = 130;
          return;
        }
        if (err instanceof DiscoveryInputError) {
          safeEmit(ctx.log, () => discoverFinish({ outcome: 'invalid' }));
        }
        reportError(err, ctx.log, discoverErrorText);
        process.exitCode = 1;
      }
    });
}
