# TODO

Source of truth for progress. One milestone at a time — details, design notes and open questions live in `docs/milestones/`.

**Current milestone: M1b (not started)** — M0 done 2026-09-21 (C-001); M1a done 2026-09-22 (C-002, C-003)

---

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

Decisions (2026-09-21): SK/CZ market first; synthetic test mail built with nodemailer MailComposer (devDependency, no SMTP); ~150 messages / ~25 MB seeded deterministically into folder `mm-test` of **test@mihalikdalibor.eu** (Websupport).

- [ ] **User:** add `MM_TEST_IMAP_USER=test@mihalikdalibor.eu` + `MM_TEST_IMAP_PASS` to `.env.local` (host comes from discovery; `MM_TEST_IMAP_HOST=imap.m1.websupport.sk` only as fallback)
- [ ] `presets.json` — SK/CZ: Websupport (`imap.m1.websupport.sk`, alt `imap.websupport.sk`), WebHouse (`mail.webhouse.sk`), Webglobe (`mail.webglobe.cz`, `imap.webglobe.sk`), Active24 (`email.active24.com`), HostCreators (`imap.hostcreators.sk`), Forpsi (`imap.forpsi.com`), Wedos (per-mailbox `imap-*.wedos.net` → manual host), Seznam/Email.cz/Post.cz (`imap.seznam.cz`), Zoznam, Azet, Centrum; global: Gmail, **Outlook (XOAUTH2 only — LOGINDISABLED, blocked until M6 OAuth)**, Yahoo, iCloud, GMX, Hostinger. Each with domains, **MX suffixes**, auth, hint, helpUrl, verified flag
- [ ] `providers/discover.ts` — order: email-domain preset → **MX-suffix preset** (primary for custom domains; e.g. mihalikdalibor.eu → mx10.websupport.sk) → ISPDB → autoconfig → SRV → manual; injectable DNS/fetch + unit tests
- [ ] `mm discover <email>` — shows detected provider/settings (no login)
- [ ] `imap/session.ts` — imapflow connect (993, cert verify, timeouts), post-auth capabilities, logout, error mapping (auth failed, host not found, TLS, timeout, OAuth-only/LOGINDISABLED)
- [ ] Provider restrictions analysis in `docs/PROVIDERS.md` (connection limits, auth, capabilities per provider, brute-force/IP-ban risk, Gmail limits, Outlook OAuth)
- [ ] Test ground: integration helpers (env, **folder guard: only `mm-test`**), deterministic synthetic mail generator (seeded; Slovak diacritics, varied senders/domains, dates 2019–2026, sizes 1 KB–5 MB, attachments, seen/flagged, `X-MM-Test-Seed` header) + manifest of expected facts, `npm run test:seed` (APPEND with internal dates), `npm run test:unseed`
- [ ] Integration tests on test@mihalikdalibor.eu: discovery → Websupport, login + capabilities recorded, seeded count/manifest match, guard refuses other folders
- **Acceptance:** discovery finds Websupport for test@mihalikdalibor.eu without manual host; login works; seeding is idempotent and matches the manifest; unit + integration tests pass; no password in output.

## M1c — Account commands (needs M1a + M1b)

- [ ] `mm account add [email]` — discover (+ provider picker for SK/CZ hostings) → hints → hidden password → test login → encrypt → save
- [ ] `mm account list` / `test` / `remove` (confirm) / `update-password`
- [ ] Integration test: add + test account on test@mihalikdalibor.eu; wrong password saves nothing
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
- **Acceptance:** counts match webmail; totals within rounding; Gmail not double-counted; memory bounded.

## M3 — Filters & search → [doc](docs/milestones/M3-filters-search.md)

- [ ] Decide: received vs sent date default; saved filter scope
- [ ] `filters/schema.ts` zod model (versioned)
- [ ] `filters/compile.ts` → SearchObject + post-filters + tests
- [ ] CLI flag parsing → filter (sizes, durations, dates)
- [ ] `mm search` (count, size, top senders, samples, `--json`)
- [ ] Integration seed script (`tests/integration/seed.ts`) + folder guard
- [ ] `0002_saved_filters.sql` + `FiltersRepo`
- [ ] `mm filter save/list/show/delete`, `--filter <name>`
- **Acceptance:** each criterion returns expected seeded set; nested logic tested; webmail counts match.

## M4 — Safe delete → [doc](docs/milestones/M4-safe-delete.md)

- [ ] Decide: expunge only after M5 (proposed)
- [ ] `planner.ts` + plan serialisation (compressed UID ranges) + tests
- [ ] `delete.ts` trash mode (MOVE / COPY fallback), UIDVALIDITY guard, batching + tests with fake session
- [ ] Expunge mode (UIDPLUS only) — gated
- [ ] Plan files + `--resume`
- [ ] `0003_audit_log.sql` (append-only) + `AuditRepo`
- [ ] `mm delete` confirmation UX (`--max`, `--yes`), `mm audit`
- [ ] Gmail handling (label vs delete, `\Trash`)
- **Acceptance:** exact UIDs only; abort on UIDVALIDITY change; no folder-wide expunge; resume works; audit correct.

## M5 — Backup / export → [doc](docs/milestones/M5-backup.md)

- [ ] `backup.ts` streaming `.eml` + single-pass sha256, `.part` → rename
- [ ] Path layout + filename/folder sanitisation + tests
- [ ] `manifest.json` + incremental skip
- [ ] `mm backup`, `mm backup verify`
- [ ] Optional mbox / zip
- [ ] Disk-space + Gmail daily-limit estimate
- [ ] Enable expunge-with-verified-backup in M4 flow
- **Acceptance:** counts/hashes verify; opens in Thunderbird; re-run adds 0; expunge removes only verified messages.

## M6 — Beta → [doc](docs/milestones/M6-beta.md)

- [ ] M6a Local HTML page (Fastify, localhost, CSP, CSRF)
- [ ] M6c IMAP→IMAP migration (old → new address)
- [ ] M6b `mm worker` + jobs (scheduled backup/cleanup)
- [ ] M6d OAuth2 Gmail + Microsoft
- [ ] MFA for app login
- [ ] Docker + hermetic IMAP tests in CI

---

## Later / ideas

- Local metadata index (SQLite) for instant filtering on huge mailboxes
- Encrypted backup archives
- Hosted beta (M7) — after GDPR prerequisites (see docs/SECURITY.md)
- Migrate off Supabase (self-hosted Postgres / own auth)
- UI/UX design pass (priority after functionality)
- i18n: Slovak + English
- Duplicate-message finder
- Unsubscribe helper (List-Unsubscribe header) — read-only, no SMTP needed for HTTP links
- SMTP → full mail client
