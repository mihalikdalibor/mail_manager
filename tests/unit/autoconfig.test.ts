import { describe, it, expect } from 'vitest';
import { parseAutoconfigXml } from '../../src/core/providers/autoconfig.js';
import { parseEmail } from '../../src/core/providers/email.js';

const email = parseEmail('someone@example-test-domain.eu');

interface Server {
  type?: string;
  hostname?: string;
  port?: string;
  socketType?: string;
  username?: string | null;
}

function server(s: Server = {}): string {
  const type = s.type ?? 'imap';
  const parts = [
    `<hostname>${s.hostname ?? 'imap.example-test-domain.eu'}</hostname>`,
    `<port>${s.port ?? '993'}</port>`,
    `<socketType>${s.socketType ?? 'SSL'}</socketType>`,
  ];
  if (s.username !== null) parts.push(`<username>${s.username ?? '%EMAILADDRESS%'}</username>`);
  parts.push('<authentication>password-cleartext</authentication>');
  const tag = type === 'smtp' ? 'outgoingServer' : 'incomingServer';
  return `<${tag} type="${type}">${parts.join('')}</${tag}>`;
}

function doc(...servers: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example-test-domain.eu">
    <domain>example-test-domain.eu</domain>
    <displayName>Example</displayName>
    ${servers.join('\n    ')}
  </emailProvider>
</clientConfig>`;
}

describe('parseAutoconfigXml', () => {
  it('parses a standard SSL/993 imap entry', () => {
    expect(parseAutoconfigXml(doc(server()), email)).toEqual({
      ok: true,
      settings: { host: 'imap.example-test-domain.eu', port: 993, username: email.address },
    });
  });

  it('substitutes placeholders in hostname and username', () => {
    const r = parseAutoconfigXml(
      doc(server({ hostname: 'imap.%EMAILDOMAIN%', username: '%EMAILLOCALPART%' })),
      email,
    );
    expect(r).toEqual({
      ok: true,
      settings: { host: 'imap.example-test-domain.eu', port: 993, username: 'someone' },
    });
  });

  it('defaults a missing username to the email address', () => {
    const r = parseAutoconfigXml(doc(server({ username: null })), email);
    expect(r).toEqual({
      ok: true,
      settings: { host: 'imap.example-test-domain.eu', port: 993, username: email.address },
    });
  });

  it('normalises the hostname (case, trailing dot, whitespace)', () => {
    const r = parseAutoconfigXml(
      doc(server({ hostname: ' IMAP.Example-Test-Domain.EU. ' })),
      email,
    );
    expect(r.ok && r.settings.host).toBe('imap.example-test-domain.eu');
  });

  it('accepts port "0993"', () => {
    const r = parseAutoconfigXml(doc(server({ port: '0993' })), email);
    expect(r.ok).toBe(true);
  });

  it('skips non-qualifying entries and takes the first SSL/993 imap entry', () => {
    const r = parseAutoconfigXml(
      doc(
        server({ type: 'pop3', hostname: 'pop.example-test-domain.eu', port: '995' }),
        server({
          hostname: 'starttls.example-test-domain.eu',
          port: '143',
          socketType: 'STARTTLS',
        }),
        server({ hostname: 'first.example-test-domain.eu' }),
        server({ hostname: 'second.example-test-domain.eu' }),
      ),
      email,
    );
    expect(r.ok && r.settings.host).toBe('first.example-test-domain.eu');
  });

  it('skips an SSL/993 entry with an invalid host if a later one qualifies', () => {
    const r = parseAutoconfigXml(
      doc(server({ hostname: '1.2.3.4' }), server({ hostname: 'good.example-test-domain.eu' })),
      email,
    );
    expect(r.ok && r.settings.host).toBe('good.example-test-domain.eu');
  });

  it.each<[string, Server[]]>([
    ['STARTTLS only', [{ port: '143', socketType: 'STARTTLS' }]],
    ['plain only', [{ port: '143', socketType: 'plain' }]],
    ['SSL on 143', [{ port: '143' }]],
    ['SSL on 995', [{ port: '995' }]],
    ['port 1e3', [{ port: '1e3' }]],
    ['STARTTLS on 993', [{ socketType: 'STARTTLS' }]],
  ])('%s → insecure-only', (_label, servers) => {
    expect(parseAutoconfigXml(doc(...servers.map(server)), email)).toEqual({
      ok: false,
      reason: 'insecure-only',
    });
  });

  it('no imap entries (pop3 + smtp only) → no-imap', () => {
    const r = parseAutoconfigXml(
      doc(server({ type: 'pop3', port: '995' }), server({ type: 'smtp', port: '465' })),
      email,
    );
    expect(r).toEqual({ ok: false, reason: 'no-imap' });
  });

  it.each<[string, Server]>([
    ['IP literal host', { hostname: '1.2.3.4' }],
    ['localhost', { hostname: 'localhost' }],
    ['unknown placeholder in host', { hostname: 'imap.%FOO%.eu' }],
    ['unknown placeholder in username', { username: '%EMAILADDRESS%%XYZ%' }],
    ['control chars in host', { hostname: 'evil&#27;[31m.com' }],
  ])('only SSL/993 entry has %s → invalid', (_label, s) => {
    expect(parseAutoconfigXml(doc(server(s)), email)).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([
    ['empty string', ''],
    ['not XML', 'hello world'],
    ['JSON', '{"clientConfig":{}}'],
    ['malformed XML', '<clientConfig version="1.1"><emailProvider>'],
    ['wrong root', '<html><body>404</body></html>'],
    ['clientConfig without emailProvider', '<clientConfig version="1.1"></clientConfig>'],
    [
      'reserved __proto__ tag',
      '<clientConfig version="1.1"><emailProvider id="x"><__proto__><polluted>1</polluted></__proto__></emailProvider></clientConfig>',
    ],
    [
      'reserved constructor tag',
      '<clientConfig version="1.1"><constructor>1</constructor></clientConfig>',
    ],
  ])('%s → invalid (no throw)', (_label, xml) => {
    let result: unknown;
    expect(() => {
      result = parseAutoconfigXml(xml, email);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('does not pollute Object.prototype', () => {
    parseAutoconfigXml(
      '<clientConfig version="1.1"><emailProvider id="x"><__proto__><polluted>1</polluted></__proto__></emailProvider></clientConfig>',
      email,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not expand DOCTYPE entities', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE clientConfig [<!ENTITY x "evil.com">]>
<clientConfig version="1.1"><emailProvider id="x">
<incomingServer type="imap"><hostname>&x;</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
</emailProvider></clientConfig>`;
    let result: ReturnType<typeof parseAutoconfigXml> | undefined;
    expect(() => {
      result = parseAutoconfigXml(xml, email);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('evil.com');
  });
});

