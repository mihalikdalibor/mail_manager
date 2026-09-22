import { inspect } from 'node:util';
import { describe, it, expect } from 'vitest';
import {
  IMAP_FAILURE_REASONS,
  ImapSessionError,
  isNetworkDownCandidate,
  mapImapError,
  validateCredentialsInput,
  type ImapFailureReason,
} from '../../src/core/imap/errors.js';

const CANARY = 'CANARY-7f3a';

const ALL_REASONS: ImapFailureReason[] = [
  'auth-failed',
  'app-password-required',
  'password-expired',
  'contact-admin',
  'server-rejected',
  'oauth-only',
  'host-not-found',
  'no-internet',
  'unreachable',
  'refused',
  'reset',
  'timeout',
  'tls-certificate',
  'server-unavailable',
  'throttled',
  'unsupported-server',
  'invalid-credentials-input',
  'unexpected',
];

/** imapflow ImapFlowError look-alike; every free-text field carries the canary. */
function imapErr(fields: Record<string, unknown> = {}): Error {
  const err = new Error(`${CANARY} server said something`);
  Object.assign(err, {
    responseText: `${CANARY} response text`,
    response: { tag: 'A1', command: 'NO', attributes: [{ type: 'TEXT', value: CANARY }] },
    executedCommand: `A1 LOGIN user ${CANARY}-password`,
    details: { secret: CANARY },
    ...fields,
  });
  return err;
}

function nodeErr(code: string, where: 'code' | '_err' | 'cause' = 'code'): Error {
  const inner = Object.assign(new Error(`${CANARY} getaddrinfo ${code} host`), { code });
  if (where === 'code') return inner;
  // imapflow-style wrapper whose own code is unset; the Node error sits on `_err`.
  if (where === '_err') return imapErr({ _err: inner });
  return new Error(`${CANARY} wrapper`, { cause: inner });
}

function expectNoLeak(result: ImapSessionError): void {
  expect(result.message).not.toContain(CANARY);
  expect(String(result)).not.toContain(CANARY);
  expect(inspect(result, { depth: 10 })).not.toContain(CANARY);
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(result.stack ?? '').not.toContain(CANARY);
  expect('cause' in result).toBe(false);
}

describe('ImapSessionError', () => {
  it('IMAP_FAILURE_REASONS lists every reason exactly once', () => {
    expect([...IMAP_FAILURE_REASONS].sort()).toEqual([...ALL_REASONS].sort());
    expect(new Set(IMAP_FAILURE_REASONS).size).toBe(IMAP_FAILURE_REASONS.length);
  });

  it('has a fixed developer message, name and reason', () => {
    const e = new ImapSessionError('auth-failed');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ImapSessionError);
    expect(e.name).toBe('ImapSessionError');
    expect(e.reason).toBe('auth-failed');
    expect(e.code).toBeUndefined();
    expect(e.message).toBe('IMAP connection failed: auth-failed');
    expect('cause' in e).toBe(false);
  });

  it('appends a whitelisted code to the message', () => {
    const e = new ImapSessionError('refused', 'ECONNREFUSED');
    expect(e.code).toBe('ECONNREFUSED');
    expect(e.message).toBe('IMAP connection failed: refused (ECONNREFUSED)');
  });

  it.each(['has space', 'CRLF\r\n', `${CANARY}!`, 'A'.repeat(41), '', 'x;y', '[ALERT]', 'ÜML'])(
    'drops a code that fails the whitelist: %j',
    (code) => {
      const e = new ImapSessionError('unexpected', code);
      expect(e.code).toBeUndefined();
      expect(e.message).toBe('IMAP connection failed: unexpected');
    },
  );

  it('keeps a 40-char code and mixed case / _ / - codes', () => {
    expect(new ImapSessionError('timeout', 'A'.repeat(40)).code).toBe('A'.repeat(40));
    expect(new ImapSessionError('unsupported-server', 'MissingServerExtension').code).toBe(
      'MissingServerExtension',
    );
    expect(new ImapSessionError('tls-certificate', 'ERR_TLS_CERT_ALTNAME_INVALID').code).toBe(
      'ERR_TLS_CERT_ALTNAME_INVALID',
    );
  });

  it('toJSON returns name, reason and code only', () => {
    expect(new ImapSessionError('refused', 'ECONNREFUSED').toJSON()).toEqual({
      name: 'ImapSessionError',
      reason: 'refused',
      code: 'ECONNREFUSED',
    });
    const noCode = new ImapSessionError('unexpected').toJSON();
    expect(noCode).toEqual({ name: 'ImapSessionError', reason: 'unexpected' });
    expect('code' in noCode).toBe(false);
    expect(JSON.parse(JSON.stringify(new ImapSessionError('timeout', 'ETIMEOUT')))).toEqual({
      name: 'ImapSessionError',
      reason: 'timeout',
      code: 'ETIMEOUT',
    });
  });
});

