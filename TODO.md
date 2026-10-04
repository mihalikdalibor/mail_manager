# TODO

Source of truth for progress. One milestone at a time — details, design notes and open questions live in `docs/milestones/`.

**Current milestone: M2 Mailbox insight — M2a folder tree + `mm folders` done 2026-10-01 (C-021, C-022, reviewed); M2b-1 browser core done 2026-10-02 (C-023, follow-ups C-024 ASCII screen text + C-025, all reviewed); M2b-2 terminal browser implemented 2026-10-02 (C-026, reviewed 2026-10-03; the manual walk in a real terminal is still open — the user); M2c-1 `mm stats` done 2026-10-03 (C-027, reviewed; live test passed); M2-fix review follow-ups done 2026-10-04 (C-028, reviewed; plus the browser width fix C-029, reviewed); M2a … M2-fix released as v0.9.0; next: M2c-2 large-mailbox measurement (the user)** (M2 split into M2a/M2b/M2c) — M1c account commands done: M1c-1 account commands 2026-10-01 (v0.7.0, C-019, reviewed), M1c-2 hardening 2026-10-01 (v0.8.0, C-020, reviewed, migration applied) — M1b-4 logging foundation done (4a 2026-09-28, C-015; 4b 2026-09-29, C-016; 4d audit trail 2026-09-29, C-017, migration applied; 4c `mm logs` 2026-09-30, C-018; all reviewed) — M1b-3 test ground done: M1b-3a generator 2026-09-24 (C-013, reviewed), M1b-3b guard + seed/unseed + live test 2026-09-24 (C-014, reviewed 2026-09-28) — M0 done 2026-09-21 (C-001); M1a done 2026-09-22 (C-002, C-003); M1b-1 done 2026-09-22 (C-004…C-008, reviewed); M1b-2a done 2026-09-22 (C-009, C-010, reviewed); `mm logout` fix (C-011, reviewed); M1b-2b done 2026-09-23 (C-012, reviewed)

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

### M1b-1 — Provider discovery (no login) ✅

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

### M1b-3 — Test ground (needs M1b-2a) ✅

Decisions (2026-09-24): seed appends only missing messages and refuses when `mm-test` holds foreign/unexpected mail (never deletes messages); `test:unseed` deletes the whole `mm-test` folder (IMAP DELETE, no EXPUNGE); the integration test runs seed itself (first run uploads ~25 MB, later runs nothing); `mm-test` stays seeded between runs for M3–M5. Split into M1b-3a (generator, offline) → M1b-3b (guard, seed/unseed, live test). Both live in `tests/support/test-ground/` (tsx, no `src/` changes).

#### M1b-3a — Synthetic mail generator (offline) ✅

- [x] Deterministic generator: seeded PRNG + nodemailer MailComposer (devDependency, exact pin, MIT-0, 0 deps, no SMTP), CRLF, fixed boundaries/Message-ID/Date → byte-identical per `SEED_VERSION`: exactly 150 messages, 20–30 MB total, 1 KB–5 MB each, internal dates 2019–2026 (Date header equal except a few deliberately offset), Slovak diacritics (names, subjects, bodies, attachment names), senders on reserved domains only (`.test`/`.example`, incl. `spam.test` and a look-alike `spam.test.evil.test`), with/without attachments, `\Seen`/`\Flagged` mixes, `X-MM-Test-Seed: v<N>-<NNN>` (3-digit index) on every message
- [x] In-code manifest (per message: seed id, Message-ID, sender/domain, subject, sent + internal date, exact byte size, flags, attachments; totals per year/domain/flag/attachment + total bytes)
- [x] Unit tests: byte-identical twice + pinned digest (a generator change fails until `SEED_VERSION` is bumped), count/size/total/year ranges, diacritics, header + unique Message-ID on every message, CRLF only, reserved domains only, flag/attachment/date-offset mixes, manifest totals = per-message facts
- **Acceptance:** same bytes on every run; all ranges above hold; manifest matches the generated messages; no network; lint, typecheck, unit tests, build green.
- Logging: none (test tooling).

#### M1b-3b — Folder guard, seed/unseed, live test (needs M1b-3a) ✅

