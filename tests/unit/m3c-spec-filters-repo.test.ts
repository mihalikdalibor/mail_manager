import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect } from 'vitest';
import type { Filter } from '../../src/core/filters/schema.js';
import { RepoError } from '../../src/core/db/repos.js';
import type { SavedFilter } from '../../src/core/db/repos.js';
import {
  FILTERS_LIST_MAX,
  rowToSavedFilter,
  SupabaseFiltersRepo,
} from '../../src/core/db/supabase/filters-repo.js';
import { createSupabaseServices, MemorySessionStorage } from '../../src/core/db/supabase/index.js';

// M3c SupabaseFiltersRepo against a fake supabase-js client, pinned from the spec.
// Filters are M3a filter documents; the database stores filter_json as opaque JSON.

const FILTER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const COLUMNS = ['id', 'name', 'filter_json', 'created_at', 'updated_at'];

const F: Filter = { version: 1, where: { kind: 'subject', value: 'a' } };

interface Call {
  method: string;
  args: unknown[];
}

interface FakeResponse {
  data?: unknown;
  error?: unknown;
}

const CHAIN_METHODS = [
  'insert',
  'update',
  'delete',
  'select',
  'order',
  'limit',
  'range',
  'eq',
  'single',
  'maybeSingle',
  'abortSignal',
  'returns',
  'throwOnError',
];

/** Records every builder call; awaiting any point of the chain yields `response`. */
function fakeClient(response: FakeResponse = { data: null, error: null }) {
  const calls: Call[] = [];
  const settled = { data: response.data ?? null, error: response.error ?? null };
  const chain: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  chain['then'] = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(settled).then(onFulfilled, onRejected);
  const client = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] });
      return chain;
    },
  } as unknown as SupabaseClient;
  const methods = () => calls.map((c) => c.method);
  const argsOf = (method: string): unknown[] => {
    const found = calls.filter((c) => c.method === method);
    expect(found).toHaveLength(1);
    return found[0]?.args ?? [];
  };
  return { client, calls, methods, argsOf };
}

/** A client that fails the test if the repo sends any request. */
function noRequestClient(): { client: SupabaseClient; calls: () => number } {
  let calls = 0;
  const client = {
    from: () => {
      calls += 1;
      throw new Error('unexpected request');
    },
  } as unknown as SupabaseClient;
  return { client, calls: () => calls };
}

async function rejection(p: Promise<unknown>): Promise<RepoError> {
  const err: unknown = await p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RepoError);
  return err as RepoError;
}

/** The select list the repo sent, as column names in order. */
function selected(args: unknown[]): string[] {
  expect(typeof args[0]).toBe('string');
  return String(args[0])
    .split(',')
    .map((c) => c.trim());
}

const CREATED = '2026-10-15T09:00:00.123456+00:00';
const UPDATED = '2026-10-15T09:05:00.000000+00:00';

/** A saved_filters row as PostgREST returns it (COLUMNS only); tests override one field. */
function row(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FILTER_ID,
    name: 'big-old',
    filter_json: F,
    // PostgREST's timestamptz format (microseconds, numeric offset).
    created_at: CREATED,
    updated_at: UPDATED,
    ...extra,
  };
}

const MAPPED: SavedFilter = {
  id: FILTER_ID,
  name: 'big-old',
  filter: F,
  createdAt: new Date('2026-10-15T09:00:00.123Z'),
  updatedAt: new Date('2026-10-15T09:05:00.000Z'),
};

