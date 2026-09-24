// Input-validation fuzz for every place a user- or server-supplied host/email/username/
// password enters core: SSRF literals, IP obfuscation, IDN homographs, bidi/invisible chars,
// CRLF/NUL (IMAP command injection), path/URL smuggling, ReDoS timing.
// No network except step 4 (plain DNS A/AAAA lookups of hosts the validator ACCEPTED).
// Usage (repo root): npx tsx .claude/security/probes/input-fuzz.mts [--no-dns]
import { resolve4, resolve6 } from 'node:dns/promises';
import { join } from 'node:path';

const root = process.env.MM_REPO ?? process.cwd();
const email = await import(join(root, 'src/core/providers/email.ts'));
const errors = await import(join(root, 'src/core/imap/errors.ts'));
const settings = await import(join(root, 'src/core/providers/settings.ts'));

let findings = 0;
const find = (m: string): void => {
  findings++;
  console.log(`FIND  ${m}`);
};
const show = (s: string): string => JSON.stringify(s).slice(0, 60);

// 1. Hosts that must be REJECTED (SSRF to loopback/private/metadata, smuggling, controls).
const MUST_REJECT = [
  'localhost',
  'LOCALHOST.',
  '127.0.0.1',
  '127.1',
  '0x7f.1',
  '0x7f000001',
  '2130706433',
  '017700000001',
  '127.0.0.0x1',
  '0',
  '0.0.0.0',
  '[::1]',
  '::1',
  '[::ffff:127.0.0.1]',
  '169.254.169.254',
  '10.0.0.1',
  '192.168.1.1',
  'evil.com/x',
  'evil.com:25',
  'evil.com?x',
  'evil.com#x',
  'user@evil.com',
  'evil.com\\x',
  '%6cocalhost',
  'evil.com%2f..',
  'imap.evil.com\r\nA1 LOGOUT',
  'imap.evil.com\0',
  'imap .evil.com',
  'imap.evil.com\u202e',
  'imap\u200b.evil.com',
  '-imap.evil.com',
  'imap-.evil.com',
  'a'.repeat(64) + '.com',
  ('a'.repeat(60) + '.').repeat(5) + 'com',
  'com',
  '.',
  '',
  'https://imap.evil.com',
  'imap.evil.123',
];
for (const h of MUST_REJECT) {
  if (email.hostFromUserInput(h) !== null) find(`hostFromUserInput accepted ${show(h)}`);
  if (email.normalizeHost(h) !== null) find(`normalizeHost accepted ${show(h)}`);
  try {
    settings.validateManualHost(h);
    find(`validateManualHost accepted ${show(h)}`);
  } catch {
    /* rejected: good */
  }
}

// Accepted on purpose (valid DNS names), but they may RESOLVE to private addresses — see step 4.
const REBIND_CANDIDATES = [
  'localtest.me',
  '127.0.0.1.nip.io',
  'metadata.google.internal',
  'imap.example.com',
];

// 2. Email addresses: must reject, and display domain must equal what is looked up.
const EMAIL_REJECT = [
  'a@localhost',
  'a@127.0.0.1',
  'a@[127.0.0.1]',
  'a@evil.com/x',
  'a\r\n@evil.com',
  'a@evil.com\r\nX',
  'a\u202e@evil.com',
  'a b@evil.com',
  '@evil.com',
  'a@',
  'a'.repeat(260) + '@x.com',
  'a@0x7f.1',
];
for (const e of EMAIL_REJECT) {
  try {
    email.parseEmail(e);
    find(`parseEmail accepted ${show(e)}`);
  } catch (err) {
    if (!(err instanceof email.DiscoveryInputError))
      find(`parseEmail threw a non-user error for ${show(e)}`);
    // The message must not echo the input (terminal/escape injection, PII in logs).
    else if ((err as Error).message.includes(e.slice(0, 8)) && e.length > 3)
      find(`parseEmail message echoes input ${show(e)}`);
  }
}
// Homograph: ASCII-typed punycode must display as ASCII; mixed-script shows exactly the looked-up name.
for (const e of ['a@xn--80ak6aa92e.com', 'a@аррӏе.com', 'a@ｅｖｉｌ.com', 'a@evil。com']) {
  try {
    const p = email.parseEmail(e);
    if (e.includes('xn--') && p.displayDomain !== p.domain)
      find(`punycode ${show(e)} displayed as Unicode ${show(p.displayDomain)}`);
    console.log(`info  ${show(e)} -> lookup ${p.domain}, shown ${show(p.displayDomain)}`);
  } catch {
    console.log(`info  ${show(e)} rejected`);
  }
}

// 3. Credentials: CR/LF/NUL/oversize must be refused before any network activity.
const BAD_CREDS: [string, string][] = [
  ['user', 'pa\r\nss'],
  ['user', 'pa\nA1 LOGOUT'],
  ['user', 'pa\0ss'],
  ['user', ''],
  ['user', 'x'.repeat(1025)],
  ['us\r\ner', 'pass'],
  ['user\u200b', 'pass'],
  ['u\u202eser', 'pass'],
  [' ', 'pass'],
  ['u'.repeat(255), 'pass'],
];
for (const [u, p] of BAD_CREDS) {
  if (errors.validateCredentialsInput(u, p) === null)
    find(`validateCredentialsInput accepted user=${show(u)} pass(len ${p.length})`);
}

// ReDoS: validators must stay linear on long adversarial input.
for (const [label, fn] of [
  ['hostFromUserInput', () => email.hostFromUserInput('a-'.repeat(50_000) + '!')],
  [
    'parseEmail',
    () => {
      try {
        email.parseEmail('a'.repeat(200) + '@' + 'a.'.repeat(30_000));
      } catch {
        /* */
      }
    },
  ],
  ['normalizeHost', () => email.normalizeHost('a.'.repeat(100_000) + '-')],
] as const) {
  const t = performance.now();
  fn();
  const ms = performance.now() - t;
  if (ms > 200) find(`${label} took ${ms.toFixed(0)} ms on adversarial input (ReDoS?)`);
}

// 4. DNS rebinding / private resolution: accepted names that resolve to internal ranges.
// Known accepted gap until M6a (docs/SECURITY.md) for the CLI; CRITICAL once a server connects.
const PRIVATE =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|^(::1|fc|fd|fe80)/i;
if (!process.argv.includes('--no-dns')) {
  for (const h of REBIND_CANDIDATES) {
    if (email.hostFromUserInput(h) === null) {
      console.log(`info  ${h} rejected by validator`);
      continue;
    }
    const ips = [...(await resolve4(h).catch(() => [])), ...(await resolve6(h).catch(() => []))];
    const priv = ips.filter((ip) => PRIVATE.test(ip));
    console.log(
      `${priv.length ? 'GAP ' : 'info'}  ${h} accepted; resolves to ${ips.join(', ') || '(nothing)'}${priv.length ? ' <- private (resolve-and-pin guard needed before hosting)' : ''}`,
    );
  }
}

console.log(findings === 0 ? 'clean' : `${findings} finding(s)`);
process.exitCode = findings === 0 ? 0 : 1;
