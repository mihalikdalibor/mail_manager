// SSRF / hostile-server probe for provider discovery (src/core/providers/discover.ts).
// Runs discover() against FAKE DNS + fetch (no network): attacker-controlled MX/SRV answers,
// autoconfig redirects to http/IP/localhost/ports, redirect loops, oversized and stalled
// bodies, XML bombs, hostile usernames — and checks nothing attacker-controlled is echoed.
// Usage (repo root): npx tsx .claude/security/probes/discovery-ssrf.mts
import { join } from 'node:path';

const root = process.env.MM_REPO ?? process.cwd();
const { discover } = await import(join(root, 'src/core/providers/discover.ts'));

let findings = 0;
const find = (m: string): void => {
  findings++;
  console.log(`FIND  ${m}`);
};
const ok = (m: string): void => console.log(`ok    ${m}`);
const CANARY = 'ATTACKER-CANARY-7f3a';

const xml = (host: string, user = '%EMAILADDRESS%', port = '993', socket = 'SSL'): string =>
  `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="x"><incomingServer type="imap">` +
  `<hostname>${host}</hostname><port>${port}</port><socketType>${socket}</socketType>` +
  `<username>${user}</username></incomingServer></emailProvider></clientConfig>`;

type Route = (url: URL) => Response | Promise<Response>;
function deps(route: Route, dns: { mx?: unknown; srv?: unknown } = {}) {
  const requested: string[] = [];
  return {
    requested,
    d: {
      timeoutMs: 300,
      resolveMx: async () => {
        if (dns.mx) return dns.mx;
        throw Object.assign(new Error('x'), { code: 'ENODATA' });
      },
      resolveSrv: async () => {
        if (dns.srv) return dns.srv;
        throw Object.assign(new Error('x'), { code: 'ENODATA' });
      },
      fetch: (async (input: URL | string, init?: RequestInit) => {
        const url = new URL(String(input));
        requested.push(url.href);
        if (init?.redirect !== 'manual') find(`fetch without redirect:'manual' for ${url.host}`);
        return route(url);
      }) as typeof fetch,
    },
  };
}
const redirect = (to: string): Response =>
  new Response(null, { status: 302, headers: { location: to } });
const notFound = (): Response => new Response(null, { status: 404 });
const isIspdb = (u: URL): boolean => u.hostname === 'autoconfig.thunderbird.net';

async function run(
  name: string,
  route: Route,
  check: (r: any, requested: string[]) => void,
  dns = {},
) {
  const { d, requested } = deps(route, dns);
  const t = performance.now();
  let r: any;
  // A real socket keeps the event loop alive; with fakes, AbortSignal.timeout's unref'd timer
  // would let node exit mid-await. This keeps the process up while discover() runs.
  const keepAlive = setInterval(() => undefined, 1000);
  try {
    r = await discover(`user@victim-${Math.random().toString(36).slice(2, 8)}.com`, d);
  } catch (e) {
    find(`${name}: discover threw ${(e as Error).name}`);
    return;
  } finally {
    clearInterval(keepAlive);
  }
  if (performance.now() - t > 5000)
    find(`${name}: took ${(performance.now() - t).toFixed(0)} ms (timeout not enforced)`);
  const out = JSON.stringify(r);
  if (out.includes(CANARY)) find(`${name}: attacker-controlled text reached the result`);
  check(r, requested);
}

// Every non-https / IP / localhost / non-default-port redirect target must NOT be requested.
for (const target of [
  'http://imap.evil.com/c.xml',
  'https://127.0.0.1/c.xml',
  'https://[::1]/c.xml',
  'https://localhost/c.xml',
  'https://169.254.169.254/latest/meta-data/',
  'https://evil.com:8443/c.xml',
  'https://0x7f.1/c.xml',
  'file:///etc/passwd',
]) {
  await run(
    `redirect -> ${target}`,
    (u) =>
      isIspdb(u) ? notFound() : u.pathname.includes('config-v1.1') ? redirect(target) : notFound(),
    (_r, req) => {
      const t = new URL(target);
      if (
        req.some(
          (h) =>
            new URL(h).host === t.host &&
            new URL(h).protocol === t.protocol &&
            !h.includes('victim-'),
        )
      )
        find(`requested redirect target ${target}`);
      else ok(`blocked redirect to ${target}`);
    },
  );
}

// Redirect loop: bounded hops.
await run(
  'redirect loop',
  (u) => (isIspdb(u) ? notFound() : redirect(`https://${u.hostname}/loop${Math.random()}`)),
  (_r, req) =>
    req.length > 2 * 4 + 1
      ? find(`redirect loop made ${req.length} requests`)
      : ok(`redirect loop capped (${req.length} requests)`),
);

