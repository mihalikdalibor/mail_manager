import { describe, it, expect } from 'vitest';
import { RepoError } from '../../src/core/db/repos.js';
import type { AuditEntry, AuditRepo, FiltersRepo, SavedFilter } from '../../src/core/db/repos.js';
import { parseFilterLine } from '../../src/core/filters/line.js';
import { EMPTY_FILTER, type Filter } from '../../src/core/filters/schema.js';
import { MemoryEventLog } from '../../src/core/log/index.js';
import type { LogRecord, RunContext } from '../../src/core/log/index.js';
import {
  SavedFilterError,
  deleteFilter,
  filterTerms,
  getSavedFilter,
  listFilters,
  saveFilter,
  savedFilterName,
} from '../../src/core/saved-filters.js';

// M3c saved filters core (spec): the name rule, the error codes, save / replace / delete with
// their audit rows and events, the 200 limit, filterTerms. In-memory fake FiltersRepo and
// AuditRepo; the event log is a MemoryEventLog. No Supabase, no IMAP.

const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 15, 9, 0, 0);
const CTX: RunContext = { run: RUN, ver: '0.10.0', now: () => T0, level: 'debug' };
const NAME = 'big-old';

let counter = 0;

/** A fresh UUID (v4 shape) per call. */
function newId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

class FakeFiltersRepo implements FiltersRepo {
  readonly rows: SavedFilter[] = [];
  /** Malformed rows the real repo would skip and count. */
  skipped = 0;
  /** When set, create throws it. */
  createError: Error | null = null;
  /** When true, replace finds nothing (as if the row were hidden or gone). */
  replaceMisses = false;
  /** When true, remove deletes nothing. */
  removeMisses = false;

  create(name: string, filter: Filter): Promise<SavedFilter> {
    if (this.createError !== null) return Promise.reject(this.createError);
    if (this.rows.some((r) => r.name === name)) {
      return Promise.reject(new RepoError('conflict', 'name taken'));
    }
    const row = { id: newId(), name, filter, createdAt: new Date(T0), updatedAt: new Date(T0) };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  replace(id: string, filter: Filter): Promise<SavedFilter | null> {
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined || this.replaceMisses) return Promise.resolve(null);
    row.filter = filter;
    return Promise.resolve(row);
  }

  list(): Promise<{ filters: SavedFilter[]; skipped: number }> {
    return Promise.resolve({ filters: [...this.rows], skipped: this.skipped });
  }

  getByName(name: string): Promise<SavedFilter | null> {
    return Promise.resolve(this.rows.find((r) => r.name === name) ?? null);
  }

  remove(id: string): Promise<boolean> {
    if (this.removeMisses) return Promise.resolve(false);
    const index = this.rows.findIndex((r) => r.id === id);
    if (index < 0) return Promise.resolve(false);
    this.rows.splice(index, 1);
    return Promise.resolve(true);
  }
}

class FakeAuditRepo implements AuditRepo {
  readonly entries: AuditEntry[] = [];

  write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }

  listRecent(): Promise<{ records: never[]; skipped: number }> {
    return Promise.resolve({ records: [], skipped: 0 });
  }
}

function harness(repo = new FakeFiltersRepo()) {
  const audit = new FakeAuditRepo();
  const log = new MemoryEventLog(CTX);
  return { repo, audit, log, deps: { repo, audit, log } };
}

/** Adds a saved row without going through saveFilter (a fixture). */
function seed(repo: FakeFiltersRepo, name: string, filter: Filter = F_OLD): SavedFilter {
  const row = { id: newId(), name, filter, createdAt: new Date(T0), updatedAt: new Date(T0) };
  repo.rows.push(row);
  return row;
}

function fill(repo: FakeFiltersRepo, count: number): void {
  for (let n = 0; n < count; n += 1) seed(repo, `filter-${n}`);
}

/** The error a call throws; fails the test when it resolves. */
async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

function parsed(text: string): Filter {
  const result = parseFilterLine(text);
  if (!result.ok) throw new Error(`fixture does not parse: ${text}`);
  return result.filter;
}

function filterEvents(log: MemoryEventLog, event: string): LogRecord[] {
  return log.records.filter((r) => r.event === event);
}

const F_OLD = parsed('older:1y');
const F_NEW = parsed('from:@shop.sk');

describe('savedFilterName', () => {
  it('trims and lower-cases a valid name', () => {
    expect(savedFilterName(' Big-Old ')).toBe('big-old');
  });

  it('40 characters is the longest name', () => {
    expect(savedFilterName('a'.repeat(40))).toBe('a'.repeat(40));
  });

  it.each(['a b', 'ä', '', '   ', 'a'.repeat(41)])('%j is not a name → null', (raw) => {
    expect(savedFilterName(raw)).toBeNull();
  });

  it('a leading dash is refused: -old → null', () => {
    expect(savedFilterName('-old')).toBeNull();
  });

  it('an underscore may start a name: _x → _x', () => {
    expect(savedFilterName('_x')).toBe('_x');
  });

  it('a trailing dash is allowed: a- is a name', () => {
    expect(savedFilterName('a-')).toBe('a-');
  });
});

