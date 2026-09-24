# TODO

Source of truth for progress. One milestone at a time — details, design notes and open questions live in `docs/milestones/`.

**Current milestone: M1b-3 Test ground (not started)**, then **M1b-4 Logging foundation** (added 2026-09-23), then M1c — M0 done 2026-09-21 (C-001); M1a done 2026-09-22 (C-002, C-003); M1b-1 done 2026-09-22 (C-004…C-008, reviewed); M1b-2a done 2026-09-22 (C-009, C-010, reviewed); `mm logout` fix (C-011, reviewed); M1b-2b done 2026-09-23 (C-012, reviewed)

---

## Fixes (do first, before M1b-2b) ✅

- [x] **`mm logout` without a session** (user, 2026-09-22): today it always prints "Logged out" (`src/cli/commands/auth.ts`), even when nobody is logged in. Check the local session first: no session (or an unreadable/corrupt one) → print "Not logged in" and exit 0 without contacting Supabase; logged in → revoke + delete as now, "Logged out". Broken config: still delete any local session file; say "Logged out" only if one existed. Unit tests for all three cases in `tests/unit/cli-auth.test.ts`.

## Step 0 — Planning & docs ✅

- [x] Folder structure, git init
- [x] README, CLAUDE.md, TODO.md, .gitignore, .env.example
- [x] Section docs (architecture, data model, security, providers, testing, deployment)
- [x] Milestone docs M0–M6
- [ ] User review of docs + resolve "Open questions" marked for M0/M1

## M0 — Scaffold & tooling ✅ → [doc](docs/milestones/M0-scaffold.md)