describe('SupabaseFiltersRepo.create', () => {
  it('create inserts name and filter_json only, selecting the saved_filters columns', async () => {
    const fake = fakeClient({ data: row() });
    await new SupabaseFiltersRepo(fake.client).create('big-old', F);
    expect(fake.argsOf('from')).toEqual(['saved_filters']);
    expect(fake.argsOf('insert')).toEqual([{ name: 'big-old', filter_json: F }]);
    expect(selected(fake.argsOf('select'))).toEqual(COLUMNS);
  });

  it('maps the returned row to a SavedFilter with Date timestamps', async () => {
    const fake = fakeClient({ data: row() });
    const saved = await new SupabaseFiltersRepo(fake.client).create('big-old', F);
    expect(saved).toEqual(MAPPED);
    expect(saved.createdAt).toBeInstanceOf(Date);
    expect(saved.updatedAt).toBeInstanceOf(Date);
  });

  it('create duplicate: fake error 23505 → RepoError conflict, without leaking its text', async () => {
    const fake = fakeClient({
      error: {
        code: '23505',
        message: 'LEAKCANARY-msg',
        details: 'LEAKCANARY-details',
        hint: 'LEAKCANARY-hint',
      },
    });
    const err = await rejection(new SupabaseFiltersRepo(fake.client).create('big-old', F));
    expect(err.code).toBe('conflict');
    expect(err.message).not.toContain('LEAKCANARY');
  });

  it.each([
    ['42501', 'forbidden'],
    ['XX000', 'unknown'],
  ] as const)('create maps error %s to %s', async (code, kind) => {
    const fake = fakeClient({
      error: { code, message: 'LEAKCANARY-msg', details: 'x', hint: 'y' },
    });
    const err = await rejection(new SupabaseFiltersRepo(fake.client).create('big-old', F));
    expect(err.code).toBe(kind);
    expect(err.message).not.toContain('LEAKCANARY');
  });

  it('create maps a network failure to unavailable', async () => {
    const fake = fakeClient({
      error: { code: '', message: 'TypeError: fetch failed', details: 'LEAKCANARY', hint: '' },
    });
    const err = await rejection(new SupabaseFiltersRepo(fake.client).create('big-old', F));
    expect(err.code).toBe('unavailable');
    expect(err.message).not.toContain('LEAKCANARY');
  });

  it('create rejects a returned row that does not validate with RepoError(unknown)', async () => {
    const fake = fakeClient({ data: row({ name: 'Big' }) });
    const err = await rejection(new SupabaseFiltersRepo(fake.client).create('big-old', F));
    expect(err.code).toBe('unknown');
    expect(err.message).toBe('Unexpected saved_filters row');
  });
});

describe('SupabaseFiltersRepo.replace', () => {
  it.each(['', 'not-a-uuid', "1' or '1'='1", '11111111-1111-4111-8111-11111111111'])(
    'replace with the id %j → null and no request',
    async (id) => {
      const { client, calls } = noRequestClient();
      await expect(new SupabaseFiltersRepo(client).replace(id, F)).resolves.toBeNull();
      expect(calls()).toBe(0);
    },
  );

  it('replace 0 rows → null', async () => {
    const fake = fakeClient({ data: [] });
    await expect(new SupabaseFiltersRepo(fake.client).replace(FILTER_ID, F)).resolves.toBeNull();
  });

  it('replace 1 row → mapped', async () => {
    const fake = fakeClient({ data: [row()] });
    await expect(new SupabaseFiltersRepo(fake.client).replace(FILTER_ID, F)).resolves.toEqual(
      MAPPED,
    );
  });

  it('replace update payload is exactly { filter_json }, filtered .eq(id)', async () => {
    const fake = fakeClient({ data: [row()] });
    await new SupabaseFiltersRepo(fake.client).replace(FILTER_ID, F);
    expect(fake.argsOf('from')).toEqual(['saved_filters']);
    expect(fake.argsOf('update')).toEqual([{ filter_json: F }]);
    expect(fake.argsOf('eq')).toEqual(['id', FILTER_ID]);
    expect(selected(fake.argsOf('select'))).toEqual(COLUMNS);
  });

  it('replace maps query errors through toRepoError', async () => {
    const fake = fakeClient({ error: { code: '42501', message: 'LEAKCANARY', details: '' } });
    const err = await rejection(new SupabaseFiltersRepo(fake.client).replace(FILTER_ID, F));
    expect(err.code).toBe('forbidden');
    expect(err.message).not.toContain('LEAKCANARY');
  });

  it('replace rejects a malformed returned row with RepoError(unknown)', async () => {
    const fake = fakeClient({ data: [row({ id: 'not-a-uuid' })] });
    const err = await rejection(new SupabaseFiltersRepo(fake.client).replace(FILTER_ID, F));
    expect(err.code).toBe('unknown');
    expect(err.message).toBe('Unexpected saved_filters row');
  });
});

