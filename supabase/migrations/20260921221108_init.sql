-- M1a: mailbox accounts. Email content never goes into this database; only account
-- settings and the AES-256-GCM encrypted mailbox secret (key lives outside the DB).

create table public.mail_accounts (
  id uuid primary key default gen_random_uuid(), -- the app sends a client-generated id (bound into the AAD)
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  label text,
  email text not null check (email = lower(email)),
  provider text not null default 'custom',
  host text not null,
  port integer not null default 993 check (port between 1 and 65535),
  username text not null,
  auth_type text not null default 'password' check (auth_type in ('password', 'oauth2')),
  secret_ciphertext text not null, -- base64
  secret_iv text not null, -- base64, 12 bytes
  secret_tag text not null, -- base64, 16 bytes
  key_version integer not null check (key_version > 0),
  capabilities jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_checked_at timestamptz,
  unique (user_id, email, host)
);

alter table public.mail_accounts enable row level security;

-- One policy per command, logged-in owners only.
create policy "own rows: select" on public.mail_accounts
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows: insert" on public.mail_accounts
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own rows: update" on public.mail_accounts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "own rows: delete" on public.mail_accounts
  for delete to authenticated using (user_id = (select auth.uid()));

-- Supabase default privileges grant ALL (incl. TRUNCATE, which bypasses RLS). Reset first.
revoke all on public.mail_accounts from anon, authenticated;
grant select, insert, delete on public.mail_accounts to authenticated;
-- Column-level UPDATE: id, user_id and created_at are immutable (id/user_id are bound into the AAD).
grant update (
  label, email, provider, host, port, username, auth_type,
  secret_ciphertext, secret_iv, secret_tag, key_version,
  capabilities, last_checked_at
) on public.mail_accounts to authenticated;

create function public.set_updated_at() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Trigger-only function: nobody needs to call it directly (EXECUTE is checked at CREATE TRIGGER, not per row).
revoke execute on function public.set_updated_at() from public, anon, authenticated;

create trigger mail_accounts_set_updated_at
  before update on public.mail_accounts
  for each row execute function public.set_updated_at();
