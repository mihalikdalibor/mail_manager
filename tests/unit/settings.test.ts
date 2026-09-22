import { describe, it, expect } from 'vitest';
import { DiscoveryInputError, parseEmail } from '../../src/core/providers/email.js';
import type { Preset } from '../../src/core/providers/presets.js';
import {
  manualSettings,
  settingsFromPreset,
  validateManualHost,
  validateManualUsername,
} from '../../src/core/providers/settings.js';

const email = parseEmail('someone@example-test-domain.eu');

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

describe('settingsFromPreset', () => {
  it('builds settings with username = email address', () => {
    expect(settingsFromPreset(preset(), email)).toEqual({
      host: 'imap.p.example.com',
      port: 993,
      username: 'someone@example-test-domain.eu',
    });
  });

  it('returns null when the preset has no imap host', () => {
    expect(settingsFromPreset(preset({ imap: null, hostHint: 'x' }), email)).toBeNull();
  });
});

describe('validateManualHost', () => {
  it.each([
    ['imap.x.sk', 'imap.x.sk'],
    ['  imap.x.sk  ', 'imap.x.sk'],
    ['IMAP.X.SK.', 'imap.x.sk'],
  ])('%j → %j', (input, expected) => {
    expect(validateManualHost(input)).toBe(expected);
  });

  it.each([[''], ['   '], ['1.2.3.4'], ['localhost'], ['[::1]'], ['a b.sk'], ['x\u001b.sk']])(
    'rejects %j',
    (input) => {
      expect(() => validateManualHost(input)).toThrow(DiscoveryInputError);
    },
  );

  it.each([['imap.x.sk:993'], ['imaps://imap.x.sk'], ['imap.x.sk/']])(
    'rejects %j with a message about host name only / port 993',
    (input) => {
      let caught: unknown;
      try {
        validateManualHost(input);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DiscoveryInputError);
      const msg = (caught as Error).message.toLowerCase();
      expect(msg.includes('host name') || msg.includes('993')).toBe(true);
    },
  );
});

describe('validateManualUsername', () => {
  it('defaults to the email address when empty or undefined', () => {
    expect(validateManualUsername(undefined, email)).toBe(email.address);
    expect(validateManualUsername('', email)).toBe(email.address);
    expect(validateManualUsername('   ', email)).toBe(email.address);
  });

  it('trims and keeps a custom username', () => {
    expect(validateManualUsername('  Some.User  ', email)).toBe('Some.User');
  });

  it('accepts 254 chars and rejects 255', () => {
    expect(validateManualUsername('u'.repeat(254), email)).toBe('u'.repeat(254));
    expect(() => validateManualUsername('u'.repeat(255), email)).toThrow(DiscoveryInputError);
  });

  it.each([['a\u0000b'], ['a\u001bb'], ['a\nb'], ['a\u007fb']])('rejects control chars %j', (u) => {
    expect(() => validateManualUsername(u, email)).toThrow(DiscoveryInputError);
  });
});

describe('manualSettings', () => {
  it('validates host and defaults the username', () => {
    expect(manualSettings({ host: 'IMAP.X.SK' }, email)).toEqual({
      host: 'imap.x.sk',
      port: 993,
      username: email.address,
    });
  });

  it('uses a given username', () => {
    expect(manualSettings({ host: 'imap.x.sk', username: 'login1' }, email)).toEqual({
      host: 'imap.x.sk',
      port: 993,
      username: 'login1',
    });
  });

  it('throws on an invalid host', () => {
    expect(() => manualSettings({ host: 'localhost' }, email)).toThrow(DiscoveryInputError);
  });
});

describe('manual host: IDN and unsafe characters', () => {
  it('converts an IDN host to punycode', () => {
    expect(validateManualHost('imap.münchen.de')).toBe('imap.xn--mnchen-3ya.de');
  });

  it('rejects a host with a zero-width character', () => {
    expect(() => validateManualHost('imap.exa\u200bmple.com')).toThrow(DiscoveryInputError);
  });

  it('rejects a username with a bidi override', () => {
    const e = parseEmail('someone@example-test-domain.eu');
    expect(() => validateManualUsername('evil\u202eadmin', e)).toThrow(DiscoveryInputError);
  });
});
