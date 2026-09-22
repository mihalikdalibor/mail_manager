import type { ImapFailureReason } from '../core/imap/errors.js';
import { geoIpNotice, type ConnectingFrom } from '../core/providers/geoip.js';

// Login/connection failures that could help someone probe accounts or hosts (wrong password,
// unknown host, refused, timeout, GeoIP or fail2ban drops, "password expired" — which would
// confirm the password) share ONE message with no code. Only failures that don't reveal
// anything about the target, or that the user must act on differently, get their own text.

function genericText(from: ConnectingFrom): string {
  return (
    `${geoIpNotice(from)} If your provider requires an app password (for example Gmail or ` +
    'iCloud with two-step verification), use that instead of your normal password.'
  );
}

/** User-facing text for a failed IMAP connection: what happened and what to do next. */
export function imapErrorText(reason: ImapFailureReason, from: ConnectingFrom): string {
  switch (reason) {
    case 'auth-failed':
    case 'app-password-required':
    case 'password-expired':
    case 'contact-admin':
    case 'server-rejected':
    case 'host-not-found':
    case 'unreachable':
    case 'refused':
    case 'reset':
    case 'timeout':
      return genericText(from);
    case 'no-internet':
      return 'No internet connection. Check that this computer is online and try again.';
    case 'tls-certificate':
      return (
        "The mail server's security certificate is not valid, so Mail Manager stopped before " +
        'sending your password. Check the IMAP server name; if it is right, contact your mail ' +
        'provider. Do not continue on an untrusted network (e.g. public Wi-Fi).'
      );
    case 'oauth-only':
      return (
        'This provider only allows sign-in through its own login page (OAuth), which Mail ' +
        'Manager does not support yet. Your password was not accepted for this reason, not ' +
        'because it is wrong.'
      );
    case 'server-unavailable':
      return 'The mail server says it is temporarily unavailable. Try again later.';
    case 'throttled':
      return 'The mail server is limiting connections right now. Wait a few minutes and try again.';
    case 'invalid-credentials-input':
      return (
        'The username or password contains characters that cannot be sent to the mail server ' +
        '(for example line breaks), or is too long. Type them again without those characters.'
      );
    case 'unsupported-server':
      return (
        'This mail server lacks a feature Mail Manager needs. Contact your mail provider or ' +
        'try a different IMAP server for this mailbox.'
      );
    case 'unexpected':
      return 'Unexpected error while connecting to the mail server. Try again later.';
  }
}
