import { describe, it, expect } from 'vitest';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import { IMAP_FAILURE_REASONS, type ImapFailureReason } from '../../src/core/imap/errors.js';
import { geoIpNotice, type ConnectingFrom } from '../../src/core/providers/geoip.js';

const LOCAL: ConnectingFrom = { kind: 'this-computer' };
const SERVER_DE: ConnectingFrom = { kind: 'server', region: 'Germany' };
const SERVER_NO_REGION: ConnectingFrom = { kind: 'server' };

// Causes the user can't tell apart from outside (wrong password vs GeoIP block vs firewall):
// one shared message that leads with the GeoIP / credentials notice.
const GENERIC: ImapFailureReason[] = [
  'auth-failed',
  'app-password-required',
  'password-expired',
  'contact-admin',
  'server-rejected',
  'host-not-found',
  'unreachable',
  'refused',
  'reset',
  'timeout',
];

const DISTINCT: ImapFailureReason[] = [
  'no-internet',
  'tls-certificate',
  'oauth-only',
  'server-unavailable',
  'throttled',
  'invalid-credentials-input',
  'unsupported-server',
  'unexpected',
];

// Raw codes / tokens that must never show up in the generic message.
const RAW_TOKENS = [
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'AUTHENTICATIONFAILED',
  'EXPIRED',
  'CONTACTADMIN',
  'PRIVACYREQUIRED',
];

describe('imapErrorText', () => {
  it('the generic and distinct lists cover every reason exactly once', () => {
    expect([...GENERIC, ...DISTINCT].sort()).toEqual([...IMAP_FAILURE_REASONS].sort());
  });

  describe.each<[string, ConnectingFrom]>([
    ['this computer', LOCAL],
    ['server in Germany', SERVER_DE],
    ['server without region', SERVER_NO_REGION],
  ])('from %s', (_label, from) => {
    const generic = imapErrorText('auth-failed', from);

    it('every generic reason gives the identical text', () => {
      for (const reason of GENERIC) expect(imapErrorText(reason, from), reason).toBe(generic);
    });

    it('generic text starts with the GeoIP notice and mentions an app password', () => {
      const notice = geoIpNotice(from);
      expect(generic).toContain(notice);
      expect(generic.startsWith(notice)).toBe(true);
      expect(generic.length).toBeGreaterThan(notice.length);
      expect(generic.toLowerCase()).toMatch(/app(lication-specific)? password/);
    });

    it('generic text shows no bracketed code and no reason/code token', () => {
      expect(generic).not.toContain('[');
      expect(generic).not.toContain('undefined');
      for (const reason of GENERIC) expect(generic, reason).not.toContain(reason);
      for (const token of RAW_TOKENS) expect(generic, token).not.toContain(token);
    });

    it('every distinct reason has its own non-empty text, different from the generic one', () => {
      const texts = DISTINCT.map((r) => imapErrorText(r, from));
      for (const [i, t] of texts.entries()) {
        const reason = DISTINCT[i] ?? '';
        expect(t.trim().length, reason).toBeGreaterThan(0);
        expect(t, reason).not.toBe(generic);
        expect(t, reason).not.toContain('undefined');
        expect(t, reason).not.toContain('null');
      }
      expect(new Set(texts).size).toBe(DISTINCT.length);
    });
  });

  it('server variant names the hosting region', () => {
    expect(imapErrorText('auth-failed', SERVER_DE)).toContain('Germany');
    expect(imapErrorText('timeout', SERVER_DE)).toContain('Germany');
  });

  it('this-computer variant differs from the server variant', () => {
    expect(imapErrorText('auth-failed', LOCAL)).not.toBe(imapErrorText('auth-failed', SERVER_DE));
  });

  describe('distinct texts tell the user what to do', () => {
    it('no-internet mentions the internet connection', () => {
      expect(imapErrorText('no-internet', LOCAL).toLowerCase()).toContain('internet');
    });

    it('tls-certificate mentions the certificate', () => {
      expect(imapErrorText('tls-certificate', LOCAL).toLowerCase()).toContain('certificate');
    });

    it('oauth-only mentions OAuth', () => {
      expect(imapErrorText('oauth-only', LOCAL)).toContain('OAuth');
    });

    it.each<ImapFailureReason>(['throttled', 'server-unavailable'])(
      '%s asks to try again later / wait',
      (reason) => {
        expect(imapErrorText(reason, LOCAL).toLowerCase()).toMatch(/try again later|later|wait/);
      },
    );

    it('invalid-credentials-input mentions characters', () => {
      expect(imapErrorText('invalid-credentials-input', LOCAL).toLowerCase()).toContain(
        'character',
      );
    });

    it('unsupported-server is plain words, no raw tokens', () => {
      const t = imapErrorText('unsupported-server', LOCAL);
      expect(t).not.toContain('MissingServerExtension');
      expect(t).not.toContain('unsupported-server');
    });
  });
});
