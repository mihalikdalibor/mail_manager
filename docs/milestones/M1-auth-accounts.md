# M1 — Auth, credential encryption, accounts

Split on 2026-09-21 into three backlog items (see `TODO.md`): **M1a** Supabase foundation → **M1b** IMAP, providers & test ground → **M1c** account commands (needs both).

## Goal

A user can log in and connect one or more IMAP mailboxes with minimal typing; credentials are stored encrypted and each account can be login-tested.

## M1a — Supabase foundation (implemented)

Decisions (2026-09-21): migrations via the Supabase CLI (`npm run db:push`); **invite-only** signup; RLS proven with two real test users.

- Migration `supabase/migrations/20260921221108_init.sql`: `mail_accounts` (see [DATA_MODEL.md](../DATA_MODEL.md)) — RLS for `authenticated`, privileges reset (no TRUNCATE, no anon), column-level update keeps `id`/`user_id`/`created_at` immutable, `updated_at` trigger.
- `src/core/crypto.ts` — AES-256-GCM, 12-byte IV, 16-byte tag, AAD `mail_accounts:<user_id>:<account_id>`, `keyVersion`.
- `src/core/credentials.ts` — `CredentialProvider` + `LocalCredentialProvider` (key-version guard; rotation tooling later).
- `src/core/db/repos.ts` — `AccountsRepo`, `MailAccount`, `RepoError` (no Supabase imports). `src/core/db/supabase/` — `SupabaseAccountsRepo` (zod-validated rows, email lowercased, update/remove return whether exactly one row changed), `SupabaseAuthService`, file session storage, `createSupabaseServices()` factory.
- `src/core/auth.ts` — `AuthService` / `AuthError`.
- CLI: `mm login [--email]` (hidden prompt — nothing echoed, TTY required, empty email refused, Ctrl+C → exit 130), `mm logout` (always clears the local session, even offline or with a broken config; prints "Not logged in" (exit 0) without contacting Supabase when no session existed), `mm whoami` (reports "Supabase unreachable" instead of "not logged in" on network failures).
- `mm doctor`: now 7 checks — adds `database` (table present and anon blocked with 42501; missing → "run `npm run db:push`"; anon readable → FAIL), `signup` (public signups disabled → OK; enabled → FAIL) and `session` (logged in → OK, else WARN; "Supabase unreachable" on network failure). The session check may refresh and rewrite the session file.
- Supabase client: per-request timeout (10 s default, 5 s in doctor) via a `fetch` wrapper; PostgREST retries disabled (fail fast).
- Node floor raised to 22.13 (`@inquirer/prompts` requirement).
- Integration test `tests/integration/supabase-rls.test.ts` (skips without `MM_TEST_SUPABASE_*`): owner CRUD, cross-user read/write blocked, cross-user insert forbidden, `id`/`user_id` immutable, anon denied with 42501, ciphertext only.

## M1b — IMAP foundation, providers & test ground

Split on 2026-09-22 into **M1b-1** discovery → **M1b-2** IMAP session → **M1b-3** test ground; **M1b-4** logging foundation added 2026-09-23 (runs after M1b-3, before M1c).

### M1b-1 — Provider discovery (implemented)

Three tiers (user decision 2026-09-22):

