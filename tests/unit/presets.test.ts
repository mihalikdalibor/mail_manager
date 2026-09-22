import { describe, it, expect } from 'vitest';
import {
  PRESETS,
  findByDomain,
  findByMxHost,
  parsePresets,
  pickableProviders,
  type Preset,
} from '../../src/core/providers/presets.js';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acme',
    name: 'Acme Mail',
    group: 'global',
    domains: ['acme.example.com'],
    mxSuffixes: ['mx.acme.example.com'],
    imap: { host: 'imap.acme.example.com', port: 993 },
    altHosts: [],
    auth: ['password'],
    verified: true,
    helpUrl: 'https://acme.example.com/help',
    ...overrides,
  };
}

function preset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'p',
    name: 'P',
    group: 'global',
    domains: [],
    mxSuffixes: [],
    imap: { host: 'imap.p.example.com', port: 993 },
    altHosts: [],
    auth: ['password'],
    verified: false,
    ...overrides,
  };
}

describe('parsePresets', () => {
  it('accepts a valid preset', () => {
    const [p] = parsePresets([raw()]);
    expect(p?.id).toBe('acme');
    expect(p?.imap).toEqual({ host: 'imap.acme.example.com', port: 993 });
  });

  it('accepts an unverified preset without helpUrl', () => {
    const data = raw({ verified: false });
    delete data.helpUrl;
    expect(() => parsePresets([data])).not.toThrow();
  });

  it('accepts imap null with a hostHint', () => {
    expect(() =>
      parsePresets([raw({ imap: null, hostHint: 'See your admin panel' })]),
    ).not.toThrow();
  });

  it.each<[string, Record<string, unknown>]>([
    ['unknown key', { extra: 1 }],
    ['verified without helpUrl', { helpUrl: undefined }],
    ['verified with http helpUrl', { helpUrl: 'http://acme.example.com/help' }],
    ['imap null without hostHint', { imap: null }],
    ['uppercase imap host', { imap: { host: 'IMAP.acme.example.com', port: 993 } }],
    ['uppercase alt host', { altHosts: ['Imap2.acme.example.com'] }],
    ['empty auth', { auth: [] }],
    ['unknown auth', { auth: ['kerberos'] }],
    ['port 143', { imap: { host: 'imap.acme.example.com', port: 143 } }],
    ['port 995', { imap: { host: 'imap.acme.example.com', port: 995 } }],
    ['bad group', { group: 'eu' }],
    ['unknown key in imap', { imap: { host: 'imap.acme.example.com', port: 993, tls: true } }],
  ])('rejects %s', (_label, overrides) => {
    const data = raw(overrides);
    if ('helpUrl' in overrides && overrides.helpUrl === undefined) delete data.helpUrl;
    expect(() => parsePresets([data])).toThrow();
  });

  it('rejects non-array input', () => {
    expect(() => parsePresets({})).toThrow();
    expect(() => parsePresets(null)).toThrow();
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      parsePresets([
        raw(),
        raw({ domains: ['other.example.com'], mxSuffixes: ['mx.other.example.com'] }),
      ]),
    ).toThrow();
  });

  it('rejects a domain shared by two presets', () => {
    expect(() =>
      parsePresets([raw(), raw({ id: 'other', mxSuffixes: ['mx.other.example.com'] })]),
    ).toThrow();
  });

  it('rejects an MX suffix shared by two presets', () => {
    expect(() =>
      parsePresets([raw(), raw({ id: 'other', domains: ['other.example.com'] })]),
    ).toThrow();
  });
});

describe('PRESETS (shipped list)', () => {
  it('passes parsePresets', () => {
    expect(() => parsePresets(PRESETS)).not.toThrow();
    expect(PRESETS.length).toBeGreaterThan(0);
  });

  it('contains websupport, gmail, outlook, wedos', () => {
    const byId = new Map(PRESETS.map((p) => [p.id, p]));
    const ws = byId.get('websupport');
    expect(ws?.imap?.host).toBe('imap.m1.websupport.sk');
    expect(ws?.mxSuffixes).toContain('websupport.sk');
    expect(byId.get('gmail')?.domains).toContain('gmail.com');
    const outlook = byId.get('outlook');
    expect(outlook?.domains).toContain('outlook.com');
    expect(typeof outlook?.blocked).toBe('string');
    expect(outlook?.blocked?.length).toBeGreaterThan(0);
    const wedos = byId.get('wedos');
    expect(wedos?.imap).toBeNull();
    expect(wedos?.hostHint?.length).toBeGreaterThan(0);
  });
});

describe('findByDomain', () => {
  it('finds gmail.com in the shipped list', () => {
    expect(findByDomain('gmail.com')?.id).toBe('gmail');
  });

  it('normalises case and a trailing dot', () => {
    expect(findByDomain('GMAIL.COM.')?.id).toBe('gmail');
  });

  it('matches exactly, not by suffix', () => {
    expect(findByDomain('sub.gmail.com')).toBeUndefined();
    expect(findByDomain('notgmail.com')).toBeUndefined();
  });

  it('uses the given list', () => {
    const list = [preset({ id: 'x', domains: ['x.example.com'] })];
    expect(findByDomain('x.example.com', list)?.id).toBe('x');
    expect(findByDomain('gmail.com', list)).toBeUndefined();
  });
});

describe('findByMxHost', () => {
  it.each([
    ['mx10.websupport.sk', 'websupport'],
    ['MX10.WEBSUPPORT.SK.', 'websupport'],
    ['websupport.sk', 'websupport'],
  ])('%j → %s', (host, id) => {
    expect(findByMxHost(host)?.id).toBe(id);
  });

  it.each([
    ['evilwebsupport.sk'],
    ['websupport.sk.evil.com'],
    ['1.2.3.4'],
    ['localhost'],
    [''],
    ['mx.websupport.sk\u001b'],
  ])('%j → undefined', (host) => {
    expect(findByMxHost(host)).toBeUndefined();
  });

  it('longest suffix wins', () => {
    const list = [
      preset({ id: 'short', mxSuffixes: ['example.com'] }),
      preset({ id: 'long', mxSuffixes: ['mail.example.com'] }),
    ];
    expect(findByMxHost('mx1.mail.example.com', list)?.id).toBe('long');
    expect(findByMxHost('mx1.other.example.com', list)?.id).toBe('short');
    // order in the list doesn't matter
    expect(findByMxHost('mx1.mail.example.com', [...list].reverse())?.id).toBe('long');
  });
});

describe('pickableProviders', () => {
  it('puts sk-cz first, then global, each sorted by name', () => {
    const list = [
      preset({ id: 'g2', name: 'Zeta', group: 'global' }),
      preset({ id: 's2', name: 'Seznam', group: 'sk-cz' }),
      preset({ id: 'g1', name: 'Alpha', group: 'global' }),
      preset({ id: 's1', name: 'Active24', group: 'sk-cz' }),
    ];
    const snapshot = list.map((p) => p.id);
    expect(pickableProviders(list).map((p) => p.id)).toEqual(['s1', 's2', 'g1', 'g2']);
    expect(list.map((p) => p.id)).toEqual(snapshot);
  });

  it('includes every shipped preset', () => {
    const picked = pickableProviders();
    expect(picked).toHaveLength(PRESETS.length);
    const firstGlobal = picked.findIndex((p) => p.group === 'global');
    const lastSkCz = picked.map((p) => p.group).lastIndexOf('sk-cz');
    if (firstGlobal !== -1 && lastSkCz !== -1) expect(lastSkCz).toBeLessThan(firstGlobal);
  });
});
