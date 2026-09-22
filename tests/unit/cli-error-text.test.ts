import { describe, it, expect } from 'vitest';
import { errorText } from '../../src/cli/error-text.js';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import { AuthError } from '../../src/core/auth.js';
import { ConfigError } from '../../src/core/config.js';
import { CredentialError } from '../../src/core/credentials.js';
import { CryptoError } from '../../src/core/crypto.js';
import { RepoError } from '../../src/core/db/repos.js';
import { IMAP_FAILURE_REASONS, ImapSessionError } from '../../src/core/imap/errors.js';
import { DiscoveryInputError } from '../../src/core/providers/email.js';

const CANARY = 'raw library text CANARY-7f3a';
const UNEXPECTED = 'Unexpected error';

describe('errorText', () => {
  it.each([...IMAP_FAILURE_REASONS])(
    'ImapSessionError(%s) → the CLI text for this computer',
    (reason) => {
      const err = new ImapSessionError(reason, 'ECONNREFUSED');
      expect(errorText(err)).toBe(imapErrorText(reason, { kind: 'this-computer' }));
    },
  );

  it.each<[string, Error]>([
    ['ConfigError', new ConfigError([{ variable: 'MM_MASTER_KEY', problem: 'is missing' }])],
    ['DiscoveryInputError', new DiscoveryInputError('Email address must contain "@"')],
    ['CredentialError', new CredentialError('Stored password could not be decrypted')],
    ['CryptoError', new CryptoError('Master key has the wrong length')],
    ['RepoError', new RepoError('not_found', 'Account not found')],
    ['AuthError', new AuthError('invalid_credentials', 'Wrong email or password')],
  ])('%s → its own (already user-facing) message', (_label, err) => {
    expect(errorText(err)).toBe(err.message);
  });

  it.each<[string, unknown]>([
    ['plain Error', new Error(CANARY)],
    ['TypeError', new TypeError(CANARY)],
    ['RangeError', new RangeError(CANARY)],
    ['Error with a code', Object.assign(new Error(CANARY), { code: 'ENOTFOUND' })],
    ['string', CANARY],
    ['object', { message: CANARY }],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('%s → exactly "Unexpected error"', (_label, err) => {
    expect(errorText(err)).toBe(UNEXPECTED);
  });

  it('a look-alike named ConfigError that is not an instance → Unexpected error', () => {
    const fakeError = Object.assign(new Error(CANARY), { name: 'ConfigError' });
    expect(errorText(fakeError)).toBe(UNEXPECTED);

    const plainObject = { name: 'ConfigError', message: CANARY, issues: [] };
    expect(errorText(plainObject)).toBe(UNEXPECTED);

    class ConfigErrorLookAlike extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
      }
    }
    expect(errorText(new ConfigErrorLookAlike(CANARY))).toBe(UNEXPECTED);
  });

  it('a look-alike ImapSessionError (plain object with a reason) → Unexpected error', () => {
    const fake = { name: 'ImapSessionError', reason: 'auth-failed', message: CANARY };
    expect(errorText(fake)).toBe(UNEXPECTED);
  });

  it('never throws, even on a hostile value', () => {
    const hostile = {
      get message(): string {
        throw new Error(CANARY);
      },
      get name(): string {
        throw new Error(CANARY);
      },
    };
    expect(errorText(hostile)).toBe(UNEXPECTED);
  });
});
