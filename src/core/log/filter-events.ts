import { oneOf, uuidOrUndefined } from './builders.js';
import { ACCOUNT_OUTCOMES, FILTER_FAILURE_REASONS } from './event-schemas.js';
import type {
  AccountOutcome,
  FilterDeleteEvent,
  FilterFailureReason,
  FilterSaveEvent,
} from './events.js';

// Builders for `mm filter …` events (M3c). Like the other builders they allowlist every field: a
// saved filter's UUID, a flag and fixed codes — never the name, the typed terms or the body text.

export interface FilterSaveFields {
  filter?: string | undefined;
  replaced?: boolean | undefined;
  outcome: AccountOutcome;
  reason?: FilterFailureReason | undefined;
}

/** `replaced` only on success; a reason only on failure, and then always one (the reader checks). */
export function filterSave(f: FilterSaveFields): FilterSaveEvent {
  const filter = uuidOrUndefined(f.filter);
  const outcome = oneOf<AccountOutcome>(f.outcome, ACCOUNT_OUTCOMES, 'failed');
  return {
    event: 'filter.save',
    ...(filter !== undefined && { filter }),
    ...(outcome === 'ok' && typeof f.replaced === 'boolean' && { replaced: f.replaced }),
    outcome,
    ...(outcome === 'failed' && {
      reason: oneOf(f.reason, FILTER_FAILURE_REASONS, 'unexpected'),
    }),
  };
}

export interface FilterDeleteFields {
  filter?: string | undefined;
  outcome: AccountOutcome;
  reason?: FilterFailureReason | undefined;
}

/** A reason only on failure, and then always one (the reader checks both). */
export function filterDelete(f: FilterDeleteFields): FilterDeleteEvent {
  const filter = uuidOrUndefined(f.filter);
  const outcome = oneOf<AccountOutcome>(f.outcome, ACCOUNT_OUTCOMES, 'failed');
  return {
    event: 'filter.delete',
    ...(filter !== undefined && { filter }),
    outcome,
    ...(outcome === 'failed' && {
      reason: oneOf(f.reason, FILTER_FAILURE_REASONS, 'unexpected'),
    }),
  };
}
