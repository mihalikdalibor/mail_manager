-- M1b-4d: append-only audit trail of what a user changed (accounts, filters, mail, backups).
-- Counts, bytes, folder names, the filter definition and reason codes only — never message
-- content, subjects or addresses. Users read and add their own rows; nobody edits or deletes
-- them (deleting the user cascades; removing an account keeps its rows with account_id null).

create table public.audit_log (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account_id uuid references public.mail_accounts (id) on delete set null,
  action text not null check (action ~ '^[a-z]+(\.[a-z-]+)?$' and length(action) <= 40),
  folder text check (length(folder) <= 1024),
  message_count integer check (message_count >= 0),
  bytes bigint check (bytes >= 0),
  details jsonb check (pg_column_size(details) <= 4096),
  result text not null check (result in ('ok', 'partial', 'failed', 'aborted')),
  reason text check (reason ~ '^[a-z0-9-]{1,60}$'),
  run_id text check (run_id ~ '^[0-9a-f]{16}$'),
  created_at timestamptz not null default now()
);

create index audit_log_user_created_idx on public.audit_log (user_id, created_at desc);
create index audit_log_account_idx on public.audit_log (account_id);

alter table public.audit_log enable row level security;

-- Own rows only. The insert check runs before the FK check, so another user's (or an unknown)
-- account id is refused with 42501 and can't be used to probe which account ids exist.
create policy "own rows: select" on public.audit_log
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows: insert" on public.audit_log
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      audit_log.account_id is null
      or exists (
        select 1 from public.mail_accounts m
        where m.id = audit_log.account_id and m.user_id = (select auth.uid())
      )
    )
  );
-- No update or delete policies: rows are immutable for users.

-- Supabase default privileges grant ALL (incl. TRUNCATE, which bypasses RLS). Reset first.
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;
-- Column-level INSERT: id (identity), user_id (always auth.uid()) and created_at (server time)
-- can't be set by the client.
grant insert (
  account_id, action, folder, message_count, bytes, details, result, reason, run_id
) on public.audit_log to authenticated;
-- The identity sequence gets Supabase's default rwU grants; setval could break every insert.
-- An identity column needs no sequence privilege to insert.
revoke all on sequence public.audit_log_id_seq from anon, authenticated;
-- Append-only even against a leaked service key (cascade / set null run as the table owner).
revoke update, truncate on public.audit_log from service_role;