- [x] Live-IMAP env helper (address/password from `MM_TEST_IMAP_*`, host via discovery with `MM_TEST_IMAP_HOST` fallback, plain message when unset) — env + host discovery only: `imap-session.test.ts` reuses it but keeps calling `openSession` itself. Seed/unseed log in once per run via `guardedOpenSession` (in-memory guard, random target key)
- [x] **Folder guard**: resolves the real `mm-test` path once (namespace prefix) and refuses any other path — before any IMAP command — for every folder operation; the harness narrows the session's client to a typed folder-operation view internally (runtime `instanceof ImapFlow`, no `src/` change), tests never touch it
- [x] `npm run test:seed`: create `mm-test` if missing → append only messages whose seed id is missing (flags + internal date) → reset drifted flags → verify; refuses (appends nothing) when the folder holds foreign, duplicate, older-version or changed messages ("changed" = seed id present but size or internal date differs; differing flags are reset, not refused) and says to run unseed; **verify** = exactly 150 messages and every seed id's size, internal date and flags match the manifest, else fail; progress as counts. `npm run test:unseed`: deletes the `mm-test` folder (guarded, no prompt — decided 2026-09-24) and prints how many messages went with it; missing folder → "nothing to delete" (exit 0); always a fresh session (no folder selected). Output: counts only — no password, address, host or server text. Errors: login failure → the app's generic message, guard/seed refusal → plain text, anything else → "Unexpected error (<type>)", missing env → plain message; exit 1
- [x] Unit tests: guard path resolution + refusals (fake client records zero calls), seed/unseed against a fake client (empty, partial, complete, foreign, duplicate, flag drift)
- [x] Integration test on test@example-test-domain.eu (skips without env): seed → second seed appends 0 → server count, sizes, internal dates, flags, Message-IDs match the manifest → guard refuses `INBOX`, `Trash`, `mm-test/x`, `MM-TEST`, `mm-test2`, `*`; no password in captured output
- [x] Docs: `docs/TESTING.md`, `.env.example`, `CLAUDE.md` Commands (`test:seed` / `test:unseed`), the `imap-session.test.ts` comment; test ground is for the Websupport mailbox only (Gmail labels: M3)
- **Acceptance:** a second seed changes nothing; server state matches the manifest; guard refuses other folders before any IMAP command; unseed leaves no `mm-test` folder; no `src/` change; lint, typecheck, unit + integration tests, build green; leak check clean.
- Logging: none (seed/unseed are npm scripts, not `mm` commands).

### M1b-4 — Logging foundation (needs M1b-2b; after M1b-3, before M1c) → [design](docs/LOGGING.md) ✅

Decisions (2026-09-23): four kinds of records split by purpose — audit trail (Supabase `audit_log`), security events (`security-*.log`), app log (`app-*.log`), metrics/alerts (hosted only); local files in `<config dir>/logs/`; typed, allowlisted events only; the cloud `audit_log` is created **here** (moved from M4) so M1c's account actions are audited from day one. Settles the M1c "security log file" note (location, events, `mm logs`).

Split on 2026-09-28 into M1b-4a → 4b → 4c → 4d (each its own assignment; M1c needs 4a, 4b, 4d). No `MM_LOG_LEVEL=off` for now (decided 2026-09-28): levels `debug|info|warn|error` only; security lines are always written.

#### M1b-4a — Log core + run logging ✅

- [x] `src/core/paths.ts` — `configDir()` moved out of `src/core/db/supabase/session-storage.ts` (`sessionDir`); session storage uses it
- [x] `src/core/log/` — typed event union + envelope (`ts`, `event`, fields, `level`, `run`, `v`; fixed key order), `EventLog` interface, `MemoryEventLog`, `FileEventLog` (sync `O_APPEND` writes, dir 700 / files 600, one file per **UTC** day and kind, 5 MB cap → `debug` dropped first, then one `log.truncated` marker, 4 KB line cap, startup pruning app 30 d / security 90 d by file-name date, never throws), run context (16-hex run id, version), zod schema for reading lines back; `MM_LOG_LEVEL` in `config.ts` (invalid → `info`, reported by doctor)
- [x] CLI run logging: `src/cli/bin.ts` loads the env files first (failure ignored — logging never breaks a command) so the log folder matches `session.json`; commander `preAction` hook → `command.start` (command path, option **names** given on the command line) / `command.finish` (outcome, exit code, ms) for every command, also on direct `process.exit`; `interrupted` = exit code 130 (inquirer Ctrl+C) or SIGINT (handler writes the finish line, exits 130). `--help`, `--version` and parse errors write nothing (no start → no finish)
- [x] `error.unexpected` (class, code, relative stack frames, no message) through one shell helper used by `bin.ts` **and** the commands that catch their own errors (`auth`, `discover`)
- [x] `mm doctor` `logs` check (folder writable, 700/600, total size, oldest file, `MM_LOG_LEVEL` valid)
- [x] Tests: envelope key order, canary (no password/address/host/subject/option value/home path in any line), UTC daily files + pruning with a fake clock and temp dir, 5 MB cap + `log.truncated`, 4 KB line cap, file modes, two concurrent appenders, write failure doesn't change the command result, every registered command logs start + finish with one run id, interrupted runs, catalog ↔ `docs/LOGGING.md` for the events that exist
- **Acceptance:** every existing command leaves `command.start` + `command.finish` with one run id in `<config dir>/logs/app-<UTC date>.log`; Ctrl+C → `interrupted`; unexpected errors → `error.unexpected` without message; canary clean; 700/600; pruning and caps work; an unwritable log folder changes no command result; lint, typecheck, tests, build green.
- Logging: this is the foundation (`command.start`, `command.finish`, `error.unexpected`, `log.truncated`).

#### M1b-4b — Domain + security events (needs 4a) ✅

Decisions (2026-09-28/29): security day files get their own **150 MB** cap (app files keep 5 MB; local logs are per OS user and machine, so the cap can be lowered later); the two 4a review follow-ups are part of 4b; the typed e-mail is only HMAC'd when it is a valid address (a password typed into the e-mail field must not become an offline-guessable hash); built by one implementer (no worktrees — 4a isn't committed yet).

