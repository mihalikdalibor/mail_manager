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
- `src/core/security/events.ts`: HMAC targets (HKDF from `MM_MASTER_KEY`), block events (since M1b-4b through `EventLog` as `login-guard.block`), `mm-security {json}` line, fail2ban regex (IP-level blocks only). `ip.ts`: IP normalisation (IPv4-mapped, IPv6 /64).
- CLI texts (`src/cli/login-guard-text.ts`): end time with time zone + next step; permanent → "contact Mail Manager support"; `cliChallenge` = announced 5 s wait. Details: SECURITY.md "Login guard".

### M1b-3 — Test ground

- Test ground on **test@example-test-domain.eu** (Websupport): folder guard (`mm-test` only), deterministic synthetic mail (150 messages / ~26.7 MiB, nodemailer MailComposer), `npm run test:seed` / `test:unseed`.
- Decisions (2026-09-24): seed appends only missing messages and refuses when `mm-test` holds foreign, duplicate, older-version or changed mail (it never deletes messages); `test:unseed` deletes the whole `mm-test` folder (IMAP `DELETE`, no `EXPUNGE`); the integration test runs seed itself (the first run uploads ~27 MiB, later runs nothing); `mm-test` stays seeded for M3–M5. Split into **M1b-3a** (generator, offline) → **M1b-3b** (guard, seed/unseed, live test). Code in `tests/support/test-ground/` (test tooling, no `src/` changes).

#### M1b-3a — Synthetic mail generator (implemented)

