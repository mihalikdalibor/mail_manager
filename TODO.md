# TODO

Source of truth for progress. One milestone at a time — details, design notes and open questions live in `docs/milestones/`.

**Current milestone: M0 (not started)**

---

## Step 0 — Planning & docs ✅

- [x] Folder structure, git init
- [x] README, CLAUDE.md, TODO.md, .gitignore, .env.example
- [x] Section docs (architecture, data model, security, providers, testing, deployment)
- [x] Milestone docs M0–M6
- [ ] User review of docs + resolve "Open questions" marked for M0/M1

## M0 — Scaffold & tooling → [doc](docs/milestones/M0-scaffold.md)

- [ ] `package.json` (ESM, engines node>=22.12, `bin.mm` → `dist/cli/index.js`), lockfile. Pin **TypeScript 6.0.x** (typescript-eslint supports <6.1; TS 7 is incompatible)
- [ ] `tsconfig.json` strict (NodeNext, noUncheckedIndexedAccess, exactOptionalPropertyTypes, explicit `types: ["node"]`) + `tsconfig.build.json` (src only → dist)
- [ ] eslint (flat config, typescript-eslint) + prettier config
- [ ] vitest config (unit by default; `test:integration` runs `tests/integration`, passes with no tests)
- [ ] `src/core/config.ts` zod env loader: reads `.env.local` then `.env` from the project root (real env wins), vars `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, optional `MM_MASTER_KEY` (+ `MM_MASTER_KEY_VERSION`); errors name the variable, never print values; dotenv silenced
- [ ] `src/core/master-key.ts` generate + validate (32 bytes after base64 decode)
- [ ] `src/cli/index.ts` commander skeleton (`--help`, `--version`)
- [ ] `mm keygen` — prints a new `MM_MASTER_KEY` value
- [ ] `mm doctor` — checks Node version, env present/valid, master key (warn if missing, fail if malformed), Supabase reachable via `GET /auth/v1/health` with the publishable key (timeout); never prints secrets; non-zero exit on failure
- [ ] npm scripts: dev, build, start, test, test:integration, lint, format, format:check, typecheck
- [ ] Secret scanning: gitleaks job in CI; local gitleaks documented as optional (not installed here)
- [ ] `.github/workflows/ci.yml` (npm ci, lint, format:check, typecheck, test, build, audit, gitleaks)
- [x] Verify licences of imapflow / mailparser (both MIT, checked 2026-09-21)
- [x] **User:** create Supabase cloud project (EU region) — keys in `.env.local`
- [ ] **User:** rename vars in `.env.local` to `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`; add `MM_MASTER_KEY` from `mm keygen`
- [ ] Update `.env.example`, docs (anon key → publishable key), CLAUDE.md Commands + current milestone, README Getting started
- **Acceptance:** fresh copy of the repo → `npm ci`, lint, format:check, typecheck, test, build green; `mm --help`/`--version` work; `mm doctor` passes against the real Supabase project and fails clearly with a bad key/URL; no secret value appears in any output; `.env.local` ignored by git.

## M1 — Auth, credential encryption, accounts → [doc](docs/milestones/M1-auth-accounts.md)

- [ ] Decide open questions (signup mode, Microsoft-unsupported message, account-removal audit behaviour)
- [ ] `supabase/migrations/0001_init.sql` — `mail_accounts` + RLS
- [ ] `crypto.ts` AES-256-GCM + AAD + key_version + tests
- [ ] `CredentialProvider` interface + local impl
- [ ] `AccountsRepo` interface + Supabase impl
- [ ] Supabase session storage (`~/.config/mail-manager/session.json`, 600)
- [ ] `mm signup` / `login` / `logout` / `whoami`
- [ ] Verify SK/CZ provider settings, write `presets.json`
- [ ] `providers/discover.ts` (presets → ISPDB → autoconfig → SRV → MX → manual) + tests
- [ ] `imap/session.ts` connect, TLS policy, capabilities, error mapping
- [ ] `mm account add` / `list` / `test` / `remove` / `update-password`
- [ ] Integration test: add + test account on test mailbox
- **Acceptance:** crypto/discovery tests pass; account add/test works on test mailbox; wrong password saves nothing; RLS two-user check; no password in output.

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