1. **Autodetect** (`src/core/providers/discover.ts`): preset by email domain → preset by **MX suffix** (the domain's MX host → matching preset in `presets.json` → its IMAP host) → Mozilla ISPDB → HTTPS autoconfig (`autoconfig.<domain>`, then `<domain>/.well-known/autoconfig`) → DNS SRV `_imaps._tcp`. Sequential, stops at the first hit. Only implicit TLS on 993 is accepted.
2. **Provider picker** (`src/cli/prompts/imap-settings.ts`): when autodetect finds nothing, the user picks from the presets (SK/CZ first, blocked ones shown disabled).
3. **Manual entry**: IMAP host (validated host name, no IP/localhost/port) + username (default = full address) — for proxied DNS or unlisted providers.

- Presets: `src/core/providers/presets.json`, zod-validated at load (`presets.ts`); unique ids/domains/MX suffixes; `verified` only with an official `helpUrl`.
- Untrusted input: strict host-name check for the email domain and every DNS/XML host; redirects followed manually and only to https; body cap 256 KiB; XML validated before parsing (fast-xml-parser, entities and value coercion off). Error details are codes only.
- **GeoIP hint** (`geoip.ts`): not shown with discovery results. From M1b-2 on it is printed only when a connection fails (timeout / refused): "The connection was not successful — first check the address, password and IMAP server; if they're right, check whether GeoIP security is on for this mailbox; if so, allow <country> or turn GeoIP off while Mail Manager connects." The server must be configured with its hosting country wherever it is deployed. The CLI names this computer's country; the server variant takes an optional region (hosting not decided: local now, later Vercel or a VPS).
- **Domain check (informational, never blocking):** the MX lookup distinguishes domain doesn't exist (typo/expired hint; stops the online lookups, picker/manual still offered) / DNS error at the domain / DNS unreachable — each explained in plain words (PROVIDERS.md). Missing MX records are not reported: IMAP doesn't depend on MX.
- Preset hosts verified live by `tests/integration/presets-live.test.ts` (TLS 993 + greeting, no login).
- `mm discover <email>` exit codes:

| Result                                    | TTY                                           | No TTY        |
| ----------------------------------------- | --------------------------------------------- | ------------- |
| found                                     | 0                                             | 0             |
| needs-host (per-mailbox host, e.g. Wedos) | host prompt → 0                               | 0 + host hint |
| blocked (e.g. Outlook until M6)           | 1                                             | 1             |
| nothing found                             | picker / manual → 0; Cancel → 1; Ctrl+C → 130 | 1             |
| domain doesn't exist                      | hint + picker / manual → 0; Cancel → 1        | 1             |
| invalid email                             | 1                                             | 1             |

### M1b-2a — IMAP session (implemented)

- `src/core/imap/session.ts` `openSession()`: imapflow 2.0.5 (exact pin), implicit TLS 993 + cert verify + TLS 1.2+, logger off, client ID name+version only, timeouts (connect 15 s, greeting 10 s, socket 5 min), **one attempt, no retry**, password dropped from the client after connect, CR/LF/NUL rejected before connecting. `ImapSession` exposes `features`, sanitised `capabilities`, `serverName`, `closed`/`lastErrorReason`, `logout()` (never throws).
- `src/core/imap/features.ts`: `ServerFeatures` (rev2 folding only when advertised **and** enabled), `sanitizeCapabilities` (bounded `CapabilityRecord` for `mail_accounts.capabilities`).
- `src/core/imap/errors.ts`: `ImapSessionError` (reason + whitelisted code, no server text) and `mapImapError`. `EAI_AGAIN`/`ENETUNREACH` are reported as "no internet" only after a connectivity check fails.
- Error messages (user decision 2026-09-22): one **generic** message for everything that could help probe accounts or hosts (wrong password/address, host not found, refused/reset/timeout, GeoIP, app password, password expired) — it includes the GeoIP and app-password hints and no code. Distinct messages: no internet, TLS certificate, OAuth-only, server unavailable/throttled, invalid input (`src/cli/imap-errors.ts`).
- `src/cli/bin.ts` (and `mm login`/`logout`/`whoami`) print only whitelisted core errors (`src/cli/error-text.ts`).
- Repo: UUID guard on ids, capabilities schema-checked.
- Measured Websupport capabilities in IMAP.md §7 (no SPECIAL-USE); provider restrictions in PROVIDERS.md.

### M1b-2b — Login guard (implemented)

- `src/core/security/login-guard.ts` `LoginGuard`: per (IP + mailbox) pair 2 failures → challenge, 5 in 15 min → 15 min lock, challenge for 24 h after a lock; per IP 3 lockouts in 24 h → 24 h block, 3 blocks in 30 days → permanent; per mailbox across IPs 10 in 15 min → challenge only. Only credential failures count. In-memory `AttemptStore` (async interface for the M6a store), per-pair serialisation.
- `src/core/imap/guarded-session.ts` `guardedOpenSession`: guard → challenge hook → `openSession` once → record; blocked → `LoginBlockedError` without contacting the server.
- `src/core/security/events.ts`: HMAC targets (HKDF from `MM_MASTER_KEY`), `SecurityEvent` + sinks, `mm-security {json}` line, fail2ban regex (IP-level blocks only). `ip.ts`: IP normalisation (IPv4-mapped, IPv6 /64).
- CLI texts (`src/cli/login-guard-text.ts`): end time with time zone + next step; permanent → "contact Mail Manager support"; `cliChallenge` = announced 5 s wait. Details: SECURITY.md "Login guard".

### M1b-3 — Test ground

- Test ground on **test@example-test-domain.eu** (Websupport): folder guard (`mm-test` only), deterministic synthetic mail (~150 messages / ~25 MB, nodemailer MailComposer), `npm run test:seed` / `test:unseed`.

### M1b-4 — Logging foundation

Decisions (2026-09-23): runs after M1b-3 and before M1c, so every command that manages mailboxes logs from day one; the cloud `audit_log` table is created here (moved from M4). Full design: [LOGGING.md](../LOGGING.md).

- **Goal:** every run leaves a readable, leak-free trace — local app and security logs, a cloud audit trail, and `mm logs` to read them.
- **Scope:**
  - `src/core/paths.ts` — neutral `configDir()` (moved out of `db/supabase/session-storage.ts`; the session storage uses it).
  - `src/core/log/` — typed event union + envelope (`ts`, `event`, fields, `level`, `run`, `v`), `EventLog` interface, `MemoryEventLog`, `FileEventLog` (sync append, dir 700 / files 600, one file per day and kind, 5 MB cap, startup pruning: app 30 days, security 90 days, 4 KB line cap, never throws), run context, zod schema for reading lines back. `SecurityEvent` joins the catalog; new fields only after `target` (fail2ban regex unchanged).
  - Security events: `auth.login`, `auth.login-failed` (reason + HMAC of the typed e-mail), `auth.logout`; `imap.login`, `imap.login-failed`, `login-guard.challenge`, `login-guard.block` (all guard events, incl. `too-many-attempts`) built and tested through `guardedOpenSession` with a fake opener — M1c wires them to the file.
  - CLI: run logger in `src/cli/bin.ts` + commander `preAction` hook → `command.start` (command path, option **names**) / `command.finish` (outcome, exit code, ms) for every command, also on direct `process.exit` and Ctrl+C (`interrupted`); `error.unexpected` (class, code, relative stack frames, no message). Events for today's commands: `login`/`logout`/`whoami`, `doctor` (`doctor.check`), `discover` (`discover.finish`: source + provider id, no domain), `keygen` (start/finish only).
  - `mm logs [--since] [--level] [--security] [--run] [--json]`, `mm logs path`, `mm logs clear` (confirm); plain-language text in `src/cli/log-text.ts`. `mm doctor` `logs` check. `MM_LOG_LEVEL` in `config.ts`.
  - Audit trail: new migration — generic `audit_log` ([DATA_MODEL.md](../DATA_MODEL.md#audit_log-m1b-4)), `AuditRepo` interface + Supabase implementation, `audit.write-failed` when a row can't be written. First rows are written by M1c.
  - **User:** Supabase dashboard → Authentication → Audit Logs: decide on "write audit logs to the database" and its retention (proposal: on, 90 days).
- **Out of scope:** account events (M1c), hosted log shipping, error tracking, alerting (M6a/M7), `security_events` table (M6a).
- **Acceptance:** every existing command leaves `command.start` + `command.finish` with the same `run`; a failed `mm login` writes `auth.login-failed` with a reason and no e-mail or password; `mm logs` shows readable lines and marks interrupted runs; canary test clean (no password, address, host, subject in any line); files 600, dir 700; daily files pruned by age; a write failure doesn't change the command's result; catalog ↔ LOGGING.md test and "every command logs start/finish" test pass; the fail2ban regex still matches `login-guard.block` lines; two-user RLS test on `audit_log` (select/insert own rows only, no update/delete); lint, typecheck, tests, build green.
- **Verification:**
  1. `MM_CONFIG_DIR=$(mktemp -d) mm discover <placeholder address>` → `mm logs` shows the run; `mm logs --json` lines parse with `jq`.
  2. `mm login` with a wrong password (external terminal, dashboard test user) → `mm logs --security` shows "Mail Manager login failed"; `grep` the log folder for the typed address → nothing.
  3. Ctrl+C during a `mm login` prompt → `mm logs` shows the run as interrupted.
  4. `ls -la` on the log folder → 700 / 600. `mm doctor` → `logs` OK.
  5. `npm run test:integration` with `MM_TEST_SUPABASE_*` → `audit_log` RLS suite passes.

## M1c — Account commands

- `mm account add [email]` — `discover` → `chooseImapSettings` (picker / manual, from M1b-1) → hints → hidden password → test login (on timeout/refused: GeoIP hint) → encrypt → save.
- `mm account list` · `test` · `remove` (confirm) · `update-password`.
- **Logging** ([LOGGING.md](../LOGGING.md)): `account.add` / `account.remove` / `account.password-update` → app log + `audit_log` row; `account.test` → app log; `guardedOpenSession` wired to the security log file (`imap.login`, `imap.login-failed`, `login-guard.*`). No address, host or password in any event.

## Out of scope (M1)

OAuth2 (M6), STARTTLS/143, any mailbox reading beyond login + capabilities, key rotation tooling, MFA, self-service signup / password reset.

## Open questions

- Microsoft users unsupported until M6 — confirmed: Outlook advertises `LOGINDISABLED` (XOAUTH2 only).
- Account removal: keep audit rows with `account_id` set null (M4 decision).

## Verification (M1a)

1. `npm run db:push` (second run: no changes) and `npm run db:status`.
2. `mm doctor` → `database` OK, `session` WARN before login.
3. `mm login` (dashboard user) → `mm whoami` → `mm doctor` session OK → `mm logout` → `mm whoami` exits 1.
4. `npm run test:integration` with `MM_TEST_SUPABASE_*` set → RLS suite passes.