describe('placeholder substitution and unsafe usernames', () => {
  const doc = (username: string): string =>
    `<clientConfig version="1.1"><emailProvider id="x"><incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType><username>${username}</username></incomingServer></emailProvider></clientConfig>`;

  it('substitutes in a single pass (a local part containing a placeholder is not expanded)', () => {
    const e = parseEmail('bob%EMAILDOMAIN%@example-test-domain.eu');
    const r = parseAutoconfigXml(doc('%EMAILADDRESS%'), e);
    expect(r).toEqual({
      ok: true,
      settings: {
        host: 'imap.example.com',
        port: 993,
        username: 'bob%EMAILDOMAIN%@example-test-domain.eu',
      },
    });
  });

  it('rejects a username containing a bidi override', () => {
    expect(parseAutoconfigXml(doc('evil\u202eadmin'), email)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('review fixes: placeholders and server-provided usernames', () => {
  const docWith = (username: string, host = 'imap.example.com'): string =>
    `<clientConfig version="1.1"><emailProvider id="x"><incomingServer type="imap"><hostname>${host}</hostname><port>993</port><socketType>SSL</socketType><username>${username}</username></incomingServer></emailProvider></clientConfig>`;

  it.each([['%emailaddress%'], ['%EmailAddress%']])(
    'rejects the non-uppercase placeholder %s instead of using it literally',
    (username) => {
      expect(parseAutoconfigXml(docWith(username), email)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    },
  );

  it('rejects a username containing spaces (free text from the server)', () => {
    expect(
      parseAutoconfigXml(docWith('CALL +1-800 to verify your account at evil.example'), email),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a hex IPv4 host name', () => {
    expect(parseAutoconfigXml(docWith('%EMAILADDRESS%', '0x7f.0x1'), email)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('review fixes round 2: username template allowlist, own-property placeholders', () => {
  const withUser = (username: string): string =>
    `<clientConfig version="1.1"><emailProvider id="x"><incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType><username>${username}</username></incomingServer></emailProvider></clientConfig>`;

  it.each([['%constructor%'], ['%toString%'], ['%hasOwnProperty%']])(
    'rejects the built-in property name %s as a placeholder',
    (username) => {
      expect(parseAutoconfigXml(withUser(username), email)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    },
  );

  it.each([
    ['Hangul filler', String.fromCodePoint(0x3164)],
    ['braille blank', String.fromCodePoint(0x2800)],
    ['Cyrillic look-alike', `${String.fromCodePoint(0x0430)}dmin`],
  ])('rejects a username template with %s', (_label, username) => {
    expect(parseAutoconfigXml(withUser(username), email)).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([
    ['recent:%EMAILADDRESS%', `recent:${email.address}`],
    ['%EMAILLOCALPART%@%EMAILDOMAIN%', email.address],
    ['domain\\%EMAILLOCALPART%', `domain\\${email.localPart}`],
  ])('keeps real-world template %s working', (template, expected) => {
    const r = parseAutoconfigXml(withUser(template), email);
    expect(r.ok && r.settings.username).toBe(expected);
  });

  it('fills a Unicode local part from the user address (template itself is ASCII)', () => {
    const e = parseEmail('žofia@example-test-domain.eu');
    const r = parseAutoconfigXml(withUser('%EMAILADDRESS%'), e);
    expect(r.ok && r.settings.username).toBe('žofia@example-test-domain.eu');
  });
});
