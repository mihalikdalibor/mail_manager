import {
  SOURCE_LABEL,
  type DiscoveryResult,
  type DiscoverySource,
  type DomainProblem,
  type ProviderInfo,
  type Tried,
} from '../core/providers/discover.js';
import type { ImapSettings } from '../core/providers/settings.js';
import { sanitize } from './log-text.js';

// How discovery results are printed — shared by `mm discover` and `mm account add`.

const OUTCOME_LABEL: Record<Tried['outcome'], string> = {
  'no-match': 'no known provider',
  'not-found': 'nothing found',
  'insecure-only': 'only STARTTLS / non-993 (not supported)',
  invalid: 'invalid response',
  timeout: 'timed out',
  error: 'failed',
};

/** Plain-language explanation of a domain problem: what happened and what to do. */
export function domainProblemText(problem: DomainProblem, domain: string): string {
  switch (problem) {
    case 'not-exist':
      return `The domain "${domain}" does not exist. Check the email address for typos. If the domain has expired but the mailbox still exists at your provider, you can still choose the provider or enter its IMAP host.`;
    case 'dns-error':
      return `The DNS servers of "${domain}" answered with an error, so its mail settings can't be looked up right now. Try again later, or ask whoever manages the domain.`;
    case 'dns-unreachable':
      return `Could not reach DNS to look up "${domain}". Check your internet connection and try again.`;
  }
}

/**
 * Warning for a DNS SRV result that points outside the email's domain (and is no preset host):
 * SRV records are unsigned, so someone on the network could have faked one. Host and domain
 * come from DNS and the typed address, so they go through `sanitize`.
 */
export function offDomainWarning(result: DiscoveryResult): string | undefined {
  if (result.status !== 'found' || result.offDomain !== true) return undefined;
  return `Warning: this server is not under ${sanitize(result.email.displayDomain)} and comes from an unsigned DNS record, which someone on your network could fake. Only continue if you know your provider uses ${sanitize(result.imap.host)}.`;
}

export function line(label: string, value: string): void {
  console.log(`${label.padEnd(10)} ${value}`);
}

export function warn(text: string): void {
  console.log(`! ${text}`);
}

export function printProvider(provider: ProviderInfo): void {
  line('Provider', provider.verified ? provider.name : `${provider.name} (unverified preset)`);
}

export function printHelp(provider: ProviderInfo | undefined): void {
  if (provider?.hint !== undefined) line('Hint', provider.hint);
  if (provider?.helpUrl !== undefined) line('Help', provider.helpUrl);
}

export function printSettings(imap: ImapSettings): void {
  line('IMAP', `${imap.host}:${imap.port} (TLS)`);
  line('Username', imap.username);
}

export function foundVia(source: DiscoverySource, via: string | undefined): string {
  return via === undefined ? SOURCE_LABEL[source] : `${SOURCE_LABEL[source]} — ${via}`;
}

export function printTried(tried: Tried[]): void {
  for (const t of tried) {
    const detail = t.detail === undefined ? '' : ` (${t.detail})`;
    line('  tried', `${SOURCE_LABEL[t.source]}: ${OUTCOME_LABEL[t.outcome]}${detail}`);
  }
}