- [x] `package.json` (ESM, engines node>=22.12, `bin.mm` → `dist/cli/bin.js`), lockfile. Pin **TypeScript 6.0.x** (typescript-eslint supports <6.1; TS 7 is incompatible)
- [x] `tsconfig.json` strict (NodeNext, noUncheckedIndexedAccess, exactOptionalPropertyTypes, explicit `types: ["node"]`) + `tsconfig.build.json` (src only → dist)
- [x] eslint (flat config, typescript-eslint) + prettier config
- [x] vitest config (unit by default; `test:integration` runs `tests/integration`, passes with no tests)
- [x] `src/core/config.ts` zod env loader: reads `.env.local` then `.env` from the project root (real env wins), vars `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, optional `MM_MASTER_KEY` (+ `MM_MASTER_KEY_VERSION`); errors name the variable, never print values; dotenv silenced
- [x] `src/core/master-key.ts` generate + validate (32 bytes after base64 decode)
- [x] `src/cli/index.ts` commander skeleton (`--help`, `--version`)
- [x] `mm keygen` — prints a new `MM_MASTER_KEY` value
- [x] `mm doctor` — checks Node version, env present/valid, master key (warn if missing, fail if malformed), Supabase reachable via `GET /auth/v1/health` with the publishable key (timeout); never prints secrets; non-zero exit on failure
- [x] npm scripts: dev, build, start, test, test:integration, lint, format, format:check, typecheck
- [x] Secret scanning: gitleaks job in CI; local gitleaks documented as optional (not installed here)
- [x] `.github/workflows/ci.yml` (npm ci, lint, format:check, typecheck, test, build, audit, gitleaks)
- [x] Verify licences of imapflow / mailparser (both MIT, checked 2026-09-21)
- [x] **User:** create Supabase cloud project (EU region) — keys in `.env.local`
- [x] **User:** rename vars in `.env.local` to `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`; add `MM_MASTER_KEY` from `mm keygen`
- [x] Update `.env.example`, docs (anon key → publishable key), CLAUDE.md Commands + current milestone, README Getting started
- **Acceptance:** fresh copy of the repo → `npm ci`, lint, format:check, typecheck, test, build green; `mm --help`/`--version` work; `mm doctor` passes against the real Supabase project and fails clearly with a bad key/URL; no secret value appears in any output; `.env.local` ignored by git.

## M1a — Supabase foundation: migration, crypto, auth ✅ → [doc](docs/milestones/M1-auth-accounts.md)

Decisions (2026-09-21): migrations via Supabase CLI (npm devDependency, `npm run db:push`); **invite-only** signup (public signups disabled, users created in the dashboard); RLS proven with 2 real test users.

- [x] **User:** disable public signups (Auth → Sign In / Providers); create 2 auto-confirmed test users; add `MM_TEST_SUPABASE_A_EMAIL/_PASSWORD`, `MM_TEST_SUPABASE_B_EMAIL/_PASSWORD` to `.env.local`; run `npx supabase login` + `npx supabase link --project-ref <ref>` once
- [x] `supabase` CLI devDependency + `npm run db:push`
- [x] `supabase/migrations/0001_init.sql` — `mail_accounts` (secrets as base64 text), RLS for `authenticated` (`user_id = auth.uid()`), explicit grants, no anon access, `updated_at` trigger
- [x] `src/core/crypto.ts` AES-256-GCM encrypt/decrypt with AAD `user_id:account_id`, key_version + unit tests (round trip, wrong key, tamper, AAD mismatch, IV uniqueness)
- [x] Supabase client factory + file session storage (`~/.config/mail-manager/session.json`, 600; dir 700)
- [x] `mm login` / `mm logout` / `mm whoami` (hidden password prompt; no `mm signup`)
- [x] `AccountsRepo` interface + Supabase implementation (zod-validated rows)
- [x] `CredentialProvider` interface + local implementation (encrypt for new account, decrypt for connect)
- [x] `mm doctor`: add "database schema" check (mail_accounts reachable) and "session" check (logged in / not)
- [x] Integration test (real Supabase, skipped without test-user env): user A CRUD on own row; user B sees 0 rows, can't update/delete A's row, can't insert with A's user_id; anon sees nothing; ciphertext not plaintext; cleanup
- **Acceptance:** migration applied via `npm run db:push`; login/logout/whoami work with a dashboard-created user; crypto tests pass; RLS integration test passes with 2 users; no password/secret in any output.

## M1b — IMAP foundation, providers & test ground

Decisions (2026-09-21): SK/CZ market first; synthetic test mail built with nodemailer MailComposer (devDependency, no SMTP); ~150 messages / ~25 MB seeded deterministically into folder `mm-test` of **test@example-test-domain.eu** (Websupport).
Split on 2026-09-22 into M1b-1 → M1b-2 → M1b-3 (each its own assignment); M1b-4 logging foundation added 2026-09-23 (after M1b-3, before M1c).

### M1b-1 — Provider discovery (no login)

Decisions (2026-09-22): order = preset by email domain → preset by **MX suffix** (primary for custom domains: the domain's MX host is matched against the preset records) → ISPDB → autoconfig (**HTTPS only**: `autoconfig.<domain>` + `<domain>/.well-known/autoconfig`) → SRV `_imaps._tcp` → manual. XML parsed with **fast-xml-parser**. Only implicit-TLS / 993 results accepted.

- [x] **User:** add `MM_TEST_IMAP_USER=test@example-test-domain.eu` to `.env.local` (password not needed until M1b-2)
- [x] `src/core/providers/presets.json` + zod schema — id, name, domains, `mxSuffixes`, imap host/port, `altHosts`, auth, hint, helpUrl, `verified`, optional `blocked` reason. SK/CZ: Websupport (host in `presets.json`), WebHouse (`mail.webhouse.sk`), Webglobe (`mail.webglobe.cz`, `imap.webglobe.sk`), Active24 (`email.active24.com`), HostCreators (`imap.hostcreators.sk`), Forpsi (`imap.forpsi.com`), Wedos (per-mailbox `imap-*.wedos.net` → manual host), Seznam/Email.cz/Post.cz (`imap.seznam.cz`), Zoznam, Azet, Centrum; global: Gmail (+ Google Workspace MX), **Outlook (+ M365 MX; blocked: XOAUTH2 only — LOGINDISABLED, until M6 OAuth)**, Yahoo, iCloud, GMX, Hostinger. Each preset verified against an official help page (`helpUrl` + `verified: true`) or marked `verified: false`
- [x] `src/core/providers/discover.ts` — injectable DNS/fetch, per-lookup timeouts; failing sources fall through (never throw); MX sorted by preference, suffix matched on label boundary; `%EMAILADDRESS%`/`%EMAILLOCALPART%`/`%EMAILDOMAIN%` substituted; STARTTLS/143-only results skipped with a notice; redirects only to https; domain lowercased + IDN → ASCII. Result: source + provider + host/port/username + altHosts + verified + blocked + notices, or `manual` with the list of tried sources
- [x] Unit tests: each source, order/fallthrough, suffix boundary, STARTTLS skip, placeholders, malformed XML, timeouts, Outlook blocked, IDN
- [x] Three tiers (user, 2026-09-22): (1) autodetect as above (MX → IMAP mapping through the preset records in `presets.json`); (2) autodetect fails → user **picks the provider** from the preset list (SK/CZ first, blocked shown disabled); (3) proxied DNS / provider not listed → **manual IMAP host** (+ username, default = address). Core stays prompt-free (`pickableProviders`, `settingsFromPreset`, `manualSettings`); prompts in `src/cli/prompts/imap-settings.ts` (reused by M1c)
- [x] **GeoIP hint** (`geoIpNotice`) — changed by the user 2026-09-22: **not** shown with discovery results; printed only when a connection fails (from M1b-2): "connection not successful — first check the address, password and IMAP server; if they're right, check whether the mailbox has GeoIP security on; if so, allow [country] or turn it off while Mail Manager connects". CLI names this computer's country; server variant takes an optional region (hosting not decided: local now, later Vercel or VPS)
- [x] `mm discover <email>` — prints the result, unverified/blocked warnings, hint + helpUrl; nothing found → picker/manual in a TTY, exit 1 without TTY or on Cancel; no login, no password prompt
- [x] Integration test (skips without `MM_TEST_IMAP_USER`): real DNS → Websupport via MX
- [x] Domain check in plain language (user, 2026-09-22): MX lookup tells apart domain doesn't exist (typo/expired hint; online lookups stop, nothing sent to Mozilla; picker/manual still offered) / DNS error at the domain / DNS unreachable (no internet); each with a what-to-do message
- [x] Live preset check `tests/integration/presets-live.test.ts`: every preset host + alt host answers on 993 with a valid certificate and an IMAP greeting (no login)
- [x] `docs/PROVIDERS.md` — new discovery order, preset format, SK/CZ table with verification status, privacy note (domain sent to Mozilla ISPDB)
- **Acceptance:** `mm discover` on the test address → Websupport via MX without manual host; gmail.com → Gmail; outlook.com → blocked notice; unknown domain → tried sources + provider picker + manual entry (TTY); no GeoIP text in discovery output; unit + integration tests, lint, typecheck, build green.

### M1b-2a — IMAP session (needs M1b-1) ✅

Decisions (2026-09-22): split into M1b-2a (session) → M1b-2b (login guard). Failed logins use **one generic message** (wrong password / wrong address / host not found / timeout / refused / reset / GeoIP / auth-blocked — so the app can't be used to probe hosts or accounts); only no internet on our side, invalid TLS certificate, OAuth-only provider, too many attempts and server-reported "temporarily unavailable" get their own message. Core always keeps the precise typed reason. SSRF/DNS-rebinding guard deferred to M6a. Live probe 2026-09-22: Websupport = Dovecot, TLS 1.3, UIDPLUS/MOVE/QUOTA/STATUS=SIZE/CONDSTORE/QRESYNC/ESEARCH/LIST-STATUS/COMPRESS, **no SPECIAL-USE**, no OBJECTID/IMAP4rev2.

- [x] **User:** add `MM_TEST_IMAP_PASS` to `.env.local` (`MM_TEST_IMAP_HOST` only as fallback; host normally from discovery)
- [x] imapflow dependency (exact pin — 2.0.x is a fresh TS rewrite); `src/core/imap/session.ts` — connect (`secure: true`, 993, `tls.rejectUnauthorized` + `minVersion: 'TLSv1.2'`, `disableAutoIdle`, connection/greeting/socket timeouts, logger off or redacting, own `clientInfo` overriding imapflow's vendor/support-url), post-auth capabilities, logout; **never retries a failed login**; password dropped from the client's options after auth; password/username with CR/LF/NUL rejected before connecting
- [x] `ServerFeatures` from `capabilities` + `enabled` with IMAP4rev2 folding (docs/IMAP.md §3.2, §9 M1); raw capability record sanitised (name pattern, value boolean|number, count/length caps) before it can reach `mail_accounts.capabilities`; server ID info and server response text treated as untrusted (never printed raw)
- [x] Error mapping to typed reasons (auth failed, `[ALERT]` app-password required, host not found, no internet, refused/reset/timeout, TLS certificate, OAuth-only/LOGINDISABLED, RFC 5530 codes `UNAVAILABLE`/`EXPIRED`/`CONTACTADMIN`/`LIMIT`/`PRIVACYREQUIRED`, `ETHROTTLE`, `MissingServerExtension`, unexpected); CLI text per the generic/distinct split above, generic text includes the GeoIP hint (`geoIpNotice`) and the app-password hint; no password or raw server text in any message, `String(err)`, `util.inspect(err)` or JSON of the error
- [x] Side fixes: `src/cli/bin.ts` prints `err.message` only for known user-facing error classes (else "Unexpected error"); `AccountsRepo.get(id)` validates the UUID; `recordCheck` takes the sanitised capability type; CLAUDE.md "User-facing errors" rule updated for the generic/distinct split
- [x] Provider restrictions analysis in `docs/PROVIDERS.md` (connection limits, auth, capabilities per provider, brute-force/IP-ban risk incl. fail2ban-style bans, Gmail limits, Outlook OAuth); update docs/IMAP.md §7 with the measured Websupport capabilities; DB-injection audit result in docs/SECURITY.md (supabase-js parameterised builders only; no `.or()`/raw filters/RPC)
- [x] Integration tests on test@example-test-domain.eu: discovered host → login + capabilities + features; exactly **one** wrong-password attempt per run → generic auth error; canary check: the test password appears in no output, error or log line
- **Acceptance:** login works on the test mailbox with the discovered host; features built correctly (unit-tested with fixture capability sets incl. the measured Websupport set); every error reason mapped and unit-tested with a canary password; no password in output; lint, typecheck, unit + integration tests, build green.

### M1b-2b — Login guard (needs M1b-2a; before M1c) ✅

Decisions (2026-09-22): app-level guard is the primary brute-force layer (works on any hosting); fail2ban / Cloudflare WAF are outer layers added when hosted (M6a). Refined 2026-09-22: only **credential failures** count (auth-failed, app-password-required, password-expired, contact-admin, server-rejected — not timeouts/refused/TLS/no-internet/input validation); the lock counts per **(IP + mailbox) pair**, while one mailbox attacked from many IPs only gets the challenge (never locked, so nobody can lock the owner out); target hashed with HMAC keyed by HKDF(`MM_MASTER_KEY`, `mm-login-guard-v1`), random per-process key without a master key. In-memory store now: in the CLI the counters live for one `mm` run (M1c's password retries); persistent store + IP/permanent tiers become effective on the server (M6a).

- [x] `src/core/security/login-guard.ts` — policy with injectable clock and a store interface (in-memory now). Per (IP + mailbox) pair: failures 1–2 free; from the 3rd → `challenge-required`; 5 failures within 15 min → `too-many-attempts` for 15 min. Per IP: 3 lockouts within 24 h → IP blocked 24 h; 3 IP blocks within 30 days → **permanent** block. Per mailbox across all IPs: 10+ failures within 15 min → `challenge-required` only. Success resets the pair counter (lockout/block history stays). Mailbox key = lower-cased host + username
- [x] `guardedOpenSession` (core): check the guard → blocked: throw `LoginBlockedError` (kind + end time) without contacting the server; challenge: the caller's challenge hook runs (CLI: 5 s delay; server: Turnstile in M6a) → `openSession` once → record success / counted failure
- [x] User is told about every block in plain words with the time it ends, or "couldn't connect — contact Mail Manager support" when permanent (`errorText` / CLI texts; distinct messages per CLAUDE.md)
- [x] Block-event record (time, IP, reason, attempt count, target = HMAC of host+username — no plain address) + `SecurityEventSink` interface; one structured JSON log line per block, fail2ban/Cloudflare-parsable (example filter regex in docs); retention note (IPs are personal data, e.g. 90 days)
- [x] Unit tests: every threshold, window expiry, pair vs IP vs mailbox counting, only credential failures counted, reset on success, permanent tier, event records (no address/password), `guardedOpenSession` with a fake session opener
- **Acceptance:** policy fully unit-tested with a fake clock; a blocked attempt never reaches the server; messages name the unblock time; no plain address or password in event records; lint, typecheck, tests, build green.

### M1b-3 — Test ground (needs M1b-2a)

- [ ] Test ground: integration helpers (env, **folder guard: only `mm-test`**), deterministic synthetic mail generator (seeded; Slovak diacritics, varied senders/domains, dates 2019–2026, sizes 1 KB–5 MB, attachments, seen/flagged, `X-MM-Test-Seed` header) + manifest of expected facts, `npm run test:seed` (APPEND with internal dates), `npm run test:unseed`
- [ ] Integration tests on test@example-test-domain.eu: seeded count/manifest match, guard refuses other folders
- **Acceptance:** seeding is idempotent and matches the manifest; guard refuses other folders; unit + integration tests pass; no password in output.
- Logging: none (seed/unseed are npm scripts, not `mm` commands).

### M1b-4 — Logging foundation (needs M1b-2b; after M1b-3, before M1c) → [design](docs/LOGGING.md)

Decisions (2026-09-23): four kinds of records split by purpose — audit trail (Supabase `audit_log`), security events (`security-*.log`), app log (`app-*.log`), metrics/alerts (hosted only); local files in `<config dir>/logs/`; typed, allowlisted events only; the cloud `audit_log` is created **here** (moved from M4) so M1c's account actions are audited from day one. Settles the M1c "security log file" note (location, events, `mm logs`).

- [ ] **User:** Supabase dashboard → Authentication → Audit Logs: decide "write audit logs to the database" + retention (proposal: on, 90 days — IPs)
- [ ] `src/core/paths.ts` — `configDir()` moved out of `src/core/db/supabase/session-storage.ts` (`sessionDir`); session storage uses it
- [ ] `src/core/log/` — typed event union + envelope (`ts`, `event`, fields, `level`, `run`, `v`; fixed key order), `EventLog` interface, `MemoryEventLog`, `FileEventLog` (sync `appendFileSync`, dir 700 / files 600, one file per day and kind, 5 MB cap, startup pruning app 30 d / security 90 d, 4 KB line cap, never throws), run context (run id, version), zod schema for reading lines back; `MM_LOG_LEVEL` in `config.ts`
- [ ] Security events: `SecurityEvent` joins the catalog (new fields only after `target`, fail2ban regex unchanged + test); new `auth.login`, `auth.login-failed` (reason + HMAC of the typed e-mail), `auth.logout`; `imap.login`, `imap.login-failed`, `login-guard.challenge`, `login-guard.block` (**all** guard kinds incl. `too-many-attempts`) emitted by `guardedOpenSession` (tested with a fake opener; M1c wires the file)
- [ ] CLI run logging: `src/cli/bin.ts` + commander `preAction` hook → `command.start` (command path, option **names** only) / `command.finish` (outcome, exit code, ms) for every command, also on direct `process.exit` and Ctrl+C (`interrupted`); `error.unexpected` (class, code, relative stack frames, no message); events for today's commands (`doctor.check`, `discover.finish` with source + provider id and no domain, auth events; keygen start/finish only)
- [ ] `mm logs [--since] [--level] [--security] [--run] [--json]`, `mm logs path`, `mm logs clear` (confirm); plain-language lines in `src/cli/log-text.ts`; interrupted runs marked
- [ ] `mm doctor` `logs` check (folder writable, 700/600, size, oldest file)
- [ ] Audit trail: new migration — generic `audit_log` (docs/DATA_MODEL.md), `AuditRepo` interface + Supabase implementation, `audit.write-failed` event; two-user RLS integration test (own rows only, no update/delete)
- [ ] Tests: canary (no password/address/host/subject in any line), daily files + pruning with a fake clock and temp dir, file modes, two concurrent appenders, write failure doesn't change the command result, catalog ↔ `docs/LOGGING.md`, every registered command logs start + finish, fail2ban regex still matches
- **Acceptance:** every existing command leaves start + finish lines with one run id; failed `mm login` → `auth.login-failed` with a reason and no e-mail/password; `mm logs` readable, interrupted runs marked; canary clean; 700/600; pruning works; `audit_log` RLS test passes; lint, typecheck, tests, build green.

## M1c — Account commands (needs M1a + M1b)

- [ ] `mm account add [email]` — discover → (`chooseImapSettings`: provider picker / manual host from M1b-1) → hints → hidden password → test login through the login guard (M1b-2b; generic failure message incl. GeoIP hint) → encrypt → save
- [ ] `mm account list` / `test` / `remove` (confirm) / `update-password`
- [ ] `mm --help` shows how to connect a mailbox (user, 2026-09-22): the `account` command group with its subcommands, plus a short "Getting started" footer (`mm login` → `mm discover <email>` → `mm account add <email>` → `mm account test`)
- [ ] Logging ([LOGGING.md](docs/LOGGING.md); foundation from M1b-4): `guardedOpenSession` wired to the security log file (`imap.login`, `imap.login-failed`, `login-guard.*`); `account.add` / `account.remove` / `account.password-update` → app log + `audit_log` row; `account.test` → app log; no address, host or password in any event (canary)
- [ ] Integration test: add + test account on test@example-test-domain.eu; wrong password saves nothing
- [ ] Follow-ups from the M1a review (2026-09-22):
  - [ ] lowercase `host` in the accounts repo + a DB check in the next migration (the `(user_id, email, host)` uniqueness can be bypassed by case)
  - [ ] next migration: force `created_at`/`updated_at` to `now()` on insert (the client can currently set them)
  - [ ] `mm login` over an existing session: revoke the old refresh token first (logout → login)
  - [ ] unit test for the `src/cli/bin.ts` exit/flush path; comment that the auth deadline doesn't cancel the underlying library call
- **Acceptance:** account add/test works on the test mailbox; wrong password saves nothing; RLS holds; no password in output.

## M2 — Mailbox insight → [doc](docs/milestones/M2-insight.md)

- [ ] Folder listing with special-use roles
- [ ] `mm folders`
- [ ] Batched fetch helpers (sizes, envelopes) with bounded memory
- [ ] `stats.ts` aggregations (folder, sender, domain, year, largest) + Gmail `\All` de-dup + tests
- [ ] Quota (when supported)
- [ ] `mm stats` (table + `--json`, progress)
- [ ] Measure on a large mailbox; decide on local cache need
- [ ] Logging: `stats.finish`, `imap.capability-fallback` (docs/LOGGING.md catalog + canary test)
- **Acceptance:** counts match webmail; totals within rounding; Gmail not double-counted; memory bounded.

## M3 — Filters & search → [doc](docs/milestones/M3-filters-search.md)

- [ ] Decide: received vs sent date default; saved filter scope
- [ ] `filters/schema.ts` zod model (versioned)
- [ ] `filters/compile.ts` → SearchObject + post-filters + tests
- [ ] CLI flag parsing → filter (sizes, durations, dates)
- [ ] `mm search` (count, size, top senders, samples, `--json`)
- [ ] Gmail `X-GM-RAW` compile + cross-check vs standard search, `--gmail-only` (IMAP.md §5.6)
- [ ] Gmail search equivalence integration test (one case per mapping row, expected-differences list)
- [ ] Integration seed script (`tests/integration/seed.ts`) + folder guard
- [ ] `0002_saved_filters.sql` + `FiltersRepo`
- [ ] `mm filter save/list/show/delete`, `--filter <name>`
- [ ] Logging: `search.finish` (criterion names only, never values), `gmail.search-mismatch`, `filter.save`/`filter.delete` → `audit_log`
- **Acceptance:** each criterion returns expected seeded set; nested logic tested; webmail counts match.

## M4 — Safe delete → [doc](docs/milestones/M4-safe-delete.md)

- [ ] Decide: expunge only after M5 (proposed)
- [ ] `planner.ts` + plan serialisation (compressed UID ranges) + tests
- [ ] `delete.ts` capability matrix (IMAP.md §6.2) with notice + confirm per fallback, UIDVALIDITY guard, batching + tests with fake session (never `messageDelete`/`messageMove`/`CLOSE` without UIDPLUS/MOVE)
- [ ] Expunge mode (UIDPLUS only) — gated
- [ ] Plan files + `--resume`
- [ ] Audit rows in the existing `audit_log` (created in M1b-4): `mail.trash` / `mail.expunge` / `mail.move`, one per folder per run
- [ ] Logging: `delete.plan`, `delete.confirm`, `delete.batch` (debug), `delete.finish`, `trash.select`, notices; resume offer from interrupted runs
- [ ] `mm delete` confirmation UX: notices → full paged list (`--list-file`) → `y/N` → type count; interactive only, `--max` (IMAP.md §6.4); `mm audit`
- [ ] Trash selection: candidate scan, root ranking, always shown, saved on account + migration (IMAP.md §6.5)
- [ ] Decide: guarded plain EXPUNGE for servers without MOVE/UIDPLUS (IMAP.md §6.3 B; proposal: no)
- [ ] Gmail handling (label vs delete, `\Trash`, plan = standard ∩ `X-GM-RAW`)
- **Acceptance:** exact UIDs only; abort on UIDVALIDITY change; no folder-wide expunge; resume works; audit correct.

## M5 — Backup / export → [doc](docs/milestones/M5-backup.md)

- [ ] Discovery lookup cache (decided 2026-09-22: implement around M4–M5): remember ISPDB/autoconfig/MX results per domain for a limited time (e.g. 24 h) so repeated lookups — many users or accounts on the same domain, the server app — don't ask Mozilla/DNS again; never cache failures caused by being offline; no email addresses in the cache (domain only)
- [ ] `backup.ts` streaming `.eml` + single-pass sha256, `.part` → rename
- [ ] Path layout + filename/folder sanitisation + tests
- [ ] `manifest.json` + incremental skip
- [ ] `mm backup`, `mm backup verify`
- [ ] Optional mbox / zip
- [ ] Disk-space + Gmail daily-limit estimate
- [ ] Enable expunge-with-verified-backup in M4 flow
- [ ] Logging: `backup.start` / `backup.finish` / `backup.verify` → `audit_log` action `backup` (paths stay in the manifest)
- **Acceptance:** counts/hashes verify; opens in Thunderbird; re-run adds 0; expunge removes only verified messages.

## M6 — Beta → [doc](docs/milestones/M6-beta.md)

- [ ] M6a Local HTML page (Fastify, localhost, CSP, CSRF)
  - [ ] Login-guard hosting layer (from M1b-2b): persistent store + `security_events` table (RLS, service role, retention job), Cloudflare Turnstile on `challenge-required`, real client IP from `CF-Connecting-IP` only behind Cloudflare, Cloudflare WAF rate-limit rules / fail2ban (Cloudflare action) on the block log lines, support unblock procedure
  - [ ] Hosting-aware client IP + network-level bans (user, 2026-09-23 — **Vercel first, VPS later**). Split: the app (login guard) decides and logs; the network layer blocks traffic before the app; the app never runs firewall commands
    - [ ] Client IP from a trusted source only: Vercel → `x-real-ip` / `x-forwarded-for` set by Vercel's edge (country from `x-vercel-ip-country`); behind Cloudflare → `CF-Connecting-IP` + `CF-IPCountry`, accepted only when the request comes from Cloudflare's IP ranges; direct VPS → socket address (+ source port) and a GeoIP database (MaxMind GeoLite2, licence key, regular updates) for the country. Never take `local` or an IP header from an untrusted request
    - [ ] `mm-security` block lines gain `country` and `port` (source port when known — needed for ISP abuse reports behind carrier-grade NAT; not used for bans); same 90-day retention (IP + country are personal data)
    - [ ] Vercel phase: serverless instances don't share memory → login-guard store must be persistent (Supabase `security_events` / attempt table, atomic updates) before the web login goes live; bans via Vercel Firewall custom rules / IP blocking (dashboard or API) fed from the block records; check function time limits for IMAP sessions and that the GeoIP hint names the right region (Vercel's outgoing IPs vary)
    - [ ] VPS phase: fail2ban reading the `mm-security` log with `FAIL2BAN_FAILREGEX` (`<ADDR>`) → nftables bans, or the Cloudflare action / WAF rules when proxied; nftables allows web traffic only from Cloudflare's ranges (no bypassing the proxy); log rotation
  - [ ] Logging (docs/LOGGING.md): `http.request` via Fastify's pino (no query strings/bodies), `http.csrf-failed` / `http.csp-violation` / `http.session-invalid`, `security_events` table + 90-day retention job, alert rules (permanent block, block spikes, error rate)
  - [ ] SSRF / DNS-rebinding guard (deferred from M1b-2a): resolve the IMAP host once, refuse loopback/private/link-local/CGNAT/metadata IPs, connect to the resolved IP with `servername` = host; server hides host-not-found vs refused vs timeout (generic message)
- [ ] M6c IMAP→IMAP migration (old → new address) — logging: `migrate.finish` run summary → `audit_log` `migrate`
- [ ] M6b `mm worker` + jobs (scheduled backup/cleanup) — logging: `job.start` / `job.finish` → `job_runs` + heartbeat (missed runs alert)
- [ ] M6d OAuth2 Gmail + Microsoft — logging: `oauth.token-refresh` / `oauth.token-revoked`, never token values
- [ ] MFA for app login
- [ ] Docker + hermetic IMAP tests in CI

---

## Later / ideas

- Local metadata index (SQLite) for instant filtering on huge mailboxes
- Encrypted backup archives
- Hosted beta (M7) — after GDPR prerequisites (see docs/SECURITY.md); hosted observability from docs/LOGGING.md: log service (Vercel Log Drain / VPS shipper), error tracking (EU region), uptime, alerting, logs in the GDPR record of processing
- Migrate off Supabase (self-hosted Postgres / own auth)
- UI/UX design pass (priority after functionality)
- i18n: Slovak + English
- Duplicate-message finder
- Unsubscribe helper (List-Unsubscribe header) — read-only, no SMTP needed for HTTP links
- SMTP → full mail client
