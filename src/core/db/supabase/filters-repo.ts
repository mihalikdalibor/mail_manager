import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { parseFilter, type Filter } from '../../filters/schema.js';
import { RepoError, type FiltersRepo, type SavedFilter } from '../repos.js';
import { toRepoError } from './accounts-repo.js';

const TABLE = 'saved_filters';
const COLUMNS = 'id, name, filter_json, created_at, updated_at';
export const FILTERS_LIST_MAX = 1000;

const filterId = z.uuid();

// Reading back: rows may have been written by the user directly (their JWT allows inserts), so
// they're untrusted. A row whose id, name or timestamps don't match is skipped; a filter_json the
// filter schema refuses is kept with `filter: null`. Stored text such as `name` must still be
// sanitised before the CLI prints it.
const rowSchema = z.object({
  id: z.uuid(),
  name: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  filter_json: z.unknown(),
  created_at: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  updated_at: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
});

/** Validates a raw row and maps it to the domain type; null when its own columns don't match. */
export function rowToSavedFilter(raw: unknown): SavedFilter | null {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    id: r.id,
    name: r.name,
    filter: parseFilter(r.filter_json),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

/** For a row the database just returned: a malformed one is a failure, not a skip. */
function requireRow(raw: unknown): SavedFilter {
  const saved = rowToSavedFilter(raw);
  if (saved === null) throw new RepoError('unknown', 'Unexpected saved_filters row');
  return saved;
}

export class SupabaseFiltersRepo implements FiltersRepo {
  constructor(private readonly client: SupabaseClient) {}

  async create(name: string, filter: Filter): Promise<SavedFilter> {
    const { data, error } = await this.client
      .from(TABLE)
      .insert({ name, filter_json: filter })
      .select(COLUMNS)
      .single<unknown>();
    if (error) throw toRepoError(error);
    return requireRow(data);
  }

  async replace(id: string, filter: Filter): Promise<SavedFilter | null> {
    if (!filterId.safeParse(id).success) return null;
    const { data, error } = await this.client
      .from(TABLE)
      .update({ filter_json: filter })
      .eq('id', id)
      .select(COLUMNS);
    if (error) throw toRepoError(error);
    const rows = data as unknown[];
    return rows.length === 1 ? requireRow(rows[0]) : null;
  }

  async list(): Promise<{ filters: SavedFilter[]; skipped: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(COLUMNS)
      .order('name')
      .limit(FILTERS_LIST_MAX);
    if (error) throw toRepoError(error);
    if (!Array.isArray(data)) throw new RepoError('unknown', 'Unexpected saved_filters response');
    const filters: SavedFilter[] = [];
    let skipped = 0;
    for (const raw of data as unknown[]) {
      const saved = rowToSavedFilter(raw);
      if (saved === null) skipped++;
      else filters.push(saved);
    }
    return { filters, skipped };
  }

  async getByName(name: string): Promise<SavedFilter | null> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(COLUMNS)
      .eq('name', name)
      .maybeSingle<unknown>();
    if (error) throw toRepoError(error);
    return data === null ? null : rowToSavedFilter(data);
  }

  async remove(id: string): Promise<boolean> {
    if (!filterId.safeParse(id).success) return false;
    const { data, error } = await this.client.from(TABLE).delete().eq('id', id).select('id');
    if (error) throw toRepoError(error);
    return data.length === 1;
  }
}
