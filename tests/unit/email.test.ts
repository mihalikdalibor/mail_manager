import { describe, it, expect } from 'vitest';
import {
  DiscoveryInputError,
  hostnameSchema,
  normalizeHost,
  parseEmail,
} from '../../src/core/providers/email.js';

describe('normalizeHost', () => {
  it.each([
    ['imap.example.com', 'imap.example.com'],
    ['IMAP.Example.COM', 'imap.example.com'],
    ['imap.example.com.', 'imap.example.com'],
    ['a-b.example-test-domain.eu', 'a-b.example-test-domain.eu'],
    ['1a.example.com', '1a.example.com'],
    ['example.c0m', 'example.c0m'],
  ])('accepts %j → %j', (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it('accepts a label of exactly 63 chars', () => {
    const label = 'a'.repeat(63);
    expect(normalizeHost(`${label}.com`)).toBe(`${label}.com`);
  });

  it('accepts a host of exactly 253 chars and rejects 254', () => {
    const l = 'a'.repeat(61);
    const base = `${l}.${l}.${l}.${l}`; // 247 chars
    const ok = `${base}.abcde`; // 253
    expect(ok).toHaveLength(253);
    expect(normalizeHost(ok)).toBe(ok);
    const tooLong = `${base}.abcdef`; // 254
    expect(tooLong).toHaveLength(254);
    expect(normalizeHost(tooLong)).toBeNull();
  });

  it.each([
    [''],
    ['.'],
    ['com'],
    ['localhost'],
    ['LOCALHOST'],
    ['1.2.3.4'],
    ['127.0.0.1'],
    ['[::1]'],
    ['::1'],
    ['imap.example.com:993'],
    ['imap.example.com/path'],
    ['imaps://imap.example.com'],
    ['imap example.com'],
    [' imap.example.com'],
    ['imap_x.example.com'],
    ['imap.example.com..'],
    ['a..b.com'],
    ['.example.com'],
    ['-a.example.com'],
    ['a-.example.com'],
    ['example.123'],
    [`${'a'.repeat(64)}.com`],
    ['evil\u001b[31m.com'],
    ['evil\u0000.com'],
    ['evil\n.com'],
    ['user@example.com'],
  ])('rejects %j', (input) => {
    expect(normalizeHost(input)).toBeNull();
  });

  it('strips only ONE trailing dot', () => {
    expect(normalizeHost('example.com..')).toBeNull();
  });
});

describe('hostnameSchema', () => {
  it('is a zod schema that accepts strings', () => {
    expect(hostnameSchema.safeParse('imap.example.com').success).toBe(true);
    expect(hostnameSchema.safeParse(42).success).toBe(false);
  });
});

describe('parseEmail', () => {
  it('parses a plain address', () => {
    expect(parseEmail('someone@example-test-domain.eu')).toEqual({
      address: 'someone@example-test-domain.eu',
      localPart: 'someone',
      domain: 'example-test-domain.eu',
      displayDomain: 'example-test-domain.eu',
    });
  });

  it('trims the input, lowercases the domain, keeps local-part case', () => {
    const e = parseEmail('  Some.One@Example-Test-Domain.EU.  ');
    expect(e.localPart).toBe('Some.One');
    expect(e.domain).toBe('example-test-domain.eu');
    expect(e.displayDomain).toBe('example-test-domain.eu');
    expect(e.address).toBe('Some.One@example-test-domain.eu');
  });

  it('converts an IDN domain to punycode, keeps the display domain', () => {
    const e = parseEmail('jan@žltý.sk');
    expect(e.domain).toMatch(/^xn--[a-z0-9-]+\.sk$/);
    expect(e.domain).toBe(new URL('http://žltý.sk').hostname);
    expect(e.displayDomain).toBe('žltý.sk');
    expect(e.address).toBe(`jan@${e.domain}`);
  });

  it('lowercases an uppercase IDN display domain', () => {
    const e = parseEmail('jan@ŽLTÝ.SK');
    expect(e.displayDomain).toBe('žltý.sk');
    expect(e.domain).toBe(new URL('http://žltý.sk').hostname);
  });

  it('splits at the LAST @ (quoted-ish local parts keep their @)', () => {
    const e = parseEmail('a@b@example.com');
    expect(e.localPart).toBe('a@b');
    expect(e.domain).toBe('example.com');
  });

  it('accepts a 254-char input and rejects 255', () => {
    const domain = 'example.com';
    const ok = `${'a'.repeat(254 - domain.length - 1)}@${domain}`;
    expect(ok).toHaveLength(254);
    expect(parseEmail(ok).address).toBe(ok);
    const tooLong = `a${ok}`;
    expect(() => parseEmail(tooLong)).toThrow(DiscoveryInputError);
  });

  it.each([
    [''],
    ['   '],
    ['no-at-sign'],
    ['@example.com'],
    ['a@'],
    ['a@b@c'],
    ['a@localhost'],
    ['a@1.2.3.4'],
    ['a@a..b'],
    ['a@-a.com'],
    ['a@a_b.com'],
    [`a@${'a'.repeat(64)}.com`],
    ['a@evil.com/x'],
    ['a@%41.com'],
    ['a@[::1]'],
    ['a@a b.com'],
    ['a@example.com:993'],
    ['a b@example.com'],
    ['a\u0000b@example.com'],
    ['a\u001bb@example.com'],
    ['a@evil\u001b[31m.com'],
    ['a@example.123'],
  ])('rejects %j with DiscoveryInputError', (input) => {
    expect(() => parseEmail(input)).toThrow(DiscoveryInputError);
  });

  it('DiscoveryInputError has its name set', () => {
    let caught: unknown;
    try {
      parseEmail('no-at-sign');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DiscoveryInputError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('DiscoveryInputError');
  });
});

describe('invisible and bidi characters', () => {
  it.each([
    ['bidi override in the local part', 'evil\u202eadmin@example.com'],
    ['zero-width space in the domain', 'a@exa\u200bmple.com'],
    ['soft hyphen in the domain', 'a@exa\u00admple.com'],
    ['BOM inside the local part (a leading one is trimmed)', 'a\ufeffb@example.com'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseEmail(input)).toThrow(DiscoveryInputError);
  });
});

describe('review fixes: IPv4 in disguise and display domain', () => {
  it.each([['0x7f.0x1'], ['127.0.0.0x1'], ['0177.0.0.0x1'], ['1.0x2'], ['a.0X1F']])(
    'normalizeHost rejects the IPv4 form %s',
    (host) => {
      expect(normalizeHost(host)).toBeNull();
    },
  );

  it('still accepts real host names with hex-looking inner labels', () => {
    expect(normalizeHost('0x7f.example.com')).toBe('0x7f.example.com');
  });

  it('displayDomain is derived from the looked-up domain, not the raw input', () => {
    const variationSelector = String.fromCodePoint(0xfe0f);
    const fullwidthDot = String.fromCodePoint(0xff0e);
    const a = parseEmail(`a@exa${variationSelector}mple.com`);
    expect(a.domain).toBe('example.com');
    expect(a.displayDomain).toBe('example.com');
    const b = parseEmail(`a@example${fullwidthDot}com`);
    expect(b.displayDomain).toBe('example.com');
    expect(parseEmail('a@žltý.sk').displayDomain).toBe('žltý.sk');
  });
});

describe('review fixes round 2: typed punycode is displayed as typed', () => {
  it('shows an xn-- domain in ASCII, not as a Unicode look-alike', () => {
    const r = parseEmail('a@xn--80ak6aa92e.com');
    expect(r.displayDomain).toBe('xn--80ak6aa92e.com');
  });

  it('shows a Unicode domain typed in Unicode as Unicode', () => {
    expect(parseEmail('a@münchen.de').displayDomain).toBe('münchen.de');
  });
});
