import { count, oneOf, uuidOrUndefined } from './builders.js';
import {
  ACCOUNT_FAILURE_REASONS,
  ACCOUNT_OUTCOMES,
  BROWSE_OUTCOMES,
  FALLBACK_FEATURES,
} from './event-schemas.js';
import type {
  AccountFailureReason,
  AccountOutcome,
  BrowseFinishEvent,
  BrowseOutcome,
  CapabilityFallbackEvent,
  FoldersListEvent,
  StatsFinishEvent,
} from './events.js';
import { FALLBACK_OF, type FallbackFeature } from '../mailbox/folders.js';

// Builders for the mailbox insight events (M2a, M2b-2, M2c-1). Like the other builders they allowlist every
// field: an account UUID, counts and fixed codes — never folder names, the address or host.

export interface FoldersListFields {
  acct?: string | undefined;
  folders: number;
  ms: number;
  outcome: AccountOutcome;
  reason?: AccountFailureReason | undefined;
}

export function foldersList(f: FoldersListFields): FoldersListEvent {
  const acct = uuidOrUndefined(f.acct);
  const outcome = oneOf(f.outcome, ACCOUNT_OUTCOMES, 'failed');
  return {
    event: 'folders.list',
    ...(acct !== undefined && { acct }),
    folders: count(f.folders),
    ms: Number.isFinite(f.ms) && f.ms >= 0 ? count(Math.round(f.ms)) : 0,
    outcome,
    // A reason only on failure, and then always one (the reader checks both).
    ...(outcome === 'failed' && {
      reason: oneOf(f.reason, ACCOUNT_FAILURE_REASONS, 'unexpected'),
    }),
  };
}

export interface BrowseFinishFields {
  acct?: string | undefined;
  folders: number;
  mails: number;
  marked: number;
  bytes: number;
  reconnects: number;
  ms: number;
  outcome: BrowseOutcome;
  reason?: AccountFailureReason | undefined;
}

/** Once per browser run: counts and bytes only (the basket's known sizes). */
export function browseFinish(f: BrowseFinishFields): BrowseFinishEvent {
  const acct = uuidOrUndefined(f.acct);
  const outcome = oneOf(f.outcome, BROWSE_OUTCOMES, 'failed');
  return {
    event: 'browse.finish',
    ...(acct !== undefined && { acct }),
    folders: count(f.folders),
    mails: count(f.mails),
    marked: count(f.marked),
    bytes: count(f.bytes),
    reconnects: count(f.reconnects),
    ms: Number.isFinite(f.ms) && f.ms >= 0 ? count(Math.round(f.ms)) : 0,
    outcome,
    ...(outcome === 'failed' && {
      reason: oneOf(f.reason, ACCOUNT_FAILURE_REASONS, 'unexpected'),
    }),
  };
}

export interface StatsFinishFields {
  acct?: string | undefined;
  folders: number;
  messages: number;
  bytes: number;
  ms: number;
  outcome: AccountOutcome;
  reason?: AccountFailureReason | undefined;
}

/** Once per `mm stats` run: counts and bytes only. */
export function statsFinish(f: StatsFinishFields): StatsFinishEvent {
  const acct = uuidOrUndefined(f.acct);
  const outcome = oneOf(f.outcome, ACCOUNT_OUTCOMES, 'failed');
  return {
    event: 'stats.finish',
    ...(acct !== undefined && { acct }),
    folders: count(f.folders),
    messages: count(f.messages),
    bytes: count(f.bytes),
    ms: Number.isFinite(f.ms) && f.ms >= 0 ? count(Math.round(f.ms)) : 0,
    outcome,
    ...(outcome === 'failed' && {
      reason: oneOf(f.reason, ACCOUNT_FAILURE_REASONS, 'unexpected'),
    }),
  };
}

/** The fallback is derived from the feature, so the pair is always consistent. */
export function capabilityFallback(feature: FallbackFeature): CapabilityFallbackEvent {
  const safe = oneOf(feature, FALLBACK_FEATURES, 'status-size');
  return { event: 'imap.capability-fallback', feature: safe, fallback: FALLBACK_OF[safe] };
}
