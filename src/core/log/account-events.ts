import { cleanProvider, oneOf, uuidOrUndefined } from './builders.js';
import { ACCOUNT_FAILURE_REASONS, ACCOUNT_OUTCOMES } from './event-schemas.js';
import type {
  AccountEvent,
  AccountEventName,
  AccountFailureReason,
  AccountOutcome,
  LogEvent,
} from './events.js';

// Builder for `mm account …` events (M1c-1). Like the other builders it allowlists every
// field: an account UUID, a preset id and fixed codes — never the address, host or username.

export interface AccountEventFields {
  acct?: string | undefined;
  provider: string;
  outcome: AccountOutcome;
  reason?: AccountFailureReason | undefined;
}

/** Typed as the matching catalog event(s), so a union of names still gives a `LogEvent`. */
export function accountEvent<N extends AccountEventName>(
  name: N,
  f: AccountEventFields,
): Extract<LogEvent, { event: N }> {
  const acct = uuidOrUndefined(f.acct);
  const outcome = oneOf(f.outcome, ACCOUNT_OUTCOMES, 'failed');
  const event: AccountEvent = {
    event: name,
    ...(acct !== undefined && { acct }),
    provider: cleanProvider(f.provider) ?? 'custom',
    outcome,
    // A reason only on failure, and then always one (the reader checks both).
    ...(outcome === 'failed' && {
      reason: oneOf(f.reason, ACCOUNT_FAILURE_REASONS, 'unexpected'),
    }),
  };
  return event as Extract<LogEvent, { event: N }>;
}