describe('SupabaseFiltersRepo.list', () => {
  it('list skips malformed rows: bad name, bad id and bad created_at → 1 filter, skipped 3', async () => {
    const fake = fakeClient({
      data: [
        row(),
        row({ id: OTHER_ID, name: 'Big' }),
        row({ id: 'not-a-uuid' }),
        row({ id: OTHER_ID, created_at: 'yesterday' }),
      ],
    });
    await expect(new SupabaseFiltersRepo(fake.client).list()).resolves.toEqual({
      filters: [MAPPED],
      skipped: 3,
    });
  });

  it('list is ordered by name ascending, limited to FILTERS_LIST_MAX (1000) rows', async () => {
    const fake = fakeClient({ data: [] });
    await new SupabaseFiltersRepo(fake.client).list();
    expect(FILTERS_LIST_MAX).toBe(1000);
    expect(fake.argsOf('from')).toEqual(['saved_filters']);
    expect(selected(fake.argsOf('select'))).toEqual(COLUMNS);
    const [column, options] = fake.argsOf('order');
    expect(column).toBe('name');
    expect((options as { ascending?: boolean } | undefined)?.ascending ?? true).toBe(true);
    expect(fake.argsOf('limit')).toEqual([1000]);
  });

  it('list keeps a row whose filter_json is not a valid filter, with filter null', async () => {
    const fake = fakeClient({
      data: [row({ filter_json: { version: 1, where: { kind: 'nope' } } })],
    });
    await expect(new SupabaseFiltersRepo(fake.client).list()).resolves.toEqual({
      filters: [{ ...MAPPED, filter: null }],
      skipped: 0,
    });
  });

  it('list returns the valid rows in the order the server sent them', async () => {
    const fake = fakeClient({
      data: [row({ id: OTHER_ID, name: 'zeta' }), row({ name: 'alpha' })],
    });
    const { filters, skipped } = await new SupabaseFiltersRepo(fake.client).list();
    expect(skipped).toBe(0);
    expect(filters.map((f) => f.name)).toEqual(['zeta', 'alpha']);
  });

  it('list counts null and non-object rows as skipped', async () => {
    const fake = fakeClient({ data: [null, 'row', 42, row()] });
    await expect(new SupabaseFiltersRepo(fake.client).list()).resolves.toEqual({
      filters: [MAPPED],
      skipped: 3,
    });
  });

  it('list accepts a 40-character name and skips a 41-character one', async () => {
    const forty = 'a'.repeat(40);
    const fake = fakeClient({
      data: [row({ name: forty }), row({ id: OTHER_ID, name: 'a'.repeat(41) })],
    });
    const { filters, skipped } = await new SupabaseFiltersRepo(fake.client).list();
    expect(filters.map((f) => f.name)).toEqual([forty]);
    expect(skipped).toBe(1);
  });

  it.each<unknown>([{}, 'rows', 42, true])(
    'list rejects non-array data %j with RepoError(unknown)',
    async (data) => {
      const fake = fakeClient({ data });
      const err = await rejection(new SupabaseFiltersRepo(fake.client).list());
      expect(err.code).toBe('unknown');
      expect(err.message).toBe('Unexpected saved_filters response');
    },
  );

  it.each([
    ['42501', 'forbidden'],
    ['XX000', 'unknown'],
  ] as const)('list maps query error %s to %s without leaking text', async (code, kind) => {
    const fake = fakeClient({
      error: { code, message: 'LEAKCANARY-msg', details: 'x', hint: 'y' },
    });
    const err = await rejection(new SupabaseFiltersRepo(fake.client).list());
    expect(err.code).toBe(kind);
    expect(err.message).not.toContain('LEAKCANARY');
  });

  it('list maps a network failure to unavailable', async () => {
    const fake = fakeClient({ error: { code: '', message: 'TypeError: fetch failed' } });
    const err = await rejection(new SupabaseFiltersRepo(fake.client).list());
    expect(err.code).toBe('unavailable');
  });
});

