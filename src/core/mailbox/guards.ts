import { MailboxError } from './errors.js';

// Checks shared by the mailbox modules: numbers from the server are validated before use, and
// a failure on a dead connection is reported as `connection-lost`, not as the folder's fault.

/** A server count: a safe non-negative integer, otherwise null. */
export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** What `checkOpen` reads: the session's `closed` and, when given, the client's `usable`. */
export interface OpenState {
  readonly closed: boolean;
  readonly client?: { readonly usable: boolean };
}

/**
 * Throws `connection-lost` when the session is closed. `client.usable === false` counts too:
 * imapflow's `close` event (which sets `closed`) can arrive after the rejected command.
 */
export function checkOpen(session: OpenState): void {
  if (session.closed || session.client?.usable === false) {
    throw new MailboxError('connection-lost');
  }
}
