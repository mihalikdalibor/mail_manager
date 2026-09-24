# Data model (Supabase / Postgres)

All tables live in `public`, all have **RLS enabled** with ownership `user_id = auth.uid()`. Users come from Supabase Auth (`auth.users`). Migrations live in `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` (Supabase CLI convention) and are applied with `npm run db:push` (Supabase CLI, no Docker needed for the cloud project; link once with `npx supabase login` + `npx supabase link --project-ref <ref>`). An applied migration is never edited — changes go into a new file. Signup is **invite-only**: public signups are disabled in the dashboard (Authentication → Sign In / Providers; verified live 2026-09-22, `disable_signup: true`) and users are created there. `mm doctor`'s `signup` check fails if they are ever re-enabled. `supabase/config.toml` also has `enable_signup = false`, but that file only affects the local dev stack and a future `supabase config push` — the dashboard setting is what counts for the cloud project.

**Rule:** no message content, subjects, or message addresses are stored. See [ARCHITECTURE.md](ARCHITECTURE.md#1-email-content-never-goes-to-the-cloud-db).

## Tables

### `mail_accounts` (M1a — `supabase/migrations/20260921221108_init.sql`)

| Column                  | Type                                                                      | Notes                                                                          |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| id                      | uuid PK default `gen_random_uuid()`                                       | the app sends a client-generated id (bound into the AAD)                       |
| user_id                 | uuid FK → auth.users, not null, default `auth.uid()`, `on delete cascade` | owner                                                                          |
| label                   | text                                                                      | user-facing name ("Work", "Old Gmail")                                         |
| email                   | text not null, check `email = lower(email)`                               | the mailbox address (the user's own, not message data); lowercased by the repo |
| provider                | text                                                                      | preset key (`gmail`, `seznam`, …) or `custom`                                  |
| host                    | text not null                                                             |                                                                                |
| port                    | int not null default 993                                                  |                                                                                |
| username                | text not null                                                             |                                                                                |
| auth_type               | text check in (`password`,`oauth2`)                                       | `oauth2` from M6                                                               |
| secret_ciphertext       | text not null (base64)                                                    | AES-256-GCM output                                                             |
| secret_iv               | text not null (base64)                                                    | 12 bytes, unique per encryption                                                |
| secret_tag              | text not null (base64)                                                    | 16 bytes GCM auth tag                                                          |
| key_version             | int not null                                                              | which master key encrypted it                                                  |
| capabilities            | jsonb                                                                     | cached server capabilities (UIDPLUS, MOVE, QUOTA, …)                           |
| created_at / updated_at | timestamptz                                                               |                                                                                |
| last_checked_at         | timestamptz                                                               | last successful login test                                                     |

Planned for M4 (new migration, since the init migration is already applied): `trash_path` text, `trash_source` text check in (`extension`,`name`,`user`), `trash_confirmed_at` timestamptz. This is the Trash folder the user confirmed ([IMAP.md §6.5](IMAP.md#65-choosing-the-trash-folder)). It's account configuration, not message data.

Unique `(user_id, email, host)`. `updated_at` is set by a `before update` trigger.

Secrets are base64 **text**, not `bytea`: PostgREST returns bytea as `\x…` hex strings, and text is portable to a future non-Supabase Postgres.

**Access (M1a):**

- RLS enabled; four policies (select / insert / update / delete) for `authenticated`, each `user_id = (select auth.uid())`.
- Privileges are reset explicitly — `revoke all … from anon, authenticated` (Supabase's defaults include TRUNCATE, which bypasses RLS) — then `select, insert, delete` plus **column-level `update`** on everything except `id`, `user_id`, `created_at`. Changing `id`/`user_id` would break the AAD binding, so they are immutable.
- `anon` has no privileges at all: an anon read fails with `42501` (`mm doctor`'s `database` check relies on this).

### `saved_filters` (M3)

| Column                  | Type           | Notes                                                                         |
| ----------------------- | -------------- | ----------------------------------------------------------------------------- |
| id                      | uuid PK        |                                                                               |
| user_id                 | uuid FK        | owner                                                                         |
| name                    | text not null  | unique per user                                                               |
| filter_json             | jsonb not null | validated by zod (`filters/schema.ts`) in the app; includes a `version` field |
| account_id              | uuid FK null   | optional default account                                                      |
| created_at / updated_at | timestamptz    |                                                                               |

Note: filter values may contain addresses the user typed (e.g. "from newsletter@shop.com"). That is user-authored config, accepted as necessary; documented in SECURITY.md.

### `audit_log` (M1b-4)

Append-only record of every state change a user makes to accounts, filters or mail (moved from M4 to M1b-4 on 2026-09-23 and made generic, so M1c's account actions are audited from day one). Part of the logging design: [LOGGING.md](LOGGING.md).

| Column        | Type                                                                      | Notes                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id            | bigint identity PK                                                        |                                                                                                                                                                                 |
| user_id       | uuid FK → auth.users, not null, default `auth.uid()`, `on delete cascade` | deleting the user deletes their audit rows                                                                                                                                      |
| account_id    | uuid FK null (`on delete set null`)                                       | keep history after account removal                                                                                                                                              |
| action        | text not null, check `action ~ '^[a-z]+(\.[a-z-]+)?$'`                    | zod enum in the app: `account.add`, `account.remove`, `account.password-update`, `filter.save`, `filter.delete`, `mail.trash`, `mail.expunge`, `mail.move`, `backup`, `migrate` |
| folder        | text null                                                                 | folder name (mail actions)                                                                                                                                                      |
| message_count | int null                                                                  |                                                                                                                                                                                 |
| bytes         | bigint null                                                               |                                                                                                                                                                                 |
| details       | jsonb null, size-capped (check on `pg_column_size`)                       | zod-validated per action: provider id, filter JSON, plan/backup id, notices — no mail content                                                                                   |
| result        | text check in (`ok`,`partial`,`failed`,`aborted`)                         |                                                                                                                                                                                 |
| reason        | text null                                                                 | typed reason code, never raw error text                                                                                                                                         |
| run_id        | text null                                                                 | the local run id — links the row to `mm logs --run`                                                                                                                             |
| created_at    | timestamptz not null default `now()`                                      | set by the database (no insert privilege on the column)                                                                                                                         |

RLS: `select` and `insert` policies only — **no update/delete policies**, so rows are immutable for users. Privileges reset explicitly like `mail_accounts` (no TRUNCATE, no anon). Writers: M1c (account actions), M3 (filters), M4 (delete), M5 (backup), M6c (migrate).

### `jobs` / `job_runs` (M6)

- `jobs`: id, user_id, account_id, type (`backup`|`cleanup`), filter_id, cron text, enabled bool, options jsonb, next_run_at.
- `job_runs`: id, job_id, status, started_at, finished_at, message_count, bytes, error.
- The worker runs with the service-role key (bypasses RLS) and must filter by `user_id` explicitly.

## Key versioning

`key_version` lets us rotate `MM_MASTER_KEY`: add new key as version N+1, re-encrypt rows lazily (on next use) or via a one-off script, retire old key when no rows reference it.

## Supabase operational notes

- **Free tier pauses** a project after ~1 week without activity — expect a cold resume during development; not acceptable once others rely on it (upgrade or migrate).
- Choose an **EU region** (e.g. Frankfurt) — relevant for GDPR.
- The publishable key (`sb_publishable_…`, formerly "anon") is public by design; safety depends entirely on RLS. Every new table ships with RLS + policies in the same migration.
- Test RLS with **two users**: user B must see zero rows of user A.

## Open questions

- Account deletion: cascade audit rows too, or keep with `account_id = null`? (Current proposal: keep, set null; deleting the whole user deletes them.)
- Should `email` of the account be considered sensitive enough to encrypt? (Proposal: no — needed for display and uniqueness.)
