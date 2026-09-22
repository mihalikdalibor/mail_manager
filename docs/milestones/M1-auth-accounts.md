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
- CLI: `mm login [--email]` (hidden prompt — nothing echoed, TTY required, empty email refused, Ctrl+C → exit 130), `mm logout` (always clears the local session, even offline or with a broken config), `mm whoami` (reports "Supabase unreachable" instead of "not logged in" on network failures).
- `mm doctor`: now 7 checks — adds `database` (table present and anon blocked with 42501; missing → "run `npm run db:push`"; anon readable → FAIL), `signup` (public signups disabled → OK; enabled → FAIL) and `session` (logged in → OK, else WARN; "Supabase unreachable" on network failure). The session check may refresh and rewrite the session file.
- Supabase client: per-request timeout (10 s default, 5 s in doctor) via a `fetch` wrapper; PostgREST retries disabled (fail fast).
- Node floor raised to 22.13 (`@inquirer/prompts` requirement).
- Integration test `tests/integration/supabase-rls.test.ts` (skips without `MM_TEST_SUPABASE_*`): owner CRUD, cross-user read/write blocked, cross-user insert forbidden, `id`/`user_id` immutable, anon denied with 42501, ciphertext only.

## M1b — IMAP foundation, providers & test ground

Split on 2026-09-22 into **M1b-1** discovery → **M1b-2** IMAP session → **M1b-3** test ground.

### M1b-1 — Provider discovery (implemented)

Three tiers (user decision 2026-09-22):

1. **Autodetect** (`src/core/providers/discover.ts`): preset by email domain → preset by **MX suffix** (e.g. `mx10.websupport.sk` → Websupport → `imap.m1.websupport.sk`) → Mozilla ISPDB → HTTPS autoconfig (`autoconfig.<domain>`, then `<domain>/.well-known/autoconfig`) → DNS SRV `_imaps._tcp`. Sequential, stops at the first hit. Only implicit TLS on 993 is accepted.
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

### M1b-2 — IMAP session (next)

- `imap/session.ts`: imapflow connect (993, cert verify, timeouts), post-auth capabilities → `ServerFeatures`, error mapping incl. Outlook's `LOGINDISABLED` / XOAUTH2-only, GeoIP hint on timeout/refused.
- Provider restrictions analysis in `docs/PROVIDERS.md`.

### M1b-3 — Test ground

- Test ground on **test@example-test-domain.eu** (Websupport): folder guard (`mm-test` only), deterministic synthetic mail (~150 messages / ~25 MB, nodemailer MailComposer), `npm run test:seed` / `test:unseed`.

## M1c — Account commands

- `mm account add [email]` — `discover` → `chooseImapSettings` (picker / manual, from M1b-1) → hints → hidden password → test login (on timeout/refused: GeoIP hint) → encrypt → save.
- `mm account list` · `test` · `remove` (confirm) · `update-password`.

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