- `prng.ts`: mulberry32 (`createPrng(seed)`) and `subPrng(seed, index)`, an independent stream per message so one message's content never shifts another's.
- Two phases in `generator.ts`: **A** plans every message's spec from one stream (size class, year/day/time, date offset, flags, sender, subject, attachment names); **B** composes each message from its own sub-stream (body sentences, attachment content) and adjusts a text filler (compose → measure → adjust, ≤ 4 passes) to hit the size target.
- Size classes with fixed, evenly spaced targets (total ≈ 26.7 MiB, a design constant): tiny 1 (1,030 B), small 101 (1.5–30 KiB; 31 with a `.txt`/`.csv`), medium 38 (40–400 KiB; 1 `.bin`, the 4 largest 2), large 8 (0.8–1.5 MiB), huge 2 (3.2 MiB and 4,850,000 B; 2 attachments each). Every message 1,024–4,900,000 bytes, so both "1 KB–5 MB" readings (decimal and binary) hold.
- Dates: internal dates 2019-01-01 … 2026-06-30 UTC, whole seconds, ≥ 18 per year; messages 25, 50 … 150 have a Date header 1–3 days earlier (M3's sent vs received date).
- Flags 50 none / 60 `\Seen` / 20 `\Flagged` / 20 both; senders on reserved domains only (12 × `spam.test`, 4 × look-alike `spam.test.evil.test`); recipient `mm-test@mm-test.invalid`.
- Identity: `X-MM-Test-Seed: v<N>-<NNN>` + `Message-ID: <v<N>-<NNN>@mm-test.invalid>`; `manifest.ts` holds per-message facts (seed id, Message-ID, sender/domain, subject, sent + internal date, exact size, flags, attachments) and totals.
- nodemailer options that make it deterministic and offline: fixed `baseBoundary`, `messageId`, `date` as a `Date` object (a string is copied verbatim into the header), `newline: '\r\n'`, `normalizeHeaderKey` (nodemailer would write `X-Mm-Test-Seed`), `textEncoding: 'Q'`, `disableUrlAccess` + `disableFileAccess`. Attachment names come out as RFC 2231 `filename*0*=utf-8''…`.
- `groundDigest` = sha256 over sha256(raw) + sha256(canonical facts) per message; pinned per `SEED_VERSION` in the unit test (see `docs/TESTING.md` for the bump rule).

#### Verification (M1b-3a)

1. `npm test` — `tests/unit/test-ground-generator.test.ts` passes (determinism, pinned digest, ranges, headers ↔ facts, no network).
2. `TZ=Pacific/Kiritimati npx vitest run tests/unit/test-ground-generator.test.ts` — same digest in another time zone.
3. `npm ls nodemailer` — exactly 10.0.10, devDependency, no children; `grep -rn nodemailer src/` finds nothing (an ESLint `no-restricted-imports` rule in `eslint.config.js` blocks it under `src/`).

#### M1b-3b — Folder guard, seed/unseed, live test (implemented)

- **Guard** (`folder.ts`): `TestFolder` resolves `<personal namespace prefix>mm-test` once; every operation (`exists`, `create`, `remove`, `messageCount`, `open`) compares the path with `===` as its first statement and throws `FolderGuardError` otherwise — no IMAP call happens first. An opened folder checks, before each fetch/append/flag change, that it isn't released and that the selected folder is still `mm-test`; a second `open()` is refused (imapflow's lock would wait forever).
- **Adapter:** the only IMAP surface is a small `FolderClient` interface, implemented over imapflow (`imapFolderClient`) and faked in unit tests. It exists because imapflow reports some failures as falsy results instead of errors (`mailboxCreate`/`mailboxDelete` → `undefined` on a dropped connection, `status`/`append`/`messageFlagsSet`/`mailboxUnsubscribe` → `false`); the adapter turns each into an error. `TestFolder.fromSession` narrows `session.client` with `instanceof ImapFlow` — no `src/` change. No expunge, CLOSE, move or rename exists in the tooling.
- **Remove** refuses while `mm-test` is selected: imapflow would send `CLOSE` first, which expunges `\Deleted` messages. Unseed runs in a fresh session: `DELETE` → best-effort unsubscribe (CREATE auto-subscribes; a server may decline for a deleted folder, which must not block unseed) → check it's gone.
- **Seed** (`seed.ts`): classify by the `X-MM-Test-Seed` header → refuse with counts (foreign, duplicate, older version, changed = size or internal date differs) **before any write** → reset differing system flags (keywords the server adds, e.g. Dovecot's `$HasAttachment`, are ignored and kept) → APPEND the missing messages with flags and internal date while `mm-test` is selected (its PERMANENTFLAGS apply) → verify count/size/date/flags (a cached count of 0 is refreshed with `NOOP` first — right after the APPENDs it can be stale). Websupport's PERMANENTFLAGS weren't measured; verify is the safety net.
- **Scripts** (`cli.ts`): one login per run via `guardedOpenSession` (in-memory guard, random target key), logout in `finally`, counts-only output, fixed error texts (login → the app's generic message; OVERQUOTA → "the test mailbox is full"; other → `Unexpected error (<allowlisted name>)`), unhandled errors routed the same way, flush + exit like `src/cli/bin.ts`.
- **Env** (`live-env.ts`): shared with `imap-session.test.ts`; the password is used raw (never trimmed); address and password are hidden from `inspect`/JSON.

#### Verification (M1b-3b)

Live commands are real logins — each once, in this order, never in a loop:

1. Offline: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`; `MM_TEST_IMAP_USER= npm run test:seed` → the missing-env text, exit 1, no login.
2. `npm run test:seed` → `created: yes, appended 150`.
3. `npm run test:integration` → all suites pass (test ground: second seed appends 0; server = manifest; guard refusals).
4. `npm run test:unseed` → `deleted (150 messages)`; again → `nothing to delete`.
5. `npm run test:seed` → appended 150; again → appended 0, flags reset 0.
6. `npx tsx tests/support/test-ground/leak-check.ts …` over the saved outputs → all `clean`.

### M1b-4 — Logging foundation

Decisions (2026-09-23): runs after M1b-3 and before M1c, so every command that manages mailboxes logs from day one; the cloud `audit_log` table is created here (moved from M4). Full design: [LOGGING.md](../LOGGING.md).

Split on 2026-09-28 into **M1b-4a** log core + run logging → **4b** domain and security events → **4c** `mm logs` → **4d** audit trail (each its own assignment; M1c needs 4a, 4b, 4d — see `TODO.md`). Decided the same day: no `MM_LOG_LEVEL=off` (security lines are always written).

- **Goal:** every run leaves a readable, leak-free trace — local app and security logs, a cloud audit trail, and `mm logs` to read them.
- **Scope:**
  - `src/core/paths.ts` — neutral `configDir()` (moved out of `db/supabase/session-storage.ts`; the session storage uses it).
  - `src/core/log/` — typed event union + envelope (`ts`, `event`, fields, `level`, `run`, `v`), `EventLog` interface, `MemoryEventLog`, `FileEventLog` (sync append, dir 700 / files 600, one file per UTC day and kind, 5 MB cap (security 150 MB since 4b), startup pruning: app 30 days, security 90 days, 4 KB line cap, never throws), run context, zod schema for reading lines back. `login-guard.block` (formerly `SecurityEvent`) joins the catalog in 4b; new fields only after `target` (fail2ban regex unchanged).
  - Security events: `auth.login`, `auth.login-failed` (reason + HMAC of the typed e-mail), `auth.logout`; `imap.login`, `imap.login-failed`, `login-guard.challenge`, `login-guard.block` (all guard events, incl. `too-many-attempts`) built and tested through `guardedOpenSession` with a fake opener — M1c wires them to the file.
  - CLI: run logger in `src/cli/bin.ts` + commander `preAction` hook → `command.start` (command path, option **names**) / `command.finish` (outcome, exit code, ms) for every command, also on direct `process.exit` and Ctrl+C (`interrupted`); `error.unexpected` (class, code, relative stack frames, no message). Events for today's commands: `login`/`logout`/`whoami`, `doctor` (`doctor.check`), `discover` (`discover.finish`: source + provider id, no domain), `keygen` (start/finish only).
  - `mm logs [--since] [--level] [--security] [--run] [--json]`, `mm logs path`, `mm logs clear` (confirm); plain-language text in `src/cli/log-text.ts`. `mm doctor` `logs` check. `MM_LOG_LEVEL` in `config.ts`.
  - Audit trail: new migration — generic `audit_log` ([DATA_MODEL.md](../DATA_MODEL.md#audit_log-m1b-4d-migration-20260929063314_audit_logsql)), `AuditRepo` interface + Supabase implementation, `audit.write-failed` when a row can't be written. First rows are written by M1c.
  - **User:** Supabase dashboard → Authentication → Audit Logs: "write audit logs to the database" — decided 2026-09-29: on, 90 days (cleanup job later).
- **Out of scope:** account events (M1c), hosted log shipping, error tracking, alerting (M6a/M7), `security_events` table (M6a).
- **Acceptance:** every existing command leaves `command.start` + `command.finish` with the same `run`; a failed `mm login` writes `auth.login-failed` with a reason and no e-mail or password; `mm logs` shows readable lines and marks interrupted runs; canary test clean (no password, address, host, subject in any line); files 600, dir 700; daily files pruned by age; a write failure doesn't change the command's result; catalog ↔ LOGGING.md test and "every command logs start/finish" test pass; the fail2ban regex still matches `login-guard.block` lines; two-user RLS test on `audit_log` (select/insert own rows only, no update/delete); lint, typecheck, tests, build green.
- **Verification:**
  1. `MM_CONFIG_DIR=$(mktemp -d) mm discover <placeholder address>` → `mm logs` shows the run; `mm logs --json` lines parse with `jq`.
  2. `mm login` with a wrong password (external terminal, dashboard test user) → `mm logs --security` shows "Mail Manager login failed: invalid credentials"; `grep` the log folder for the typed address → nothing.
  3. Ctrl+C during a `mm login` prompt → `mm logs` shows the run as "interrupted after …" (a run killed without a finish line: "interrupted or still running").
  4. `ls -la` on the log folder → 700 / 600. `mm doctor` → `logs` OK.
  5. `npm run test:integration` with `MM_TEST_SUPABASE_*` → `audit_log` RLS suite passes.

#### M1b-4a — Log core + run logging (implemented)

- **Paths** (`src/core/paths.ts`): `configDir(env)` (moved from `sessionDir`; session storage and the CLI use it) and `logDir(env)` = `<config dir>/logs`.
- **Log core** (`src/core/log/`): typed event union (`events.ts`: `command.start`, `command.finish`, `error.unexpected`, `log.truncated`; kind and level per event), records with a fixed key order (`record.ts`: `ts`, `event`, fields, `level`, `run`, `v`), capped/allowlisted builders (`builders.ts`), `EventLog` + `NullEventLog` + `MemoryEventLog` + `safeEmit` (`event-log.ts`), `FileEventLog` (`file-event-log.ts`), `parseLogLine` for reading back (`schema.ts`), the doctor check (`health.ts`). `MM_LOG_LEVEL` in `config.ts` (`validateLogLevel`, `logLevel`).
- **`FileEventLog`:** lazy (no folder until the first write; created one level at a time — Node's recursive `mkdir` hangs under `/proc`), dir 700 / files 600 (re-applied, also for an own 400 file; symlinks never followed — `O_NOFOLLOW` + `lstat`, the folder re-checked on every write; hard-linked or foreign-owned day files refused; the file name's date must be a real `YYYY-MM-DD`), one `O_APPEND` write per line, one file per UTC day and kind, 4 KB line cap, 5 MB file cap (debug dropped from 80 %, then one `log.truncated`), pruning on the first write (app > 30 days, security > 90 days by the name date), never throws (`failures`/`dropped` counters).
- **`error.unexpected`:** class (allowlisted name), code (`^[A-Z0-9_]{1,40}$` only), up to 10 frames. The header is cut by exact prefix (`Name: message`), so a message line that looks like a frame can't slip through; frames stop at the first non-frame line (e.g. an appended `Caused by: …`); Node's `Name [CODE]: message` header is recognised; function names are kept only for frames in our own code or `node:` internals and only in the shapes V8 prints (else `<fn>` — an overwritten `stack` could put data there), eval frames → `eval`, paths inside the package → relative (`..` escapes → `<external>`), anything else → `<external>`; printable ASCII only; never the message.
- **CLI** (`src/cli/run.ts`, `bin.ts`): `createRunLog` loads the env files first (so `MM_CONFIG_DIR`/`MM_LOG_LEVEL` from `.env.local` apply), builds the run context (16-hex run id) and the file log (any failure → no logging). `runCli` passes an `onCommandStart` to `buildProgram`, whose root `preAction` hook reports the command path and the **names** of options given on the command line; `command.finish` after the command, from the `exit` handler (direct `process.exit`) and the SIGINT handler (`interrupted`, exit 130); inquirer Ctrl+C (exit 130) is `interrupted` too. Uncaught exceptions/rejections print "Unexpected error" and log `error.unexpected`. `reportError` (`src/cli/report-error.ts`) is used by `runCli`, `auth` and `discover`: same text as before, plus `error.unexpected` for non-user-facing errors. `--help`, `--version`, parse errors: no lines.
- **Doctor:** `logs` check (last) — folder can't be created/written or today's file not writable (or not a regular file) → warn "logs are not being written"; a missing folder at `MM_LOG_LEVEL=warn|error` is OK ("no logs yet") — since 4b only if it could be created (see the 4b section); wrong modes → warn; invalid `MM_LOG_LEVEL` → warn; otherwise `N files, X KB, oldest <date>`. Never shows the path.

#### Verification (M1b-4a)

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`.
2. `D=$(mktemp -d); MM_CONFIG_DIR=$D npm run dev -- keygen` → `$D/logs` 700, `app-<UTC date>.log` 600 with `command.start` + `command.finish`, one `run`.
3. `MM_CONFIG_DIR=$(mktemp -d) npm run dev -- --help` (also `--version`, `nosuchcmd`) → no `logs` folder.
4. `MM_CONFIG_DIR=<a regular file> npm run dev -- keygen` → key printed, exit 0.
5. `MM_CONFIG_DIR=$D npm run dev -- doctor` → `logs` OK; with `MM_LOG_LEVEL=verbose` → WARN.
6. Interactive (external terminal): `MM_CONFIG_DIR=$D mm login` → Ctrl+C at the prompt → last line `outcome: "interrupted"`.

#### Logging (M1b-4a)

`command.start`, `command.finish`, `error.unexpected`, `log.truncated` (app log). Canary tests: no password, address, host, subject, option value or home path in any line.

#### M1b-4b — Domain + security events (implemented)

- **Catalog** (`src/core/log/events.ts`): `doctor.check`, `discover.finish` (app); `auth.login`, `auth.login-failed`, `auth.logout`, `imap.login`, `imap.login-failed`, `login-guard.challenge`, `login-guard.block` (security → `security-<UTC date>.log`, `mm-security` prefix). Builders in `src/core/log/domain-events.ts` and `guard-events.ts` allowlist every field (preset ids, UUIDs, IP buckets, 64-hex targets, ISO times); shared helpers `cleanProvider` / `uuidOrUndefined` in `builders.ts`.
- **CLI:** `mm doctor` → one `doctor.check` per check (name + status); `mm discover` → one `discover.finish` (outcome, source, preset id, domain problem, picker choice — never the address/domain/host; `invalid` for bad input; nothing on Ctrl+C); `mm login` → `auth.login` (user id) or one `auth.login-failed` (reason + target) only after a password was submitted; `mm logout` → `auth.logout`.
- **Typed e-mail target** (`authEmailTarget`, `src/core/security/events.ts`): HMAC with its own key (`authTargetKey`, HKDF info `mm-auth-target-v1`) of the normalised address, or `invalid` when the input isn't an address — a password typed into the e-mail field is never hashed (decided 2026-09-29). Random key per run without a valid `MM_MASTER_KEY`.
- **Guard:** `LoginGuard` takes `log?: EventLog` (the `SecurityEventSink`/`LineEventSink`/`formatEventLine` are gone), exposes `identify(attempt)` (IP bucket + HMAC target) and puts `attempts` on the challenge decision. `guardedOpenSession` takes `provider` (required), `acct?`, `log?` and emits `login-guard.challenge` before the challenge, `imap.login-failed` (`blocked` without contacting the server; counted/uncounted; `unexpected`) before the guard records a failure, and `imap.login` after success; login behaviour is unchanged. M1c passes a file log.
- **Caps / follow-ups:** security files have their own 150 MB cap (app 5 MB); pruning runs on the first event even when nothing passes the level; at `MM_LOG_LEVEL=warn|error` doctor says "no logs yet" only when the log folder could be created (nearest existing ancestor is a writable directory), and checks today's security file too.

#### Verification (M1b-4b)

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`; `grep -rn "SecurityEventSink\|MemoryEventSink\|LineEventSink\|formatEventLine" src tests` → nothing.
2. `D=$(mktemp -d); MM_CONFIG_DIR=$D npm run dev -- logout` → `security-<date>.log` (600) with `auth.logout`; `discover not-an-email` → `discover.finish` `invalid`.
3. `MM_CONFIG_DIR=<a regular file> MM_LOG_LEVEL=warn npm run dev -- doctor` → `logs` WARN (doctor contacts Supabase).
4. Interactive (external terminal): `mm login` with a wrong password → `auth.login-failed` with a 64-hex target; the password typed into the e-mail prompt → `target: "invalid"`; grep the log folder for the typed address → nothing.

#### Logging (M1b-4b)

`doctor.check`, `discover.finish`, `auth.login`, `auth.login-failed`, `auth.logout`, `imap.login`, `imap.login-failed`, `login-guard.challenge`, `login-guard.block`. Canary tests cover every builder.

#### M1b-4c — `mm logs` (implemented)

- **Shared schemas** (`src/core/log/event-schemas.ts`): the allowlists and field shapes the builders clean to (statuses, outcomes, reasons, block kinds, audit actions, `PROVIDER_RE`, `UUID_RE`, `IP_BUCKET_RE`, `ADDR_RE`, `ISO_RE`, `TARGET_RE`, cmd/option/version/os/frame rules) are defined once; `builders.ts`, `domain-events.ts`, `guard-events.ts` import them. Output is unchanged except where a builder could write a line the reader rejects: a non-string doctor check → `other`, `exit`/`ms` safe integers only, `until` a real instant (else null), a stack frame's `node:` location only as a real module path (else `<external>`). `validateRecord(line, fileKind, fileDate)` checks a parsed line against its event's strict schema: exact fields and types, the writer's `ts` format on the file's UTC day, the level the writer derives, the file's kind (`log.truncated` fits both), `command.finish` outcome ↔ exit, `until` a real instant; returns the record in canonical key order, or `unreadable` / `unknown` (other `v`, or an event this version doesn't know). Never throws.
- **Day files** (`src/core/log/files.ts`): `listDayFiles` (folder status `ok`/`missing`/`not-a-folder`/`unreadable`, names with a real date), `regularDayFiles` and `deleteDayFiles` for `clear` (lstat before counting and again before each unlink; the folder's dev/ino re-checked before each unlink, so a folder swapped during the prompt stops the delete).
- **Reader** (`src/core/log/reader.ts`, `readLogs`): day files in the window by name date (all retained files for `--run` without `--since`); only regular files (`lstat`, then `O_NOFOLLOW | O_NONBLOCK` + `fstat` — no symlink, no FIFO hang); 64 KB chunks split on `\n` by bytes, lines over the cap dropped while streaming and counted once, fatal UTF-8 decoding, CRLF tolerated; one UTC day at a time (app + security merged by time), newest 5,000 kept together with the interrupted markers (`omitted`); files over 151 MB skipped unread; at most 100,000 runs tracked, only from start/finish lines (`runsCapped`); only read errors count a file as skipped; `parseLogLine` rejects an own `__proto__` key and leaves any other `v` to `validateRecord` (unknown). Run info (cmd, started, finished, last time, truncated day) from every valid record before filtering; the reading run is excluded everywhere; interrupted = started, no finish, last line in the window, not `--security`, level ≤ warn, day not truncated.
- **CLI:** `mm logs [--since] [--level] [--security] [--run] [--json]` (`src/cli/commands/logs.ts`, zod-validated, no commander defaults), `mm logs path`, `mm logs clear [--yes]`; text in `src/cli/log-text.ts` (`sanitize`, `eventText` for all 14 events, `timelineLine`, `formatReport` with date headers, interrupted lines and footers; the time zone is injectable for tests). `--json` prints sanitized canonical records, footers on stderr. EPIPE on stdout or stderr (`mm logs | head`, `mm logs --json 2>&1 | head`) ends quietly with exit 0. A log folder that is a symlink, a file or unreadable → a plain message, exit 1. `CliContext.run` / `BuildOptions.run` carry the run id so the reader can leave its own run out.
- **Known commander behaviour:** `mm logs foo` / `mm logs help` → "too many arguments for 'logs'" (exit 1; use `mm help logs`); `logs` options given with `path`/`clear` are refused.

#### Verification (M1b-4c)

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`.
2. `D=$(mktemp -d); export MM_CONFIG_DIR=$D; npm run dev -- keygen; npm run dev -- discover not-an-email; npm run dev -- logout` → `npm run dev -- logs` lists the three runs (not its own); `--security` shows the logout; `--json` lines parse.
3. Append `printf '\x1b]0;pwn\x07{"ts":"x"}\n'` to today's app file → `mm logs` prints no escape and "1 unreadable line skipped".
4. `mm logs | head -1` → exit 0, no "Unexpected error".
5. `mm logs clear </dev/null` → refused (exit 1); `mm logs clear --since 7d --yes` → refused; `mm logs clear --yes` → "Deleted N log files.".
6. A run whose finish line was removed by hand → "interrupted or still running"; Ctrl+C in `mm login` (a terminal) → "interrupted after …".

#### Logging (M1b-4c)

No new events: `mm logs`, `mm logs path` and `mm logs clear` log `command.start` / `command.finish` like every command (the "every command" test now also covers commands with their own action and subcommands).

#### M1b-4d — Audit trail (implemented)

- **Migration** `supabase/migrations/20260929063314_audit_log.sql` (applied 2026-09-29 with the user's go-ahead): `audit_log` per [DATA_MODEL.md](../DATA_MODEL.md#audit_log-m1b-4d-migration-20260929063314_audit_logsql) — checks on every column, RLS select/insert own rows (insert also requires an own `account_id`), column-level insert grant (no `id`/`user_id`/`created_at`), identity-sequence grants revoked, no UPDATE/TRUNCATE for `service_role`. Verified offline on Postgres (PGlite, Supabase-like roles; 23 checks) and live.
- **Core:** `AUDIT_ACTIONS`, `AuditEntry`/`AuditRecord`/`AuditRepo` (`src/core/db/repos.ts`); `auditEntrySchema` + `recordAudit` (`src/core/audit.ts`: validates first → `invalid`, never throws, `audit.write-failed` with a typed reason); `SupabaseAuditRepo` (`src/core/db/supabase/audit-repo.ts`: fixed error messages, `listRecent` skips + counts untrusted rows); `createSupabaseServices(...).audit`. Nothing writes rows yet — M1c's account commands will.
- **Doctor:** the `database` check probes `mail_accounts` then `audit_log` (missing → "run `npm run db:push`"; a network failure skips the second probe).
- **User decisions (2026-09-29):** Supabase Auth → Audit Logs → "write audit logs to the database" **on**, 90 days (cleanup job later); live RLS test rows stay (append-only); database setup to be automated later so users don't get stuck on a missing table.
- **M1c trap:** write `account.remove`'s row before deleting the account (the insert policy refuses a deleted account's id), or with `account_id` null.

#### Verification (M1b-4d)

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`.
2. `npm run db:status` → `20260929063314` local = remote.
3. `npx vitest run --config vitest.integration.config.ts tests/integration/supabase-rls.test.ts` → 13 passed (5 `mail_accounts` + 8 `audit_log`), once.
4. `npm run dev -- doctor` → `database  mail_accounts and audit_log present, anon blocked`.

#### Logging (M1b-4d)

`audit.write-failed` (app log, error): `action`, `reason` (`forbidden`/`unavailable`/`conflict`/`not-found`/`unknown`/`invalid`) — no row values.

## M1c — Account commands

Split on 2026-09-30 into **M1c-1** (all account commands) → **M1c-2** (hardening follow-ups, see `TODO.md`).

- `mm account add [email]` — `discover` → `chooseImapSettings` (picker / manual, from M1b-1) → hints → hidden password → test login (on timeout/refused: GeoIP hint) → encrypt → save.
- `mm account list` · `test` · `remove` (confirm) · `update-password`.
- **Logging** ([LOGGING.md](../LOGGING.md)): `account.add` / `account.remove` / `account.password-update` → app log + `audit_log` row; `account.test` → app log; `guardedOpenSession` wired to the security log file (`imap.login`, `imap.login-failed`, `login-guard.*`) — pass the **same** file log to `new LoginGuard({ log })` and `guardedOpenSession({ log })`, or the guard's `login-guard.block` lines are lost. No address, host or password in any event.

### M1c-1 — Account commands (implemented)

- **Core** (`src/core/accounts.ts`, prompt-free): `addAccount` (duplicate check → guarded login → encrypt → save → capabilities, best effort → audit), `testAccount` (decrypt → login → capabilities), `updatePassword` (login with the new password first, then save), `removeAccount` (no key needed), `assertNotDuplicate`, `parseAccountRef` / `resolveAccountRef` (UUID prefix ≥ 4 chars), `settingsOf` (refuses port ≠ 993 / OAuth rows), `createLocalGuard` (one in-memory guard per command), `accountFailureReason`, `AccountError` (`duplicate` / `not-found` / `secret-unreadable` / `unsupported`).
- **AAD v2** (decided 2026-10-01): the secret is bound to user, account id, host, port and username — a server swapped in the database can't decrypt, so the password is never sent there ([SECURITY.md](../SECURITY.md#credential-encryption)); `update-password` refuses such a row before the prompt (recovery: `remove` + `add`). `addAccount` lowercases the host once (login, binding and saved row) and the repo lowercases it again on insert.
- **CLI** (`src/cli/commands/account.ts`, texts in `src/cli/account-text.ts`, shared discovery printing in `src/cli/discovery-text.ts`): checks run cheapest first — terminal → id format → `MM_MASTER_KEY` → login → network. `add` confirms found settings ("Use these settings?" → else picker), refuses blocked providers, checks duplicates before the password, and offers "Try another password?" only after a rejected password (the guard locks at the 5th failure; network failures end the run). `update-password` shows the mailbox, server and username before the prompt. Every stored string (ids included) is sanitized before printing. `mm --help` ends with a "Getting started" list.
- **Audit** (decided 2026-10-01): every `account.add` attempt writes a row (failed: `account_id` null + reason); password-update on success; remove after the delete with `account_id` null.

#### Verification (M1c-1)

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`.
2. `D=$(mktemp -d); MM_CONFIG_DIR=$D npm run dev -- account add x@example.com </dev/null` → "needs a terminal"; `account test` → "Which mailbox?"; `account remove zz` → invalid id; `account list` → "Not logged in"; `mm --help` → "Getting started".
3. `npx vitest run --config vitest.integration.config.ts tests/integration/accounts-live.test.ts` (once) → 3 passed; the RLS suite → 13 passed.
4. Interactive (external terminal, logged in): `mm account add <test mailbox>` → confirm → password → "Added … (id …)"; `mm account list`, `test`, `update-password`, `remove`; `mm logs --since 30m` shows `account.*` and `imap.login` lines without address or host.

#### Logging (M1c-1)

`account.add`, `account.test`, `account.password-update`, `account.remove` (app log; `acct`, `provider`, `outcome`, `reason` on failure) — catalog table "Account commands (M1c-1)". `imap.login`, `imap.login-failed`, `login-guard.*` now reach `security-*.log`. `mm account add` emits `account.add`, not `discover.finish`. Canary tests cover the new builder and the account core (no password, address or host in any line or audit row).

### M1c-2 — Hardening follow-ups (implemented)

- **Database** (migration `20261001150806_hardening.sql`, [DATA_MODEL.md](../DATA_MODEL.md)): `mail_accounts` host lowercased + named checks (host lowercase, length limits, provider format), column-level INSERT (no `created_at`/`updated_at`/`capabilities`/`last_checked_at` from the client), UPDATE revoked on `email`/`host`/`port`/`username` (changing the server = remove + add); `audit_log` checks (`folder` without `@`, `details` a JSON object) and `service_role` loses DELETE. `SupabaseAuditRepo.listRecent` breaks `created_at` ties by `id desc`.
- **Run/exit:** `runCli` takes `streams` (stdout/stderr) and handles their 'error' once: EPIPE / `ERR_STREAM_DESTROYED` ignored, anything else exits 1 quietly — `mm keygen | true` is no crash. `withDeadline` documents that the deadline only stops waiting.
- **`mm login`** with a stored session refuses ("You're already logged in — run `mm logout` first, then `mm login`.", exit 1, nothing sent), so the old session goes through `mm logout` first (which revokes its refresh token on the server when the server can be reached — offline it only clears the local file, and the token then lives until it expires; follow-up).
- **`mm logs`:** `--json` caps records only; the "older lines" hint drops flags already given; "No matching log lines" when a filter is active; `log.truncated` takes the triggering record's `ts`; the command column fits the longest command.
- **Accounts:** DNS SRV results outside the email's domain (and not a preset host) get a warning and "Use these settings?" defaults to no; `parseEmail` also limits the punycode address to 254; `update-password` refusing an unreadable secret logs `account.password-update` failed (`secret-unreadable`) from core (`assertSecretReadable`); the duplicate text mentions remove + add; audit rows of an existing account carry `details.account` (UUID).

#### Verification (M1c-2)

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`.
2. Offline CLI: `bash -c 'mm keygen | true; echo "exit ${PIPESTATUS[0]}"'` → exit 0, no "Unexpected error"; with a non-empty `session.json`, `mm login` → "already logged in", exit 1; `mm logs --since 5m --level error` → "No matching log lines …".
3. `npm run db:push` + `npm run db:status` (after the user's go-ahead), then the RLS suite once and `accounts-live.test.ts` once.

#### Logging (M1c-2)

No new events. `account.password-update` failed (`secret-unreadable`) is now emitted from core for the `update-password` refusal; `details.account` added to account audit rows ([LOGGING.md](../LOGGING.md#account-commands-m1c-1)).

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