- [x] App events for today's commands, emitted by the CLI shell through `ctx.log` (builders in core): `doctor.check` (`check`, `status`, one per check); `discover.finish` (`outcome` = `found`/`needs-host`/`blocked`/`manual`/`invalid`, optional `source`, `provider` preset id, `domainProblem`, `choice` = `picked`/`host-entered`/`manual`/`cancelled` — never the address, domain or host)
- [x] Security events for `mm login`/`logout`: `auth.login` (`user` = Supabase user id), `auth.login-failed` (`reason` = `invalid-credentials`/`unreachable`/`unknown`/`unexpected`, `target` = HMAC of the typed e-mail with its own `MM_MASTER_KEY`-derived key — random per run without it — or `invalid` when the input isn't a valid address) only after a password was submitted; `auth.logout` (`outcome` = `logged-out`/`not-logged-in`, no user id — no network call). Written to `security-<UTC date>.log` with the `mm-security` prefix
- [x] `login-guard.block` joins the catalog: `LoginGuard` emits through `EventLog` (an adapter replaces the `SecurityEventSink`), line = `mm-security {ts, event, kind, reason, ip, addr, attempts, until, target, level, run, v}` — envelope only after `target`, `FAIL2BAN_FAILREGEX` unchanged + test on the rendered line; level `warn` (`permanent`: `error`)
- [x] `guardedOpenSession` emits `imap.login` (`acct?`, `provider`, `ip`, `target`), `imap.login-failed` (`acct?`, `provider`, `reason`, `counted`, `ip`, `target`) and `login-guard.challenge` (`ip`, `attempts`, `target`); the caller passes `log?`, `provider` (preset id or `custom`) and `acct?`; the guard exposes an attempt's `ip`/`target` and the challenge decision carries `attempts`. Tested with a fake opener; nothing calls it with a file log until M1c
- [x] Security day files: own 150 MB cap (then one `log.truncated`); app files keep 5 MB
- [x] 4a follow-ups: pruning runs on the first `emit` even when no line passes the level threshold; doctor at `MM_LOG_LEVEL=warn|error` reports OK "no logs yet" only when the nearest existing parent of the log folder is a writable directory, else warns
- [x] Tests: canary over every new builder (password, address, domain, host, typed e-mail, subject), catalog ↔ `docs/LOGGING.md` (rows marked `M1b-4b` exist in code), fail2ban regex matches a rendered `login-guard.block` line, every guard kind emitted, CLI wiring (failed `mm login` → one `auth.login-failed`), security cap
- **Acceptance:** failed `mm login` → `auth.login-failed` with a reason and no e-mail/password; successful → `auth.login` with the user id only; `mm doctor` → one `doctor.check` per check; `mm discover` → one `discover.finish` without address/domain/host; guard events built and tested; fail2ban regex still matches; canary clean; lint, typecheck, tests, build green.
- Logging: `doctor.check`, `discover.finish`, `auth.login`, `auth.login-failed`, `auth.logout`, `imap.login`, `imap.login-failed`, `login-guard.challenge`, `login-guard.block`.

#### M1b-4c — `mm logs` (needs 4a, 4b) ✅

Decisions (2026-09-29): flat event list (one line per event, time order, `command.start` shown as "started"); `--json` prints validated, re-serialized records — never raw lines.

- [x] Reader (`src/core/log/`): per-event zod schemas (same allowlists as the builders) over `parseLogLine`; unknown events and malformed lines skipped and **counted**; reads only regular `app-`/`security-` day files in the window (no symlinks, line by line — security files can reach 150 MB); merges both kinds by `ts`; excludes the reader's own run
- [x] `mm logs [--since 30m|24h|7d] [--level debug|info|warn|error] [--security] [--run <16 hex>] [--json]`: default last 24 h, `--since` max 90 d; `--level` is a minimum; `--security` = security lines only; `--run` searches all retained files; local time (`HH:MM:SS`, date headers when the range spans days); plain text per event in `src/cli/log-text.ts` from the event's real fields only (no invented counts); every printed string stripped of control/bidi/invisible characters; runs with a start and no finish (other than the reader's own) shown as **interrupted**; footer "N unreadable lines skipped"
- [x] `mm logs --json`: one validated record per line (`JSON.stringify` of the schema output), same filters — safe to paste into a support ticket
- [x] `mm logs path` prints the log folder; `mm logs clear` deletes the real `app-*`/`security-*` day files only after a confirmation (non-TTY: refuses unless `--yes`), never follows symlinks, reports the count
- [x] Tests: per-event schema round trip for every catalog event, tampered lines (escape sequences, bidi, wrong types, unknown events, oversized) skipped/counted or sanitized, interrupted detection incl. own run excluded, filters, day-boundary/local-time formatting with a fake clock + TZ, `clear` refusals and symlink safety, `--json` output parses and contains only catalog fields
- **Acceptance:** `mm logs` readable, interrupted runs marked, tampered lines never printed raw, `--json` lines parse with `jq`/`JSON.parse`; lint, typecheck, tests, build green.
- Logging: `mm logs` runs are logged like every command (start/finish); no new events.

