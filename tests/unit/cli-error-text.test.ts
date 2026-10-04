import { afterEach, describe, it, expect, vi } from 'vitest';
import { errorText, isUserFacing } from '../../src/cli/error-text.js';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import { loginBlockedText } from '../../src/cli/login-guard-text.js';
import { AuthError } from '../../src/core/auth.js';
import { ConfigError } from '../../src/core/config.js';
import { CredentialError } from '../../src/core/credentials.js';
import { CryptoError } from '../../src/core/crypto.js';
import { RepoError } from '../../src/core/db/repos.js';
import { IMAP_FAILURE_REASONS, ImapSessionError } from '../../src/core/imap/errors.js';
import { MailboxError, type MailboxErrorCode } from '../../src/core/mailbox/errors.js';
import { DiscoveryInputError } from '../../src/core/providers/email.js';
import type { BlockKind } from '../../src/core/security/events.js';
import { LoginBlockedError } from '../../src/core/security/login-guard.js';

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

describe('errorText — LoginBlockedError', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<[BlockKind, Date | null]>([
    ['too-many-attempts', new Date(2026, 2, 10, 14, 30)],
    ['ip-blocked', new Date(2026, 2, 11, 9, 5)],
    ['permanent', null],
  ])('%s → loginBlockedText', (kind, until) => {
    vi.useFakeTimers({ now: new Date(2026, 2, 10, 8, 0) });
    const err = new LoginBlockedError(kind, until);
    expect(errorText(err)).toBe(loginBlockedText(err));
  });

  it('a look-alike LoginBlockedError (plain object) → Unexpected error', () => {
    expect(errorText({ name: 'LoginBlockedError', kind: 'permanent' })).toBe(UNEXPECTED);
  });
});

describe('errorText — MailboxError (M2a)', () => {
  it.each<[MailboxErrorCode, string]>([
    [
      'connection-lost',
      'The connection to the mail server was lost while reading folders — try again.',
    ],
    ['list-failed', 'The mail server could not list the folders — try again later.'],
    [
      'folder-unavailable',
      'The mail server could not open this folder — it may have been deleted or renamed. Go back and try again.',
    ],
    [
      'folder-not-found',
      'There is no folder with that path in this mailbox — use the full path from `mm folders --json` (e.g. "INBOX.Sent" or "[Gmail]/Sent Mail").',
    ],
    [
      'gmail-all-hidden',
      'Gmail hides "All Mail" from IMAP for this account, so the totals can\'t be counted without double counting labels. Turn on "Show in IMAP" for All Mail in Gmail\'s settings (Labels), or pick one folder with --folder.',
    ],
  ])('%s → its own text, never the generic login text', (code, text) => {
    const err = new MailboxError(code);
    expect(isUserFacing(err)).toBe(true);
    expect(errorText(err)).toBe(text);
    expect(errorText(err)).not.toBe(imapErrorText('auth-failed', { kind: 'this-computer' }));
  });

  it('a look-alike MailboxError (plain object with a code) → Unexpected error', () => {
    const fake = { name: 'MailboxError', code: 'list-failed', message: CANARY };
    expect(isUserFacing(fake)).toBe(false);
    expect(errorText(fake)).toBe(UNEXPECTED);
  });
});
