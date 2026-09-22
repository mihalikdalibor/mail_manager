import { Resolver } from 'node:dns/promises';
import { parseAutoconfigXml, type AutoconfigResult } from './autoconfig.js';
import { normalizeHost, parseEmail, type ParsedEmail } from './email.js';
import { findByDomain, findByMxHost, type Preset } from './presets.js';
import { settingsFromPreset, type ImapSettings } from './settings.js';

export interface DiscoveryDeps {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolveSrv(
    name: string,
  ): Promise<{ name: string; port: number; priority: number; weight: number }[]>;
  fetch: typeof globalThis.fetch;
  /** Per lookup (one DNS query, or one HTTP request including its redirects). */
  timeoutMs: number;
  /** Called before each network lookup (not for the offline preset-domain check). */
  onProgress?: (source: DiscoverySource) => void;
}

export type DiscoverySource = 'preset-domain' | 'preset-mx' | 'ispdb' | 'autoconfig' | 'srv';

export type TriedOutcome =
  'no-match' | 'not-found' | 'insecure-only' | 'invalid' | 'timeout' | 'error';

/** One source that didn't produce settings. `detail` is only ever a code, number or validated host. */
export interface Tried {
  source: DiscoverySource;
  outcome: TriedOutcome;
  detail?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  verified: boolean;
  auth: Preset['auth'];
  hint?: string;
  hostHint?: string;
  helpUrl?: string;
}

/**
 * What the domain's MX lookup says about the domain itself, so the CLI can explain it in
 * plain words: it doesn't exist (typo? expired?), its DNS is broken, or DNS couldn't be
 * reached at all (offline?). Informational only — never blocks the picker or manual entry:
 * a mailbox can still be reachable over IMAP on the provider's host (e.g. expired domain).
 * Missing MX records are deliberately NOT a problem: IMAP doesn't depend on MX.
 */
export type DomainProblem = 'not-exist' | 'dns-error' | 'dns-unreachable';

interface ResultBase {
  email: ParsedEmail;
  notices: string[];
  tried: Tried[];
  domainProblem?: DomainProblem;
}

export type DiscoveryResult =
  | (ResultBase & {
      status: 'found';
      source: DiscoverySource;
      /** What matched: the MX host, the autoconfig/ISPDB host, or the SRV name. */
      via?: string;
      provider?: ProviderInfo;
      imap: ImapSettings;
      altHosts: string[];
    })
  | (ResultBase & {
      status: 'needs-host';
      source: DiscoverySource;
      via?: string;
      provider: ProviderInfo;
    })
  | (ResultBase & {
      status: 'blocked';
      source: DiscoverySource;
      via?: string;
      provider: ProviderInfo;
      reason: string;
    })
  | (ResultBase & { status: 'manual' });

export const ISPDB_URL = 'https://autoconfig.thunderbird.net/v1.1/';
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 256 * 1024;

export function providerInfo(p: Preset): ProviderInfo {
  return {
    id: p.id,
    name: p.name,
    verified: p.verified,
    auth: p.auth,
    ...(p.hint !== undefined && { hint: p.hint }),
    ...(p.hostHint !== undefined && { hostHint: p.hostHint }),
    ...(p.helpUrl !== undefined && { helpUrl: p.helpUrl }),
  };
}

function fromPreset(
  preset: Preset,
  source: DiscoverySource,
  via: string | undefined,
  base: ResultBase,
): DiscoveryResult {
  const provider = providerInfo(preset);
  const at = via === undefined ? {} : { via };
  if (!preset.verified) {
    base.notices.push(
      `The ${preset.name} preset is not yet verified against the provider's official documentation.`,
    );
  }
  if (preset.blocked !== undefined) {
    return { ...base, status: 'blocked', source, ...at, provider, reason: preset.blocked };
  }
  const imap = settingsFromPreset(preset, base.email);
  if (imap === null) return { ...base, status: 'needs-host', source, ...at, provider };
  return {
    ...base,
    status: 'found',
    source,
    ...at,
    provider,
    imap,
    altHosts: [...preset.altHosts],
  };
}

/** DNS/network error → outcome. Only the error code is kept: messages can carry request data. */
function failure(source: DiscoverySource, err: unknown): Tried {
  const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  // fetch wraps network errors in TypeError('fetch failed') with the real code on `cause`.
  const code = e?.code ?? e?.cause?.code;
  const name = e?.name;
  if (code === 'ENOTFOUND' || code === 'ENODATA') return { source, outcome: 'not-found' };
  if (code === 'ETIMEOUT' || name === 'TimeoutError' || name === 'AbortError') {
    return { source, outcome: 'timeout' };
  }
  return {
    source,
    outcome: 'error',
    ...(typeof code === 'string' && /^[A-Z_]+$/.test(code) && { detail: code }),
  };
}

type Fetched = { ok: true; body: string; host: string } | { ok: false; tried: Tried };

