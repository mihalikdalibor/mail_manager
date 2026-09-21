# Data model (Supabase / Postgres)

All tables live in `public`, all have **RLS enabled** with ownership `user_id = auth.uid()`. Users come from Supabase Auth (`auth.users`). Migrations live in `supabase/migrations/` and are applied via the Supabase SQL editor or CLI (`supabase db push`, CLI does not need Docker for pushing to cloud).

**Rule:** no message content, subjects, or message addresses are stored. See [ARCHITECTURE.md](ARCHITECTURE.md#1-email-content-never-goes-to-the-cloud-db).

## Tables

### `mail_accounts` (M1)

| Column                  | Type                                                | Notes                                                  |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| id                      | uuid PK default `gen_random_uuid()`                 |                                                        |
| user_id                 | uuid FK → auth.users, not null, `on delete cascade` | owner                                                  |
| label                   | text                                                | user-facing name ("Work", "Old Gmail")                 |
| email                   | text not null                                       | the mailbox address (the user's own, not message data) |
| provider                | text                                                | preset key (`gmail`, `seznam`, …) or `custom`          |
| host                    | text not null                                       |                                                        |
| port                    | int not null default 993                            |                                                        |
| username                | text not null                                       |                                                        |
| auth_type               | text check in (`password`,`oauth2`)                 | `oauth2` from M6                                       |
| secret_ciphertext       | bytea not null                                      | AES-256-GCM output                                     |
| secret_iv               | bytea not null                                      | 12 bytes, unique per encryption                        |
| secret_tag              | bytea not null                                      | 16 bytes GCM auth tag                                  |
| key_version             | int not null                                        | which master key encrypted it                          |
| capabilities            | jsonb                                               | cached server capabilities (UIDPLUS, MOVE, QUOTA, …)   |
| created_at / updated_at | timestamptz                                         |                                                        |
| last_checked_at         | timestamptz                                         | last successful login test                             |

Unique `(user_id, email, host)`.

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

### `audit_log` (M4)

Append-only record of destructive / export actions.

| Column        | Type                                                        | Notes                              |
| ------------- | ----------------------------------------------------------- | ---------------------------------- |
| id            | bigint identity PK                                          |                                    |
| user_id       | uuid FK                                                     |                                    |
| account_id    | uuid FK null (`on delete set null`)                         | keep history after account removal |
| action        | text check in (`trash`,`expunge`,`backup`,`move`,`migrate`) |                                    |
| folder        | text                                                        | folder name                        |
| message_count | int                                                         |                                    |
| bytes         | bigint                                                      |                                    |
| filter_json   | jsonb                                                       | what was selected                  |
| result        | text check in (`ok`,`partial`,`failed`,`aborted`)           |                                    |
| error         | text null                                                   | redacted                           |
| created_at    | timestamptz default now()                                   |                                    |

RLS: `select` and `insert` policies only — **no update/delete policies**, so rows are immutable for users.

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

- Account deletion: cascade audit rows too, or keep with `account_id = null`? (Current proposal: keep, set null.)
- Should `email` of the account be considered sensitive enough to encrypt? (Proposal: no — needed for display and uniqueness.)