describe('SupabaseFiltersRepo.getByName', () => {
  it('getByName uses .eq(name) and maybeSingle, and maps the row', async () => {
    const fake = fakeClient({ data: row() });
    await expect(new SupabaseFiltersRepo(fake.client).getByName('big-old')).resolves.toEqual(
      MAPPED,
    );
    expect(fake.argsOf('from')).toEqual(['saved_filters']);
    expect(fake.argsOf('eq')).toEqual(['name', 'big-old']);
    expect(fake.methods()).toContain('maybeSingle');
    expect(selected(fake.argsOf('select'))).toEqual(COLUMNS);
  });

  it('getByName with null data → null', async () => {
    const fake = fakeClient({ data: null });
    await expect(new SupabaseFiltersRepo(fake.client).getByName('big-old')).resolves.toBeNull();
  });

  it('getByName with a malformed row → null', async () => {
    const fake = fakeClient({ data: row({ name: 'Big' }) });
    await expect(new SupabaseFiltersRepo(fake.client).getByName('big-old')).resolves.toBeNull();
  });

  it('getByName maps query errors through toRepoError', async () => {
    const fake = fakeClient({ error: { code: '42501', message: 'LEAKCANARY', details: '' } });
    const err = await rejection(new SupabaseFiltersRepo(fake.client).getByName('big-old'));
    expect(err.code).toBe('forbidden');
    expect(err.message).not.toContain('LEAKCANARY');
  });
});

describe('SupabaseFiltersRepo.remove', () => {
  it('remove with 1 row deleted → true, filtered .eq(id)', async () => {
    const fake = fakeClient({ data: [{ id: FILTER_ID }] });
    await expect(new SupabaseFiltersRepo(fake.client).remove(FILTER_ID)).resolves.toBe(true);
    expect(fake.argsOf('from')).toEqual(['saved_filters']);
    expect(fake.argsOf('eq')).toEqual(['id', FILTER_ID]);
    expect(selected(fake.argsOf('select'))).toEqual(['id']);
  });

  it('remove with 0 rows deleted → false', async () => {
    const fake = fakeClient({ data: [] });
    await expect(new SupabaseFiltersRepo(fake.client).remove(FILTER_ID)).resolves.toBe(false);
  });

  it('remove with a bad UUID → false without request', async () => {
    const { client, calls } = noRequestClient();
    await expect(new SupabaseFiltersRepo(client).remove('not-a-uuid')).resolves.toBe(false);
    expect(calls()).toBe(0);
  });

  it('remove maps query errors through toRepoError', async () => {
    const fake = fakeClient({ error: { code: '42501', message: 'LEAKCANARY', details: '' } });
    const err = await rejection(new SupabaseFiltersRepo(fake.client).remove(FILTER_ID));
    expect(err.code).toBe('forbidden');
    expect(err.message).not.toContain('LEAKCANARY');
  });
});

describe('rowToSavedFilter', () => {
  it('maps a valid row to a SavedFilter', () => {
    expect(rowToSavedFilter(row())).toEqual(MAPPED);
  });

  it('returns null for a row that is not an object', () => {
    expect(rowToSavedFilter('row')).toBeNull();
    expect(rowToSavedFilter(null)).toBeNull();
  });

  it('returns null for a row whose created_at is not a date', () => {
    expect(rowToSavedFilter(row({ created_at: 'yesterday' }))).toBeNull();
  });
});

describe('createSupabaseServices (M3c)', () => {
  it('exposes a SupabaseFiltersRepo as filters with the five repo methods', () => {
    const services = createSupabaseServices(
      {
        SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_TESTKEY123',
      },
      new MemorySessionStorage(),
    );
    expect(services.filters).toBeInstanceOf(SupabaseFiltersRepo);
    for (const method of ['create', 'replace', 'list', 'getByName', 'remove'] as const) {
      expect(typeof services.filters[method]).toBe('function');
    }
  });
});