async function readCapped(res: Response, signal: AbortSignal): Promise<string | null> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    await res.body?.cancel();
    return null;
  }
  if (res.body === null) return '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  // The deadline covers the body too: a server that stalls mid-body must not hang discovery.
  const onAbort = (): void => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    signal.throwIfAborted();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      signal.removeEventListener('abort', onAbort);
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  signal.removeEventListener('abort', onAbort);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

/** HTTPS GET; redirects followed manually and only to https, so no plaintext request is ever sent. */
async function httpsGet(
  url: string,
  source: DiscoverySource,
  deps: DiscoveryDeps,
): Promise<Fetched> {
  const signal = AbortSignal.timeout(deps.timeoutMs);
  let current = new URL(url);
  try {
    for (let hop = 0; ; hop++) {
      // Every hop, including redirect targets: https only, a real host name (no IP literal,
      // no localhost), default port. Checked before the request is sent.
      const host = normalizeHost(current.hostname);
      if (current.protocol !== 'https:' || host === null || current.port !== '') {
        return { ok: false, tried: { source, outcome: 'invalid' } };
      }
      const res = await deps.fetch(current, { redirect: 'manual', signal });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const location = res.headers.get('location');
        if (location === null || hop >= MAX_REDIRECTS) {
          return { ok: false, tried: { source, outcome: 'invalid' } };
        }
        current = new URL(location, current);
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel();
        return { ok: false, tried: { source, outcome: 'not-found' } };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, tried: { source, outcome: 'error', detail: `HTTP ${res.status}` } };
      }
      const body = await readCapped(res, signal);
      if (body === null) return { ok: false, tried: { source, outcome: 'invalid' } };
      return { ok: true, body, host };
    }
  } catch (err) {
    const tried = failure(source, err);
    // ISPDB's host always exists: a DNS failure there means we're offline, not "no config".
    if (source === 'ispdb' && tried.outcome === 'not-found') {
      return { ok: false, tried: { source, outcome: 'error', detail: 'ENOTFOUND' } };
    }
    return { ok: false, tried };
  }
}

function autoconfigTried(source: DiscoverySource, result: AutoconfigResult & { ok: false }): Tried {
  if (result.reason === 'insecure-only') return { source, outcome: 'insecure-only' };
  if (result.reason === 'no-imap') return { source, outcome: 'not-found' };
  return { source, outcome: 'invalid' };
}

function fromSettings(
  source: DiscoverySource,
  via: string,
  imap: ImapSettings,
  base: ResultBase,
): DiscoveryResult {
  base.notices.push(
    `These settings come from ${SOURCE_LABEL[source]}, not a built-in preset — check the host before entering a password.`,
  );
  // An online source just answered, so "DNS unreachable" from the MX step was transient or
  // wrong — don't show "check your internet connection" next to working settings.
  if (base.domainProblem === 'dns-unreachable') delete base.domainProblem;
  return { ...base, status: 'found', source, via, imap, altHosts: [] };
}

export const SOURCE_LABEL: Record<DiscoverySource, string> = {
  'preset-domain': 'built-in preset (email domain)',
  'preset-mx': 'built-in preset (MX record)',
  ispdb: 'Mozilla ISPDB',
  autoconfig: "the domain's autoconfig file",
  srv: 'DNS SRV record',
};

async function tryMx(
  email: ParsedEmail,
  deps: DiscoveryDeps,
  base: ResultBase,
): Promise<DiscoveryResult | null> {
  deps.onProgress?.('preset-mx');
  let records: { exchange: string; priority: number }[];
  try {
    records = await deps.resolveMx(email.domain);
  } catch (err) {
    base.tried.push(failure('preset-mx', err));
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOTFOUND') base.domainProblem = 'not-exist';
    else if (code === 'ENODATA') {
      // Exists, just no MX records: fine for IMAP, nothing to report.
    } else if (code === 'ESERVFAIL' || code === 'EREFUSED') base.domainProblem = 'dns-error';
    else base.domainProblem = 'dns-unreachable';
    return null;
  }
  const hosts = records
    .map((r) => ({ host: normalizeHost(r.exchange), priority: r.priority }))
    .filter((r): r is { host: string; priority: number } => r.host !== null)
    .sort((a, b) => a.priority - b.priority);
  if (hosts.length === 0) {
    // No usable MX (none, or only a "null MX"): not a problem for IMAP, just no match here.
    base.tried.push({ source: 'preset-mx', outcome: 'not-found' });
    return null;
  }
  for (const { host } of hosts) {
    const preset = findByMxHost(host);
    if (preset !== undefined) return fromPreset(preset, 'preset-mx', host, base);
  }
  base.tried.push({ source: 'preset-mx', outcome: 'no-match', detail: hosts[0]?.host ?? '' });
  return null;
}

const RANK: Record<TriedOutcome, number> = {
  'no-match': 0,
  'not-found': 0,
  timeout: 1,
  error: 1,
  invalid: 2,
  'insecure-only': 3,
};