// Oversized body (declared and streamed) and stalled body.
await run(
  'huge body',
  (u) => (isIspdb(u) ? notFound() : new Response('x'.repeat(5 * 1024 * 1024))),
  (r) => (r.status === 'found' ? find('accepted a 5 MB autoconfig body') : ok('5 MB body refused')),
);
await run(
  'stalled body',
  (u) =>
    isIspdb(u)
      ? notFound()
      : new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('<?xml'));
            },
          }),
        ),
  () => ok('stalled body did not hang discovery'),
);

// Hostile XML: entity bombs, __proto__, IP host, CRLF username, STARTTLS, attacker text.
const HOSTILE: [string, string, (r: any) => boolean][] = [
  // Positive control: proves the harness reaches the parser (otherwise every case "passes").
  [
    'CONTROL valid config is found',
    xml('imap.evil.com'),
    (r) => r.status === 'found' && r.imap.host === 'imap.evil.com',
  ],
  [
    'billion laughs',
    `<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "${'A'.repeat(1000)}"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><clientConfig><emailProvider><incomingServer type="imap"><hostname>&b;</hostname></incomingServer></emailProvider></clientConfig>`,
    (r) => r.status !== 'found',
  ],
  [
    '__proto__ pollution',
    xml('imap.evil.com').replace(
      '<emailProvider id="x">',
      '<emailProvider id="x"><__proto__><polluted>1</polluted></__proto__>',
    ),
    () => (({}) as any).polluted === undefined,
  ],
  ['IP literal host', xml('127.0.0.1'), (r) => r.status !== 'found'],
  ['metadata host', xml('169.254.169.254'), (r) => r.status !== 'found'],
  [
    'CRLF username',
    xml('imap.evil.com', `x&#13;&#10;A1 LOGOUT`),
    (r) => r.status !== 'found' || !/[\r\n]/.test(r.imap.username),
  ],
  ['free-text username', xml('imap.evil.com', `${CANARY} please`), (r) => r.status !== 'found'],
  [
    'STARTTLS only',
    xml('imap.evil.com', '%EMAILADDRESS%', '143', 'STARTTLS'),
    (r) => r.status !== 'found',
  ],
  ['unknown placeholder', xml('%REALNAME%.evil.com'), (r) => r.status !== 'found'],
  [
    'placeholder re-expansion',
    xml('imap.%EMAILDOMAIN%', '%EMAILLOCALPART%'),
    (r) => r.status !== 'found' || !r.imap.username.includes('%'),
  ],
];
for (const [name, body, pass] of HOSTILE) {
  await run(
    `xml: ${name}`,
    (u) => (isIspdb(u) ? notFound() : new Response(body)),
    (r) =>
      pass(r)
        ? ok(`xml: ${name}`)
        : find(`xml: ${name} -> ${r.status} ${JSON.stringify(r.imap ?? {})}`),
  );
}

// Hostile DNS: MX/SRV pointing to IPs/localhost/huge ports must not become settings.
await run(
  'SRV -> localhost',
  notFound,
  (r) =>
    r.status === 'found'
      ? find(`SRV localhost accepted: ${r.imap.host}`)
      : ok('SRV localhost refused'),
  { srv: [{ name: 'localhost', port: 993, priority: 0, weight: 0 }] },
);
await run(
  'SRV -> 127.0.0.1',
  notFound,
  (r) => (r.status === 'found' ? find('SRV IP accepted') : ok('SRV IP refused')),
  { srv: [{ name: '127.0.0.1', port: 993, priority: 0, weight: 0 }] },
);
await run(
  'SRV -> port 143',
  notFound,
  (r) => (r.status === 'found' ? find('SRV port 143 accepted') : ok('SRV port 143 refused')),
  { srv: [{ name: 'imap.evil.com', port: 143, priority: 0, weight: 0 }] },
);
await run('MX canary text', notFound, () => ok('MX with control chars handled'), {
  mx: [{ exchange: `${CANARY}\u001b[31m.evil.com`, priority: 0 }],
});

// Privacy: a non-existent domain must not be sent to Mozilla ISPDB.
{
  const { d, requested } = deps(notFound);
  d.resolveMx = async () => {
    throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
  };
  await discover('user@typo-domain-xyz.com', d);
  requested.some((u) => u.includes('thunderbird'))
    ? find('non-existent domain sent to ISPDB')
    : ok('non-existent domain not sent to ISPDB');
}

console.log(findings === 0 ? 'clean' : `${findings} finding(s)`);
process.exitCode = findings === 0 ? 0 : 1;
