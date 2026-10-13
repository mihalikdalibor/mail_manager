// Failures after a successful login, while reading the mailbox (M2+). Typed codes and fixed
// messages only: server replies and library text never reach the user or a log line. The CLI
// maps the code to its own text (src/cli/error-text.ts) — never the generic login text.

export type MailboxErrorCode =
  | 'list-failed'
  | 'connection-lost'
  | 'folder-unavailable'
  | 'folder-not-found'
  | 'gmail-all-hidden'
  | 'search-failed'
  | 'too-many-matches';

export const MAILBOX_ERROR_CODES: readonly MailboxErrorCode[] = [
  'list-failed',
  'connection-lost',
  'folder-unavailable',
  'folder-not-found',
  'gmail-all-hidden',
  'search-failed',
  'too-many-matches',
];

const MAILBOX_ERROR_MESSAGES: Record<MailboxErrorCode, string> = {
  'list-failed': 'The mail server could not list the folders',
  'connection-lost': 'The connection to the mail server was lost',
  'folder-unavailable': 'The mail server could not open this folder',
  'folder-not-found': 'There is no folder with that path',
  'gmail-all-hidden': 'Gmail hides All Mail from IMAP',
  'search-failed': 'The mail server could not run this search',
  'too-many-matches': 'Too many messages match this search',
};

export class MailboxError extends Error {
  readonly code: MailboxErrorCode;

  constructor(code: MailboxErrorCode) {
    super(MAILBOX_ERROR_MESSAGES[code]);
    this.name = 'MailboxError';
    this.code = code;
  }
}

/** A search the caller stopped (`shouldStop`): not a failure, never shown or logged. */
export class SearchStopped extends Error {
  constructor() {
    super('The search was stopped');
    this.name = 'SearchStopped';
  }
}