async function tryXml(
  source: 'ispdb' | 'autoconfig',
  urls: string[],
  email: ParsedEmail,
  deps: DiscoveryDeps,
  base: ResultBase,
): Promise<DiscoveryResult | null> {
  deps.onProgress?.(source);
  let last: Tried = { source, outcome: 'not-found' };
  for (const url of urls) {
    const fetched = await httpsGet(url, source, deps);
    const parsed = fetched.ok ? parseAutoconfigXml(fetched.body, email) : null;
    if (fetched.ok && parsed?.ok) return fromSettings(source, fetched.host, parsed.settings, base);
    const outcome = fetched.ok
      ? autoconfigTried(source, parsed as AutoconfigResult & { ok: false })
      : fetched.tried;
    // Keep the most informative outcome across URLs (e.g. a later "not found" or timeout
    // never hides an earlier STARTTLS-only finding).
    if (RANK[outcome.outcome] > RANK[last.outcome]) last = outcome;
  }
  if (last.outcome === 'insecure-only') {
    base.notices.push(
      `${SOURCE_LABEL[source]} lists only STARTTLS / non-993 IMAP, which is not supported.`,
    );
  }
  base.tried.push(last);
  return null;
}

async function trySrv(
  email: ParsedEmail,
  deps: DiscoveryDeps,
  base: ResultBase,
): Promise<DiscoveryResult | null> {
  deps.onProgress?.('srv');
  const name = `_imaps._tcp.${email.domain}`;
  let records: { name: string; port: number; priority: number; weight: number }[];
  try {
    records = await deps.resolveSrv(name);
  } catch (err) {
    base.tried.push(failure('srv', err));
    return null;
  }
  const sorted = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  const first = sorted[0];
  // A single record with target "." (RFC 2782) means the service is explicitly not offered.
  if (first === undefined || first.name === '' || first.name === '.') {
    base.tried.push({ source: 'srv', outcome: 'not-found' });
    return null;
  }
  // First record (priority order) with a valid host on port 993.
  let host: string | null = null;
  for (const r of sorted) {
    const candidate = normalizeHost(r.name);
    if (candidate !== null && r.port === 993) {
      host = candidate;
      break;
    }
  }
  if (host === null) {
    const otherPort = sorted.find((r) => normalizeHost(r.name) !== null && r.port !== 993);
    if (otherPort === undefined) {
      base.tried.push({ source: 'srv', outcome: 'invalid' });
      return null;
    }
    base.notices.push(
      'The DNS SRV record points to a port other than 993, which is not supported.',
    );
    base.tried.push({ source: 'srv', outcome: 'insecure-only', detail: String(otherPort.port) });
    return null;
  }
  base.notices.push('The username is a guess (full email address); SRV records do not specify it.');
  return fromSettings('srv', name, { host, port: 993, username: email.address }, base);
}

/**
 * Finds IMAP settings for an email address without logging in. Order: preset by email
 * domain → preset by MX suffix → Mozilla ISPDB → HTTPS autoconfig → DNS SRV → manual.
 * Lookups run one after another and stop at the first hit, so later sources (e.g. Mozilla)
 * never see the domain when an earlier one matched. Network/DNS/XML failures never throw;
 * only an invalid email address throws DiscoveryInputError.
 */
export async function discover(input: string, deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const email = parseEmail(input);
  const base: ResultBase = { email, notices: [], tried: [] };

  const byDomain = findByDomain(email.domain);
  if (byDomain !== undefined) return fromPreset(byDomain, 'preset-domain', undefined, base);
  base.tried.push({ source: 'preset-domain', outcome: 'no-match' });

  const steps = [
    () => tryMx(email, deps, base),
    () => tryXml('ispdb', [`${ISPDB_URL}${email.domain}`], email, deps, base),
    () =>
      tryXml(
        'autoconfig',
        [
          `https://autoconfig.${email.domain}/mail/config-v1.1.xml`,
          `https://${email.domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
        ],
        email,
        deps,
        base,
      ),
    () => trySrv(email, deps, base),
  ];
  for (const step of steps) {
    const result = await step();
    if (result !== null) return result;
    // A domain that doesn't exist has no autoconfig/SRV/ISPDB entry; stop the lookups instead
    // of sending a (probably mistyped) domain to Mozilla. The user can still pick or type the host.
    if (base.domainProblem === 'not-exist') break;
  }
  return { ...base, status: 'manual' };
}

/** Real DNS + fetch. The resolver's own timeout cancels slow queries (no dangling Promise.race). */
export function defaultDiscoveryDeps(timeoutMs: number): DiscoveryDeps {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  return {
    resolveMx: (domain) => resolver.resolveMx(domain),
    resolveSrv: (name) => resolver.resolveSrv(name),
    fetch: globalThis.fetch,
    timeoutMs,
  };
}