describe('SavedFilterError', () => {
  it.each([
    ['duplicate', 'A filter with this name is already saved'],
    ['not-found', 'Saved filter not found'],
    ['limit', 'Too many saved filters'],
  ] as const)('code %s carries its fixed message', (code, message) => {
    const err = new SavedFilterError(code);
    expect(err.name).toBe('SavedFilterError');
    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
  });
});

describe('saveFilter', () => {
  it('a new name is created, audited and logged as saved', async () => {
    const h = harness();
    const { saved, replaced } = await saveFilter(h.deps, NAME, F_NEW, { replace: false });
    expect(replaced).toBe(false);
    expect(saved).toMatchObject({ name: NAME, filter: F_NEW });
    expect(h.repo.rows).toHaveLength(1);
    expect(h.audit.entries).toEqual([
      { action: 'filter.save', details: { filter: saved.id, replaced: false }, result: 'ok' },
    ]);
    expect(filterEvents(h.log, 'filter.save')).toMatchObject([
      { outcome: 'ok', filter: saved.id, replaced: false },
    ]);
  });

  it('an existing name without replace → duplicate: nothing written, failed event, no audit row', async () => {
    const h = harness();
    const existing = seed(h.repo, NAME, F_OLD);
    const err = await thrown(() => saveFilter(h.deps, NAME, F_NEW, { replace: false }));
    expect(err).toBeInstanceOf(SavedFilterError);
    expect(err).toMatchObject({ code: 'duplicate' });
    expect(h.repo.rows).toEqual([existing]);
    expect(h.audit.entries).toEqual([]);
    expect(filterEvents(h.log, 'filter.save')).toMatchObject([
      { outcome: 'failed', reason: 'duplicate' },
    ]);
  });

  it('replace of an existing name keeps its id, stores the new filter, audited as replaced', async () => {
    const h = harness();
    const existing = seed(h.repo, NAME, F_OLD);
    const { saved, replaced } = await saveFilter(h.deps, NAME, F_NEW, { replace: true });
    expect(replaced).toBe(true);
    expect(saved.id).toBe(existing.id);
    expect(saved.filter).toEqual(F_NEW);
    expect(h.audit.entries).toEqual([
      { action: 'filter.save', details: { filter: existing.id, replaced: true }, result: 'ok' },
    ]);
    expect(filterEvents(h.log, 'filter.save')).toMatchObject([
      { outcome: 'ok', filter: existing.id, replaced: true },
    ]);
  });

  it('replace of a name whose row is gone → not-found, nothing audited, failed event', async () => {
    const h = harness();
    seed(h.repo, NAME, F_OLD);
    h.repo.replaceMisses = true;
    const err = await thrown(() => saveFilter(h.deps, NAME, F_NEW, { replace: true }));
    expect(err).toBeInstanceOf(SavedFilterError);
    expect(err).toMatchObject({ code: 'not-found' });
    expect(h.audit.entries).toEqual([]);
    expect(filterEvents(h.log, 'filter.save')).toMatchObject([
      { outcome: 'failed', reason: 'not-found' },
    ]);
  });

  it('replace of a name that is not saved yet saves it as new (replaced false)', async () => {
    const h = harness();
    const { saved, replaced } = await saveFilter(h.deps, NAME, F_NEW, { replace: true });
    expect(replaced).toBe(false);
    expect(h.repo.rows).toEqual([saved]);
    expect(h.audit.entries).toEqual([
      { action: 'filter.save', details: { filter: saved.id, replaced: false }, result: 'ok' },
    ]);
  });

  it('199 saved filters and no skipped rows → a new name is saved (the 200th)', async () => {
    const h = harness();
    fill(h.repo, 199);
    const { replaced } = await saveFilter(h.deps, NAME, F_NEW, { replace: false });
    expect(replaced).toBe(false);
    expect(h.repo.rows).toHaveLength(200);
  });

  it('at 200 filters (199 saved + 1 skipped) a new name → limit: nothing written', async () => {
    const h = harness();
    fill(h.repo, 199);
    h.repo.skipped = 1;
    const err = await thrown(() => saveFilter(h.deps, NAME, F_NEW, { replace: false }));
    expect(err).toBeInstanceOf(SavedFilterError);
    expect(err).toMatchObject({ code: 'limit' });
    expect(h.repo.rows).toHaveLength(199);
    expect(h.audit.entries).toEqual([]);
    expect(filterEvents(h.log, 'filter.save')).toMatchObject([
      { outcome: 'failed', reason: 'limit' },
    ]);
  });

  it('at 200 filters a replace of an existing name still works', async () => {
    const h = harness();
    fill(h.repo, 199);
    h.repo.skipped = 1;
    const { replaced } = await saveFilter(h.deps, 'filter-7', F_NEW, { replace: true });
    expect(replaced).toBe(true);
    expect(h.audit.entries).toHaveLength(1);
  });

  it('a create that loses a race on the same name (conflict) → duplicate', async () => {
    const h = harness();
    h.repo.createError = new RepoError('conflict', 'taken');
    const err = await thrown(() => saveFilter(h.deps, NAME, F_NEW, { replace: false }));
    expect(err).toBeInstanceOf(SavedFilterError);
    expect(err).toMatchObject({ code: 'duplicate' });
    expect(h.audit.entries).toEqual([]);
    expect(filterEvents(h.log, 'filter.save')).toMatchObject([
      { outcome: 'failed', reason: 'duplicate' },
    ]);
  });

  it('a repo failure is rethrown as it was, logged as database, no audit row', async () => {
    const h = harness();
    const failure = new RepoError('unavailable', 'down');
    h.repo.createError = failure;
    expect(await thrown(() => saveFilter(h.deps, NAME, F_NEW, { replace: false }))).toBe(failure);
    expect(h.audit.entries).toEqual([]);
    expect(filterEvents(h.log, 'filter.save')).toMatchObject([
      { outcome: 'failed', reason: 'database' },
    ]);
  });
});

