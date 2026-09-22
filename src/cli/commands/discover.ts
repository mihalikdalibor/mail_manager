import type { Command } from 'commander';
import {
  defaultDiscoveryDeps,
  discover,
  SOURCE_LABEL,
  type DiscoveryResult,
  type DomainProblem,
  type DiscoverySource,
  type ProviderInfo,
  type Tried,
} from '../../core/providers/discover.js';
import { DiscoveryInputError } from '../../core/providers/email.js';
import type { ImapSettings } from '../../core/providers/settings.js';
import { chooseImapSettings, inquirerPrompts } from '../prompts/imap-settings.js';

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

const OUTCOME_LABEL: Record<Tried['outcome'], string> = {
  'no-match': 'no known provider',
  'not-found': 'nothing found',
  'insecure-only': 'only STARTTLS / non-993 (not supported)',
  invalid: 'invalid response',
  timeout: 'timed out',
  error: 'failed',
};

/** Plain-language explanation of a domain problem: what happened and what to do. */
function domainProblemText(problem: DomainProblem, domain: string): string {
  switch (problem) {
    case 'not-exist':
      return `The domain "${domain}" does not exist. Check the email address for typos. If the domain has expired but the mailbox still exists at your provider, you can still choose the provider or enter its IMAP host.`;
    case 'dns-error':
      return `The DNS servers of "${domain}" answered with an error, so its mail settings can't be looked up right now. Try again later, or ask whoever manages the domain.`;
    case 'dns-unreachable':
      return `Could not reach DNS to look up "${domain}". Check your internet connection and try again.`;
  }
}

function line(label: string, value: string): void {
  console.log(`${label.padEnd(10)} ${value}`);
}

function warn(text: string): void {
  console.log(`! ${text}`);
}

function printProvider(provider: ProviderInfo): void {
  line('Provider', provider.verified ? provider.name : `${provider.name} (unverified preset)`);
}

function printHelp(provider: ProviderInfo | undefined): void {
  if (provider?.hint !== undefined) line('Hint', provider.hint);
  if (provider?.helpUrl !== undefined) line('Help', provider.helpUrl);
}

function printSettings(imap: ImapSettings): void {
  line('IMAP', `${imap.host}:${imap.port} (TLS)`);
  line('Username', imap.username);
}

function foundVia(source: DiscoverySource, via: string | undefined): string {
  return via === undefined ? SOURCE_LABEL[source] : `${SOURCE_LABEL[source]} — ${via}`;
}

function printTried(tried: Tried[]): void {
  for (const t of tried) {
    const detail = t.detail === undefined ? '' : ` (${t.detail})`;
    line('  tried', `${SOURCE_LABEL[t.source]}: ${OUTCOME_LABEL[t.outcome]}${detail}`);
  }
}

/** Tiers 2–3 (provider picker / manual host). Returns the exit code. */
async function choose(result: DiscoveryResult): Promise<number> {
  const chosen = await chooseImapSettings(result, inquirerPrompts);
  if (chosen === null) {
    console.log('Cancelled — no settings chosen.');
    return 1;
  }
  console.log('');
  // For host-entered the provider line was already printed with the discovery result.
  if (chosen.provider !== undefined && chosen.source !== 'host-entered') {
    printProvider(chosen.provider);
  }
  printSettings(chosen.settings);
  line('Found via', SOURCE_TEXT[chosen.source]);
  printHelp(chosen.provider);
  return 0;
}

async function report(result: DiscoveryResult): Promise<number> {
  switch (result.status) {
    case 'found':
      if (result.provider !== undefined) printProvider(result.provider);
      printSettings(result.imap);
      line('Found via', foundVia(result.source, result.via));
      if (result.altHosts.length > 0) line('Also try', result.altHosts.join(', '));
      printHelp(result.provider);
      for (const n of result.notices) warn(n);
      if (result.domainProblem !== undefined) {
        warn(domainProblemText(result.domainProblem, result.email.displayDomain));
      }
      return 0;
    case 'blocked':
      printProvider(result.provider);
      line('Found via', foundVia(result.source, result.via));
      printHelp(result.provider);
      for (const n of result.notices) warn(n);
      warn(`Not supported yet: ${result.reason}`);
      return 1;
    case 'needs-host':
      printProvider(result.provider);
      line('Found via', foundVia(result.source, result.via));
      for (const n of result.notices) warn(n);
      if (interactive()) return choose(result);
      warn(`The IMAP host is per mailbox: ${result.provider.hostHint ?? 'enter it manually'}`);
      printHelp(result.provider);
      return 0;
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
        return 1;
      }
      return choose(result);
  }
}

export function registerDiscover(program: Command): void {
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
        process.exitCode = await report(result);
      } catch (err) {
        if (err instanceof Error && err.name === 'ExitPromptError') {
          process.exitCode = 130;
          return;
        }
        // Only DiscoveryInputError messages are ours and value-free; anything else stays generic.
        console.error(err instanceof DiscoveryInputError ? err.message : 'Unexpected error');
        process.exitCode = 1;
      }
    });
}
