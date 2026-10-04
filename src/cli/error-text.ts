import { AccountError } from '../core/accounts.js';
import { AuthError } from '../core/auth.js';
import { ConfigError } from '../core/config.js';
import { CredentialError } from '../core/credentials.js';
import { CryptoError } from '../core/crypto.js';
import { RepoError } from '../core/db/repos.js';
import { ImapSessionError } from '../core/imap/errors.js';
import { MailboxError, type MailboxErrorCode } from '../core/mailbox/errors.js';
import { DiscoveryInputError } from '../core/providers/email.js';
import { LoginBlockedError } from '../core/security/login-guard.js';
import { imapErrorText } from './imap-errors.js';
import { loginBlockedText } from './login-guard-text.js';

// Core errors whose messages are written to be shown: fixed text, variable names or codes,
// never secrets, server replies or library messages.
const USER_FACING = [
  AccountError,
  AuthError,
  ConfigError,
  CredentialError,
  CryptoError,
  DiscoveryInputError,
  RepoError,
] as const;

// After a successful login: never the generic login text (the login worked).
const MAILBOX_ERROR_TEXT: Record<MailboxErrorCode, string> = {
  'connection-lost':
    'The connection to the mail server was lost while reading folders — try again.',
  'list-failed': 'The mail server could not list the folders — try again later.',
  'folder-unavailable':
    'The mail server could not open this folder — it may have been deleted or renamed. Go back and try again.',
  'folder-not-found':
    'There is no folder with that path in this mailbox — use the full path from `mm folders --json` (e.g. "INBOX.Sent" or "[Gmail]/Sent Mail").',
  'gmail-all-hidden':
    'Gmail hides "All Mail" from IMAP for this account, so the totals can\'t be counted without double counting labels. Turn on "Show in IMAP" for All Mail in Gmail\'s settings (Labels), or pick one folder with --folder.',
};

/** true for errors with a text written for users; anything else is unexpected. */
export function isUserFacing(err: unknown): boolean {
  return (
    err instanceof ImapSessionError ||
    err instanceof LoginBlockedError ||
    err instanceof MailboxError ||
    USER_FACING.some((cls) => err instanceof cls)
  );
}

/** Text for an error that reached the top level. Anything unknown stays generic. */
export function errorText(err: unknown): string {
  if (err instanceof ImapSessionError) return imapErrorText(err.reason, { kind: 'this-computer' });
  if (err instanceof LoginBlockedError) return loginBlockedText(err);
  if (err instanceof MailboxError) return MAILBOX_ERROR_TEXT[err.code];
  if (USER_FACING.some((cls) => err instanceof cls)) return (err as Error).message;
  return 'Unexpected error';
}