describe('deleteFilter', () => {
  it('an existing name is removed, audited and logged; the removed filter is returned', async () => {
    const h = harness();
    const existing = seed(h.repo, NAME, F_OLD);
    const removed = await deleteFilter(h.deps, NAME);
    expect(removed).toMatchObject({ id: existing.id, name: NAME });
    expect(h.repo.rows).toEqual([]);
    expect(h.audit.entries).toEqual([
      { action: 'filter.delete', details: { filter: existing.id }, result: 'ok' },
    ]);
    expect(filterEvents(h.log, 'filter.delete')).toMatchObject([
      { outcome: 'ok', filter: existing.id },
    ]);
  });

  it('a missing name → not-found, failed event, no audit row', async () => {
    const h = harness();
    const err = await thrown(() => deleteFilter(h.deps, NAME));
    expect(err).toBeInstanceOf(SavedFilterError);
    expect(err).toMatchObject({ code: 'not-found' });
    expect(h.audit.entries).toEqual([]);
    expect(filterEvents(h.log, 'filter.delete')).toMatchObject([
      { outcome: 'failed', reason: 'not-found' },
    ]);
  });

  it('a row the repo cannot remove → not-found, nothing audited', async () => {
    const h = harness();
    seed(h.repo, NAME, F_OLD);
    h.repo.removeMisses = true;
    const err = await thrown(() => deleteFilter(h.deps, NAME));
    expect(err).toMatchObject({ code: 'not-found' });
    expect(h.audit.entries).toEqual([]);
  });
});

describe('listFilters and getSavedFilter', () => {
  it('listFilters sorts by name (plain order) and passes the skipped count through', async () => {
    const repo = new FakeFiltersRepo();
    seed(repo, 'c-one');
    seed(repo, 'a-one');
    seed(repo, 'b-one');
    repo.skipped = 2;
    const result = await listFilters(repo);
    expect(result.filters.map((f) => f.name)).toEqual(['a-one', 'b-one', 'c-one']);
    expect(result.skipped).toBe(2);
  });

  it('getSavedFilter returns the row by name, null when there is none', async () => {
    const repo = new FakeFiltersRepo();
    const existing = seed(repo, NAME, F_OLD);
    expect(await getSavedFilter(repo, NAME)).toEqual(existing);
    expect(await getSavedFilter(repo, 'nope')).toBeNull();
  });
});

describe('filterTerms', () => {
  it('an all-of root gives its terms', () => {
    expect(filterTerms(parsed('from:@shop.sk older:1y'))).toEqual([
      { kind: 'from', values: ['@shop.sk'] },
      { kind: 'olderThan', age: '1y' },
    ]);
  });

  it('a root that is one leaf gives that leaf', () => {
    expect(filterTerms({ version: 1, where: { kind: 'larger', bytes: 1048576 } })).toEqual([
      { kind: 'larger', bytes: 1048576 },
    ]);
  });

  it('the empty filter gives no terms', () => {
    expect(filterTerms(EMPTY_FILTER)).toEqual([]);
  });
});

describe('canary: the name and the filter values reach no log line and no audit row', () => {
  it('a save, a duplicate, a delete and a missing delete leave no name or filter value', async () => {
    const h = harness();
    const F = parsed('from:@geheim.example subject:tajne');
    await saveFilter(h.deps, 'secret-name', F, { replace: false });
    await thrown(() => saveFilter(h.deps, 'secret-name', F, { replace: false }));
    await deleteFilter(h.deps, 'secret-name');
    await thrown(() => deleteFilter(h.deps, 'secret-name'));

    expect(h.log.lines).toHaveLength(4);
    const written = [...h.log.lines, JSON.stringify(h.audit.entries)].join('\n');
    for (const canary of ['secret-name', 'geheim', 'tajne']) {
      expect(written, `leaks ${canary}`).not.toContain(canary);
    }
  });
});
