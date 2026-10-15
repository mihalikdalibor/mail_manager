-- M3c: saved filters — a user's named filter definitions (user-authored config: values may hold
-- addresses or words the user typed; never message content). Global per user, one row per name.
-- Not insertable: id, user_id (database defaults), created_at, updated_at (server time).
-- Updatable: filter_json only (no rename).

create table public.saved_filters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null constraint saved_filters_name_format check (name ~ '^[a-z0-9_-]{1,40}$'),
  filter_json jsonb not null
    constraint saved_filters_filter_object check (jsonb_typeof(filter_json) = 'object')
    constraint saved_filters_filter_size check (pg_column_size(filter_json) <= 16384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_filters_user_name unique (user_id, name)
);

alter table public.saved_filters enable row level security;

create policy "own rows: select" on public.saved_filters
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows: insert" on public.saved_filters
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own rows: update" on public.saved_filters
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "own rows: delete" on public.saved_filters
  for delete to authenticated using (user_id = (select auth.uid()));

-- Supabase default privileges grant ALL (incl. TRUNCATE, which bypasses RLS). Reset first.
revoke all on public.saved_filters from anon, authenticated;
grant select, delete on public.saved_filters to authenticated;
grant insert (name, filter_json) on public.saved_filters to authenticated;
grant update (filter_json) on public.saved_filters to authenticated;

create trigger saved_filters_set_updated_at
  before update on public.saved_filters
  for each row execute function public.set_updated_at();