#### M1b-4d — Audit trail (needs 4a; implement after 4b — both edit the event catalog) ✅

Decisions (2026-09-29): live RLS tests insert a few tagged rows per run that stay (append-only; deleting a test user removes them); `mm doctor` checks that `audit_log` exists (to be automated later so users don't get stuck — see Later); Supabase Auth "write audit logs to the database" → **on**, deleted after 90 days (cleanup job later).

- [x] **User:** Supabase dashboard → Authentication → Audit Logs → turn on "write audit logs to the database"
- [x] New migration `audit_log` per docs/DATA_MODEL.md: `user_id` default `auth.uid()` (cascade), `account_id` FK `on delete set null`, `action` check + zod enum (all 10 actions), `details` jsonb ≤ 4 KB (`pg_column_size` check), `result`/`reason`/`run_id`, `created_at` server-set; RLS `select` + `insert` own rows only, insert policy also requires `account_id` null or one of the user's own accounts; privileges reset (no anon, no update/delete/truncate, column-level insert without `id`/`created_at`). Applying it (`npm run db:push`, shared cloud DB) needs the user's go-ahead
- [x] `AuditRepo` interface (`src/core/db/repos.ts`) + Supabase implementation (`write`, `listRecent` for tests/`mm logs` later); zod `details` schema for `account.*` (`provider` preset id) — other actions get theirs in their milestones; core `recordAudit(repo, entry, log)` never throws and emits `audit.write-failed` (`action`, `reason` code) on failure; nothing calls it before M1c
- [x] `mm doctor` `database` check also probes `audit_log` (present + anon blocked → OK; missing → FAIL "run npm run db:push")
- [x] Tests: unit (repo mapping/validation with a fake client, `recordAudit` failure → event, no row data in errors); two-user RLS integration test (own rows only, B can't read A's rows, can't insert with A's `user_id` or A's `account_id`, no update/delete, anon denied, `created_at` not client-settable; rows tagged `reason: 'rls-test'`)
- **Acceptance:** migration applied; `audit_log` RLS suite passes; doctor detects a missing table; `audit.write-failed` tested; lint, typecheck, tests, build green.
- Logging: `audit.write-failed`.

## M1c — Account commands (needs M1a + M1b) ✅

Decisions (2026-09-30): split into M1c-1 (all account commands) → M1c-2 (hardening follow-ups). Accounts are named by the short id `mm account list` shows (first 8 hex chars of the account UUID; any unique prefix of ≥ 4 chars or the full UUID also works). Password retries in `add`/`update-password` stay inside one run and are limited by the login guard (2 free, then a 5 s wait, lock after 5). Decided 2026-10-01: the encrypted password is bound to the account's host, port and username (AAD), so an account whose server was changed in the database can't decrypt — the password is never sent to a swapped host; failed `account add` attempts also get an audit row (`result: failed`, `account_id` null, reason code).

### M1c-1 — Account commands ✅

- [x] Core `src/core/accounts.ts` (no prompts): add / test / update-password / remove / resolve id prefix. Every login goes through `guardedOpenSession` with one `LoginGuard` per run (in-memory store, target key from `MM_MASTER_KEY`); the same run log is passed to the guard and the session (security log)
- [x] `mm account add [email]` (needs a terminal):
  - discover → show provider, host, hint/help link and the unverified warning; nothing found or a per-mailbox host → provider picker / manual host; blocked provider (Outlook) → reason, exit 1
  - hidden password → test login; wrong password → the generic message (with GeoIP hint) and "try again?" (guard-limited); other failures → their message, exit 1
  - success → encrypt → save → capabilities recorded → "Added <email> (id 3f2a91c0)"
  - same email + host already saved → points at `update-password`; nothing is saved unless the login succeeded; the repo lowercases `host`
- [x] `mm account list`: id (8 chars), email, provider, host, last checked — never secrets; empty → "No mailboxes yet — run `mm account add <email>`"
- [x] `mm account test <id>`: decrypt → login → "Login works" + server features; stores capabilities and last-checked time; failure → the same texts, exit 1
- [x] `mm account update-password <id>` (terminal): new hidden password → test login with it → only then encrypt and save; a wrong password saves nothing (retries as in `add`)
- [x] `mm account remove <id> [--yes]`: shows email and provider, asks (default no); without a terminal refuses unless `--yes`; Ctrl+C → 130; the audit row is written after the delete with `account_id` null
- [x] Id handling: no id → "Which mailbox? Run `mm account list` and pass its id"; bad format → plain error; no match → "No mailbox with id …"; ambiguous prefix → "matches N mailboxes — type more characters"
- [x] Errors in plain words: not logged in → `mm login`; missing/invalid `MM_MASTER_KEY` → `mm keygen` hint; secret saved with another key version → "use `update-password`" (superseded 2026-10-01, C-019: `update-password` refuses an unreadable secret — the row may point at a swapped host — so the texts say `mm account remove` + `mm account add`); database unreachable → the existing repo texts
- [x] `mm --help` lists the `account` group and a "Getting started" footer: `mm login` → `mm discover <email>` → `mm account add <email>` → `mm account test <id>` (user, 2026-09-22)
- [x] Logging ([LOGGING.md](docs/LOGGING.md)): app events `account.add` / `account.test` / `account.password-update` / `account.remove` (`acct`, `provider`, `outcome`, `reason`); `audit_log` rows for add (also failed attempts) / remove / password-update (`details: { provider }`); guard + IMAP events in the security log; canary tests (no address, host or password in any line or row)
- [x] Tests: core with fakes (nothing saved on failure, guard-limited retries, duplicate, key-version mismatch, prefix resolution); CLI with mocked prompts; integration test (skips without `MM_TEST_SUPABASE_A_*` + `MM_TEST_IMAP_*`): add → list → test → update-password (same password) → remove on the test mailbox as test user A — no live wrong-password attempt (TESTING.md: the suite's one is in `imap-session`); "wrong password saves nothing" is proven with a fake IMAP opener
- **Acceptance:** add / list / test / update-password / remove work on the test mailbox; a wrong password saves nothing; no password, address or host in logs or audit rows; RLS suite still passes; lint, typecheck, tests, build green.

### M1c-2 — Hardening follow-ups (needs M1c-1) ✅

Decisions (2026-10-01): kept as **one** assignment (sliced: DB / run + login / `mm logs` / accounts); revoke UPDATE on `mail_accounts` email/host/port/username (the app never updates them; changing the server = remove + add); `mm login` with a session present **refuses** ("run `mm logout` first"); every `account.*` audit row for an existing account stores its UUID in `details.account`, so the history stays linked after a remove.

- [x] DB hardening migration (one new file; `npm run db:push` only after the user's go-ahead):
  - `mail_accounts`: `update … set host = lower(host)` then check `host = lower(host)` (safe: AAD v2 already lowercases the host); length limits email ≤ 254, host ≤ 253, username ≤ 320, label ≤ 100; provider `^[a-z0-9-]{1,40}$`; INSERT granted only on the columns the app sends (`created_at`/`updated_at` always from the database); UPDATE revoked on email, host, port, username
  - `audit_log`: `folder !~ '@'`; `details` null or a JSON object; `service_role` loses DELETE
  - RLS suite: one test per new rule with the exact error code; run once after the push
- [x] `SupabaseAuditRepo.listRecent` tie-break by `id desc` (C-017 review)
- [x] Run/exit: a closed pipe ends any command quietly (`mm keygen | true` → exit code unchanged, no "Unexpected error", no `error.unexpected`), handled once in `runCli`/`bin.ts` (C-018 review); a test for the `bin.ts` exit/flush path; comment that the auth deadline doesn't cancel the underlying library call
- [x] `mm login` with a local session present → "You're already logged in — run `mm logout` first", exit 1, nothing sent (so an old refresh token is always revoked by `mm logout` before a new login)
- [x] `mm logs` (C-018 review): `--json` caps only the records it prints (interrupted markers don't count); the "older lines not shown" hint suggests `--level`/`--security`/`--run`; the empty message says "no matching log lines" when a filter is active; `log.truncated` takes the timestamp of the line that triggered it (lands in the right day file); the command column fits the longest command shown (`account update-password`)
- [x] Accounts (C-019 security audit + review): a DNS SRV result whose host is neither under the email's domain nor a preset host → a specific warning, and "Use these settings?" defaults to no; `update-password` refusing an unreadable secret emits `account.password-update` failed (`secret-unreadable`) from core; the duplicate-add text also mentions remove + add; stale comment in `src/cli/account-text.ts`; `details.account` (UUID) on `account.add` ok, `account.password-update` and `account.remove` rows
- **Acceptance:** migration applied, RLS suite passes; each follow-up has a test; lint, typecheck, tests, build, format:check green.

## M2 — Mailbox insight → [doc](docs/milestones/M2-insight.md)

Split 2026-10-01 (with the user): M2a folder tree → M2b interactive browser → M2c stats. Show all folders. The delete "double check" is a local basket that feeds the M4 flow; a server-side review folder may come later in M4 as an opt-in mode.

### M2a — Folder tree + `mm folders` (read-only)

- [x] Docs: M2 doc split into M2a/M2b/M2c; TODO; M4 basket note; LOGGING catalog (`folders.list`, `imap.capability-fallback` now; `browse.finish`, `stats.finish` planned); CLAUDE.md state
- [x] Core `src/core/mailbox/folders.ts`: LIST (all folders, unsubscribed ones included and marked) + special-use role + `\Noselect` + tree by delimiter; counts via LIST-STATUS/STATUS (messages, unseen); size via `STATUS=SIZE`, otherwise read-only (EXAMINE) batched `UID FETCH RFC822.SIZE`, marked "approx."; at most 5,000 folders (note when cut)
- [x] Quota via GETQUOTA when `QUOTA` is supported, otherwise none → "approx. sum of folders"
- [x] Gmail: `\All` = total source, label folders flagged "overlapping", Trash/Spam shown separately; totals never double-count
- [x] Folder names from the server are untrusted: control/bidi characters stripped on display; a folder whose STATUS fails shows "—" and the rest still lists
- [x] `withAccountSession` in `src/core/accounts.ts` (one guarded login → fn → logout; reused by M2b/M2c)
- [x] `mm folders [id] [--json] [--no-size]`: id optional when exactly one mailbox is saved (named in the output); indented tree (role, messages, unread, size, "(hidden)" for unsubscribed), totals + quota line; progress on stderr while sizing; versioned JSON
- [x] Logging: `folders.list` (acct, folders, ms, outcome/reason), `imap.capability-fallback` (feature, fallback; once per run) + catalog + canary test
- [x] Tests: fake-client unit tests (tree, roles, Gmail, size-fallback batches, quota missing, hostile names, folder cap, STATUS failure); integration: `mm-test` counts/bytes = manifest (assert on `mm-test` only)
- **Acceptance:** counts match webmail; `mm-test` = manifest (150 messages, seen count, bytes); Gmail not double-counted; size-fallback memory bounded.

### M2b — Interactive folder browser (needs M2a)

A full-terminal view (like `less`/`htop`, inside the terminal — not a desktop or HTML app). Split 2026-10-01 (with the user): M2b-1 browser core → M2b-2 terminal. Decided: own raw-mode loop on `node:readline` (no new dependency; replaces the `@inquirer/core` idea), mails newest **arrived** first (sequence order; date sort stays in "Later"), quitting with marks asks first.

#### M2b-1 — Browser core (no visible change yet)

- [x] Docs: M2 doc (M2b-1/M2b-2 split, raw-mode loop instead of `@inquirer/core`, arrival order, quit confirm, cache/paging rules); TODO
- [x] Core `src/core/mailbox/messages.ts`: `openFolder` (EXAMINE → UIDVALIDITY + message count snapshot) and `loadPage` (newest arrived first by sequence, 200 per page: UID, received date, envelope from/subject, RFC822.SIZE, attachment marker from BODYSTRUCTURE); never sets `\Seen`; folder changed on the server (count or UIDVALIDITY differs) → reported so the caller reloads; a folder that can't be opened → `MailboxError('folder-unavailable')`, connection drop → `connection-lost`
- [x] Basket `src/core/mailbox/basket.ts`: marks = folder + UIDVALIDITY + UID + bytes, toggle, running count/size, UIDVALIDITY change clears that folder's marks (reported); M4 acts on it later
- [x] State reducer `src/cli/browser/state.ts` (pure, returns effects for the shell to run): ↑/↓ PgUp/PgDn, Enter opens a folder, Backspace/← back, Space toggles the mark on a mail (on a folder: hint "only mails can be marked"), `a` toggles every mail on the visible screen, `q`/Esc quit (with marks: "Quit and drop N marks? (y/N)"); subfolders first, then mails; at most 5 pages (1,000 mails) of the open folder cached, sliding, evicted pages reloaded; going back drops the folder's mails; load errors → status message, connection lost → "Connection closed - reconnect? (y/N)" state (N keeps browsing what is loaded)
- [x] Renderer `src/cli/browser/render.ts` (pure: state + rows/cols → lines): header path + folder total, folder rows (messages, size), mail rows (received date, from, subject, size, attachment marker, mark), status bar "marked: N mails, X MB" + key help; every server string sanitised and cut to the width; "window too small" below a minimum size. Mail data is displayed only — never stored or logged
- [x] Tests: messages core with a fake client (paging ranges, newest first, short last page, empty folder, changed folder, open failure, connection drop, read-only lock, hostile strings untouched in core); basket; reducer (navigation, paging/eviction, marks, `a` toggle, UIDVALIDITY change, quit confirm, reconnect state); renderer (widths, truncation, sanitising, too small)
- **Acceptance:** lint, typecheck, tests, build, format:check green; no command changes behaviour yet.

#### M2b-2 — Terminal browser + `mm folders` switch (needs M2b-1)

Rewritten 2026-10-02 with the user (`/next`): tree printed before the browser, no offline nagging (`r` reconnects), four review follow-ups folded in.

- [x] Core `openAccountSession(deps, account)` in `src/core/accounts.ts`: one guarded login with the saved password, the caller logs out; `withAccountSession` built on it (the browser keeps its session open; a reconnect is one more call)
- [x] Terminal `src/cli/browser/terminal.ts`: raw mode + alternate screen, cursor hidden, line wrap off, full-frame redraw (cursor row in reverse video), clear + redraw on resize; idempotent restore on `q`, Ctrl+C, an error, SIGTERM (exit 143), SIGHUP (exit 129) and any process exit; a crash restores the screen before "Unexpected error" is printed
- [x] Controller `src/cli/browser/controller.ts`: keys → reducer → effects (load = `loadPage` on the current session; reconnect = log out the old session + one new guarded login, never automatic; quit); Ctrl+C (a key in raw mode) ends at once in every mode, also `reconnecting` and "window too small"
- [x] Reconnect: the login guard's challenge wait is an ASCII status notice ("Several wrong passwords - waiting 5 seconds before trying again.") instead of stderr; a failed reconnect shows "Couldn't reconnect - showing what is loaded. Details after you quit." and the full login text (as `mm account test` prints it) goes to stderr after the screen is restored; entering `reconnecting` and `reconnected` clear the message, `reconnecting` shows a text message when one is set
- [x] Offline (after N): moving over unloaded rows shows "not loaded (offline)" without asking again; only opening a folder asks; new key `r` reconnects (offline only); status "Offline - showing what is loaded (r = reconnect)."
- [x] `mm folders`: stdin + stdout a terminal and neither `--plain` (new) nor `--json` → listing as today (progress, `folders.list`), the M2a tree printed, then the browser on the same session; `--no-size` hides the browser's folder size column; otherwise the M2a output unchanged. After `q`/Ctrl+C one line on stdout: "Folder browser closed — nothing was changed on the server." or "Folder browser closed — 12 marks (4.1 MB) dropped, nothing was changed on the server."; exit 0 (`q`), 130 (Ctrl+C); an error → screen restored, its text, exit 1
- [x] Logging: `browse.finish` (app; `acct`, `folders` opened, `mails` loaded, `marked`, `bytes` (marked, known sizes), `reconnects`, `ms`, `outcome` ok/interrupted/failed, `reason?` failed only) — once per browser run, also on Ctrl+C, signals and failures, written before `command.finish`; none when the browser never opened — + LOGGING catalog + M2 doc + `mm logs` text + canary; no names, subjects or addresses
- [x] Review follow-ups: emoji + spacing-marks width overflow (C-023 MEDIUM, `width.ts`); sender column at least 8 wide (C-024; the subject shrinks); short too-small text "Too small - need 40x8" below 37 columns (C-025); stale doc texts (old `—` screen texts in the M2 doc/TODO, the NOOP-refreshes-UIDVALIDITY claim, the M2a section's doubled bullet and quota stand-in line)
- [x] Tests: terminal with fake streams/process (escape sequences, raw mode off, idempotent restore, signal/exit/crash paths, resize); controller with a fake terminal + fake session (loads, stale results, reconnect y/N/failure/challenge notice, `r`, Ctrl+C in every mode, an error → restore); `mm folders` (TTY → tree + browser + summary + exit codes + `browse.finish`; `--plain`, `--json`, no TTY → M2a output and the terminal never touched; existing tests pinned to non-TTY); reducer/renderer/width changes; `browse.finish` builder/schema/text/canary
- **Acceptance:** manual walk in a real terminal (screen restored after `q`, Ctrl+C and `kill -TERM`; resize; reconnect after the 5-minute idle timeout; opened mails still unread in webmail; `mm logs` shows `browse.finish` without names); lint, typecheck, tests, build, format:check green.

### M2c — `mm stats` (needs M2a)

Split 2026-10-02 with the user (`/next`): M2c-1 the command, M2c-2 measuring on a large mailbox. Per-folder table kept; Trash/Spam included in every stat. Implement M2c-1 right after M2b-2 is done (agreed 2026-10-02).

#### M2c-1 — `mm stats` (read-only)

- [x] Shared batched fetch `scanFolder` (`src/core/mailbox/scan.ts`): read-only lock (EXAMINE), sequence ranges of 5,000, each message streamed to a callback (no batch or message list kept); M2a's size fallback reuses it
- [x] Core `src/core/mailbox/stats.ts`, one streaming pass (UID, ENVELOPE, INTERNALDATE, RFC822.SIZE): totals; per folder (messages, bytes); per year (INTERNALDATE in a given time zone, missing → "unknown"); top 10 senders (lowercased address; none → "(no address)") and top 10 domains, by count and by size; 10 largest mails (folder, date, from, subject, size). At most 50,000 distinct senders/domains kept: later new ones go to "others" and the lists say "approximate". An unreadable folder is skipped and counted; a dropped connection → `MailboxError('connection-lost')`
- [x] Scope: all selectable folders incl. Trash/Spam; Gmail: All Mail + Trash + Spam only (labels are in All Mail → no double count); Gmail with All Mail hidden from IMAP → plain message + hint (show it in IMAP, or `--folder`); `--folder <path>` = that one folder (unknown / not selectable → error text)
- [x] `mm stats [id] [--folder X] [--json]`: id optional with one saved mailbox; one guarded login; progress on stderr (TTY only); text report (sizes "approx.", RFC822.SIZE ≠ quota); versioned JSON
- [x] Logging: `stats.finish` (`acct`, `folders`, `messages`, `bytes`, `ms`, `outcome`, `reason?`) + catalog + `mm logs` text + canary — never senders, domains, subjects or folder names
- [x] Tests: scan helper (batches, M2a size fallback unchanged); aggregation fixtures (years + time zone, senders/domains, no address, cap → approximate, largest 10, Gmail scope); command (text, `--json`, `--folder`, errors, progress, nothing private in the log); integration: `mm-test` totals / per year / per domain = manifest
- **Acceptance:** `mm-test` = manifest (150 messages, bytes, per year, per domain); Gmail not double-counted; memory bounded (no per-message list kept); `mm stats --json | jq` parses; lint, typecheck, tests, build, format:check green.

#### M2-fix — Review follow-ups from C-026 / C-027 (before M2c-2)

The three MEDIUM findings of the 2026-10-03 review (`.claude/changes.md`, Review notes of C-026 and C-027). Added 2026-10-04 with the user (`/next`).

- [x] `mm stats` short read: a folder whose scan ends without an error but with fewer messages counted than the folder holds (imapflow gives up on a throttled FETCH after 4 retries and returns nothing) is marked like a failed one — "(partial)" with its counts kept, or `—` when nothing was counted — and the first line's "read only partly" / "couldn't be read" notes count it. `collectStats` compares the messages that passed its FETCH filter with the folder's message count from EXAMINE
- [x] `mm folders` size fallback (same gap, M2a): a folder whose summed FETCH returns fewer sizes than it has messages gets size `—` and counts as "couldn't be read", instead of a too-small `~size`
- [x] `mm stats --folder`: when no folder has exactly that path, take the one folder whose path without invisible characters (as `mm folders --json` / `mm stats --json` print it) equals the given value; none or more than one → the `folder-not-found` text as today; the exact path still wins. M2 doc updated
- [x] Browser width (`src/cli/browser/width.ts`): a skin-tone modifier (U+1F3FB–1F3FF) counts 2 columns unless it directly follows an emoji that takes a skin tone (`👍🏽` stays 2), so a chain of modifiers is cut by `fit` like any long text
- [x] Tests: `collectStats` with an empty range, a short range and nothing at all (no error); the size fallback's short read; `statsScope` / `mm stats --folder` with ZWNJ, a ZWJ emoji, a soft hyphen, an ambiguous pair and exact-wins; width pins for modifier chains, the existing width values unchanged
- **Acceptance:** the three repros from the review no longer reproduce; lint, typecheck, tests, build, format:check green.

#### M2c-2 — Measure on a large mailbox (the user runs it; needs M2c-1)

- [ ] `mm stats` on a mailbox with ≥100k messages: time, peak memory (`/usr/bin/time -v`), totals vs. webmail/quota
- [ ] Decide on the local metadata cache (SQLite, TODO "Later") from those numbers

## M3 — Filters & search → [doc](docs/milestones/M3-filters-search.md)

- [ ] Decide: received vs sent date default; saved filter scope
- [ ] `filters/schema.ts` zod model (versioned)
- [ ] `filters/compile.ts` → SearchObject + post-filters + tests
- [ ] CLI flag parsing → filter (sizes, durations, dates)
- [ ] `mm search` (count, size, top senders, samples, `--json`)
- [ ] Gmail `X-GM-RAW` compile + cross-check vs standard search, `--gmail-only` (IMAP.md §5.6)
- [ ] Gmail search equivalence integration test (one case per mapping row, expected-differences list)
- [ ] Extend the M1b-3 test-ground generator with one seeded case per filter criterion (bump `SEED_VERSION`, then `npm run test:unseed` + `test:seed`)
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
- [ ] Basket from the M2b browser → delete plan (same notices → full list → two confirmations → Trash flow) — the default double check (confirmed 2026-10-01)
- [ ] Optional review folder (opt-in, later in M4): move the planned mails to a dedicated server folder first; local record of each mail's origin + `mm restore`; MOVE + UIDPLUS servers only; not Gmail; emptying uses the same confirm flow (design: M4 doc)
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

- `mm login` session check should fail closed (M1c-2 security audit, 2026-10-01): today a corrupt, unreadable (e.g. root-owned after `sudo mm login`) or non-JSON `session.json` counts as "no session" and login overwrites it without revoking anything. Only a missing file or `{}` should count as empty; anything else → "run `mm logout` first" (`logout` already clears it). Also re-check `isEmpty()` right before `signInWithPassword` (two parallel logins both pass the check). Related: `mm logout` while offline clears the local file but can't revoke the server token and still says "Logged out" — say so ("logged out on this computer only"); a relative `MM_CONFIG_DIR`/`XDG_CONFIG_HOME` should be refused (zod absolute path).
- Database setup without getting stuck (from 2026-09-29): today `mm doctor` only reports a missing table ("run npm run db:push"); automate or guide it (e.g. detect pending migrations and explain the one command, or apply them from a setup step) so non-technical users never hit a missing-table error
- Auth audit log retention: scheduled cleanup of `auth.audit_log_entries` older than 90 days (decided 2026-09-29; M6/M7 hosting)
- App shell (after M3, decided 2026-10-01): plain `mm` opens a home screen (accounts → folders → mails → stats/search) reusing the M2b screens; scripted commands stay
- Sort mails in the M2b browser (with M3 filters)
- Local metadata index (SQLite) for instant filtering on huge mailboxes
- Encrypted backup archives
- Hosted beta (M7) — after GDPR prerequisites (see docs/SECURITY.md); hosted observability from docs/LOGGING.md: log service (Vercel Log Drain / VPS shipper), error tracking (EU region), uptime, alerting, logs in the GDPR record of processing
- Migrate off Supabase (self-hosted Postgres / own auth)
- UI/UX design pass (priority after functionality)
- i18n: Slovak + English
- Duplicate-message finder
- Unsubscribe helper (List-Unsubscribe header) — read-only, no SMTP needed for HTTP links
- SMTP → full mail client
