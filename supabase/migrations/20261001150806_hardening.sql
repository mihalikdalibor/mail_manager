-- M1c-2: database hardening. Stricter rules on mail_accounts (lowercase host, length limits,
-- provider format, server-set timestamps, the server of a saved mailbox can't be changed) and on
-- audit_log (no '@' in folder, details is an object, nobody deletes rows). All-or-nothing: if an
-- existing row breaks a rule, the whole migration fails and nothing is applied.

-- Existing hosts first. The secret's AAD binds lower(host), so stored secrets still decrypt.
-- Two rows that differ only in host case would now collide on unique (user_id, email, host):
-- the migration fails then, and the duplicate is sorted out by hand (never worked around here).
update public.mail_accounts set host = lower(host) where host <> lower(host);

alter table public.mail_accounts
  add constraint mail_accounts_host_lower check (host = lower(host)),
  add constraint mail_accounts_email_length check (length(email) <= 254),
  add constraint mail_accounts_host_length check (length(host) <= 253),
  add constraint mail_accounts_username_length check (length(username) <= 320),
  add constraint mail_accounts_label_length check (label is null or length(label) <= 100),
  add constraint mail_accounts_provider_format check (provider ~ '^[a-z0-9-]{1,40}$');

-- Column-level INSERT: exactly the columns the app sends (accountToInsertRow + the secret
-- columns). created_at, updated_at, capabilities and last_checked_at can't be sent on insert
-- (they take the database defaults; the last two stay writable by a later UPDATE).
-- user_id stays insertable (the insert policy forces it to auth.uid()). A new insert
-- column must be added to this grant. The table-level INSERT from the init migration goes first;
-- revoking it at table level also drops any column-level INSERT privileges.
revoke insert on public.mail_accounts from authenticated;
grant insert (
  id, user_id, label, email, provider, host, port, username, auth_type,
  secret_ciphertext, secret_iv, secret_tag, key_version
) on public.mail_accounts to authenticated;

-- The server of a saved mailbox (and the AAD inputs email/host/port/username) never changes:
-- changing the server = remove + add. Still updatable: label, provider, auth_type, the secret
-- columns, key_version, capabilities, last_checked_at.
revoke update (email, host, port, username) on public.mail_accounts from authenticated;

-- audit_log: a folder name never holds an address, and details is always a JSON object.
alter table public.audit_log
  add constraint audit_log_folder_no_at check (folder is null or folder !~ '@'),
  add constraint audit_log_details_object check (details is null or jsonb_typeof(details) = 'object');

-- A leaked service key can no longer delete audit rows (it already can't update or truncate). It can
-- still insert backdated rows and delete the auth user, which cascades to the user's rows.
-- Deleting a user cascades as the table owner, not through this grant.
revoke delete on public.audit_log from service_role;
