import { projectRoot } from '../core/config.js';
import { safeEmit, unexpectedError, type EventLog } from '../core/log/index.js';
import { errorText, isUserFacing } from './error-text.js';

/**
 * Prints the user-facing text of an error and, when it isn't one of ours, records
 * `error.unexpected` (class, code and frames — never the message).
 */
export function reportError(
  err: unknown,
  log: EventLog,
  text: (err: unknown) => string = errorText,
  root: string = projectRoot(),
): void {
  console.error(text(err));
  if (!isUserFacing(err)) safeEmit(log, () => unexpectedError(err, root));
}
