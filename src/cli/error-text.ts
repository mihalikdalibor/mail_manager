import { AuthError } from '../core/auth.js';
import { ConfigError } from '../core/config.js';
import { CredentialError } from '../core/credentials.js';
import { CryptoError } from '../core/crypto.js';
import { RepoError } from '../core/db/repos.js';
import { ImapSessionError } from '../core/imap/errors.js';
import { DiscoveryInputError } from '../core/providers/email.js';
import { LoginBlockedError } from '../core/security/login-guard.js';
import { imapErrorText } from './imap-errors.js';
import { loginBlockedText } from './login-guard-text.js';

// Core errors whose messages are written to be shown: fixed text, variable names or codes,
// never secrets, server replies or library messages.
const USER_FACING = [
  AuthError,
  ConfigError,
  CredentialError,
  CryptoError,
  DiscoveryInputError,
  RepoError,
] as const;

/** Text for an error that reached the top level. Anything unknown stays generic. */
export function errorText(err: unknown): string {
  if (err instanceof ImapSessionError) return imapErrorText(err.reason, { kind: 'this-computer' });
  if (err instanceof LoginBlockedError) return loginBlockedText(err);
  if (USER_FACING.some((cls) => err instanceof cls)) return (err as Error).message;
  return 'Unexpected error';
}
