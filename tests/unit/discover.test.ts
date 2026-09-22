import { describe, it, expect, vi } from 'vitest';
import {
  ISPDB_URL,
  SOURCE_LABEL,
  discover,
  type DiscoveryDeps,
  type DiscoveryResult,
  type DiscoverySource,
  type Tried,
} from '../../src/core/providers/discover.js';
import { DiscoveryInputError } from '../../src/core/providers/email.js';
import { PRESETS } from '../../src/core/providers/presets.js';

const DOMAIN = 'example-test-domain.eu';
const EMAIL = `someone@${DOMAIN}`;
const ISPDB = `${ISPDB_URL}${DOMAIN}`;
const AC1 = `https://autoconfig.${DOMAIN}/mail/config-v1.1.xml`;
const AC2 = `https://${DOMAIN}/.well-known/autoconfig/mail/config-v1.1.xml`;
const SRV_NAME = `_imaps._tcp.${DOMAIN}`;
const KIB = 1024;

type MxRecord = { exchange: string; priority: number };
type SrvRecord = { name: string; port: number; priority: number; weight: number };
type Route = () => Response | Promise<Response>;

function dnsError(code: string, message = `query ${code} secret-dns-message`): Error {
  return Object.assign(new Error(message), { code });
}

function notFoundNetworkError(): TypeError {
  return new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

interface FakeOptions {
  mx?: MxRecord[] | Error;
  srv?: SrvRecord[] | Error;
  routes?: Record<string, Route>;
  events?: string[];
}

interface Fake {
  deps: DiscoveryDeps;
  resolveMx: ReturnType<typeof vi.fn<DiscoveryDeps['resolveMx']>>;
  resolveSrv: ReturnType<typeof vi.fn<DiscoveryDeps['resolveSrv']>>;
  fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  fetchedUrls: () => string[];
  progress: DiscoverySource[];
}

function fake(opts: FakeOptions = {}): Fake {
  const events = opts.events;
  const progress: DiscoverySource[] = [];
  const resolveMx = vi.fn<DiscoveryDeps['resolveMx']>((domain) => {
    events?.push(`mx:${domain}`);
    // Default: the domain exists but has no MX (ENODATA), so every later source is tried.
    const mx = opts.mx ?? dnsError('ENODATA');
    return mx instanceof Error ? Promise.reject(mx) : Promise.resolve(mx);
  });
  const resolveSrv = vi.fn<DiscoveryDeps['resolveSrv']>((name) => {
    events?.push(`srv:${name}`);
    const srv = opts.srv ?? dnsError('ENOTFOUND');
    return srv instanceof Error ? Promise.reject(srv) : Promise.resolve(srv);
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = urlOf(input);
    events?.push(`fetch:${url}`);
    const route = opts.routes?.[url];
    if (!route) throw notFoundNetworkError();
    return route();
  });
  const deps: DiscoveryDeps = {
    resolveMx,
    resolveSrv,
    fetch,
    timeoutMs: 50,
    onProgress: (s) => {
      events?.push(`progress:${s}`);
      progress.push(s);
    },
  };
  return {
    deps,
    resolveMx,
    resolveSrv,
    fetch,
    fetchedUrls: () => fetch.mock.calls.map(([input]) => urlOf(input)),
    progress,
  };
}

function xml(
  opts: { host?: string; port?: string; socketType?: string; type?: string } = {},
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1"><emailProvider id="${DOMAIN}">
<incomingServer type="${opts.type ?? 'imap'}"><hostname>${opts.host ?? `imap.${DOMAIN}`}</hostname><port>${opts.port ?? '993'}</port><socketType>${opts.socketType ?? 'SSL'}</socketType><username>%EMAILADDRESS%</username></incomingServer>
</emailProvider></clientConfig>`;
}

const ok =
  (body: string | Uint8Array = xml(), headers: Record<string, string> = {}): Route =>
  () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/xml', ...headers } });
const status =
  (code: number, headers: Record<string, string> = {}): Route =>
  () =>
    new Response(null, { status: code, headers });
const redirect = (location: string, code = 302): Route => status(code, { location });

function tried(r: DiscoveryResult, source: DiscoverySource): Tried | undefined {
  return r.tried.find((t) => t.source === source);
}

function presetBy(pred: (p: (typeof PRESETS)[number]) => boolean): (typeof PRESETS)[number] {
  const p = PRESETS.find(pred);
  if (!p) throw new Error('fixture preset missing');
  return p;
}

describe('discover: input', () => {
  it.each([['no-at-sign'], ['a@localhost'], ['a@1.2.3.4'], ['']])(
    'rejects %j before touching any dependency',
    async (input) => {
      const f = fake();
      await expect(discover(input, f.deps)).rejects.toBeInstanceOf(DiscoveryInputError);
      expect(f.resolveMx).not.toHaveBeenCalled();
      expect(f.resolveSrv).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.progress).toEqual([]);
    },
  );
});

describe('discover: preset by email domain', () => {
  it('finds gmail without any network lookup', async () => {
    const gmail = presetBy((p) => p.id === 'gmail');
    const f = fake();
    const r = await discover('Someone@GMAIL.com', f.deps);
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.source).toBe('preset-domain');
    expect(r.provider?.id).toBe('gmail');
    expect(r.provider?.name).toBe(gmail.name);
    expect(r.imap).toEqual({ host: gmail.imap?.host, port: 993, username: 'Someone@gmail.com' });
    expect(r.altHosts).toEqual(gmail.altHosts);
    expect(r.email.domain).toBe('gmail.com');
    expect(f.resolveMx).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.resolveSrv).not.toHaveBeenCalled();
  });

  it('returns blocked for outlook.com with the preset reason and no lookups', async () => {
    const outlook = presetBy((p) => p.id === 'outlook');
    const f = fake();
    const r = await discover('someone@outlook.com', f.deps);
    expect(r.status).toBe('blocked');
    if (r.status !== 'blocked') return;
    expect(r.source).toBe('preset-domain');
    expect(r.provider.id).toBe('outlook');
    expect(r.reason).toBe(outlook.blocked);
    expect(f.resolveMx).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('returns needs-host for a preset without imap host', async () => {
    const p = presetBy((x) => x.id === 'wedos');
    const domain = p.domains[0];
    const f = domain
      ? fake()
      : fake({ mx: [{ exchange: `mx1.${p.mxSuffixes[0] ?? ''}`, priority: 10 }] });
    const r = await discover(domain ? `someone@${domain}` : EMAIL, f.deps);
    expect(r.status).toBe('needs-host');
    if (r.status !== 'needs-host') return;
    expect(r.source).toBe(domain ? 'preset-domain' : 'preset-mx');
    expect(r.provider.id).toBe(p.id);
    expect(r.provider.hostHint).toBe(p.hostHint);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('adds a notice for an unverified preset', async () => {
    const p = presetBy((x) => x.id === 'zoznam' && !x.verified);
    const r = await discover(`someone@${p.domains[0] ?? ''}`, fake().deps);
    expect(r.status).toBe('found');
    expect(r.notices.some((n) => /verif/i.test(n))).toBe(true);
  });
});

describe('discover: preset by MX', () => {
  it('matches websupport via MX and never fetches', async () => {
    const ws = presetBy((p) => p.id === 'websupport');
    const f = fake({
      mx: [
        { exchange: 'mx20.other.example.com', priority: 20 },
        { exchange: 'mx10.websupport.sk', priority: 10 },
      ],
    });
    const r = await discover(EMAIL, f.deps);
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.source).toBe('preset-mx');
    expect(r.via).toBe('mx10.websupport.sk');
    expect(r.provider?.id).toBe('websupport');
    expect(r.imap).toEqual({ host: 'imap.m1.websupport.sk', port: 993, username: EMAIL });
    expect(r.altHosts).toEqual(ws.altHosts);
    expect(r.tried[0]).toEqual({ source: 'preset-domain', outcome: 'no-match' });
    expect(f.resolveMx).toHaveBeenCalledWith(DOMAIN);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.resolveSrv).not.toHaveBeenCalled();
    expect(f.progress).toEqual(['preset-mx']);
  });

  it('a matching MX wins even if a non-matching one has lower priority', async () => {
    const f = fake({
      mx: [
        { exchange: 'mx1.other.example.com', priority: 1 },
        { exchange: 'mx10.websupport.sk', priority: 30 },
      ],
    });
    const r = await discover(EMAIL, f.deps);
    expect(r.status === 'found' && r.provider?.id).toBe('websupport');
  });

  it('picks the matching MX with the lowest priority', async () => {
    const p = presetBy((x) => x.id === 'webhouse');
    const f = fake({
      mx: [
        { exchange: 'mx10.websupport.sk', priority: 20 },
        { exchange: `mx.${p.mxSuffixes[0] ?? ''}`, priority: 5 },
      ],
    });
    const r = await discover(EMAIL, f.deps);
    expect(r.status === 'found' || r.status === 'needs-host' || r.status === 'blocked').toBe(true);
    if (r.status === 'manual') return;
    expect(r.source).toBe('preset-mx');
    expect(r.provider?.id).toBe(p.id);
    expect(r.via).toBe(`mx.${p.mxSuffixes[0] ?? ''}`);
  });

  it('drops null MX records → not-found and continues', async () => {
    const f = fake({
      mx: [
        { exchange: '', priority: 0 },
        { exchange: '.', priority: 0 },
      ],
    });
    const r = await discover(EMAIL, f.deps);
    expect(tried(r, 'preset-mx')?.outcome).toBe('not-found');
    expect(f.fetchedUrls()).toContain(ISPDB);
  });

  it('drops invalid exchanges and never leaks them', async () => {
    const f = fake({
      mx: [
        { exchange: '1.2.3.4', priority: 1 },
        { exchange: 'evil\u001b[31m.com', priority: 2 },
      ],
    });
    const r = await discover(EMAIL, f.deps);
    expect(tried(r, 'preset-mx')?.outcome).toBe('not-found');
    const json = JSON.stringify(r);
    expect(json).not.toContain('evil');
    expect(json).not.toContain('1.2.3.4');
  });

  it('records present but no preset → no-match with the lowest-priority valid MX', async () => {
    const f = fake({
      mx: [
        { exchange: 'mx2.other.example.com', priority: 20 },
        { exchange: '1.2.3.4', priority: 1 },
        { exchange: 'MX1.Other.Example.com.', priority: 10 },
      ],
    });
    const r = await discover(EMAIL, f.deps);
    expect(tried(r, 'preset-mx')).toEqual({
      source: 'preset-mx',
      outcome: 'no-match',
      detail: 'mx1.other.example.com',
    });
  });

  it.each<[string, Error, Tried]>([
    ['ENOTFOUND', dnsError('ENOTFOUND'), { source: 'preset-mx', outcome: 'not-found' }],
    ['ENODATA', dnsError('ENODATA'), { source: 'preset-mx', outcome: 'not-found' }],
    ['ETIMEOUT', dnsError('ETIMEOUT'), { source: 'preset-mx', outcome: 'timeout' }],
    [
      'ESERVFAIL',
      dnsError('ESERVFAIL'),
      { source: 'preset-mx', outcome: 'error', detail: 'ESERVFAIL' },
    ],
    ['odd code', dnsError('bad code\u001b!'), { source: 'preset-mx', outcome: 'error' }],
    ['no code', new Error('secret-dns-message'), { source: 'preset-mx', outcome: 'error' }],
  ])('MX lookup error %s', async (_label, error, expected) => {
    const r = await discover(EMAIL, fake({ mx: error }).deps);
    expect(tried(r, 'preset-mx')).toEqual(expected);
    const json = JSON.stringify(r);
    expect(json).not.toContain('secret-dns-message');
    expect(json).not.toContain('\u001b');
  });
});

describe('discover: ISPDB', () => {
  it('found via ISPDB; no provider; notice; stops there', async () => {
    const f = fake({ routes: { [ISPDB]: ok() } });
    const r = await discover(EMAIL, f.deps);
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.source).toBe('ispdb');
    expect(r.via).toBe('autoconfig.thunderbird.net');
    expect(r.provider).toBeUndefined();
    expect(r.imap).toEqual({ host: `imap.${DOMAIN}`, port: 993, username: EMAIL });
    expect(r.notices.some((n) => /preset/i.test(n))).toBe(true);
    expect(f.fetchedUrls()).toEqual([ISPDB]);
    expect(f.resolveSrv).not.toHaveBeenCalled();
    expect(f.progress).toEqual(['preset-mx', 'ispdb']);
  });

  it('calls fetch with redirect manual and an abort signal', async () => {
    const f = fake({ routes: { [ISPDB]: ok() } });
    await discover(EMAIL, f.deps);
    const init = f.fetch.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('insecure-only → tried + STARTTLS/993 notice, continues to autoconfig', async () => {
    const f = fake({ routes: { [ISPDB]: ok(xml({ port: '143', socketType: 'STARTTLS' })) } });
    const r = await discover(EMAIL, f.deps);
    expect(tried(r, 'ispdb')?.outcome).toBe('insecure-only');
    expect(r.notices.some((n) => /STARTTLS|993/.test(n))).toBe(true);
    expect(f.fetchedUrls()).toContain(AC1);
  });

  it('no-imap → not-found', async () => {
    const r = await discover(EMAIL, fake({ routes: { [ISPDB]: ok(xml({ type: 'pop3' })) } }).deps);
    expect(tried(r, 'ispdb')?.outcome).toBe('not-found');
  });

  it('invalid XML → invalid', async () => {
    const r = await discover(EMAIL, fake({ routes: { [ISPDB]: ok('<html>oops') } }).deps);
    expect(tried(r, 'ispdb')?.outcome).toBe('invalid');
  });

  it.each<[number, Tried]>([
    [404, { source: 'ispdb', outcome: 'not-found' }],
    [410, { source: 'ispdb', outcome: 'not-found' }],
    [500, { source: 'ispdb', outcome: 'error', detail: 'HTTP 500' }],
    [403, { source: 'ispdb', outcome: 'error', detail: 'HTTP 403' }],
  ])('HTTP %i', async (code, expected) => {
    const r = await discover(EMAIL, fake({ routes: { [ISPDB]: status(code) } }).deps);
    expect(tried(r, 'ispdb')).toEqual(expected);
  });

  // ISPDB's host always exists, so a DNS failure there means "offline", not "no config".
  it('network ENOTFOUND → error (offline), not "nothing found"', async () => {
    const r = await discover(EMAIL, fake().deps);
    expect(tried(r, 'ispdb')).toEqual({ source: 'ispdb', outcome: 'error', detail: 'ENOTFOUND' });
  });

  it.each([
    ['AbortError', () => new DOMException('This operation was aborted', 'AbortError')],
    ['TimeoutError', () => new DOMException('The operation timed out', 'TimeoutError')],
  ])('%s → timeout', async (_label, make) => {
    const r = await discover(
      EMAIL,
      fake({
        routes: {
          [ISPDB]: () => {
            throw make();
          },
        },
      }).deps,
    );
    expect(tried(r, 'ispdb')?.outcome).toBe('timeout');
  });

  it('other fetch errors → error, message not leaked', async () => {
    const r = await discover(
      EMAIL,
      fake({
        routes: {
          [ISPDB]: () => {
            throw new Error('secret-fetch-message');
          },
        },
      }).deps,
    );
    expect(tried(r, 'ispdb')?.outcome).toBe('error');
    expect(JSON.stringify(r)).not.toContain('secret-fetch-message');
  });

  it('Content-Length over 256 KiB → invalid', async () => {
    const r = await discover(
      EMAIL,
      fake({ routes: { [ISPDB]: ok(xml(), { 'content-length': String(256 * KIB + 1) }) } }).deps,
    );
    expect(tried(r, 'ispdb')?.outcome).toBe('invalid');
  });

  it('streamed body over 256 KiB → invalid', async () => {
    const chunk = new Uint8Array(64 * KIB).fill(0x20);
    const route: Route = () => {
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 5) controller.close();
          else {
            sent += 1;
            controller.enqueue(chunk);
          }
        },
      });
      return new Response(stream, { status: 200 });
    };
    const r = await discover(EMAIL, fake({ routes: { [ISPDB]: route } }).deps);
    expect(tried(r, 'ispdb')?.outcome).toBe('invalid');
  });

  it('a body just under 256 KiB is still read', async () => {
    const body = xml() + ' '.repeat(200 * KIB);
    const r = await discover(EMAIL, fake({ routes: { [ISPDB]: ok(body) } }).deps);
    expect(r.status === 'found' && r.source).toBe('ispdb');
  });

  it('invalid UTF-8 → invalid', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode(xml()), 0xff, 0xfe, 0xc3]);
    const r = await discover(EMAIL, fake({ routes: { [ISPDB]: ok(bytes) } }).deps);
    expect(tried(r, 'ispdb')?.outcome).toBe('invalid');
  });

  it('control chars in an XML hostname never reach the result', async () => {
    const r = await discover(
      EMAIL,
      fake({ routes: { [ISPDB]: ok(xml({ host: 'evil\u001b[31m.com' })) } }).deps,
    );
    expect(r.status === 'found' && r.source === 'ispdb').toBe(false);
    expect(JSON.stringify(r)).not.toContain('evil');
  });
});

describe('discover: redirects', () => {
  it('follows a relative redirect on the same host', async () => {
    const next = 'https://autoconfig.thunderbird.net/v1.1/other-path';
    const f = fake({ routes: { [ISPDB]: redirect('/v1.1/other-path'), [next]: ok() } });
    const r = await discover(EMAIL, f.deps);
    expect(r.status === 'found' && r.source).toBe('ispdb');
    expect(f.fetchedUrls()).toEqual([ISPDB, next]);
    for (const call of f.fetch.mock.calls) expect(call[1]?.redirect).toBe('manual');
  });

  it('via is the final https host', async () => {
    const next = 'https://mirror.example.com/config.xml';
    const r = await discover(
      EMAIL,
      fake({ routes: { [ISPDB]: redirect(next, 301), [next]: ok() } }).deps,
    );
    expect(r.status === 'found' && r.via).toBe('mirror.example.com');
  });

  it('a redirect to http is invalid and the http URL is never fetched', async () => {
    const f = fake({
      routes: {
        [ISPDB]: redirect('http://autoconfig.thunderbird.net/v1.1/x'),
        'http://autoconfig.thunderbird.net/v1.1/x': ok(),
      },
    });
    const r = await discover(EMAIL, f.deps);
    expect(tried(r, 'ispdb')?.outcome).toBe('invalid');
    for (const url of f.fetchedUrls()) expect(url.startsWith('http:')).toBe(false);
  });

  it('resolves a protocol-relative redirect against https', async () => {
    const next = 'https://other.example.com/x.xml';
    const r = await discover(
      EMAIL,
      fake({ routes: { [ISPDB]: redirect('//other.example.com/x.xml'), [next]: ok() } }).deps,
    );
    expect(r.status === 'found' && r.via).toBe('other.example.com');
  });

  it('allows 3 redirects', async () => {
    const r1 = 'https://r1.example.com/';
    const r2 = 'https://r2.example.com/';
    const r3 = 'https://r3.example.com/';
    const f = fake({
      routes: { [ISPDB]: redirect(r1), [r1]: redirect(r2), [r2]: redirect(r3), [r3]: ok() },
    });
    const r = await discover(EMAIL, f.deps);
    expect(r.status === 'found' && r.via).toBe('r3.example.com');
  });

  it('the 4th redirect is invalid', async () => {
    const r1 = 'https://r1.example.com/';
    const r2 = 'https://r2.example.com/';
    const r3 = 'https://r3.example.com/';
    const r4 = 'https://r4.example.com/';
    const f = fake({
      routes: {
        [ISPDB]: redirect(r1),
        [r1]: redirect(r2),
        [r2]: redirect(r3),
        [r3]: redirect(r4),
        [r4]: ok(),
      },
    });
    const r = await discover(EMAIL, f.deps);
    expect(tried(r, 'ispdb')?.outcome).toBe('invalid');
    expect(f.fetchedUrls()).not.toContain(r4);
  });
});

describe('discover: autoconfig', () => {
  it('found at autoconfig.<domain>', async () => {
    const f = fake({ routes: { [ISPDB]: status(404), [AC1]: ok() } });
    const r = await discover(EMAIL, f.deps);
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.source).toBe('autoconfig');
    expect(r.via).toBe(`autoconfig.${DOMAIN}`);
    expect(r.provider).toBeUndefined();
    expect(r.notices.some((n) => /preset/i.test(n))).toBe(true);
    expect(f.fetchedUrls()).toEqual([ISPDB, AC1]);
    expect(f.resolveSrv).not.toHaveBeenCalled();
  });

  it('falls back to the .well-known URL', async () => {
    const f = fake({ routes: { [ISPDB]: status(404), [AC1]: status(404), [AC2]: ok() } });
    const r = await discover(EMAIL, f.deps);
    expect(r.status === 'found' && r.source).toBe('autoconfig');
    expect(r.status === 'found' && r.via).toBe(DOMAIN);
    expect(f.fetchedUrls()).toEqual([ISPDB, AC1, AC2]);
  });

  it('keeps insecure-only from the first URL when the second is not found', async () => {
    const f = fake({
      routes: {
        [ISPDB]: status(404),
        [AC1]: ok(xml({ port: '143', socketType: 'STARTTLS' })),
        [AC2]: status(404),
      },
    });
    const r = await discover(EMAIL, f.deps);
    expect(r.tried.filter((t) => t.source === 'autoconfig')).toHaveLength(1);
    expect(tried(r, 'autoconfig')?.outcome).toBe('insecure-only');
  });
});

describe('discover: SRV', () => {
  it('found via _imaps._tcp with a username-guess notice', async () => {
    const f = fake({ srv: [{ name: `imap.${DOMAIN}`, port: 993, priority: 10, weight: 0 }] });
    const r = await discover(EMAIL, f.deps);
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.source).toBe('srv');
    expect(r.imap).toEqual({ host: `imap.${DOMAIN}`, port: 993, username: EMAIL });
    expect(r.notices.some((n) => /guess/i.test(n))).toBe(true);
    expect(f.resolveSrv).toHaveBeenCalledWith(SRV_NAME);
  });

  it('sorts by priority asc, weight desc', async () => {
    const r = await discover(
      EMAIL,
      fake({
        srv: [
          { name: 'b.example.com', port: 993, priority: 20, weight: 100 },
          { name: 'a.example.com', port: 993, priority: 10, weight: 1 },
          { name: 'c.example.com', port: 993, priority: 10, weight: 50 },
        ],
      }).deps,
    );
    expect(r.status === 'found' && r.imap.host).toBe('c.example.com');
  });

  it.each([[''], ['.']])('target %j → not-found', async (name) => {
    const r = await discover(
      EMAIL,
      fake({ srv: [{ name, port: 993, priority: 0, weight: 0 }] }).deps,
    );
    expect(r.status).toBe('manual');
    expect(tried(r, 'srv')?.outcome).toBe('not-found');
  });

  it.each([['1.2.3.4'], ['localhost'], ['evil\u001b[31m.com']])(
    'invalid target %j → invalid, not leaked',
    async (name) => {
      const r = await discover(
        EMAIL,
        fake({ srv: [{ name, port: 993, priority: 0, weight: 0 }] }).deps,
      );
      expect(r.status).toBe('manual');
      expect(tried(r, 'srv')?.outcome).toBe('invalid');
      const json = JSON.stringify(r);
      expect(json).not.toContain('evil');
      expect(json).not.toContain('1.2.3.4');
    },
  );

  it('port other than 993 → insecure-only with detail and notice', async () => {
    const r = await discover(
      EMAIL,
      fake({ srv: [{ name: `imap.${DOMAIN}`, port: 143, priority: 0, weight: 0 }] }).deps,
    );
    expect(r.status).toBe('manual');
    const t = tried(r, 'srv');
    expect(t?.outcome).toBe('insecure-only');
    expect(t?.detail).toContain('143');
    expect(r.notices.length).toBeGreaterThan(0);
  });
});

describe('discover: manual', () => {
  it('lists every failed source in order', async () => {
    const f = fake();
    const r = await discover(EMAIL, f.deps);
    expect(r.status).toBe('manual');
    expect(r.tried.map((t) => t.source)).toEqual([
      'preset-domain',
      'preset-mx',
      'ispdb',
      'autoconfig',
      'srv',
    ]);
    expect(r.email.address).toBe(EMAIL);
    expect(f.fetchedUrls()).toEqual([ISPDB, AC1, AC2]);
  });

  it('reports progress for each network source before its lookup', async () => {
    const events: string[] = [];
    await discover(EMAIL, fake({ events }).deps);
    const first = (e: string): number => events.indexOf(e);
    expect(events).not.toContain('progress:preset-domain');
    expect(first('progress:preset-mx')).toBeGreaterThanOrEqual(0);
    expect(first('progress:preset-mx')).toBeLessThan(first(`mx:${DOMAIN}`));
    expect(first('progress:ispdb')).toBeLessThan(first(`fetch:${ISPDB}`));
    expect(first('progress:autoconfig')).toBeLessThan(first(`fetch:${AC1}`));
    expect(first('progress:autoconfig')).toBeGreaterThan(first(`fetch:${ISPDB}`));
    expect(first('progress:srv')).toBeLessThan(first(`srv:${SRV_NAME}`));
    expect(first('progress:srv')).toBeGreaterThan(first(`fetch:${AC2}`));
  });

  it('works without onProgress', async () => {
    const f = fake();
    const deps: DiscoveryDeps = { ...f.deps };
    delete deps.onProgress;
    const r = await discover(EMAIL, deps);
    expect(r.status).toBe('manual');
  });
});

describe('SOURCE_LABEL', () => {
  it('has a non-empty label for every source', () => {
    const sources: DiscoverySource[] = ['preset-domain', 'preset-mx', 'ispdb', 'autoconfig', 'srv'];
    for (const s of sources) expect(SOURCE_LABEL[s].length).toBeGreaterThan(0);
  });

  it('ISPDB_URL is the Thunderbird v1.1 endpoint', () => {
    expect(ISPDB_URL).toBe('https://autoconfig.thunderbird.net/v1.1/');
  });
});

describe('discover: review fixes', () => {
  it.each([
    ['https://127.0.0.1/config.xml'],
    ['https://[::1]/config.xml'],
    ['https://localhost/config.xml'],
    ['https://autoconfig.example.com:8443/config.xml'],
  ])('refuses a redirect to %s without requesting it', async (location) => {
    const f = fake({ routes: { [ISPDB]: redirect(location), [location]: ok() } });
    const r = await discover(EMAIL, f.deps);
    expect(tried(r, 'ispdb')?.outcome).toBe('invalid');
    expect(
      f
        .fetchedUrls()
        .some(
          (u) =>
            u.includes('127.0.0.1') ||
            u.includes('[::1]') ||
            u.includes('localhost') ||
            u.includes(':8443'),
        ),
    ).toBe(false);
  });

  it('autoconfig host that does not resolve stays "not found" (no config)', async () => {
    const r = await discover(EMAIL, fake().deps);
    expect(tried(r, 'autoconfig')?.outcome).toBe('not-found');
  });

  it('keeps an insecure-only finding even when the other autoconfig URL timed out', async () => {
    const f = fake({
      routes: {
        [AC1]: () => {
          throw new DOMException('The operation timed out', 'TimeoutError');
        },
        [AC2]: ok(xml({ socketType: 'STARTTLS', port: '143' })),
      },
    });
    const r = await discover(EMAIL, f.deps);
    expect(tried(r, 'autoconfig')?.outcome).toBe('insecure-only');
    expect(r.notices.some((n) => /STARTTLS/.test(n))).toBe(true);
  });

  it('SRV uses a lower-priority 993 record when the top one is on 143', async () => {
    const f = fake({
      srv: [
        { name: 'imap.example.com', port: 143, priority: 0, weight: 0 },
        { name: 'imaps.example.com', port: 993, priority: 10, weight: 0 },
      ],
    });
    const r = await discover(EMAIL, f.deps);
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.source).toBe('srv');
    expect(r.imap.host).toBe('imaps.example.com');
  });

  it('times out a request that never answers (real AbortSignal wiring)', async () => {
    const f = fake();
    f.fetch.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
        }),
    );
    const r = await discover(EMAIL, { ...f.deps, timeoutMs: 20 });
    expect(tried(r, 'ispdb')?.outcome).toBe('timeout');
  });

  it('times out a body that streams too slowly', async () => {
    const f = fake({
      routes: {
        [ISPDB]: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('<clientConfig>'));
                // never closes
              },
            }),
            { status: 200 },
          ),
      },
    });
    const r = await discover(EMAIL, { ...f.deps, timeoutMs: 20 });
    expect(tried(r, 'ispdb')?.outcome).toBe('timeout');
  });
});

describe('discover: domain check (plain-language errors)', () => {
  it('domain does not exist (ENOTFOUND) → not-exist, stops without HTTP or SRV', async () => {
    const f = fake({ mx: dnsError('ENOTFOUND') });
    const r = await discover(EMAIL, f.deps);
    expect(r.status).toBe('manual');
    expect(r.domainProblem).toBe('not-exist');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.resolveSrv).not.toHaveBeenCalled();
  });

  it('no MX records (ENODATA) is not a problem (IMAP does not need MX); other sources tried', async () => {
    const f = fake({ mx: dnsError('ENODATA') });
    const r = await discover(EMAIL, f.deps);
    expect(r.domainProblem).toBeUndefined();
    expect(f.fetchedUrls()).toContain(ISPDB);
    expect(f.resolveSrv).toHaveBeenCalled();
  });

  it('only a null MX is not reported as a problem either', async () => {
    const r = await discover(EMAIL, fake({ mx: [{ exchange: '', priority: 0 }] }).deps);
    expect(r.domainProblem).toBeUndefined();
  });

  it.each([['ESERVFAIL'], ['EREFUSED']])('%s → dns-error', async (code) => {
    const r = await discover(EMAIL, fake({ mx: dnsError(code) }).deps);
    expect(r.domainProblem).toBe('dns-error');
  });

  it.each([['ETIMEOUT'], ['ECONNREFUSED']])('%s → dns-unreachable', async (code) => {
    const r = await discover(EMAIL, fake({ mx: dnsError(code) }).deps);
    expect(r.domainProblem).toBe('dns-unreachable');
  });

  it('a domain with MX records has no domainProblem', async () => {
    const r = await discover(
      EMAIL,
      fake({ mx: [{ exchange: 'mx.unknown-host.example.com', priority: 10 }] }).deps,
    );
    expect(r.domainProblem).toBeUndefined();
  });

  it('a preset match by email domain never checks DNS (no domainProblem)', async () => {
    const r = await discover('someone@gmail.com', fake().deps);
    expect(r.domainProblem).toBeUndefined();
  });
});

describe('discover: review fixes', () => {
  it('SRV target in hex IPv4 form is invalid, never returned', async () => {
    const r = await discover(
      EMAIL,
      fake({ srv: [{ name: '0x7f.0x1', port: 993, priority: 0, weight: 0 }] }).deps,
    );
    expect(r.status).toBe('manual');
    expect(tried(r, 'srv')?.outcome).toBe('invalid');
    expect(JSON.stringify(r)).not.toContain('0x7f.0x1');
  });

  it('drops dns-unreachable when a later online source found settings', async () => {
    const r = await discover(
      EMAIL,
      fake({ mx: dnsError('ETIMEOUT'), routes: { [ISPDB]: ok() } }).deps,
    );
    expect(r.status).toBe('found');
    expect(r.domainProblem).toBeUndefined();
  });

  it('keeps dns-error (the domain itself is misconfigured) even when ISPDB answers', async () => {
    const r = await discover(
      EMAIL,
      fake({ mx: dnsError('ESERVFAIL'), routes: { [ISPDB]: ok() } }).deps,
    );
    expect(r.status).toBe('found');
    expect(r.domainProblem).toBe('dns-error');
  });
});
