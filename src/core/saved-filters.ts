import { recordAudit } from './audit.js';
import {
  RepoError,
  type AuditEntry,
  type AuditRepo,
  type FiltersRepo,
  type SavedFilter,
} from './db/repos.js';
import type { Filter, FilterNode } from './filters/schema.js';
import {
  filterDelete,
  filterSave,
  safeEmit,
  type EventLog,
  type FilterFailureReason,
} from './log/index.js';

// Saved filters (M3c): a user's named filters in the cloud table `saved_filters`. The name rule,
// the limit and the duplicate check live here; the database checks the format again. Every change
// that reaches the database gets one log event, a successful save or delete also one audit row.
// Both carry ids and reason codes only: never the name or the filter, whose terms can hold
// addresses and words the user typed. Core never prints; the CLI maps SavedFilterError to text.

export const SAVED_FILTERS_MAX = 200;
export const FILTER_NAME_RE = /^[a-z0-9_][a-z0-9_-]{0,39}$/;

export type SavedFilterErrorCode = 'duplicate' | 'not-found' | 'limit';

const SAVED_FILTER_ERROR_MESSAGES: Record<SavedFilterErrorCode, string> = {
  duplicate: 'A filter with this name is already saved',
  'not-found': 'Saved filter not found',
  limit: 'Too many saved filters',
};

/** A typed saved-filter problem; the CLI maps the code to text. Messages are fixed. */
export class SavedFilterError extends Error {
  readonly code: SavedFilterErrorCode;

  constructor(code: SavedFilterErrorCode) {
    super(SAVED_FILTER_ERROR_MESSAGES[code]);
    this.name = 'SavedFilterError';
    this.code = code;
  }
}

/**
 * Trimmed and lower-cased; null when it is not a name (1–40 of a-z, 0-9, `-` and `_`, not starting
 * with `-` — a leading `-` would read as an option in `show`, `delete` and `--filter`).
 */
export function savedFilterName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return FILTER_NAME_RE.test(name) ? name : null;
}

/** What every save and delete needs. */
export interface FilterStoreDeps {
  repo: FiltersRepo;
  audit: AuditRepo;
  log: EventLog;
  /** Ties audit rows to the run's log lines. */
  runId?: string | undefined;
}

/** The terms of a filter: an all-of root gives its terms, any other filter is one term. */
export function filterTerms(filter: Filter): FilterNode[] {
  return filter.where.kind === 'all' ? filter.where.of : [filter.where];
}

/**
 * True when a group in the filter has no terms (`all []`, `any []`, at any depth). Such a group
 * compiles to match-all or match-none without any check, so it can't be searched with.
 */
export function hasEmptyGroup(node: FilterNode): boolean {
  switch (node.kind) {
    case 'all':
    case 'any':
      return node.of.length === 0 || node.of.some((child) => hasEmptyGroup(child));
    case 'not':
      return hasEmptyGroup(node.of);
    default:
      return false;
  }
}

export async function getSavedFilter(repo: FiltersRepo, name: string): Promise<SavedFilter | null> {
  return repo.getByName(name);
}

/** Every saved filter the repo reads, by name; `skipped` counts the rows that couldn't be read. */
export async function listFilters(
  repo: FiltersRepo,
): Promise<{ filters: SavedFilter[]; skipped: number }> {
  const { filters, skipped } = await repo.list();
  return { filters: [...filters].sort(compareNames), skipped };
}

function compareNames(a: SavedFilter, b: SavedFilter): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * Saves `filter` under `name`. An existing name is refused unless `replace` is set; then its row
 * gets the new filter and keeps its id. Audited and logged once the database has answered.
 */
export async function saveFilter(
  deps: FilterStoreDeps,
  name: string,
  filter: Filter,
  opts: { replace: boolean },
): Promise<{ saved: SavedFilter; replaced: boolean }> {
  let existing: SavedFilter | null = null;
  try {
    existing = await deps.repo.getByName(name);
    if (existing !== null && !opts.replace) throw new SavedFilterError('duplicate');
    const saved =
      existing === null
        ? await createSaved(deps.repo, name, filter)
        : await replaceSaved(deps.repo, existing.id, filter);
    const replaced = existing !== null;
    await audit(deps, {
      action: 'filter.save',
      details: { filter: saved.id, replaced },
      result: 'ok',
    });
    safeEmit(deps.log, () => filterSave({ filter: saved.id, replaced, outcome: 'ok' }));
    return { saved, replaced };
  } catch (err) {
    const reason = filterFailureReason(err);
    safeEmit(deps.log, () => filterSave({ filter: existing?.id, outcome: 'failed', reason }));
    throw err;
  }
}

/** A new name: refused at the limit (skipped rows count too); a lost race is a duplicate. */
async function createSaved(repo: FiltersRepo, name: string, filter: Filter): Promise<SavedFilter> {
  const { filters, skipped } = await repo.list();
  if (filters.length + skipped >= SAVED_FILTERS_MAX) throw new SavedFilterError('limit');
  try {
    return await repo.create(name, filter);
  } catch (err) {
    if (err instanceof RepoError && err.code === 'conflict') {
      throw new SavedFilterError('duplicate');
    }
    throw err;
  }
}

/** An existing row: the repo finds nothing when the row is gone or hidden. */
async function replaceSaved(repo: FiltersRepo, id: string, filter: Filter): Promise<SavedFilter> {
  const saved = await repo.replace(id, filter);
  if (saved === null) throw new SavedFilterError('not-found');
  return saved;
}

/** Deletes the saved filter `name` (no mail is touched). Returns the filter that was removed. */
export async function deleteFilter(deps: FilterStoreDeps, name: string): Promise<SavedFilter> {
  let existing: SavedFilter | null = null;
  try {
    existing = await deps.repo.getByName(name);
    if (existing === null || !(await deps.repo.remove(existing.id))) {
      throw new SavedFilterError('not-found');
    }
    const removed = existing;
    await audit(deps, {
      action: 'filter.delete',
      details: { filter: removed.id },
      result: 'ok',
    });
    safeEmit(deps.log, () => filterDelete({ filter: removed.id, outcome: 'ok' }));
    return removed;
  } catch (err) {
    const reason = filterFailureReason(err);
    safeEmit(deps.log, () => filterDelete({ filter: existing?.id, outcome: 'failed', reason }));
    throw err;
  }
}

/** Why a save or delete failed: the typed error's code, `database` or `unexpected`. */
function filterFailureReason(err: unknown): FilterFailureReason {
  if (err instanceof SavedFilterError) return err.code;
  if (err instanceof RepoError) return 'database';
  return 'unexpected';
}

async function audit(deps: FilterStoreDeps, entry: Omit<AuditEntry, 'runId'>): Promise<void> {
  await recordAudit(
    deps.audit,
    { ...entry, ...(deps.runId !== undefined && { runId: deps.runId }) },
    deps.log,
  );
}