describe('mapImapError', () => {
  describe('rule 1: oauth-only (only when password login is impossible)', () => {
    it.each([
      ['LOGINDISABLED'],
      ['LOGINDISABLED', 'AUTH=XOAUTH2'],
      ['LOGINDISABLED', 'AUTH=OAUTHBEARER'],
    ])('authenticationFailed + %s without AUTH=PLAIN/LOGIN → oauth-only', (...caps) => {
      const r = mapImapError(imapErr({ authenticationFailed: true }), {
        preAuthCaps: new Set(['IMAP4REV1', ...caps]),
      });
      expect(r.reason).toBe('oauth-only');
    });

    // imapflow still sends LOGIN when only an OAuth mechanism is advertised; a failure there
    // may be a plain wrong password, so it must get the generic auth-failed, not oauth-only.
    it.each([['AUTH=XOAUTH2'], ['AUTH=OAUTHBEARER']])(
      'authenticationFailed + only %s (no LOGINDISABLED) → auth-failed',
      (cap) => {
        const r = mapImapError(imapErr({ authenticationFailed: true }), {
          preAuthCaps: new Set(['IMAP4REV1', cap]),
        });
        expect(r.reason).toBe('auth-failed');
      },
    );

    it('LOGINDISABLED + AUTH=PLAIN is NOT oauth-only → auth-failed', () => {
      const r = mapImapError(imapErr({ authenticationFailed: true }), {
        preAuthCaps: new Set(['LOGINDISABLED', 'AUTH=PLAIN']),
      });
      expect(r.reason).toBe('auth-failed');
    });

    it('AUTH=XOAUTH2 + AUTH=LOGIN is NOT oauth-only → auth-failed', () => {
      const r = mapImapError(imapErr({ authenticationFailed: true }), {
        preAuthCaps: new Set(['AUTH=XOAUTH2', 'AUTH=LOGIN']),
      });
      expect(r.reason).toBe('auth-failed');
    });

    it('oauth caps without authenticationFailed are not oauth-only', () => {
      const r = mapImapError(imapErr({ code: 'ECONNRESET' }), {
        preAuthCaps: new Set(['LOGINDISABLED']),
      });
      expect(r.reason).toBe('reset');
    });

    it('authenticationFailed with no preAuthCaps → auth-failed', () => {
      expect(mapImapError(imapErr({ authenticationFailed: true })).reason).toBe('auth-failed');
      expect(
        mapImapError(imapErr({ authenticationFailed: true }), { preAuthCaps: new Set() }).reason,
      ).toBe('auth-failed');
    });

    it('oauth-only wins over an AUTHENTICATIONFAILED response code', () => {
      const r = mapImapError(
        imapErr({ authenticationFailed: true, serverResponseCode: 'AUTHENTICATIONFAILED' }),
        { preAuthCaps: new Set(['LOGINDISABLED', 'AUTH=XOAUTH2']) },
      );
      expect(r.reason).toBe('oauth-only');
    });
  });

  describe('rule 2: server response codes', () => {
    it.each<[string, ImapFailureReason]>([
      ['AUTHENTICATIONFAILED', 'auth-failed'],
      ['AUTHORIZATIONFAILED', 'auth-failed'],
      ['EXPIRED', 'password-expired'],
      ['CONTACTADMIN', 'contact-admin'],
      ['PRIVACYREQUIRED', 'server-rejected'],
      ['UNAVAILABLE', 'server-unavailable'],
      ['LIMIT', 'throttled'],
      ['authenticationfailed', 'auth-failed'],
      ['Unavailable', 'server-unavailable'],
    ])('%s → %s', (serverResponseCode, reason) => {
      const r = mapImapError(imapErr({ serverResponseCode }));
      expect(r.reason).toBe(reason);
      expect(r.code?.toUpperCase()).toBe(serverResponseCode.toUpperCase());
    });

    it('response code wins over authenticationFailed (EXPIRED on a failed login)', () => {
      const r = mapImapError(
        imapErr({ authenticationFailed: true, serverResponseCode: 'EXPIRED' }),
      );
      expect(r.reason).toBe('password-expired');
    });

    it.each([
      'Please log in with an application-specific password',
      'Use an App Password for IMAP',
    ])('ALERT mentioning an app password → app-password-required (%s)', (text) => {
      const r = mapImapError(
        imapErr({ authenticationFailed: true, serverResponseCode: 'ALERT', responseText: text }),
      );
      expect(r.reason).toBe('app-password-required');
    });

    it('other ALERT falls through to the next rules', () => {
      expect(
        mapImapError(
          imapErr({
            authenticationFailed: true,
            serverResponseCode: 'ALERT',
            responseText: 'Maintenance tonight',
          }),
        ).reason,
      ).toBe('auth-failed');
      expect(
        mapImapError(
          imapErr({
            serverResponseCode: 'ALERT',
            responseText: 'Maintenance tonight',
            code: 'ECONNRESET',
          }),
        ).reason,
      ).toBe('reset');
    });

    it('app-password text without ALERT does not trigger app-password-required', () => {
      const r = mapImapError(
        imapErr({
          authenticationFailed: true,
          responseText: 'Use an app password',
        }),
      );
      expect(r.reason).toBe('auth-failed');
    });
  });

  it('rule 3: authenticationFailed without a response code → auth-failed', () => {
    expect(mapImapError(imapErr({ authenticationFailed: true })).reason).toBe('auth-failed');
  });

  it('authenticationFailed must be exactly true', () => {
    expect(mapImapError(imapErr({ authenticationFailed: 'true' })).reason).toBe('unexpected');
    expect(mapImapError(imapErr({ authenticationFailed: 1 })).reason).toBe('unexpected');
  });

  describe('rule 4: imapflow error codes', () => {
    it.each<[string, ImapFailureReason]>([
      ['ETHROTTLE', 'throttled'],
      ['CONNECT_TIMEOUT', 'timeout'],
      ['GREETING_TIMEOUT', 'timeout'],
      ['ETIMEOUT', 'timeout'],
      ['UPGRADE_TIMEOUT', 'timeout'],
      ['MissingServerExtension', 'unsupported-server'],
    ])('%s → %s', (code, reason) => {
      const r = mapImapError(imapErr({ code }));
      expect(r.reason).toBe(reason);
      expect(r.code).toBe(code);
    });

    it.each(['ClosedAfterConnectTLS', 'ClosedAfterConnectText', 'NoConnection'])(
      '%s → reset whatever the BYE text says',
      (code) => {
        // imapflow 2.0.5 drops the BYE's [CODE] and keeps only its (untrusted) text in
        // `reason`; the mapper never reads it, so a server can't steer the message.
        for (const reason of [undefined, '[UNAVAILABLE] try later', '[LIMIT] x', `${CANARY} bye`]) {
          const r = mapImapError(imapErr(reason === undefined ? { code } : { code, reason }));
          expect(r.reason).toBe('reset');
          expect(r.code).toBe(code);
        }
      },
    );
  });

  describe('rule 5: Node socket / DNS / TLS codes', () => {
    it.each<[string, ImapFailureReason]>([
      ['ENOTFOUND', 'host-not-found'],
      ['EHOSTUNREACH', 'unreachable'],
      ['ECONNREFUSED', 'refused'],
      ['ECONNRESET', 'reset'],
      ['EPIPE', 'reset'],
      ['ETIMEDOUT', 'timeout'],
      ['CERT_HAS_EXPIRED', 'tls-certificate'],
      ['CERT_NOT_YET_VALID', 'tls-certificate'],
      ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls-certificate'],
      ['SELF_SIGNED_CERT_IN_CHAIN', 'tls-certificate'],
      ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls-certificate'],
      ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'tls-certificate'],
      ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls-certificate'],
      ['CERT_REVOKED', 'tls-certificate'],
      ['CERT_UNTRUSTED', 'tls-certificate'],
      ['CERT_SIGNATURE_FAILURE', 'tls-certificate'],
      ['HOSTNAME_MISMATCH', 'tls-certificate'],
      ['EPROTO', 'tls-certificate'],
      ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls-certificate'],
      ['ERR_TLS_HANDSHAKE_TIMEOUT', 'tls-certificate'],
    ])('%s → %s (on err.code, err._err.code and err.cause.code)', (code, reason) => {
      for (const where of ['code', '_err', 'cause'] as const) {
        const r = mapImapError(nodeErr(code, where));
        expect(r.reason, where).toBe(reason);
        expect(r.code, where).toBe(code);
      }
    });

    it.each(['EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN'])(
      '%s → no-internet only when internetReachable === false, otherwise unreachable',
      (code) => {
        for (const where of ['code', '_err', 'cause'] as const) {
          const err = nodeErr(code, where);
          expect(mapImapError(err, { internetReachable: false }).reason, where).toBe('no-internet');
          expect(mapImapError(err, { internetReachable: true }).reason, where).toBe('unreachable');
          expect(mapImapError(err).reason, where).toBe('unreachable');
          expect(mapImapError(err, {}).reason, where).toBe('unreachable');
        }
      },
    );

    it('internetReachable: false does not turn other errors into no-internet', () => {
      expect(mapImapError(nodeErr('ECONNREFUSED'), { internetReachable: false }).reason).toBe(
        'refused',
      );
      expect(mapImapError(nodeErr('ENOTFOUND'), { internetReachable: false }).reason).toBe(
        'host-not-found',
      );
    });
  });

  describe('rule 6: anything else → unexpected', () => {
    it.each<[string, unknown]>([
      ['null', null],
      ['undefined', undefined],
      ['a string', `${CANARY} boom`],
      ['a number', 42],
      ['a plain Error', new Error(`${CANARY} boom`)],
      ['a TypeError', new TypeError(`${CANARY} x is undefined`)],
      ['an unknown code', Object.assign(new Error(CANARY), { code: 'EWHATEVER' })],
      ['an unknown response code', imapErr({ serverResponseCode: 'TRYCREATE' })],
      ['a plain object', { message: CANARY, code: 42 }],
      ['a code that is not a string', { code: { toString: () => 'ENOTFOUND' } }],
    ])('%s', (_label, input) => {
      const r = mapImapError(input);
      expect(r).toBeInstanceOf(ImapSessionError);
      expect(r.reason).toBe('unexpected');
      expectNoLeak(r);
    });

    it('does not throw on a hostile object (throwing getters, cycles)', () => {
      const hostile: Record<string, unknown> = {};
      hostile['self'] = hostile;
      Object.defineProperty(hostile, 'code', {
        get() {
          throw new Error(CANARY);
        },
      });
      const r = mapImapError(hostile);
      expect(r.reason).toBe('unexpected');
      expectNoLeak(r);
    });
  });

  it('never returns the input object', () => {
    const input = new ImapSessionError('refused', 'ECONNREFUSED');
    const r = mapImapError(input);
    expect(r).toBeInstanceOf(ImapSessionError);
    expect(r).not.toBe(input);
  });

  describe('LEAK RULE: no server text / command / password in the result, for every reason', () => {
    const cases: [ImapFailureReason, unknown, Parameters<typeof mapImapError>[1]][] = [
      [
        'oauth-only',
        imapErr({ authenticationFailed: true }),
        { preAuthCaps: new Set(['LOGINDISABLED', 'AUTH=XOAUTH2']) },
      ],
      [
        'auth-failed',
        imapErr({ authenticationFailed: true, serverResponseCode: 'AUTHENTICATIONFAILED' }),
        undefined,
      ],
      ['auth-failed', imapErr({ authenticationFailed: true }), undefined],
      ['password-expired', imapErr({ serverResponseCode: 'EXPIRED' }), undefined],
      ['contact-admin', imapErr({ serverResponseCode: 'CONTACTADMIN' }), undefined],
      ['server-rejected', imapErr({ serverResponseCode: 'PRIVACYREQUIRED' }), undefined],
      ['server-unavailable', imapErr({ serverResponseCode: 'UNAVAILABLE' }), undefined],
      ['throttled', imapErr({ serverResponseCode: 'LIMIT' }), undefined],
      [
        'app-password-required',
        imapErr({ serverResponseCode: 'ALERT', responseText: `${CANARY} use an app password` }),
        undefined,
      ],
      ['throttled', imapErr({ code: 'ETHROTTLE' }), undefined],
      ['timeout', imapErr({ code: 'GREETING_TIMEOUT' }), undefined],
      ['unsupported-server', imapErr({ code: 'MissingServerExtension' }), undefined],
      ['reset', imapErr({ code: 'NoConnection', reason: `[UNAVAILABLE] ${CANARY}` }), undefined],
      ['reset', imapErr({ code: 'ClosedAfterConnectTLS', reason: `[LIMIT] ${CANARY}` }), undefined],
      ['reset', imapErr({ code: 'ClosedAfterConnectText', reason: CANARY }), undefined],
      ['host-not-found', nodeErr('ENOTFOUND', '_err'), undefined],
      ['no-internet', nodeErr('EAI_AGAIN', 'cause'), { internetReachable: false }],
      ['unreachable', nodeErr('ENETUNREACH', '_err'), { internetReachable: true }],
      ['refused', nodeErr('ECONNREFUSED', 'cause'), undefined],
      ['reset', nodeErr('ECONNRESET'), undefined],
      ['timeout', nodeErr('ETIMEDOUT', '_err'), undefined],
      ['tls-certificate', nodeErr('CERT_HAS_EXPIRED', 'cause'), undefined],
      ['unexpected', imapErr(), undefined],
    ];

    it('the cases cover every reason except invalid-credentials-input', () => {
      const covered = new Set(cases.map(([reason]) => reason));
      expect([...covered].sort()).toEqual(
        ALL_REASONS.filter((r) => r !== 'invalid-credentials-input').sort(),
      );
    });

    it.each(cases)('%s', (reason, input, ctx) => {
      const r = mapImapError(input, ctx);
      expect(r.reason).toBe(reason);
      expectNoLeak(r);
    });

    it('a canary in the code field itself is dropped by the whitelist', () => {
      const r = mapImapError(Object.assign(new Error('x'), { code: `${CANARY} ENOTFOUND` }));
      expect(r.reason).toBe('unexpected');
      expect(r.code).toBeUndefined();
      expectNoLeak(r);
    });

    it('a canary in serverResponseCode is dropped', () => {
      const r = mapImapError(imapErr({ serverResponseCode: `${CANARY} [x]` }));
      expect(r.reason).toBe('unexpected');
      expectNoLeak(r);
    });
  });
});

describe('isNetworkDownCandidate', () => {
  it.each(['EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN'])('%s → true on code, _err and cause', (code) => {
    expect(isNetworkDownCandidate(nodeErr(code, 'code'))).toBe(true);
    expect(isNetworkDownCandidate(nodeErr(code, '_err'))).toBe(true);
    expect(isNetworkDownCandidate(nodeErr(code, 'cause'))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['ENOTFOUND', nodeErr('ENOTFOUND')],
    ['ECONNREFUSED', nodeErr('ECONNREFUSED', 'cause')],
    ['EHOSTUNREACH', nodeErr('EHOSTUNREACH', '_err')],
    ['auth failure', imapErr({ authenticationFailed: true })],
    ['null', null],
    ['undefined', undefined],
    ['string', 'EAI_AGAIN'],
    ['object without code', {}],
  ])('%s → false', (_label, input) => {
    expect(isNetworkDownCandidate(input)).toBe(false);
  });
});

describe('validateCredentialsInput', () => {
  function expectInvalid(username: string, password: string): void {
    const r = validateCredentialsInput(username, password);
    expect(r).toBeInstanceOf(ImapSessionError);
    expect(r?.reason).toBe('invalid-credentials-input');
    // The rejected password must not end up in the error.
    if (password.length > 0) {
      expect(inspect(r, { depth: 10 })).not.toContain(password);
      expect(JSON.stringify(r)).not.toContain(password);
    }
  }

  it('accepts ordinary credentials', () => {
    expect(validateCredentialsInput('someone@example-test-domain.eu', 'hunter2')).toBeNull();
    expect(validateCredentialsInput('someone', 'p a s s w ö r d !"#$%&')).toBeNull();
    expect(validateCredentialsInput('someone@example-test-domain.eu', 'x'.repeat(1024))).toBeNull();
    expect(validateCredentialsInput('u'.repeat(254), 'pw')).toBeNull();
  });

  it.each<[string, string]>([
    ['empty', ''],
    ['too long', 'x'.repeat(1025)],
    ['CR', `${CANARY}\rpw`],
    ['LF', `${CANARY}\npw`],
    ['CRLF injection', `${CANARY}\r\nA2 LOGOUT`],
    ['NUL', `${CANARY}\0pw`],
  ])('rejects a password: %s', (_label, password) => {
    expectInvalid('someone@example-test-domain.eu', password);
  });

  it.each<[string, string]>([
    ['empty', ''],
    ['whitespace only', '   '],
    ['tab only', '\t'],
    ['too long', 'u'.repeat(255)],
    ['CR', 'some\rone'],
    ['LF', 'some\none'],
    ['NUL', 'some\0one'],
    ['zero-width space', 'some\u200bone'],
    ['bidi override', 'some\u202eone'],
    ['ESC', 'some\u001bone'],
    ['DEL', 'some\u007fone'],
    ['BOM', '\ufeffsomeone'],
  ])('rejects a username: %s', (_label, username) => {
    expectInvalid(username, 'hunter2');
  });
});
