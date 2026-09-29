# Changes log

Written by `/implement` and `/fix`, one entry per run. Reviewed by `/review-changes`, which sets each entry's status.

## C-001 — M0 scaffold & tooling (+ mm doctor, mm keygen)

- **Status:** reviewed (2026-09-21)
- **Review:** All 13 criteria met (criterion 13 via the documented TODO deviation). Fresh-copy checks green, real `mm doctor` 4× OK exit 0, edge cases re-tested, no secrets in the commit. Deviations judged justified. Follow-ups (non-blocking): [MEDIUM] `src/core/config.ts:77-80` "set but empty — check your shell environment" hint also fires for an empty value in `.env.local` (reproduced), so reword it or track the source, and add a test for the hint; [LOW] gitleaks CI job never run, image pinned by tag not digest, add `persist-credentials: false`; [LOW] `src/cli/bin.ts` catch path untested; [LOW] CLAUDE.md:7 still says "awaiting /review-changes", update to "M0 done, M1 next".
- **Date:** 2026-09-21
- **Type:** feature
- **Source:** `.claude/plans/2026-09-21-m0-scaffold.md` · TODO.md → "M0 — Scaffold & tooling"
- **Base:** no commits yet (no HEAD). Files already present before the run (untracked, docs-only): README.md, CLAUDE.md, TODO.md, .gitignore, .env.example, docs/\*\*, .gitkeep placeholders; `.env.local` (user secrets, ignored).
- **Files:**
  - created: package.json, package-lock.json, tsconfig.json, tsconfig.build.json, eslint.config.js, .prettierrc.json, .prettierignore, vitest.config.ts, vitest.integration.config.ts, .github/workflows/ci.yml, src/cli/bin.ts, src/cli/index.ts, src/cli/commands/keygen.ts, src/cli/commands/doctor.ts, src/core/config.ts, src/core/master-key.ts, src/core/doctor.ts, tests/unit/{master-key,config,doctor,cli,cli-doctor}.test.ts
  - modified: .env.example, README.md, CLAUDE.md, docs/ARCHITECTURE.md, docs/DATA_MODEL.md, docs/SECURITY.md, docs/DEPLOYMENT.md, docs/TESTING.md, docs/milestones/M0-scaffold.md; all other docs/\*.md and TODO.md reformatted by Prettier only (no content change)
  - deleted: src/cli/commands/.gitkeep, tests/unit/.gitkeep
- **Requirements** (plan acceptance criteria, verbatim):
  - [ ] In a fresh copy of the repo (tracked plus untracked, non-ignored files) in the scratchpad, `npm ci && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build` all pass.
  - [ ] `npm test` passes, and `npm run test:integration` passes even though the integration folder is empty.
  - [ ] `npm run dev -- --help` and `node dist/cli/index.js --help` print usage listing `doctor` and `keygen`. `--version` prints the `package.json` version. _(entry is now `dist/cli/bin.js`; see Deviations)_
  - [ ] `mm keygen` prints exactly one line **to stdout**: a base64 string that decodes to 32 bytes. The hint goes to stderr. Each run gives a different value.
  - [ ] Empty-string env values (`MM_MASTER_KEY=`) are treated as missing: doctor shows WARN, not FAIL.
  - [ ] The empirical health-route check (real key vs bogus key status codes) is recorded in the Review log, and doctor uses a route proven to reject bogus keys.
  - [ ] `mm doctor` against the real project, after the user renames the vars, reports all checks OK (master key may be WARN if not yet added) and exits 0.
  - [ ] `mm doctor` with a wrong key or an unreachable URL (override via real env vars) reports FAIL with a clear reason and exits 1.
  - [ ] `mm doctor` with missing Supabase vars reports which variable is missing and exits 1.
  - [ ] No secret value (the key, the master key) appears in any command output (stdout **and** stderr), and no test fixture contains the real key.
  - [ ] Unit tests exist for config, master-key, doctor and the CLI wiring, and they pass.
  - [ ] `git check-ignore .env.local .claude/plans/x.md` confirms both paths are ignored.
  - [ ] CLAUDE.md "Commands" section is filled in, and its current milestone reads M0 done / M1 next. The TODO boxes are ticked. _(TODO left for /review-changes)_
- **Summary:** Turned the docs-only repo into a strict TypeScript 6 / Node 22 CLI (`mm`) with eslint, prettier, vitest, tsx and CI. Added a zod env loader (`.env.local` then `.env`, real env wins, no values in errors), master-key generation/validation, `mm keygen`, and `mm doctor` (Node, env, master key, Supabase `/auth/v1/health` reachability with redirects disabled). Docs updated to the publishable-key naming and the new commands.
- **Grade / mode:** M — solo + test writer
- **Verification:**
  - lint, format:check, typecheck, test (92 passed), test:integration (no tests, exit 0), build and `npm audit` (0 vulnerabilities) all green in the repo and in a fresh rsync copy with `npm ci`.
  - Real `mm doctor` → 3 OK + WARN (no master key yet), exit 0, including via a symlink from another directory.
  - Exit 1 with clear reasons for: bogus key (401), `invalid.invalid` (ENOTFOUND), empty `SUPABASE_URL`, http URL, URL with credentials, malformed master key.
  - The real key and the canary values were grepped out of stdout+stderr: 0 hits. keygen gives 1 stdout line, 32 bytes, distinct per run.
  - Mutation checks: disabling each key behaviour fails at least one test.
  - **Not verified:** the CI workflow was never run (no remote, no Docker locally, so the gitleaks job is untested); `npm link` wasn't run (global install), only simulated with a symlink.
- **Deviations:**
  - Entry point split into `src/cli/bin.ts` (bin/dev/start updated), replacing the planned `isEntryPoint()` check.
  - dotenv loaded per file.
  - Doctor uses `redirect: 'manual'`.
  - URL credentials rejected; strict decimal key version.
  - CI actions pinned by SHA, plus a `test:integration` step and a push branch filter.
  - TODO.md not updated (belongs to /review-changes): it still says "M0 (not started)" and references `dist/cli/index.js`.

## C-002 — M1a Supabase foundation: migration, crypto, auth

- **Status:** reviewed (2026-09-22)
- **Review:** Round 1 failed (public signups open on the cloud project, no Supabase timeouts). Round 2 passes together with C-003: all 12 criteria met; signups disabled live (`disable_signup: true`, doctor `signup` OK); 270 unit + 5 live RLS tests; CLI re-tested including an unreachable host. Follow-ups moved to TODO.md (M1c).
- **Date:** 2026-09-22
- **Type:** feature
- **Source:** `.claude/plans/2026-09-21-m1a-supabase-foundation.md` · TODO.md → "M1a — Supabase foundation: migration, crypto, auth"
- **Base:** 3805b587be9c5242efb4544365ef588f37994330; files already dirty before the run: `.claude/changes.md` (C-001 review), `.gitignore` (user edits: `.test.users.cred`, `.prettierignore`, `.prettierrc.json`), `CLAUDE.md` (user: docs line), `TODO.md` (M1 split), `docs/IMAP.md` (new, user)
- **Files:**
  - created:
    - `supabase/config.toml`, `supabase/.gitignore`, `supabase/migrations/20260921221108_init.sql`
    - `src/core/crypto.ts`, `src/core/credentials.ts`, `src/core/auth.ts`, `src/core/db/repos.ts`
    - `src/core/db/supabase/{client,session-storage,accounts-repo,auth-service,index}.ts`, `src/cli/commands/auth.ts`
    - `tests/unit/{crypto,credentials,session-storage,accounts-repo,auth-service,cli-auth}.test.ts`
    - `tests/integration/setup.ts`, `tests/integration/supabase-rls.test.ts`
  - modified:
    - `package.json`, `package-lock.json`
    - `src/core/doctor.ts`, `src/cli/commands/doctor.ts`, `src/cli/index.ts`
    - `tests/unit/doctor.test.ts`, `vitest.integration.config.ts`
    - `.github/workflows/ci.yml`, `.prettierignore`, `.gitignore` (removed a duplicate line only), `.env.example`
    - `README.md`, `CLAUDE.md` (milestone line + Commands), `docs/DATA_MODEL.md`, `docs/SECURITY.md`, `docs/milestones/M1-auth-accounts.md`
  - deleted: `src/core/db/.gitkeep`, `supabase/migrations/.gitkeep`, `tests/integration/.gitkeep`
- **Requirements** (plan acceptance criteria, verbatim):
  - [ ] `npm run db:push` applies the migration to the linked cloud project; re-running it is a no-op. (The user performs the link. If the project isn't linked yet, ask the user; don't work around it.)
  - [ ] In the cloud DB, `public.mail_accounts` exists with RLS enabled, 4 policies (select/insert/update/delete) for `authenticated` only, and no privileges for `anon`.
  - [ ] `mm login`: prompts for email (or takes `--email`) and a hidden password; on success prints `Logged in as <email>` and writes the session file (dir 700, file 600); wrong credentials → a clear message and exit 1, with no session file written or changed.
  - [ ] `mm whoami` prints the email and user id when logged in; when not logged in it prints "Not logged in — run `mm login`" and exits 1.
  - [ ] `mm logout` removes the local session (file deleted) and succeeds even when already logged out.
  - [ ] `mm doctor` has 2 new checks: `database` (ok when the table exists and anon is blocked; fail when the table is missing, with the hint "run `npm run db:push`"; fail when anon can read it) and `session` (ok with the email when logged in; warn when not logged in). Doctor's existing behaviour is otherwise unchanged.
  - [ ] `crypto.ts` unit tests pass: round trip; wrong key fails; tampered ciphertext / IV / tag fails; AAD mismatch fails, i.e. a ciphertext copied to another account or user can't be decrypted; IV is unique across calls; a wrong-length key is rejected.
  - [ ] The RLS integration test (`npm run test:integration`, with test-user env set) passes: A can create, read, update and delete its own row; B sees 0 of A's rows, B's update/delete of A's row affects 0 rows, and B can't insert a row with A's `user_id`; an anon client's select fails with Postgres code `42501` (an empty result is not acceptable); B can't change `user_id` or `id` of its own row (column-level grants); the stored `secret_ciphertext` isn't the plaintext and decrypts back with `CredentialProvider`; all test rows are cleaned up.
  - [ ] The integration suite **skips** (doesn't fail) cleanly when the test-user env is missing, which is the CI case.
  - [ ] No password, token, master key or secret value appears in any command output, log, error or test snapshot. Verify by grepping outputs for the test passwords.
  - [ ] Full checks green: lint, format:check, typecheck, test, test:integration, build, `npm audit --audit-level=high`.
  - [ ] Docs updated: DATA_MODEL, SECURITY, the M1 milestone doc, CLAUDE.md (Commands + current milestone), README (commands), `.env.example`.
- **Summary:** Added the persistence and identity layer:
  - `mail_accounts` migration: RLS, reset grants (no anon, no TRUNCATE), immutable `id`/`user_id`, `updated_at` trigger; applied to the cloud project.
  - AES-256-GCM secret encryption bound to user and account.
  - `AccountsRepo` + Supabase impl and `CredentialProvider`; auth service + file session storage behind a `createSupabaseServices` factory.
  - `mm login` / `logout` / `whoami`, and 2 new doctor checks (`database`, `session`).
  - Node floor raised to 22.13; CI runs 22.13 + 22.
- **Grade / mode:** M — solo + test writer (the risk signal alone is L; no disjoint slices; M1 was already split)
- **Verification:**
  - Mechanical:
    - lint, format:check, typecheck, build: clean
    - unit tests 242/242 (the test writer wrote 235 from the spec; 7 more were added after the review)
    - `npm audit`: 0 vulnerabilities
  - Live database:
    - migration listed as applied remotely; second `db:push` printed "Remote database is up to date"
    - anon `GET /rest/v1/mail_accounts` → 401 `42501`
    - `test:integration` 5/5 against the cloud project with the 2 test users; 0 leftover rows; skips 5/5 without the env
  - Secrets: 0 matches for the test passwords or the master key in the test output.
  - CLI, agent shell:
    - non-TTY login refused
    - `whoami` logged out → exit 1
    - `logout` idempotent
    - logout with a broken config still deletes `session.json`
    - missing config → clear error
  - CLI, **user ran interactively:** wrong password → error; correct → logged in as test@example-test-domain.eu. Then from the agent shell:
    - session dir 700, file 600
    - `whoami` printed email + id
    - doctor 6× OK
    - `logout` removed the file; `whoami` → exit 1
  - Mutation checks: each review fix is caught by a test.
  - **Not verified:**
    - the CI workflow run on GitHub (repo is private)
    - Ctrl+C exit 130 in a real terminal (unit-tested only)
    - an RLS policy mutation test: the policies on the shared cloud DB weren't broken on purpose to prove the test would fail
- **Deviations:**
  - The user's Supabase steps ran after Iterations 2–3, and in an external terminal: `supabase login` needs a TTY.
  - Beyond the plan: `revoke execute` on the trigger function; `enable_signup = false` in `supabase/config.toml`.
  - Review fixes:
    - `currentUser` throws `unreachable` on network errors
    - logout falls back to deleting the local session
    - fully hidden password prompt
    - unique tmp files
    - empty-email check
    - stronger plaintext test
    - CI Node matrix
  - Review findings #6, #7 and #8 were deliberately left (reasons in the plan's Implementation notes).
  - TODO.md was not updated; that belongs to /review-changes.

## C-003 — Review fixes for C-002: signup guard, Supabase timeouts

- **Status:** reviewed (2026-09-22)
- **Review:** All 6 previous findings resolved and verified (signup guard with 8 tests, request timeouts + overall auth deadline, narrowed isUnreachable, anon write denials live). The extras (forced clean exit, `db.retry: false`, Request-signal fix, 401 mapping) are justified; exit codes, help/version and piped output intact. Non-blocking follow-ups: `bin.ts` exit path has no unit test; the auth deadline doesn't cancel the underlying library call (ms window, acceptable for a CLI; add a comment).
- **Date:** 2026-09-22
- **Type:** review-fix
- **Source:** `.claude/review-output.md` (fixes C-002)
- **Base:** 3805b587be9c5242efb4544365ef588f37994330; files already dirty before the run: all C-002 work (uncommitted), `.claude/changes.md`, `.claude/review-output.md`, `docs/IMAP.md`, the user's `.gitignore`/`CLAUDE.md` edits
- **Files:**
  - modified: `src/core/doctor.ts`, `src/cli/commands/doctor.ts`, `src/cli/bin.ts`, `src/core/db/supabase/{client,index,auth-service,accounts-repo}.ts`, `tests/unit/doctor.test.ts`, `tests/unit/accounts-repo.test.ts`, `tests/integration/supabase-rls.test.ts`, `docs/DATA_MODEL.md`, `docs/SECURITY.md`, `docs/milestones/M1-auth-accounts.md`, `.claude/review-output.md` (boxes ticked)
  - created: `tests/unit/supabase-client.test.ts`
- **Requirements** (the review-output checkboxes):
  - [x] Docs accurate about invite-only; the `supabase/config.toml` `enable_signup` note corrected. **Correction to C-002's Deviations** (that entry isn't edited): `enable_signup = false` in `config.toml` affects only the local dev stack and a future `supabase config push`. The cloud setting is the dashboard toggle.
  - [x] [HIGH] Public signups disabled on the cloud project. The user toggled it in the dashboard; `/auth/v1/settings` → `disable_signup: true` (verified live).
  - [x] [HIGH→guard] `mm doctor` `signup` check (7 checks): ok / fail / key rejected / network / timeout / skipped, with tests.
  - [x] [MEDIUM] Timeout on all Supabase calls: fetch wrapper with `AbortSignal.timeout` combined with the caller's or Request's signal; configurable (10 s default, 5 s in doctor). Timeouts surface as `AuthError('unreachable')` / `RepoError('unavailable')`, with never-resolving-fetch tests.
  - [x] [LOW] `isUnreachable` narrowed to network failures and timeouts; a programming TypeError is not "unreachable" (tested).
  - [x] [LOW] RLS integration test asserts anon insert/update/delete → 42501.
- **Summary:**
  - Added the doctor `signup` guard.
  - Every Supabase request now has a timeout. PostgREST auto-retries are off (`db.retry: false`); otherwise one timeout becomes about 4× the budget plus 7 s.
  - After the independent review: auth operations get an overall deadline (auth-js retries an expired-token refresh for about 30 s before every call). `bin.ts` flushes output and exits when a command finishes, so library retry timers can't keep the CLI alive or print late error stacks.
- **Grade / mode:** M by file count — run solo (downgraded: small, fully specified fixes; the spec is the review file, so a spec-only test writer adds no independence). Independent review done.
- **Verification:**
  - lint, format:check, typecheck, build: clean
  - unit tests 270/270 (+28 over C-002)
  - `test:integration` 5/5 live, including the anon write checks
  - `npm audit`: 0 vulnerabilities
  - live `/auth/v1/settings` → `disable_signup: true`
  - live `mm doctor`: 7 checks, `signup OK (invite-only)`, under 1 s
  - Unreachable host (10.255.255.1) with an expired seeded session:
    - `whoami` → "Supabase unreachable" in 10.1 s (before this fix: 31.2 s plus a raw auth-js error stack)
    - `doctor` 20.1 s, each check capped at 5 s, session "could not check: Supabase unreachable"
    - `logout` 10.2 s, still deletes the session
  - piped `mm --help` output intact after the forced exit
  - secret leak grep: 0 hits
  - mutation checks: removing the timeout wrapper, re-enabling retries, not failing on `disable_signup: false`, or widening `isUnreachable` each make tests fail
  - **Not verified:** the CI run on GitHub (private repo); a real paused Supabase project (simulated with an unroutable IP)
- **Deviations:**
  - Beyond the listed boxes: the overall auth deadline and the forced clean exit in `bin.ts` (the review found the refresh path still took ~30 s); `db.retry: false`; the Request-signal fix; `signup` maps 401/403 to "key rejected".
  - Not done (optional in the review): running doctor's HTTP probes in parallel. Worst case stays ~20 s on a dead host.
  - The follow-ups (lowercase `host`, force timestamps on insert, revoke the old refresh token on re-login) stay in `review-output.md` for M1c / the next migration.

## C-004 — M1b-1 provider discovery: autodetect → provider picker → manual host, GeoIP warning (`mm discover`)

- **Status:** reviewed (2026-09-22)
- **Review:** all criteria met (GeoIP-in-output superseded by C-005); lint/typecheck/format/554 unit/31 integration/build/audit green; CLI + pseudo-terminal picker re-tested (incl. WEDOS host prompt). Follow-ups (non-blocking, carried into review-output.md): hex/octal IPv4 host names pass `normalizeHost` (MEDIUM), lowercase `%placeholder%` not rejected, free-text autoconfig username printed, displayDomain keeps IDN-dropped chars, readCapped listener not removed on cap.
- **Date:** 2026-09-22
- **Type:** feature
- **Source:** `.claude/plans/2026-09-22-m1b1-provider-discovery.md`. TODO.md → "M1b-1 — Provider discovery (no login)", including the user amendment (three tiers + GeoIP warning).
- **Base:** 4f1b6a21240dbf7f85405725b25250803d87ce47. Already dirty before the run: `TODO.md` (the M1b split and amendment from `/next`).
- **Files:**
  - New: `src/core/providers/{email,presets,settings,geoip,autoconfig,discover}.ts`, `src/core/providers/presets.json`, `src/cli/commands/discover.ts`, `src/cli/prompts/imap-settings.ts`, `tests/unit/{email,presets,settings,geoip,autoconfig,discover,imap-settings-prompt,cli-discover}.test.ts`, `tests/integration/discover.test.ts`.
  - Modified: `src/cli/index.ts`, `package.json`, `package-lock.json` (fast-xml-parser ^5.11.1), `docs/PROVIDERS.md`, `docs/TESTING.md`, `docs/milestones/M1-auth-accounts.md`, `docs/milestones/M6-beta.md`, `.env.example`.
- **Requirements** (plan acceptance criteria, verbatim):
  - [ ] `npm run dev -- discover <MM_TEST_IMAP_USER>` → provider Websupport, found via MX, host from the Websupport preset on 993, username = full address, no manual host; exit 0.
  - [ ] `npm run dev -- discover someone@gmail.com` → Gmail (preset by domain), hint about app password + helpUrl; exit 0.
  - [ ] `npm run dev -- discover someone@outlook.com` → Outlook recognised, **blocked** notice ("needs OAuth2, supported from M6"); exit 1.
  - [ ] A domain with no match anywhere (e.g. a random `*.invalid`) → status `manual` ("No IMAP settings found"), lists every tried source with its outcome; then **in a TTY** a picker offers every preset (SK/CZ first, then global; blocked ones shown disabled with the reason) plus "Enter IMAP host manually" and "Cancel".
    - picking a preset → its settings printed ("Chosen from list"), exit 0; picking Wedos (`imap: null`) → host prompt with the hostHint;
    - manual → host prompt (validated with `normalizeHost`, re-asked on invalid input) + username prompt (default = full address) → settings printed ("Entered manually"), exit 0;
    - Cancel → nothing printed beyond the list, exit 1; Ctrl+C → exit 130 quietly;
    - **no TTY** → no prompts; message "run in a terminal to choose a provider or enter the host manually", exit 1.
  - [ ] Every printed settings block (autodetected, picked, manual, needs-host) ends with the **GeoIP warning** naming "this computer" as the connecting location.
  - [ ] Discovery never throws for network/DNS/XML failures — each becomes a `tried` entry; only invalid email input is a user error (exit 1, clear message).
  - [ ] No plain-HTTP request is ever made (autoconfig/ISPDB URLs are https; a redirect to non-https is rejected).
  - [ ] STARTTLS/143-only or non-993 results are never returned as settings; a notice says they were skipped.
  - [ ] Every preset in `presets.json` passes the zod schema; ids, domains and MX suffixes are unique; each is `verified: true` with an official `helpUrl`, or `verified: false`.
  - [ ] `npm run build && npm start -- discover someone@gmail.com` works (presets JSON present in `dist/`).
  - [ ] Unit tests cover every edge case listed below; integration test passes with `MM_TEST_IMAP_USER` set and skips without it.
  - [ ] `docs/PROVIDERS.md`, `docs/milestones/M1-auth-accounts.md` updated; TODO boxes ticked; the real test domain appears in no tracked file.
  - [ ] `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm test`, `npm run build`, `npm audit` green.
- **Summary:** Discovery works in three tiers.
  1. **Autodetect** (core, no prompts): preset by email domain → preset by MX suffix → ISPDB → HTTPS autoconfig → SRV. It runs sequentially and stops at the first hit.
  2. **Provider picker** from 24 researched presets.
  3. **Manual host entry.**

  Every settings result carries a GeoIP warning (`geoIpNotice`; it has a server variant for M6). All untrusted input is hardened: strict host check including redirect targets, manual https-only redirects, a 256 KiB body cap, a deadline that also covers the body, the XML validated before parsing, and no server text in the output. `mm discover <email>` wires it together. `chooseImapSettings()` is ready for M1c's `mm account add`.

- **Grade / mode:** M — solo + test writer. The spec-based test-writer subagent wrote 8 unit test files, and its one failing test found a real gap (the nested `imap` schema wasn't strict). A research subagent compiled the presets in parallel. An independent review subagent ran at the end.
- **Verification:**
  - Baseline: typecheck, lint, 270 tests, build and format all green.
  - Now:
    - `npm run lint`, `npm run typecheck`, `npm run format:check`: clean.
    - `npm test`: 540 passed (20 files).
    - `npm run build` + `npm start -- discover someone@gmail.com`: exit 0, `presets.json` present in `dist/`.
    - `npm run test:integration` with `MM_TEST_IMAP_USER` set inline: 6 passed (discovery + RLS). Without it the discovery suite is skipped.
    - `npm audit --omit=dev`: 0 vulnerabilities.
  - Manual runs:
    - Test address → Websupport via MX, exit 0.
    - gmail.com → Gmail, exit 0. outlook.com → blocked, exit 1.
    - `a@nothing-here.invalid` → all five sources tried, no-TTY message, exit 1.
    - seznam.cz and web.de → live ISPDB parse (web.de with a local-part username).
    - `evil.com/x` and a zero-width domain → clean error, exit 1.
  - The picker was driven in a real pseudo-terminal:
    - pick Active24 → exit 0;
    - manual: `1.2.3.4` re-asked, `IMAP.Example.COM` → `imap.example.com`, exit 0;
    - Cancel → exit 1;
    - Ctrl+C → exit 130.
  - The real test domain appears in no tracked or new file (`git grep`).
  - **Not verified:**
    - The needs-host host prompt (WEDOS) in a real TTY; unit-tested only.
    - The interactive picker on Windows terminals.
    - Real DNS timeouts (the Resolver timeout is only exercised via a faked ETIMEOUT).
    - `MM_TEST_IMAP_USER` is not yet in `.env.local` (user box), so the integration test ran with the variable set inline.
- **Deviations:**
  - The schema gained `group`.
  - WEDOS/Webglobe/Centrum/GMX preset splits as described in the plan's Implementation notes.
  - needs-host in a TTY reports "Host entered manually".
  - Prompts require stdin **and** stdout to be terminals.
  - An ISPDB DNS failure is reported as `error` (offline).
  - Docs were updated as the item required. TODO.md was not touched (the Webglobe wording in the M1b-1 item still says `imap.webglobe.sk`; the preset uses `mail.webglobe.sk` with `imap.webglobe.sk` as an alt host). The CLAUDE.md "Current milestone" line was not updated.
  - The PROVIDERS.md open question "Cache ISPDB lookups?" is annotated as moot and still waits for the user's OK.

## C-005 — GeoIP hint moved from discovery output to connection failures

- **Status:** reviewed (2026-09-22)
- **Review:** all criteria met; no GeoIP text in discovery output, failure-hint wording + optional region verified. Follow-up: absence of GeoIP only asserted for `found` results.
- **Date:** 2026-09-22
- **Type:** feature (requirement change from the user, on top of C-004)
- **Source:** user, 2026-09-22: "the geoip warning should be printed when mail is not connected as something like, the connection was not succesful, check if the mail has not activated geoip security, if so add [server country] or dissalow it. for server country i am not sure where it will be hosted, for now only locally, then probably vercel or VPS."
- **Base:** same working tree as C-004 (uncommitted).
- **Files:** `src/core/providers/geoip.ts`, `src/cli/commands/discover.ts`, `tests/unit/geoip.test.ts`, `tests/unit/cli-discover.test.ts`, `docs/PROVIDERS.md`, `docs/milestones/M1-auth-accounts.md`, `docs/milestones/M6-beta.md`, `TODO.md` (M1b-1/M1b-2/M1c wording).
- **Requirements:**
  - [ ] `mm discover` prints no GeoIP text for any result.
  - [ ] `geoIpNotice()` reads as a connection-failure hint: the connection was not successful; check whether GeoIP security is on for the mailbox; if so, allow the country (CLI: this computer's public IP) or turn GeoIP off while Mail Manager connects.
  - [ ] Server variant: `region` is optional (hosting undecided). Without it the text reads naturally, with no `()` or `undefined`.
  - [ ] Docs/TODO say the hint is shown on connection failure (timeout/refused, from M1b-2), not with discovery results.
- **Summary:** removed the five GeoIP prints from `mm discover`; rewrote `geoIpNotice` as a failure hint with an optional server region; updated tests, docs and the backlog wording. Actually wiring it to connection errors is part of M1b-2 (already in its error-mapping box).
- **Grade / mode:** S — solo.
- **Verification:** `npx tsc --noEmit`, `npx eslint src tests`, `npm test` (541 passed), `prettier --write`. The CLI GeoIP-line tests now assert **absence**. Not verified: a real connection failure (no IMAP connection exists until M1b-2).
- **Deviations:** none.

## C-006 — Plain-language domain check, credentials-first connection hint, live preset check, error rules in CLAUDE.md

- **Status:** reviewed (2026-09-22)
- **Review:** Passed with C-008: all criteria met (no-mail/dead-end superseded by C-007); CLAUDE.md rule and PROVIDERS quote fixed; live preset check 31/31 integration green.
- **Date:** 2026-09-22
- **Type:** feature (user requests on top of C-004/C-005)
- **Source:** user, 2026-09-22. Summary of the requests:
  - CLAUDE.md must say the server's hosting country has to be set where it's deployed.
  - The connection message should also tell the user to check the credentials.
  - Check the domain: a DNS server error or missing MX records gets its own message.
  - Errors must be very well managed, because the users are mostly non-technical.
  - Cache goes into TODO (around M4–M5).
  - Keep the current providers and make sure they work.
- **Base:** same working tree as C-004 (uncommitted).
- **Files:** `src/core/providers/discover.ts`, `src/core/providers/geoip.ts`, `src/cli/commands/discover.ts`, `tests/unit/discover.test.ts`, `tests/unit/geoip.test.ts`, `tests/unit/cli-discover.test.ts`, new `tests/integration/presets-live.test.ts`, `CLAUDE.md`, `TODO.md`, `docs/PROVIDERS.md`, `docs/TESTING.md`, `docs/milestones/M1-auth-accounts.md`.
- **Requirements:**
  - [ ] The discovery result carries `domainProblem`: `ENOTFOUND` → `not-exist` (discovery stops: no ISPDB/autoconfig/SRV); `ENODATA` or only a null MX → `no-mail`; `ESERVFAIL`/`EREFUSED` → `dns-error`; timeout and other errors → `dns-unreachable`.
  - [ ] `mm discover` explains each problem in plain words (what happened + what to do). `not-exist` → typo hint, no picker, exit 1. The others still offer the picker/manual entry in a TTY. A `found` result with `no-mail` shows a warning.
  - [ ] `geoIpNotice` tells the user to check address/password/IMAP server first, then GeoIP.
  - [ ] CLAUDE.md: a "User-facing errors" section (plain language, typed reasons in core, no stack traces or raw messages) plus the rule that the server's hosting country must be configured wherever it's deployed (local → Vercel/VPS).
  - [ ] TODO: a discovery lookup cache item under M5 (around M4–M5). The PROVIDERS.md open question is resolved.
  - [ ] A live check that every preset host + alt host answers on 993 with a valid certificate and an IMAP greeting (no login).
- **Summary:** `tryMx` now maps DNS error codes to a typed `DomainProblem`, and `discover` stops early for non-existent domains, which keeps typos away from Mozilla. The CLI maps each problem to a plain-language message. The connection hint now puts credentials first. The live preset test covers 25 hosts. CLAUDE.md gained the error-handling rules and the note about the server's hosting country. The docs and TODO are updated.
- **Grade / mode:** S — solo.
- **Verification:**
  - `npx tsc --noEmit` and `npx eslint src tests` clean.
  - `npm test`: 555 passed. The fake DNS default changed from `ENOTFOUND` to `ENODATA` (the domain exists but has no MX) so the full chain is still exercised; new tests cover each domain problem and the CLI messages.
  - `npm run test:integration`: 31 passed (25 live preset hosts on 993, discovery via `.env.local`'s `MM_TEST_IMAP_USER`, RLS).
  - **Not verified:** a real `ESERVFAIL` through the CLI (codes were probed live with Node — `sk` A record → ESERVFAIL — but the CLI path is unit-tested only); wiring the GeoIP hint to a real failed connection (M1b-2).
- **Deviations:** none.

## C-007 — Domain check made non-blocking; "no MX records" warning removed

- **Status:** reviewed (2026-09-22)
- **Review:** all criteria met; not-exist hint non-blocking (picker in TTY, exit 1 without), missing MX never reported, verified live. Follow-ups: "below" wording without TTY; dns-unreachable hint can show next to found settings.
- **Date:** 2026-09-22
- **Type:** feature (user correction of C-006)
- **Source:** user, 2026-09-22: "for domain without MX records, it may still connect via IMAP right? this may cause false error when domain has no MX records, but the address is created and imap points to correct server? mx check may be good idea to remove then."
- **Base:** same working tree as C-004 (uncommitted).
- **Files:** `src/core/providers/discover.ts`, `src/cli/commands/discover.ts`, `tests/unit/discover.test.ts`, `tests/unit/cli-discover.test.ts`, `CLAUDE.md`, `TODO.md`, `docs/PROVIDERS.md`, `docs/milestones/M1-auth-accounts.md`.
- **Requirements:**
  - [ ] Missing MX records (`ENODATA`, null MX) are never reported as a problem. The MX lookup itself stays, because it matches custom domains to hosting presets.
  - [ ] "Domain doesn't exist" is a hint and not a dead end: it mentions typos and expired domains, still offers the picker/manual entry in a TTY (exit 0 after a choice), and prints the hint + exit 1 without a TTY. The online lookups (ISPDB/autoconfig/SRV) still stop for a non-existent domain.
  - [ ] `DomainProblem` is `not-exist | dns-error | dns-unreachable`, all informational.
  - [ ] CLAUDE.md: hints never block the user; no warning about missing MX.
- **Summary:** removed `no-mail`. `not-exist` no longer returns early in the CLI. Docs, TODO and CLAUDE.md now describe the domain check as informational.
- **Grade / mode:** S — solo.
- **Verification:** `npx tsc --noEmit` and `npx eslint src tests` clean; `npm test`: 554 passed (no-MX tests now assert no problem; not-exist offers the picker in a TTY, exit 1 without one).
- **Deviations:** none.

## C-008 — Review fixes for C-006 (+ non-blocking follow-ups from C-004/C-005/C-007)

- **Status:** reviewed (2026-09-22)
- **Review:** All 11 review-output items fixed and re-verified (585 unit, 31 integration, lint/typecheck/format/build/audit green; web.de/gmail/nonexistent-domain re-tested). Follow-ups (LOW): printable-ASCII username tokens without placeholder still accepted (could require a placeholder or narrower charset); dns-error wording "can't be looked up" contradicts settings found by a later source; readCapped listener not removed if read() throws non-abort.
- **Date:** 2026-09-22
- **Type:** review-fix
- **Source:** `.claude/review-output.md` (fixes C-006; follow-ups from C-004, C-005, C-007)
- **Base:** 4f1b6a21240dbf7f85405725b25250803d87ce47; files already dirty before the run: the whole uncommitted M1b-1 work of C-004…C-007
- **Files:** `CLAUDE.md`, `docs/PROVIDERS.md`, `src/core/providers/email.ts`, `src/core/providers/autoconfig.ts`, `src/core/providers/discover.ts`, `src/cli/commands/discover.ts`, `tests/unit/email.test.ts`, `tests/unit/autoconfig.test.ts`, `tests/unit/discover.test.ts`, `tests/unit/cli-discover.test.ts`, `.claude/review-output.md` (boxes ticked, status done)
- **Requirements** (every box of `review-output.md`):
  - [x] `CLAUDE.md:30` states "- Never show stack traces or raw library/server messages…"; no `\1` left.
  - [x] The `docs/PROVIDERS.md` GeoIP quote matches the credentials-first `geoIpNotice` text.
  - [x] The `CLAUDE.md:7` milestone line names C-007 and what is still pending.
  - [x] `normalizeHost` rejects hex/octal/decimal IPv4 forms (numeric or `0x` last label, plus a WHATWG URL round-trip); tested via email, autoconfig and SRV.
  - [x] The unknown-placeholder check is case-insensitive and uses own properties (`%emailaddress%`, `%constructor%` rejected).
  - [x] A server-provided username template must be one printable-ASCII token (no spaces, Unicode look-alikes or blank characters); real templates (`%EMAILADDRESS%`, `recent:%EMAILADDRESS%`, `domain\…`) still work.
  - [x] `displayDomain` is derived from the looked-up domain (`domainToUnicode(domain)`); a domain typed as ASCII/punycode is shown as typed (no look-alike Unicode).
  - [x] The not-exist wording works with and without a TTY (no "below"); the docs table matches.
  - [x] `dns-unreachable` is dropped when a later online source found settings; `dns-error` is kept. There is a CLI test for found + domainProblem.
  - [x] `readCapped` removes its abort listener when the cap is exceeded.
  - [x] Tests assert no GeoIP text for blocked, needs-host (TTY/no TTY) and picked results. dns-error/dns-unreachable in a TTY open the picker with exit 0. Blocked exits 1.
- **Summary:** fixed the corrupted CLAUDE.md rule and the stale PROVIDERS quote, and hardened discovery input: disguised IPv4 hosts, placeholder and property-name tricks, and free-text or look-alike usernames are rejected. The display domain now matches the lookup (typed punycode stays ASCII), the hints' wording and timing are corrected, and the missing tests are added.
- **Grade / mode:** S — solo.
- **Verification:**
  - lint, typecheck and format:check clean.
  - `npm test`: 585 passed (baseline 554).
  - build + `npm start -- discover someone@web.de`: username `someone` still accepted.
  - `npm run test:integration`: 31 passed.
  - `npm audit --omit=dev`: 0 vulnerabilities.
  - `grep '\1' CLAUDE.md`: no matches.
  - Mutation check: with the hex-IPv4 and placeholder fixes reverted, 9 of the new tests fail; restored, all pass.
  - Invisible-character scan of src/tests/docs is clean.
  - The independent review found items 5 and 6 only partly done, plus the typed-punycode look-alike, a stale doc row and a missing exit-code assertion. All were fixed in this run and re-verified.
  - Not verified: none beyond the earlier entries (a real DNS SERVFAIL through the CLI is still unit-tested only).
- **Deviations:**
  - Username restriction: the allowlist is applied to the server's template, not the final value, so users with Unicode local parts still work.
  - Typed punycode is displayed as ASCII (the reviewer's look-alike concern about item 7).

## C-009 — M1b-2a IMAP session: secure connect, ServerFeatures, error opacity, leak hardening

- **Status:** reviewed (2026-09-22)
- **Review:** all 15 criteria met (lint/typecheck/format/build/898 unit tests/audit, DNS integration; fake-client script: CR/NUL/empty rejected before the client is created, canaries absent everywhere, hostile error objects give `unexpected`; live IMAP suite not re-run because the wrong-password budget was used up, 3 clean runs recorded). Non-blocking follow-ups: no test for the `bin.ts`/`auth.ts` → `errorText` wiring; strict row parsing makes one bad capabilities row fail `list()`; repo schema allows lower-case names; the ConfigError text includes the absolute project path (pre-existing).
- **Date:** 2026-09-22
- **Type:** feature
- **Source:** `.claude/plans/2026-09-22-m1b2a-imap-session.md`, TODO.md → "M1b-2a — IMAP session (needs M1b-1)"
- **Base:** a89ede8f9e06aa5ab6e6169fb781490c5064f5b8. Files already dirty before the run: `TODO.md`, from `/next` (M1b-2 split into M1b-2a/M1b-2b, M6a items added).
- **Files:**
  - New: `src/core/imap/session.ts`, `src/core/imap/features.ts`, `src/core/imap/errors.ts`, `src/cli/imap-errors.ts`, `src/cli/error-text.ts`, `tests/unit/imap-features.test.ts`, `tests/unit/imap-errors.test.ts`, `tests/unit/imap-session.test.ts`, `tests/unit/cli-imap-errors.test.ts`, `tests/unit/cli-error-text.test.ts`, `tests/integration/imap-session.test.ts`.
  - Modified: `package.json`, `package-lock.json` (imapflow 2.0.5, exact pin), `src/cli/bin.ts`, `src/cli/commands/auth.ts`, `src/core/config.ts`, `src/core/db/repos.ts`, `src/core/db/supabase/accounts-repo.ts`, `tests/unit/accounts-repo.test.ts`, `tests/unit/config.test.ts`, `CLAUDE.md`, `docs/IMAP.md`, `docs/PROVIDERS.md`, `docs/SECURITY.md`, `docs/TESTING.md`, `docs/milestones/M1-auth-accounts.md`.
- **Requirements** (the plan's acceptance criteria):
  - [x] `imapflow` is added as an exact version (`2.0.5`, no caret), the lockfile is updated, and `npm audit` shows no high or critical issue from it. It is justified here: the only maintained full-featured IMAP client for Node, MIT licensed.
  - [x] `openSession()` connects with implicit TLS on 993 only, `rejectUnauthorized: true`, `minVersion: 'TLSv1.2'`, `disableAutoIdle: true`, `logger: false` and explicit timeouts. It sends only `name` and `version` as client ID; a unit test checks the options passed to the client factory.
  - [x] A failed login is attempted **exactly once**: no retry, no second auth mechanism. A fake-client test counts the `connect()` calls.
  - [x] After a successful connect, the password is gone from the client's options (fake-client test). An `ImapSession` object, whether inspected, JSON-serialised or printed as a string, never contains the password.
  - [x] A password or username containing CR, LF or NUL (or an empty password) is rejected with reason `invalid-credentials-input` **before** the client is constructed. A test checks that the factory is never called.
  - [x] `buildServerFeatures(capabilities, enabled)` returns the correct flags for these fixtures: the measured Websupport set, a Gmail-like set, a minimal rev1 set, rev2 advertised + enabled (folded flags on), and rev2 advertised but not enabled (not folded).
  - [x] `sanitizeCapabilities` drops names that don't match the pattern, values that aren't boolean or a finite non-negative number, and anything past the 256-entry / 64-character caps. A test feeds it a hostile map (5,000 entries, `__proto__`, control characters, objects, huge strings).
  - [x] Every `ImapFailureReason` is produced by `mapImapError` from a representative imapflow/Node error, with one table-driven test per reason plus `unexpected` for unknown input. Deviation: BYE `[CODE]` isn't available from imapflow, so closed connections map to `reset`.
  - [x] For every reason, a canary password `CANARY-…` (and a canary server text) is absent from `err.message`, `String(err)`, `util.inspect(err, { depth: 10 })`, `JSON.stringify(err)` and the CLI text.
  - [x] `imapErrorText(reason, from)` returns **the same** generic text for `auth-failed`, `app-password-required`, `password-expired`, `contact-admin`, `host-not-found`, `unreachable`, `refused`, `reset`, `timeout` and `server-rejected`. The generic text contains the GeoIP hint and the app-password hint, and has no bracketed code. Distinct texts: `no-internet`, `tls-certificate`, `oauth-only`, `server-unavailable`, `throttled`, `invalid-credentials-input`, `unsupported-server`, `unexpected`.
  - [x] `src/cli/bin.ts`: a plain `Error('raw library text CANARY')` prints "Unexpected error". The known user-facing error classes print their message, and `ImapSessionError` prints via `imapErrorText`.
  - [x] `AccountsRepo.get` / `updateSecret` / `recordCheck` / `remove` with a non-UUID id: `get` returns `null`, the others return `false`, and the Supabase client is not called. `recordCheck` accepts only `CapabilityRecord` and re-validates it with zod.
  - [x] Integration (runs only when `MM_TEST_IMAP_USER` and `MM_TEST_IMAP_PASS` are set): discovery finds the host → login OK → `features.uidplus`, `features.move` and `features.quota` are true → logout. Then exactly one wrong-password attempt → reason `auth-failed`, generic text. The password appears in no captured stdout/stderr/console output, in no error inspection, and not in the test report.
  - [x] Docs are updated: PROVIDERS.md (provider restrictions section), IMAP.md §7 (measured Websupport) + §9 M1 ticks, SECURITY.md (session, DB-injection audit, threat rows, error opacity), TESTING.md (IMAP integration test, one-wrong-attempt rule, leak check), the M1 milestone doc, and the CLAUDE.md "User-facing errors" rule.
  - [x] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run test:integration` and `npm run build` are all green.
- **Summary:**
  - New core IMAP session (`openSession`): verified TLS 1.2+, logging off, one attempt with no retry, and the password dropped from the client after connect. It also produces sanitised/capped capabilities, `ServerFeatures` with correct rev2 folding, and typed failure reasons that never carry server text.
  - The CLI shows one generic login-failure message (GeoIP + app password) for everything probe-able, and distinct messages only for safe cases.
  - `bin.ts` and the auth commands print only whitelisted core errors.
  - The repo got UUID guards and a capability schema.
  - Docs and the CLAUDE.md error rule are updated.
- **Grade / mode:** M — solo + test writer. The test writer wrote the 5 new unit files from the spec only, and found a real bug: throwing getters crashed `mapImapError`.
- **Verification:**
  - Baseline: lint, typecheck, format, build and tests green; 585 unit tests.
  - Now: lint, typecheck, format:check and build clean; `npm test` 898 passed; `npm run test:integration` 33 passed (4 files, including the live IMAP suite); `npm audit --omit=dev` 0 vulnerabilities.
  - Leak check with dotenv (raw, JSON-escaped, inspect-escaped, base64 PLAIN and base64 forms; requires that the IMAP suite ran): `clean`.
  - Live: login on the discovered Websupport host with features UIDPLUS/MOVE/QUOTA; a wrong password gave `auth-failed` plus the generic text.
  - Built CLI smoke: `--help`, and an unknown command exits 1.
  - Independent review: 10 findings.
    - Fixed: the BYE code parsing was dead against real imapflow (removed; `reset`); oauth-only was too loose; console output wasn't captured; `createClient` errors escaped; the password-too-long text; missing TLS codes; SECURITY.md wording.
    - Accepted and documented: strict row parsing; TODO/CLAUDE progress (TODO boxes are left for /review-changes); the public preset host name in TODO/IMAP.md.
  - Not verified: real TLS-certificate, OAuth-only (Outlook) and no-internet paths against live servers (unit-tested with fakes only); the throttled/unavailable paths from real servers.
  - Live wrong-password attempts against the test mailbox today: 3 (one per integration run).
- **Deviations:**
  - BYE `[CODE]` → `reset`, because imapflow drops the code.
  - oauth-only requires LOGINDISABLED.
  - Strict (not lenient) row capabilities parsing.
  - `auth.ts` `handleError` also uses `errorText`.
  - The `config.ts` env-file read error became a `ConfigError`.

## C-010 — Installed `mm` lost its executable bit after every build; exact test-provider IMAP hosts removed from docs

- **Status:** reviewed (2026-09-22)
- **Review:** root cause fixed (`postbuild` chmod 755; re-tested with a 644 file → 755; `mm -h`/`--help`/`-V`/`help discover`/`discover -h` exit 0, and `npm start`/`dev` still work). No exact IMAP/MX host remains outside `presets.json` and tests; the preset-format example passes `parsePresets`. Follow-ups: the hosts remain in git history (a89ede8, already pushed); the PROVIDERS.md table now points to presets.json only for Websupport.
- **Date:** 2026-09-22
- **Type:** bugfix
- **Source:** user request, 2026-09-22: "exact imap server remove from docs/todo. lets keep only records of them for imap match … make sure mm -h or mm --help is set up correctly."
- **Base:** a89ede8f9e06aa5ab6e6169fb781490c5064f5b8. Files already dirty before the run: the uncommitted C-009 work.
- **Files:** `package.json` (`postbuild`), `TODO.md`, `docs/IMAP.md`, `docs/PROVIDERS.md`, `docs/milestones/M1-auth-accounts.md`, `.claude/changes.md` (two host mentions in the C-004 entry sanitised; its status is unchanged).
- **Requirements:**
  - [x] After `npm run build`, `dist/cli/bin.js` is executable, so the `npm link`ed `mm -h`, `mm --help`, `mm -V` and `mm help <cmd>` work.
  - [x] The exact Websupport IMAP/MX host names appear in no doc, TODO.md or changes.md. They remain only in `src/core/providers/presets.json`, the records used for matching, and in the unit/integration tests that verify that matching.
- **Summary:**
  - Root cause: `tsc` rewrites `dist/cli/bin.js` with mode 664 on every build. The `npm link` symlink (`~/.local/bin/mm`) then fails with "Permission denied". A `postbuild` script now sets the file to 755 (via node, so it's cross-platform).
  - Docs now point to `presets.json` instead of naming the hosts. The PROVIDERS.md preset-format example uses a fictional `example-hosting` preset.
- **Grade / mode:** S — solo.
- **Verification:**
  - Reproduced: `mm -h` gave "Permission denied" and `dist/cli/bin.js` had mode 664.
  - After the fix: `npm run build` gives mode 755. `mm -h`, `mm --help`, `mm -V` (0.1.0) and `mm help discover` print the expected help. Every subcommand's `-h` was checked on the built CLI.
  - `git grep -i websupport.sk` outside presets.json and tests leaves only the official help-page link in the PROVIDERS.md table.
  - Not verified: Windows (the chmod there is a no-op, which is harmless).
- **Deviations:** none. Noted: `mm` with no arguments prints the help to stderr and exits 1 (commander's default). It is unchanged.

## C-011 — `mm logout` says "Not logged in" when there is no session

- **Status:** reviewed (2026-09-22)
- **Review:** all 7 criteria met. Root cause fixed in core (`LogoutResult`), CLI only prints. Re-tested with the built `mm` on a temp `MM_CONFIG_DIR`: no dir, corrupt/array file (deleted), data file twice (`Logged out` → `Not logged in`), broken config with/without data, `whoami` unchanged. lint/typecheck/build/910 tests green. Follow-ups (non-blocking): `session.json` as a dir or an unwritable config dir still gives "Unexpected error" (pre-existing). Not verified: a real `mm login` → `mm logout` (needs a TTY). Note: the uncommitted `eslint.config.js` change (ignores `.claude/`) is not part of C-011.
- **Date:** 2026-09-22
- **Type:** bugfix
- **Source:** `.claude/plans/2026-09-22-logout-without-session.md`, TODO.md → "Fixes (do first, before M1b-2b)" → "`mm logout` without a session"
- **Base:** 734a0aa1a5c1e3f3c937b250e22d931db46a0350. Files already dirty before the run: `TODO.md` (the item itself was added); untracked `.claude/agents/`, `.claude/commands/` (the user's, untouched).
- **Files:** `src/core/db/supabase/session-storage.ts`, `src/core/auth.ts`, `src/core/db/supabase/auth-service.ts`, `src/cli/commands/auth.ts`, `tests/unit/session-storage.test.ts`, `tests/unit/auth-service.test.ts`, `tests/unit/cli-auth.test.ts`, `docs/milestones/M1-auth-accounts.md`, `docs/SECURITY.md`.
- **Requirements** (the plan's acceptance criteria):
  - [x] No session file → `mm logout` prints exactly `Not logged in` (stdout), exit code 0, and `signOut` is **not** called (no network).
  - [x] A corrupt or unreadable session file (invalid JSON, a JSON array, only non-string values) → `Not logged in`, exit 0, no `signOut`. The corrupt file is deleted.
  - [x] A valid session → `signOut({ scope: 'local' })` is attempted (with a deadline, as today), the file is deleted, and it prints `Logged out`, exit 0. Unchanged when Supabase is unreachable: still `Logged out`, and the file is deleted.
  - [x] Broken config (`ConfigError` while building the service): if a session file with data existed, it's deleted and `Logged out` is printed. Otherwise `Not logged in` is printed. Exit 0 in both cases.
  - [x] Unit tests cover all cases in `tests/unit/cli-auth.test.ts` (CLI) and `tests/unit/auth-service.test.ts` (service result + no signOut when empty). `SessionStorage.isEmpty()` is covered by the contract tests in `tests/unit/session-storage.test.ts` for both implementations.
  - [x] Manual check with the built CLI: `mm logout` twice in a row → `Logged out` (if logged in), then `Not logged in`.
  - [x] `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm test` and `npm run build` are green. (`format:check` over the whole repo flags only the user's untracked `.claude/agents/security-auditor.md` and `.claude/commands/security.md`, which this run didn't touch. Every file this run touched passes.)
- **Summary:**
  - `SessionStorage.isEmpty()` is added (File: a missing or corrupt file is empty; Memory: map size).
  - `AuthService.logout()` returns `'logged-out' | 'not-logged-in'`. With no local session it clears (a corrupt file is deleted) and returns before any network call. The check runs synchronously first, so auth-js `initialize()` can't race it.
  - `mm logout` prints "Logged out" or "Not logged in" (exit 0 both). The broken-config fallback reports whether a session existed.
- **Grade / mode:** M planned → **solo** (downgraded as the plan allowed: tiny change, tests specified case by case). The independent review ran.
- **Verification:**
  - Baseline: 898 unit tests. Now: 910 passed. lint, typecheck and build are clean; prettier is clean on every tracked/touched file.
  - Mutation check: with the CLI message reverted to the unconditional "Logged out", 2 new CLI tests fail.
  - Built CLI with `MM_CONFIG_DIR` set to a temp dir (the real session was untouched):
    - no dir → `Not logged in` (exit 0, no dir created)
    - corrupt file → `Not logged in`, file deleted
    - data under another key → `Logged out`
    - again → `Not logged in`
    - `SUPABASE_URL=not-a-url` with a session → `Logged out`; without one → `Not logged in`
    - `mm whoami` unchanged (exit 1)
  - Independent review: no blocking findings. Fixed: the docs (M1 doc, SECURITY.md) and a missing end-to-end corrupt-file test. Accepted:
    - `session.json` being a directory or unremovable gives "Unexpected error" (unchanged from before);
    - any leftover key counts as a session (deliberate, documented, tested);
    - a mock-reset detail.
  - Not verified: a real login → logout against Supabase from this shell (the password prompt needs a TTY). The user can check `mm login` → `mm logout` → `Logged out` → `mm logout` → `Not logged in` in their own terminal.
- **Deviations:** the mode was downgraded to solo. Added: a `clearSession.mockClear()` in `beforeEach`, an end-to-end corrupt-file test, and two doc lines.

## C-012 — M1b-2b login guard: attempt policy, guardedOpenSession, block records

- **Status:** reviewed (2026-09-23)
- **Review:** all criteria met. lint/typecheck/build/prettier clean, 1078 tests. Scenario script (fake clock + opener): challenge → pair lock → post-lock challenge, 3 parallel pairs → IP block (also for `::ffff:` form, other IP unaffected), 10 parallel on one pair → opener 5×, no canary in keys/events, fail2ban regex = doc and matches only ip-blocked, texts with end time + zone. No deadlock between the pair and state queues. Follow-ups (LOW): an attempt already past its check still reaches the server when another pair triggers the IP block; loopback/link-local IPv6 share a bucket (server must pass the real client address); a logout error after a store error hides the store error; challenge wording always says "this mailbox".
- **Date:** 2026-09-22
- **Type:** feature
- **Source:** `.claude/plans/2026-09-22-m1b2b-login-guard.md`, TODO.md → "M1b-2b — Login guard (needs M1b-2a; before M1c)"
- **Base:** 734a0aa1a5c1e3f3c937b250e22d931db46a0350. Files already dirty before the run:
  - the uncommitted C-011 work (`src/cli/commands/auth.ts`, `src/core/auth.ts`, `src/core/db/supabase/{auth-service,session-storage}.ts`, their tests, `docs/SECURITY.md`, `docs/milestones/M1-auth-accounts.md`, `TODO.md`, `.claude/changes.md`);
  - the user's security tooling (`.github/workflows/ci.yml`, `eslint.config.js`, the `CLAUDE.md` hooks line, untracked `.claude/{agents,commands,security,settings.json}`), untouched.
- **Files:**
  - New: `src/core/security/{ip,events,attempt-store,login-guard}.ts`, `src/core/imap/guarded-session.ts`, `src/cli/login-guard-text.ts`, `tests/unit/{security-ip,security-events,login-guard,guarded-session,cli-login-guard-text}.test.ts`.
  - Modified: `src/cli/error-text.ts`, `tests/unit/cli-error-text.test.ts`, `docs/SECURITY.md` (Login guard section, threat row), `docs/milestones/M1-auth-accounts.md` (M1b-2b), `CLAUDE.md` (one sentence in "Secrets rules": only `guardedOpenSession` calls `openSession`).
- **Requirements** (the plan's acceptance criteria):
  - [x] **Pair policy** (same IP + same mailbox, fake clock):
    - after 0–1 counted failures `check` → `allow`; after 2 → `challenge-required`;
    - the 5th counted failure within 15 min locks the pair until `t5 + 15 min` (`too-many-attempts`, `until`);
    - at `until` exactly → no longer locked;
    - failures older than 15 min don't count (sliding window).
  - [x] **IP policy:**
    - 3 pair lockouts from one IP within 24 h (any mailboxes) → IP blocked 24 h (`ip-blocked`, `until`), for every mailbox from that IP;
    - lockouts older than 24 h don't count;
    - 3 IP blocks within 30 days → `permanent` (no `until`), which never expires on its own.
  - [x] **After a lock expires:** a pair with a lockout in the last 24 h stays `challenge-required` from its first new attempt.
  - [x] **Concurrency:** 10 parallel `guardedOpenSession` attempts for one pair → the opener is called at most 5 times; the rest get `LoginBlockedError`. Also, after the review: parallel attempts on different pairs don't lose IP or mailbox counter updates.
  - [x] **Mailbox policy:** 10 counted failures on one mailbox from 10 different IPs within 15 min → `challenge-required` for any IP (including a fresh one), **never** a lock. After 15 min the challenge is gone.
  - [x] **Only credential failures count:** `recordFailure` with `timeout`, `refused`, `reset`, `unreachable`, `host-not-found`, `no-internet`, `tls-certificate`, `server-unavailable`, `throttled`, `unsupported-server`, `invalid-credentials-input`, `oauth-only` or `unexpected` changes nothing. `auth-failed`, `app-password-required`, `password-expired`, `contact-admin` and `server-rejected` count.
  - [x] **Success** resets the pair failure counter. It does not remove existing IP lockouts, blocks or the permanent flag.
  - [x] **Store keys never contain a plain host, username or password**; the mailbox part is the HMAC target. Tested with a canary.
  - [x] **Permanent blocks survive serialization:** "permanent" is an explicit store flag, never `Infinity`.
  - [x] **IP normalization:** `::ffff:1.2.3.4` and `1.2.3.4` → the same bucket; IPv6 → the /64 prefix; `local` stays; invalid → `invalid`. Also: IPv4-compatible and NAT64 forms → IPv4, zone ids ignored.
  - [x] **Mailbox key normalization:** the host goes through `hostFromUserInput` (fallback: the lower-cased raw host). The HMAC input is `JSON.stringify([host, username])`, with the username lower-cased and trimmed.
  - [x] **Event records:**
    - one `SecurityEvent` per pair lock, IP block and permanent block (ts, event, kind, reason, ip, `addr`, attempts, until, target);
    - `formatEventLine` gives a single line starting `mm-security `;
    - the fail2ban regex matches only ip-blocked and permanent, captures `addr` via `<ADDR>`, and never matches a line without an `addr`;
    - no canary address, host or password in any event.
  - [x] **`guardTargetKey`:** deterministic HKDF-SHA256 (info `mm-login-guard-v1`, 32 bytes) returned as a Buffer; random without a master key. `hmacTarget` is case-insensitive.
  - [x] **`guardedOpenSession`:**
    - blocked → `LoginBlockedError`, the opener never called;
    - challenge → `onChallenge` runs before the opener; if it rejects, the opener isn't called;
    - allowed → the opener is called exactly once;
    - success → `recordSuccess`;
    - a counted failure → `recordFailure`, then either `LoginBlockedError` (if that failure caused a block) or the original error;
    - an uncounted failure → rethrown, nothing recorded.
  - [x] **CLI text** (`errorText`, distinct messages):
    - too-many-attempts: says so, names the end time, and gives the next step (password or app password, try again after);
    - ip-blocked: says so, names the end time, and says to try again;
    - `formatUntil` shows the time only today, the date and time otherwise, always with the time zone;
    - permanent: "Couldn't connect — this connection is blocked. Contact Mail Manager support.";
    - no brackets and no `undefined`.
  - [x] If `recordSuccess` throws, the just-opened session is logged out before the error propagates.
  - [x] `cliChallenge()` waits 5 s and prints one line saying so.
  - [x] Docs:
    - SECURITY.md "Login guard" section: policy table, what counts, effectiveness, event line, fail2ban filter (identical to the code constant, checked by script), 90-day retention;
    - M1 milestone doc updated;
    - CLAUDE.md rule: only `guardedOpenSession` calls `openSession`.
  - [x] lint, typecheck, prettier (touched paths), `npm test` and build are green.
- **Summary:**
  - New core login guard. The policy per (IP + mailbox) pair / IP / mailbox is as decided with the user: only credential failures count; challenge → 15 min lock → 24 h IP block → permanent; mailbox-wide attacks get a challenge only.
  - Counters are keyed by normalized IP and an HMAC target, never a plain address. All updates are serialized, and `withPairLock` makes check → login → record atomic per pair.
  - `guardedOpenSession` wraps `openSession` (blocked attempts never reach the server).
  - Block events become `mm-security {json}` lines with a fail2ban `<ADDR>` filter.
  - The CLI texts give the end time and next step. `cliChallenge` is an announced 5 s wait.
  - No command uses the guard yet; M1c wires it up.
- **Grade / mode:** M — solo + test writer. The test writer wrote 189 spec-driven tests (6 files) and found no implementation bugs.
- **Verification:**
  - Baseline: 910 unit tests. Now: 1078 passed (30 files). lint, typecheck and build are clean; prettier is clean on `src tests docs *.md package.json .claude/changes.md`; `npm audit` shows 0 vulnerabilities.
  - The time-format and guard tests also pass with `TZ=UTC` and `TZ=Asia/Kathmandu`.
  - Scenario script with a fake clock: challenge from the 3rd attempt, a lock on the 5th, the challenge after the lock, an IP block after 3 locks, another IP unaffected, no canary in store keys, the fail2ban regex matching only ip-blocked.
  - Mutation checks:
    - without the guard-wide serialization, both new cross-pair concurrency tests fail;
    - the 10-parallel test depends on `withPairLock` (reviewer confirmed).
  - The user's offline security probes (`CI=1 bash .claude/security/probes/run-all.sh`): static-rules, input-fuzz, discovery-ssrf, imap-session and crypto-local are clean. secrets-scan reports 6 findings, all in git history commit 0ed2604 (pre-existing, not this change).
  - Independent review: 1 high (cross-pair lost updates → fixed + tests), 3 medium (IPv6 forms → fixed; the fail2ban `<HOST>` vs /64 → `addr` + `<ADDR>`; `withPairLock` re-entrancy → documented), 5 low (username trim → fixed; the docs overstated wiring → fixed; host aliases, store TTL and spoofable `local` → documented; a store error hiding the IMAP error → accepted).
  - Not verified:
    - a real fail2ban/Cloudflare setup (M6a);
    - behaviour with a persistent store (M6a);
    - an end-to-end CLI flow, since no command calls `guardedOpenSession` yet (M1c).
- **Deviations:**
  - guard-wide `exclusive` serialization;
  - the `addr` event field and the `<ADDR>` regex;
  - wider IPv4-in-IPv6 handling;
  - username trim;
  - the `pairLockoutChallengeMs` policy field;
  - the test writer's tests updated to these spec changes.

## C-013 — M1b-3a synthetic mail generator (offline test ground)

- **Status:** reviewed (2026-09-24)
- **Review:** All 16 criteria met (reviewer re-ran typecheck/lint/test/build/format, the generator test incl. another TZ, npm ls/audit; a throwaway double build matched the pinned digest; dumped messages inspected; sub-stream no-overlap claim verified; tests/integration not run). Non-blocking follow-ups: the tiny message has one base sentence though the plan's edge-case text said none (guarded by the <1,100 B check); the test comment "every message has a diacritic in From or Subject" (encoded-words check) only holds for this seed — relax it when `SEED_VERSION` changes; the live `imap-session` integration failure from the accidental run is still uninvestigated (user to check the mailbox).
- **Date:** 2026-09-24
- **Type:** feature
- **Source:** `.claude/plans/2026-09-24-m1b3a-test-ground-generator.md`, TODO.md → "M1b-3 — Test ground" → "M1b-3a — Synthetic mail generator (offline)"
- **Base:** c113bf24c4309f4596b788b0ec4b9d97cf78fd72. Files already dirty before the run: `TODO.md` (the M1b-3 rewrite + 3a/3b split from `/next`, confirmed by the user).
- **Files:**
  - Created: `tests/support/test-ground/prng.ts`, `tests/support/test-ground/content.ts`, `tests/support/test-ground/manifest.ts`, `tests/support/test-ground/generator.ts`, `tests/unit/test-ground-generator.test.ts`.
  - Modified: `package.json` + `package-lock.json` (devDependency `nodemailer` 10.0.10, exact), `eslint.config.js` (`no-restricted-imports` for `nodemailer` under `src/**`), `docs/TESTING.md`, `docs/milestones/M1-auth-accounts.md` (M1b-3 decisions, M1b-3a design + verification), `README.md` (project tree), `CLAUDE.md` (one Conventions line on `tests/support/` + `SEED_VERSION`).
- **Requirements (plan acceptance criteria):**
  - [ ] `buildTestGround()` returns exactly 150 messages; building twice gives identical `raw` bytes and identical facts.
  - [ ] `groundDigest()` covers raw bytes **and** each message's facts; equals `PINNED_DIGESTS[SEED_VERSION]` in the unit test; any output/facts change fails with "generator output changed: bump SEED_VERSION and add a new PINNED_DIGESTS entry" (existing entries never edited).
  - [ ] Every message 1,024–4,900,000 bytes; total 20 MiB–28 MiB; ≥ 1 message < 1,100 bytes and ≥ 1 > 4,718,592 bytes.
  - [ ] Internal dates 2019-01-01 … 2026-06-30 (UTC, whole seconds), ≥ 8 per year 2019–2026; exactly 6 messages with a Date header 1–3 days earlier, all others equal.
  - [ ] Raw `Date` header = `new Date(sentDate).toUTCString().replace('GMT', '+0000')`.
  - [ ] Header ↔ facts: `From` address + name, `To`, decoded `Subject`, `Message-ID`, number of attachment parts, decoded `filename*0*=utf-8''…` names.
  - [ ] Slovak diacritics in each category (names, subjects, file names, bodies — QP-encoded Slovak letter in ≥ 90% of bodies); full set `áäčďéíľĺňóôŕšťúýž` across categories; all pool strings NFC.
  - [ ] Exactly one case-sensitive `X-MM-Test-Seed: v<SEED_VERSION>-<NNN>` header and a unique `Message-ID: <v<N>-<NNN>@mm-test.invalid>` per message.
  - [ ] CRLF only; no `X-Mailer`; `=?UTF-8?Q?` words; `filename*0*=utf-8''` parameters.
  - [ ] Reserved domains only (`*.test`, `*.example`, `*.invalid`, `example.com/.net/.org` + subdomains); ≥ 10 × `spam.test`, ≥ 3 × `spam.test.evil.test`; recipient always `mm-test@mm-test.invalid`.
  - [ ] Flag combos ≥ 5 each (none, `\Seen`, `\Flagged`, both); ≥ 30 with and ≥ 30 without attachments; ≥ 5 with exactly 2.
  - [ ] Manifest totals (count, bytes, per year, per domain, seen, flagged, with attachments, date offset) = sums over facts; `facts.size === raw.length`.
  - [ ] No network: socket connect / DNS / fetch spied to throw during building; MailComposer with `disableUrlAccess` + `disableFileAccess`.
  - [ ] nodemailer devDependency pinned exactly 10.0.10, no transitive packages, only `nodemailer/lib/mail-composer` imported, nothing under `src/` imports it.
  - [ ] lint, typecheck, test, build, format:check green; digest identical under `TZ=Pacific/Kiritimati`.
- **Summary:** Deterministic synthetic test mail for the `mm-test` folder, in `tests/support/test-ground/` (test tooling, no `src/` change): mulberry32 PRNG with per-message sub-streams, invented Slovak content pools on reserved domains, a two-phase generator (plan all specs from one stream → compose each with nodemailer MailComposer, adjusting a text filler to fixed size-class targets), and an in-code manifest. Output: 150 messages, 28,044,687 bytes (26.75 MiB), 1,030 B … 4,850,000 B, digest `4e691928…481b` pinned for `SEED_VERSION` 1. Seeding/guard/live test are M1b-3b.
- **Grade / mode:** M — solo + test writer. The test writer wrote the unit test file from the spec + interfaces only (34 tests; 33 passed on first run against the code, the 34th was the digest placeholder). After the independent review the file was tightened to 36 tests.
- **Verification:**
  - Baseline: 30 files / 1078 unit tests, lint/typecheck/build/format green. Now: 31 files / 1114 passed; lint, typecheck, build, format:check green, no warnings; `dist/` contains no `tests/support`.
  - `TZ=Pacific/Kiritimati LANG=tr_TR.UTF-8 npx vitest run tests/unit/test-ground-generator.test.ts` → 36 passed (same digest). Throwaway build script: identical digest over 3 runs + another TZ; ~0.8 s per build.
  - `npm ls nodemailer` → 10.0.10, no children; `npm audit --audit-level=high` → 0 vulnerabilities; `grep -rn nodemailer src/` → nothing; the new ESLint rule was proven to fire on a probe import under `src/core/` (probe deleted).
  - Raw output inspected (`.eml` dumps in the session scratchpad, not committed): exact `X-MM-Test-Seed` casing, valid `Date: … +0000`, Q-encoded words, `filename*0*=utf-8''`, fixed boundaries, CRLF, no `X-Mailer`.
  - Mutation checks (each reverted): no `normalizeHeaderKey`, date as string, LF newlines, no date offsets, real-domain recipient, ASCII-only bodies, wrong attachment bytes, B-encoded headers — each fails the intended test(s).
  - Offline security probes (`bash .claude/security/probes/run-all.sh`): static-rules, input-fuzz, discovery-ssrf, imap-session, crypto-local, local-hygiene clean; secrets-scan reports the same 6 findings in git history commit 0ed2604 as in C-012 (pre-existing, not this change).
  - Independent review: 0 bugs in the generator (it independently verified sizes, dates, 85/85 attachment decodes, 7-bit output, no split multibyte Q-words). 1 medium + 7 low test/doc findings, all resolved: body-diacritics test now checks only the text/plain part (it previously also matched Q-encoded headers); attachments decoded and checked against `bytes`/`contentType`; every encoded word must be `=?UTF-8?Q?` and every disposition `filename*0*=utf-8''`; strict per-word UTF-8 decoding; exact design constants asserted (50/60/20/20 flags, 12/4 spam senders, 79 with attachments, 6 with two); network spies cover both builds + `dns.resolve`; ESLint rule for `src/`; comments corrected (~26.7 MiB; sub-stream independence wording).
  - **Accidental live run:** `npm run test:integration` was run once as a "suite loads" check, but `.env.local` has `MM_TEST_IMAP_*` set, so it ran the live IMAP session test (one good login + its one allowed wrong-password attempt). 1 of 33 failed; re-running only the three non-login files (presets, discover, supabase-rls) → 31/31 passed, so the failure is in `tests/integration/imap-session.test.ts`. This change touches nothing under `src/` or `tests/integration/`; the live test was deliberately **not** re-run (no repeated wrong-password attempts) — cause not investigated, no baseline for it.
  - Not verified: anything live (upload, server `RFC822.SIZE`/`INTERNALDATE` equality, `PERMANENTFLAGS`) — that is M1b-3b.
- **Deviations:**
  - `TODO.md` boxes and the "Current milestone" lines in `TODO.md` / `CLAUDE.md` not updated (left to `/review-changes`, per `/implement`).
  - 79 messages with attachments, not the 77 the plan's table text said (31 + 38 + 8 + 2 = 79; plan arithmetic slip); the test asserts 79.
  - Added the `eslint.config.js` rule (review finding) — not in the plan.
  - Unit test file tightened after review beyond the plan's list (see above).

---

## C-014 — M1b-3b test ground: folder guard, seed/unseed scripts, live test

- **Status:** reviewed (2026-09-28)
- **Review:** All criteria met. Live criteria judged from code + the recorded runs, not re-run live: the review's one `test:seed` was denied by the permission classifier. Reviewer re-ran the 3 unit files (188/188), the missing-env/unknown-command CLI paths (exit 1, no login), a grep for expunge/close/move/rename/delete calls (none), and a leak check over every changed file (clean, and proven to detect planted values). 3 mutation probes (selected-path re-check, keyword preservation, refuse-before-reset) each failed tests. It also traced imapflow 2.0.5: no implicit CLOSE/EXPUNGE, BODY.PEEK fetch. Full baseline green (1302 tests). Deviations justified. Non-blocking follow-ups: [LOW] `docs/milestones/M1-auth-accounts.md:95` and `docs/TESTING.md:40` still say unsubscribe → DELETE; the code is DELETE → best-effort unsubscribe (`folder.ts:232-235`). [LOW] the NOOP refresh before trusting a cached 0 count (`folder.ts:145`) isn't in the docs. [LOW] `TestFolder.path` is a public `readonly` (TS-only); a `#path` + getter would make it tamper-proof. [LOW] `leak-check.ts:36` silently skips values under 4 chars, so a very short password reports "clean" unchecked. [info] `imap-session.test.ts` now errors instead of falling back to `MM_TEST_IMAP_HOST` when discovery says `blocked` (can't happen for the test provider).
- **Date:** 2026-09-24
- **Type:** feature
- **Source:** `.claude/plans/2026-09-24-m1b3b-test-ground-seed.md`, TODO.md → "M1b-3 — Test ground" → "M1b-3b — Folder guard, seed/unseed, live test (needs M1b-3a)"
- **Base:** 7a5712a715a56cceb21cd39f70d6c5689d788f16. Files already dirty before the run: `TODO.md` (M1b-3b item rewrite from `/next`, confirmed by the user).
- **Files:**
  - Created: `tests/support/test-ground/errors.ts`, `folder.ts`, `seed.ts`, `unseed.ts`, `live-env.ts`, `cli.ts`, `leak-check.ts`; `tests/unit/test-ground-folder.test.ts`, `tests/unit/test-ground-seed.test.ts`, `tests/unit/test-ground-cli.test.ts`; `tests/integration/test-ground.test.ts`.
  - Modified: `tests/integration/imap-session.test.ts` (shared env/discovery helper, comment), `package.json` (`test:seed`, `test:unseed`), `docs/TESTING.md`, `docs/milestones/M1-auth-accounts.md` (M1b-3b design + verification), `.env.example`, `CLAUDE.md` (Commands), `README.md` (scripts table).
- **Requirements (plan acceptance criteria, verbatim):**
  **Guard**
  - [ ] `TestFolder` resolves its path once from the server's personal namespace: `prefix + 'mm-test'`, e.g. `mm-test` or `INBOX.mm-test`.
  - [ ] Every folder operation (`exists`, `create`, `remove`, `messageCount`, `open`) throws `FolderGuardError` for any other path **before any IMAP method call on the client**. That includes `INBOX`, `Trash`, `mm-test/x`, `<prefix>mm-test.x`, `MM-TEST`, `mm-test2`, `*`, `%`, `''`, `' mm-test'`, and plain `mm-test` when the prefix is non-empty.
    - "Zero calls" means no call to any `FolderClient` method except the two read-only getters `namespacePrefix()` and `selectedPath()`.
    - Unit tests prove it with a recording fake.
  - [ ] Operations on an opened folder (fetch, append, set flags) check that the selected folder is still exactly the test folder and that the handle hasn't been released; otherwise they throw. A second `open()` while one is still open is refused, because imapflow's lock would wait forever.
  - [ ] `remove` refuses while the test folder is selected (imapflow would send `CLOSE`, which expunges). Unseed always uses a fresh session.
  - [ ] `TestFolder.fromSession(session)` requires `session.client instanceof ImapFlow`, else it throws `TestGroundError`. Tests and scripts only use `TestFolder`. No file under `src/` changes.
  - [ ] No call anywhere in `tests/support/test-ground/` to `messageDelete`, `mailboxClose`, `messageMove`, `mailboxRename` or `expunge` (checked by grep).

  **Adapter (the `ImapFlow` → `FolderClient` view)**
  - [ ] Every folder command that imapflow can "succeed" with a falsy result throws `TestGroundError` instead: `mailboxCreate`/`mailboxDelete` return `undefined` when not authenticated, `status` returns `false`, `append` returns `false`, `mailboxUnsubscribe` returns `false`.
  - [ ] `listPaths()` skips `\Noselect`/`\NonExistent` entries.
  - [ ] `internalDate` accepts `Date | string`; an unparsable value becomes an invalid Date, which classifies as "changed".
  - [ ] Flags are normalized to sorted **system flags only** (`\Seen \Flagged \Answered \Draft \Deleted`). `\Recent` and keywords such as Dovecot's `$HasAttachment` are ignored, so server-added keywords never count as drift.
  - [ ] Unit-tested offline over `Object.create(ImapFlow.prototype)` with stubbed methods, through the exported pure helpers `parseSeedId(buffer)` and `normalizeFlags(iterable)`.

  **Seed**
  - [ ] **`planSeed` (pure):** server messages are split by their `X-MM-Test-Seed` header (name matched case-insensitively) into expected, missing, flag drift, and unexpected.
    - Unexpected = foreign (no or unknown seed id), duplicate (a seed id seen again), older version (`v<N>-NNN` with N ≠ `ground.version`), or changed (size or internal date differs).
    - Drift compares system flags only.
  - [ ] **`seedTestGround` flow:**
    1. create `mm-test` if missing;
    2. open it;
    3. plan;
    4. if anything is unexpected, throw `SeedRefusedError` with the four counts; **nothing is appended or changed**;
    5. reset drift (STORE `FLAGS` set to the manifest flags plus any keywords the server already had);
    6. append the missing messages in index order, each with its flags and `internalDate`;
    7. verify.

    It returns `SeedReport` = `{ created, appended, flagsReset, total }`. A second run reports `appended: 0, flagsReset: 0`.

  - [ ] **`verifySeed` (pure):** the count equals `ground.messages.length`, and each seed id appears once with the manifest's size, internal date (ms equal; the server stores whole seconds and the manifest dates are whole seconds) and system flags. Otherwise `SeedVerifyError` with the mismatch count.

  **Unseed**
  - [ ] A missing folder gives `{ deleted: false }` and "nothing to delete", exit 0.
  - [ ] Otherwise it reads the message count (STATUS), UNSUBSCRIBEs (guarded; `mailboxCreate` auto-subscribes), DELETEs, then checks `exists()` is false, otherwise `TestGroundError`. It reports the count.
  - [ ] Never `EXPUNGE`, never a flag change.

  **Scripts** (`npm run test:seed` / `npm run test:unseed` → `tsx tests/support/test-ground/cli.ts seed|unseed`)
  - [ ] One login per run via `guardedOpenSession` (in-memory `LoginGuard`, `guardTargetKey(undefined)`, `clientIp: 'local'`, a no-op challenge), and `logout()` in `finally`.
  - [ ] Output is counts only. Progress `Uploading test messages: N/M` every 10 appends and at the end (M = missing count). The final lines use `total`, never a hard-coded 150.
  - [ ] Top-level `.catch`, plus `process.on('unhandledRejection' | 'uncaughtException')`, all go through `errorText`. Then stdout and stderr are flushed and `process.exit()` runs, as in `src/cli/bin.ts`, so library timers can't keep the process alive.
  - [ ] **`errorText(err)`:**
    - `ImapSessionError` → `imapErrorText(reason, { kind: 'this-computer' })`;
    - `LoginBlockedError` → `loginBlockedText(err)`;
    - `TestGroundError` subclasses → their fixed message;
    - an imapflow error with `serverResponseCode === 'OVERQUOTA'` → "The test mailbox is full. Free space in it (e.g. empty Trash), then run npm run test:seed again.";
    - anything else → `Unexpected error (<name>)` when `err.name` matches `/^[A-Za-z][A-Za-z0-9_]{0,40}$/`, otherwise `Unexpected error`, which also covers thrown non-Errors;
    - missing env → `MISSING_ENV_TEXT` ("Set MM_TEST_IMAP_USER and MM_TEST_IMAP_PASS in .env.local (see .env.example).").

    All exit 1. No text ever contains the password, address, host or a raw error message; a canary unit test checks this.

  **Env helper**
  - [ ] `readLiveImapEnv(env?)` returns `LiveImapEnv | null`. Address and fallback host are trimmed; the password is checked for emptiness only and **passed raw, never trimmed**, as today in `imap-session.test.ts:18`. The password is kept out of `inspect`/`JSON`: a non-enumerable property or a getter over a private field, plus `inspect.custom`.
  - [ ] `resolveLiveSettings(address, fallbackHost)` finds the host through real-DNS discovery (no HTTP), falls back to `MM_TEST_IMAP_HOST`, and otherwise throws a plain `TestGroundError` naming the variable, not a value.
  - [ ] `tests/integration/imap-session.test.ts` uses both but still calls `openSession` directly. Its behavior is unchanged: the same skip condition, one good login, exactly one wrong-password attempt.

  **Integration test** `tests/integration/test-ground.test.ts` (skips when user or password is unset). One login, then:
  - [ ] the first seed, then a second seed with `appended 0`, `flagsReset 0`, `total 150`;
  - [ ] the server facts (count; per seed id: size, internal date, system flags, Message-ID) equal the manifest;
  - [ ] **live, only read-only operations are tried on refused paths:** `open` and `exists` on `INBOX`, `Trash`, `mm-test/x`, `MM-TEST`, `mm-test2`, `*` reject with `FolderGuardError`, and `folder.selectedPath()` is unchanged. Refusals of `create`/`remove`/`messageCount` are proven offline (unit tests), never attempted live;
  - [ ] errors thrown in hooks and tests are mapped through `errorText` before they propagate, so vitest never serializes raw imapflow errors carrying server text;
  - [ ] no password in captured stdout/stderr/console or in `inspect`/`JSON` of the reports.

  **Live checks, run once during implementation** (the exact sequence is under _Verification commands_)
  - [ ] The first `test:seed` uploads 150.
  - [ ] `npm run test:integration` passes every suite (presets, discover, supabase-rls, imap-session, test-ground), with exactly one wrong-password attempt in the whole run.
  - [ ] `test:unseed` deletes 150; a second `test:unseed` says "nothing to delete".
  - [ ] `test:seed` re-uploads 150; a final `test:seed` appends 0. The mailbox ends seeded.
  - [ ] The value-blind leak check over all saved logs finds none of: the password, the address, its domain, the resolved IMAP host. Script logs carry the marker `mm-test:`; the integration log carries `test ground (live)` and `imap session (live)`.

  **Docs**
  - [ ] `docs/TESTING.md`, `.env.example`, `CLAUDE.md` Commands, `README.md` scripts table, the `imap-session.test.ts` comment, and a new `docs/milestones/M1-auth-accounts.md` M1b-3b section. The test ground is for the Websupport mailbox only.
  - [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and `npm run format:check` are green.

- **Summary:** Test tooling (no `src/` change) that fills the `mm-test` folder of the dedicated test mailbox with the M1b-3a synthetic messages and deletes it again. `TestFolder` guards every folder operation (only `<prefix>mm-test`, refused before any IMAP call) over a small `FolderClient` adapter that turns imapflow's silent falsy results into errors; seed classifies by `X-MM-Test-Seed`, refuses unexpected mail before writing, resets system flags, appends only missing messages and verifies against the manifest; unseed deletes the folder and re-checks it's gone. `npm run test:seed` / `test:unseed` log in once via `guardedOpenSession` and print counts only with fixed error texts. A live integration test proves idempotency and server = manifest; a value-blind leak checker covers password/address/domain/host.
- **Grade / mode:** M — solo + test writer. The test writer wrote 179 spec-driven tests in 3 files (178 passed first run; the failure — folded `X-MM-Test-Seed` values not unfolded — was a real parser gap, fixed in the code). 9 more tests added after the independent review.
- **Verification:**
  - Baseline: 31 files / 1114 unit tests, all checks green. Now: 34 files / 1302 unit tests; typecheck, lint, build, format:check green; `dist/` has no test tooling; grep for `messageDelete|mailboxClose|messageMove|mailboxRename|expunge` in the tooling → none.
  - Offline: `MM_TEST_IMAP_USER= npm run test:seed` → missing-env text, exit 1, no login; unknown command → usage, exit 1.
  - Mutation checks (each reverted): guard blocking only `*` (31 tests fail), remove-while-selected allowed (2), refuse-only-foreign (3), no name allowlist (9), create falsy unchecked (1), password trimmed (2).
  - Live sequence (each once; real logins from this machine, correct password except the session test's single wrong attempt): `test:seed` → created, appended 150 (44 s, verify passed = server sizes/internal dates/flags match the manifest); `npm run test:integration` → 5 files / 36 tests passed (incl. test ground and imap-session); `test:unseed` → deleted (150), again → nothing to delete; `test:seed` → appended 150, again → appended 0, flags reset 0.
  - After the review fixes (they changed live code paths), a targeted second round with the correct password only: `tests/integration/test-ground.test.ts` alone → 3/3; `test:unseed` (new delete → unsubscribe order) → deleted (150); `test:seed` → appended 150 (fresh-folder verify); `test:seed` → appended 0. Total today: 12 logins, 1 wrong-password attempt. Mailbox left seeded (150).
  - Leak check (`tests/support/test-ground/leak-check.ts`) over every saved log → clean; proven to detect planted address, domain, host and base64 password (planted files deleted).
  - Independent review: 0 high; findings resolved — (1, medium) the host wasn't checked in the integration log → the checker now skips only the presets-suite lines and also checks the fallback host and login username; (2) UNSUBSCRIBE before DELETE could block unseed → DELETE first, unsubscribe best effort, `exists()` re-check decides; (3) `resolveLiveSettings` untestable / `blocked` misreported → optional deps + own message + 5 unit tests; (4) weak tests → drift-before-append ordering, `fromSession` with a real `ImapFlow` prototype, the exact `fetchAll` query asserted; (5) stale `exists` after APPEND → NOOP refresh + test; (6) overlapping `open()` → handle reserved before the await, released handle gets its own message; (7) live guard refusals mapped through `errorText`, length compared as numbers; (8) "older version" → "other version" in the message; (9) Gmail sessions refused (`X-GM-EXT-1`) + test.
  - Not verified: `openTestSession` and `cli.ts main` have no unit tests (exercised only by the live runs); behaviour on servers other than Websupport; Websupport's PERMANENTFLAGS value (verify passed, so the flags stuck).
- **Deviations:**
  - Unseed order is DELETE → best-effort UNSUBSCRIBE (plan: unsubscribe → delete); `FolderClient.unsubscribe` returns a boolean instead of throwing (review finding 2).
  - `fetchMessages` sends NOOP when the cached count is 0; Gmail sessions refused; `resolveLiveSettings` takes optional deps and explains `blocked` providers (review findings).
  - New `tests/support/test-ground/leak-check.ts` (the value-blind checker the plan's leak check needed; used by `docs/TESTING.md`).
  - `parseSeedId` unfolds folded header values (test-writer finding).
  - The ImapFlow adapter was written in iteration 1 together with `TestFolder`, not stubbed first.
  - A second, targeted live round after the review fixes (see Verification).
  - `TODO.md` ticks and the "Current milestone" lines are left to `/review-changes` / `/release`.

---

## C-015 — M1b-4a log core + run logging: typed events, FileEventLog, command start/finish, error.unexpected, doctor logs check

- **Status:** reviewed (2026-09-28)
- **Review:** All acceptance criteria met; deviations justified. Reviewer re-ran all checks (1614 tests) and the 12 targeted test files (354). CLI regression diff of 12 invocations vs a8e9dba: byte-identical except doctor's new `logs` line. Real CLI and edge cases held up: 700/600 modes, no lines for help/parse errors, option-value canary absent, `/proc` exit in 0.47 s, symlinked `logs`, 755/644 repaired. Real-process probes (uncaught, rejection, `process.exit(3)`, forged stacks, double `kill -INT`) held up. Mutation probes: `passesLevel` caught; `fileSize` equivalent. Non-blocking follow-ups: [LOW] `src/core/log/health.ts:30-36` doctor says OK "no logs yet" at `MM_LOG_LEVEL=warn|error` even when the folder can't be created (reproduced with `MM_CONFIG_DIR`=a file) → check that the nearest existing parent is a writable dir; [LOW] pruning runs only in `prepare()` after a line passes the threshold (`file-event-log.ts:107,115,140`), so at `warn`/`error` with only successful runs old app files outlive the 30-day retention → prune independent of the threshold; [LOW] `reportError` decides by `isUserFacing` while `discover` passes its own text (`discover.ts:149-151`, `report-error.ts:17`), so a user-facing non-Discovery error would print "Unexpected error" without `error.unexpected` (unreachable today); [LOW] `TODO.md` M1b-4a line still says `appendFileSync` (code uses `openSync(O_APPEND|O_NOFOLLOW)` + `writeSync`, documented in LOGGING.md).
- **Date:** 2026-09-28
- **Type:** feature
- **Source:** `.claude/plans/2026-09-28-m1b4a-log-core-run-logging.md`, TODO.md → "M1b-4 — Logging foundation" → "M1b-4a — Log core + run logging"
- **Base:** a8e9dba69fc267e1cbe03b1d8375be8d83a1a2de. Files already dirty before the run: `TODO.md` (M1b-4 split into 4a–4d from `/next`, confirmed by the user).
- **Files:**
  - Created: `src/core/paths.ts`, `src/core/log/{events,record,builders,event-log,file-event-log,schema,health,index}.ts`, `src/cli/run.ts`, `src/cli/report-error.ts`, `tests/support/log/append-worker.ts`, `tests/unit/{paths,log-record,log-builders,log-file,log-schema,log-health,log-catalog,cli-run-logging,cli-bin-smoke}.test.ts`.
  - Modified: `src/cli/bin.ts`, `src/cli/index.ts`, `src/cli/error-text.ts`, `src/cli/commands/{auth,discover,doctor}.ts`, `src/core/config.ts`, `src/core/doctor.ts`, `src/core/db/supabase/{index,session-storage}.ts` (`sessionDir` removed → `configDir`), `tests/unit/{cli-auth,cli-discover,cli-doctor,config,session-storage}.test.ts`, `docs/LOGGING.md`, `docs/milestones/M1-auth-accounts.md`, `docs/SECURITY.md`, `docs/TESTING.md`, `README.md`, `.env.example`.
- **Requirements (plan acceptance criteria, verbatim):**

  **Paths**

  - [ ] `src/core/paths.ts` exports `configDir(env)` (`MM_CONFIG_DIR` → `$XDG_CONFIG_HOME/mail-manager` → `~/.config/mail-manager`, same trimming as today's `sessionDir`) and `logDir(env) = join(configDir(env), 'logs')`. `sessionDir` is removed from `session-storage.ts` and `db/supabase/index.ts`; `src/cli/commands/auth.ts` and `doctor.ts` use `configDir`. Behavior of the session file location is unchanged (existing session-storage tests moved to `paths.test.ts`, still green).

  **Log core (`src/core/log/`)**

  - [ ] Typed event union `LogEvent` with exactly the 4a events: `command.start` (`cmd`, `opts`, `ver`, `node`, `os`), `command.finish` (`cmd`, `outcome` = `ok|failed|interrupted`, `exit`, `ms`), `error.unexpected` (`errClass`, `code?`, `stack`), `log.truncated` (no fields). Each event has a fixed kind (`app` for all four) and a level (`command.finish`: `info` for `ok`, `warn` otherwise; `error.unexpected`: `error`; others `info`). The union and a `KIND`/level map make adding `security` events in 4b a type change only.
  - [ ] Record = envelope + fields with **fixed key order**: `ts`, `event`, the event's fields in catalog order, then `level`, `run`, `v` (`v: 1`). `ts` = UTC ISO-8601 with ms from an injectable clock. Serialized with `JSON.stringify` (newlines escaped). Security-kind lines (none yet) are prefixed `mm-security `; app lines are plain JSON.
  - [ ] `RunContext` = `{ run: 16 lowercase hex (randomBytes(8)), ver, now: () => number, level: LogLevel }`.
  - [ ] `EventLog` interface `emit(event: LogEvent): void`. `MemoryEventLog` keeps records + lines (tests). `NullEventLog` (default for `buildProgram` so existing tests never write files). `FileEventLog`:
    - dir created `0o700` (recursive, then `chmodSync 0o700`), files created `0o600` and `chmodSync 0o600` once per file per process; POSIX modes only (Windows: skipped);
    - one file per UTC day and kind: `app-YYYY-MM-DD.log`, `security-YYYY-MM-DD.log`, date from the event's `ts`;
    - writes with `appendFileSync` (one `write` per line, `\n`-terminated);
    - level threshold from `RunContext.level` applies to **app** lines only; security lines are always written (decision 2026-09-28);
    - 4 KB line cap: a line longer than 4,096 bytes (UTF-8, measured after `JSON.stringify`) is not written (builders cap their fields in bytes so this never happens in practice; a test proves the builders' worst case — incl. control characters, which `JSON.stringify` expands 6× — stays under it);
    - 5 MB cap per file: at ≥ 4 MB (80 %) `debug` lines are dropped; at ≥ 5 MB nothing is written except **one** `log.truncated` marker per file (detected by reading the file's last 4 KB for `"event":"log.truncated"`, so it holds across processes). The marker bypasses the level threshold and carries the prefix of the file it goes into (`mm-security ` in a security file);
    - the constructor touches **no** filesystem (lazy): the dir is created and pruning runs on the first write, so `--help` never creates a folder;
    - `chmodSync` only after `lstatSync` shows a real directory / regular file (symlinks are never followed; a symlinked log file is skipped and counted as a failure);
    - startup pruning once per process on the first write: files matching `^(app|security)-(\d{4}-\d{2}-\d{2})\.log$` are deleted when `todayUTC − nameDate > 30 days` (app) / `> 90 days` (security), in whole days (a file exactly 30 days old stays); future dates and other files are never touched;
    - **never throws** — every fs error is swallowed (a `failures` counter is exposed for tests);
    - `emit(event)` resolves kind + level and calls the public `appendRecord(kind, record)`; tests use `appendRecord` directly for the `security` kind and `debug` lines, which no 4a event produces.
  - [ ] `parseLogLine(line)` (zod) reads a line back: strips an optional `mm-security ` prefix, `JSON.parse` in try/catch, validates the envelope (`ts` ISO, `event` `^[a-z]+(-[a-z]+)*(\.[a-z]+(-[a-z]+)*)+$`, `level` enum, `run` 16 hex, `v` positive int); returns `null` for malformed input, never throws. Used by 4c and by the tests now.
  - [ ] Builders: `commandStart(cmd, optionNames, runtime)`, `commandFinish(cmd, exitCode, ms)` (outcome: `0 → ok`, `130 → interrupted`, else `failed`), `unexpectedError(err, root)`:
    - `errClass` = `err.name` if it matches `^[A-Za-z][A-Za-z0-9_]{0,40}$`, else `'Error'` for Errors, `'NonError'` for thrown non-Errors;
    - `code` only when `err.code` is a string matching `^[A-Z0-9_]{1,40}$` (e.g. `ENOENT`), else omitted;
    - `stack`: the header is cut by **exact prefix** — only when `err.stack` (a string) starts with `` `${err.name}: ${err.message}` `` (or `err.name` alone for an empty message) is that prefix dropped; otherwise (message changed after construction, non-string stack, a throwing getter) `stack: []`. Reason: a message can itself contain lines that look like `    at …` frames. Each remaining line must match one strict frame regex (`^\s+at (?:(.+?) \()?(.+?)\)?$`); non-matching lines are dropped. The function name becomes `<fn>` unless it matches `^[A-Za-z0-9_$.<>\[\] ]{1,80}$`; eval frames (`eval at …`, which nest a second location) are reduced to `eval`; the location is rewritten: `file://` URLs → path; paths inside the package root (checked with `root + sep`) → relative (`src/cli/bin.ts:12:5`); `node:` locations kept; anything else → `<external>`. Every frame is printable ASCII only (other chars → `?`) and ≤ 200 **bytes**; at most 10 frames. **No** `err.message`, no `String(err)`, no absolute or home path ever.
    - Line budget in **bytes**: if a finished `error.unexpected` line would exceed 4,096 bytes, frames are dropped from the end until it fits — the event itself is never dropped.
    - `cmd` ≤ 100 chars, `opts` ≤ 30 names, each ≤ 40 chars, `[a-z0-9-]` only.
  - [ ] `MM_LOG_LEVEL` in `src/core/config.ts`: `validateLogLevel(env): Validation<LogLevel>` (`debug|info|warn|error`, case-insensitive trimmed; unset → `info`) and `logLevel(env): LogLevel` (invalid → `info`), validated with a zod enum. No `off`. At `warn`/`error`, `command.start` and `ok` finishes are filtered out by design — the "every command logs start + finish" criterion applies at the default `info`.

  **CLI run logging**

  - [ ] `src/cli/run.ts` exports (signatures pinned for the test writer):
    ```ts
    interface ProcLike {
      on(event: 'exit', fn: (code: number) => void): void;
      on(event: 'SIGINT', fn: () => void): void;
      on(event: 'uncaughtException' | 'unhandledRejection', fn: (err: unknown) => void): void;
      exit(code?: number): never;
      exitCode: number | string | null | undefined;
    }
    interface RunCliDeps {
      argv: string[];
      build: (o: BuildOptions) => Command; // buildProgram
      log: EventLog;
      ctx: RunContext;
      proc: ProcLike;
      flush: () => Promise<void>; // stdout + stderr
      root?: string; // package root for stack frames (default projectRoot())
    }
    function runCli(deps: RunCliDeps): Promise<void>;
    class RunLogger {
      constructor(log: EventLog, ctx: RunContext);
      start(cmd: string, opts: string[]): void;
      finish(exitCode: unknown): void;
    }
    function createRunLog(o: {
      env: EnvSource;
      loadEnv: () => void;
      now: () => number;
      ver: string;
      makeLog?: (dir: string, ctx: RunContext) => EventLog;
    }): { log: EventLog; ctx: RunContext };
    ```
    `RunLogger.finish` is idempotent (only after a start; only once) and normalizes the exit code (number → itself; numeric string → number; anything else → 0). `createRunLog` runs `loadEnv()` first (errors ignored), then reads `logLevel(env)` and `logDir(env)` and builds the `FileEventLog` (construction errors → `NullEventLog`) — so a `MM_CONFIG_DIR` set only in `.env.local` is honored. `src/cli/bin.ts` = `createRunLog({ env: process.env, loadEnv: loadEnvFiles, now: Date.now, ver })` → `runCli({ …, proc: process })`.
  - [ ] `runCli` maps a top-level `ExitPromptError` to exit 130 (no `error.unexpected`), and installs `uncaughtException`/`unhandledRejection` handlers that print `Unexpected error`, emit `error.unexpected`, and exit 1 (today Node prints a raw stack there — CLAUDE.md forbids stack traces).
  - [ ] **Logging never breaks a command:** one `safeEmit(log, build: () => LogEvent)` helper (`src/core/log/event-log.ts`) wraps building **and** emitting in try/catch; every shell caller uses it — `RunLogger.start` (inside `preAction`: a throw there would stop the command), `finish`, `reportError`, and the `exit`/`SIGINT`/`uncaughtException`/`unhandledRejection` handlers. Builders tolerate throwing getters (`name`, `stack`, `code`), non-string stacks and an invalid clock (`ts` falls back to `new Date().toISOString()`).
  - [ ] `buildProgram({ exitOverride?, log?, onCommandStart? })`: a root `preAction` hook (`program.hook('preAction', (_root, actionCommand) => …)`) calls `onCommandStart` with the command path (names from the action command up to, excluding, the root, space-joined) and the **names** of options whose `getOptionValueSource(opt.attributeName())` is `'cli'` (`opt.long` without `--`; short-only options → the short flag without `-`; `--x`/`--no-x` pairs deduplicated). Option values never reach the logger. Root/global options are not collected (none exist).
  - [ ] `command.finish` is written: after `parseAsync` resolves or rejects (`exit` = `process.exitCode ?? 0`, or 1 after a top-level error); from a `process.on('exit')` handler when a command calls `process.exit` directly; from a `process.on('SIGINT')` handler (`try { finish(130) } finally { proc.exit(130) }`, once) with `interrupted`. Inquirer Ctrl+C (`ExitPromptError` → exit code 130 in `auth`/`discover`) → `interrupted`.
  - [ ] `--help`, `--version`, unknown commands/options and missing arguments write **no** lines (commander exits before `preAction`; `finish` is a no-op without a start).
  - [ ] `src/cli/report-error.ts` `reportError(err, log, text = errorText)`: prints `text(err)` to stderr and, when the error is **not** one of the user-facing classes (`isUserFacing(err)` exported from `error-text.ts`, which also covers `ImapSessionError`/`LoginBlockedError`), emits `error.unexpected`. Used by `runCli` (top-level catch), `auth.ts` `handleError`, and `discover.ts`'s catch, which passes its own text function so its output stays byte-identical (`DiscoveryInputError` → its message, else `Unexpected error`). `ExitPromptError` stays exit 130 with no `error.unexpected`.
  - [ ] The register functions receive a `CliContext { log: EventLog }` from `buildProgram` (default `NullEventLog`); no module-level singletons.

  **Doctor**

  - [ ] `runDoctor` gains an optional `logs?: () => CheckResult` dep; core `checkLogs(dir, env, deps?)` in `src/core/log/health.ts`:
    - folder missing, not a directory, not writable (`accessSync W_OK`), or today's app file not writable (e.g. root-owned after `sudo mm`) → `warn` "logs are not being written — the log folder can't be created or written" (doctor's own `command.start` would have created the folder, so missing = broken; logging is optional, the app works);
    - POSIX: dir mode ≠ 700 or any log file mode ≠ 600 → `warn` naming the mode, never the path;
    - `MM_LOG_LEVEL` invalid → `warn` "MM_LOG_LEVEL must be debug, info, warn or error (using info)";
    - otherwise `ok` with `N files, X KB, oldest YYYY-MM-DD`. The detail never contains the folder path (home directory).
    - The CLI doctor wires `logs: () => checkLogs(logDir(process.env), process.env)`. Without the dep no `logs` result is added, so the existing `tests/unit/doctor.test.ts` name-list (line ~130) and `toHaveLength(7)` (line ~239) assertions stay valid; new tests cover 8 results with the dep.

  **Docs**

  - [ ] `docs/LOGGING.md`: status line (4a built), `log.truncated` row in the Foundation table, "Emitted from" column split into `M1b-4a` / `M1b-4b` / `M1b-4d` / `M1c`, UTC day files, `interrupted` definition (exit 130 or SIGINT), no-output runs (`--help`/`--version`/parse errors), the resolved open question (no `off`), 80 % debug drop rule.
  - [ ] `docs/milestones/M1-auth-accounts.md` M1b-4 section: the 2026-09-28 split (4a–4d) + a "M1b-4a (implemented)" design + verification + **Logging** section; `.env.example` `MM_LOG_LEVEL` (commented, optional); `README.md` env table: new `MM_LOG_LEVEL` row, `MM_CONFIG_DIR` row says "login session and logs"; `docs/TESTING.md` a line on the log tests if it lists test areas; `docs/SECURITY.md` (the config dir now also holds `logs/`, 700/600). `CLAUDE.md` "Current state" and the `TODO.md` 4a ticks are left to `/review-changes` / `/release` as usual.
  - [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check` green.

- **Summary:** Local logging foundation. `src/core/log/` holds the typed event catalog (`command.start`, `command.finish`, `error.unexpected`, `log.truncated`), fixed-key-order JSON Lines records, capped/allowlisted builders (stack frames without message, names only for in-package frames), `MemoryEventLog`/`NullEventLog`/`safeEmit`, a hardened `FileEventLog` (UTC day files, 700/600, caps, pruning, no symlinks/hard links, never throws), `parseLogLine` and the doctor `logs` check. `src/cli/run.ts` wraps every `mm` run: env loaded first, `preAction` → `command.start` (option names only), `command.finish` on normal end / `process.exit` / SIGINT / crash; `reportError` adds `error.unexpected` for non-user-facing errors. CLI output and exit codes unchanged.
- **Grade / mode:** M — solo + test writer (L-level file count and security surface, no disjoint slices). The test writer wrote 9 new test files + extensions from the spec and pinned signatures only (302 tests in round 1, 45 more after the reviews); 2 test failures were real implementation issues (empty-message stack header under Vitest's `prepareStackTrace`; `parseLogLine` length rule) and were fixed in the code.
- **Verification:**
  - Baseline: 34 files / 1302 unit tests, typecheck/lint/build/format green. Now: 43 files / 1614 tests; typecheck, lint, build, format:check green, no warnings.
  - Real CLI (tsx and built `dist/cli/bin.js`, temp `MM_CONFIG_DIR`): `keygen` → `logs` 700, `app-<UTC date>.log` 600, start + finish with one run id; `--help`, `--version`, `nosuchcmd` → no folder; `MM_CONFIG_DIR` = a regular file → key printed, exit 0; `MM_CONFIG_DIR=/proc/self/nope` → exits in 0.5 s (was an infinite loop before the audit fix); `discover not-an-email` → `failed`/1, no `error.unexpected`; `login --email <canary>` (no TTY) → `opts: ["email"]`, canary absent; `doctor` → `logs` OK, `MM_LOG_LEVEL=verbose` → WARN.
  - Real process (`runCli` with the real `process`, scratch script): `kill -INT` → exit 130, one `interrupted` finish; uncaught exception and unhandled rejection → "Unexpected error" only, `error.unexpected` without message, `failed`/1.
  - Scratch probes after the hardening: hard-linked day file refused (outside file unchanged), `ts: '../../../x'` refused, untrusted frame names → `<fn>`, `..` paths → `<external>`.
  - Mutation checks (each reverted): no exact-prefix header cut (2 tests fail), option values instead of names (2), no file chmod (1), pruning off-by-one (1), unfiltered function names (8), auth/discover logging into a no-op log (3 / 1), doctor `logs` dep dropped (1), no hard-link check (1). One equivalent mutant: removing the SIGINT handler's explicit `finish` changes nothing (the `exit` handler writes the same line).
  - Leak grep: the only `err.message` read in the new code is `builders.ts` header matching (never written).
  - Independent review: regression diff of 15 CLI invocations vs a8e9dba byte-identical (except the new doctor `logs` line). Findings resolved: (M) doctor false warning at `warn`/`error` → "no logs yet" OK; (M) no command-level wiring tests → added for auth/discover/doctor/`onCommandStart`; (L) shortened-message and appended-cause stack text → frames stop at the first non-frame line + V8-shape names; (L) doctor vs file log on non-regular/400 day files → both handled; (L) `preAction` outside try → wrapped; (L) docs `appendFileSync` wording; (L) weak smoke assertion, missing symlink-dir and security-marker tests → added. Kept as deviations: keygen/doctor without `CliContext`, upper-case option names.
  - Security audit (`security-auditor`, offline): verdict safe; 17 black-box CLI leak cases, PTY Ctrl+C, hostile errors/Proxies, hostile log lines, symlink/FIFO/ENOSPC/umask cases held up. Findings resolved: (L1) `/proc` recursive-mkdir hang → one-level-at-a-time creation; (L2) untrusted frame names + `..` traversal → names only for trusted locations, `resolve` + `relative` check; (L3) `appendRecord` date → validated; (L4) hard links / dir swap / foreign owner → `fstat` `nlink`/`uid`, dir re-checked per write. (L5) 5 MB cap on security logs → recorded as an open question for M1b-4b in `docs/LOGGING.md`.
  - Not verified: Windows (modes skipped by design); Ctrl+C at an inquirer prompt was not run by me (no TTY here) — the security auditor exercised it on a real PTY (exit 130, `interrupted`); a user can re-check with `MM_CONFIG_DIR=$D mm login` + Ctrl+C in an external terminal. No live IMAP/Supabase run (none needed: no login path changed).
- **Deviations:**
  - `registerKeygen`/`registerDoctor` take no `CliContext` (no events until 4b; an unused parameter fails lint).
  - Option names allow upper case (commander short flags); `--no-x` logged as `x`.
  - Extra stack-header forms accepted (empty message `Name: `, `Error:`/constructor name, Node `Name [CODE]: message`) — safe since the message must match exactly.
  - Hardening beyond the plan from the reviews (see Verification); `runCli` maps `CommanderError` (only with `exitOverride`) to its exit code.
  - Doctor: missing folder at `warn`/`error` is OK; non-regular day file → warn.
  - `parseLogLine` caps the JSON part at 4,096 bytes.
  - Manual checks used `node` instead of `jq` (not installed).
  - `TODO.md` ticks and the "Current milestone" lines are left to `/review-changes` / `/release`.

---

## C-016 — M1b-4b domain + security events: doctor/discover/auth events, guard events via EventLog, 150 MB security cap

- **Status:** reviewed (2026-09-29)
- **Review:** All acceptance criteria met (docs partially — LOW drift below); deviations justified. Reviewer re-ran all checks (2097 tests) and the 13 targeted test files (619). CLI before/after (pre-4b snapshot vs current, offline, no env): 11 commands byte-identical. Real log lines checked for `logout` (security file 600, `auth.logout`), `discover not-an-email` (`invalid` only, no input), and `doctor` (8 `doctor.check`, name+status). Doctor quiet-level edge cases held up (file/read-only/dangling-symlink ancestor → WARN; fresh deep/symlinked path → OK `no logs yet`), as did prune at `error`. A real guard flow (IPv4/IPv6/local, all kinds): fail2ban port matches only IP-level blocks, 0 leaks in 372 lines. Guard policy identical to the snapshot over 200 mixed attempts; 4 mutants killed. Non-blocking follow-ups: [LOW] `docs/LOGGING.md:78` example uses `"source":"mx"` (real value `preset-mx`); [LOW] `docs/LOGGING.md:94` `log.truncated` row still says "5 MB cap" (security 150 MB) — plus stale 4a design lines in `docs/milestones/M1-auth-accounts.md` ~120/139/142; [LOW] `docs/TESTING.md:31` omits `log-enum-allowlist.test.ts`; [info] a local failure after Supabase accepted the password logs `auth.login-failed` `unexpected` (per plan, could be misread as a credential attempt).
- **Date:** 2026-09-29
- **Type:** feature
- **Source:** `.claude/plans/2026-09-29-m1b4b-domain-security-events.md`, TODO.md → "M1b-4 — Logging foundation" → "M1b-4b — Domain + security events (needs 4a)"
- **Base:** a8e9dba69fc267e1cbe03b1d8375be8d83a1a2de (HEAD without 4a). Files already dirty before the run: all of M1b-4a (C-015, reviewed, uncommitted) — `src/core/log/**`, `src/core/paths.ts`, `src/cli/{run,report-error,bin,index,error-text}.ts`, `src/cli/commands/{auth,discover,doctor}.ts`, `src/core/{config,doctor}.ts`, `src/core/db/supabase/{index,session-storage}.ts`, the 4a tests, docs; plus `TODO.md` and `.claude/changes.md` (review/`/next` edits). A pre-4b snapshot of `src/` was kept in the session scratchpad for the before/after diff.
- **Files (this run):**
  - Created: `src/core/log/domain-events.ts`, `src/core/log/guard-events.ts`; tests `tests/unit/{log-domain-events,log-guard-events,log-events-canary,log-enum-allowlist,auth-target,guard-events-flow,cli-events,log-caps-followups}.test.ts`.
  - Modified: `src/core/log/{events,builders,file-event-log,health,index}.ts`, `src/core/security/{events,login-guard}.ts` (sink types + `formatEventLine` removed; `authTargetKey`/`authEmailTarget`; `identify`, challenge `attempts`, `log?`), `src/core/imap/guarded-session.ts`, `src/cli/commands/{auth,discover,doctor}.ts`, `src/cli/index.ts`, `tests/support/test-ground/live-env.ts`; tests `tests/unit/{log-record,log-catalog,log-file,login-guard,guarded-session,security-events}.test.ts`; docs `docs/LOGGING.md`, `docs/SECURITY.md`, `docs/TESTING.md`, `docs/milestones/M1-auth-accounts.md`.
- **Requirements (plan acceptance criteria, verbatim):**

  **Event catalog in code**

  - [ ] `src/core/log/events.ts`: `LogEvent` gains exactly these 9 events. Fields are listed in `EVENT_FIELDS` order; `?` means optional.
    - `doctor.check` (`check`, `status`)
    - `discover.finish` (`outcome`, `source?`, `provider?`, `domainProblem?`, `choice?`)
    - `auth.login` (`user?`)
    - `auth.login-failed` (`reason`, `target`)
    - `auth.logout` (`outcome`)
    - `imap.login` (`acct?`, `provider`, `ip`, `target`)
    - `imap.login-failed` (`acct?`, `provider`, `reason`, `counted`, `ip`, `target`)
    - `login-guard.challenge` (`ip`, `attempts`, `target`)
    - `login-guard.block` (`kind`, `reason`, `ip`, `addr`, `attempts`, `until`, `target`)
  - [ ] `EVENT_KIND`: `doctor.check` and `discover.finish` are `app`; the other seven are `security`.
  - [ ] `eventLevel`:
    - `doctor.check`: `ok` → info, `warn`/`fail` → warn.
    - `discover.finish`, `auth.login`, `auth.logout` and `imap.login`: info.
    - `auth.login-failed`, `imap.login-failed` and `login-guard.challenge`: warn.
    - `login-guard.block`: warn, except `permanent` → error.
  - [ ] Field types:
    - `status`: `CheckStatus`.
    - `discover.finish.outcome`: `'found'|'needs-host'|'blocked'|'manual'|'invalid'`.
    - `source`: `DiscoverySource`. `domainProblem`: `DomainProblem`.
    - `choice`: `'picked'|'host-entered'|'manual'|'cancelled'`.
    - `auth.login-failed.reason`: `'invalid-credentials'|'unreachable'|'unknown'|'unexpected'`.
    - `imap.login-failed.reason`: `ImapFailureReason | 'blocked'`.
    - `kind`: `BlockKind`. `addr` and `until`: `string | null`. `counted`: `boolean`.
    - Type-only imports are used.
  - [ ] A rendered `login-guard.block` line (`renderEvent`):
    - has the keys `ts, event, kind, reason, ip, addr, attempts, until, target, level, run, v` and the `mm-security ` prefix;
    - matches the unchanged `FAIL2BAN_FAILREGEX` for `ip-blocked` and `permanent` when an address is present;
    - does not match `too-many-attempts`, and does not match when `addr` is null.
  - [ ] `tests/unit/log-record.test.ts`: the old assertions "exactly the four foundation events" and "all foundation events are app events" (around lines 62–66 and 75–77) are replaced by assertions over the full set.
  - [ ] `tests/unit/log-catalog.test.ts`: every catalog row whose "Emitted from" is `M1b-4a` **or** `M1b-4b` exists in `LOG_EVENT_NAMES`.

  **Builders (core)**

  - [ ] Shared helpers go in `src/core/log/builders.ts` so the event modules never clash under the `export *` barrel:
    - `cleanProvider(id)`: matches `^[a-z0-9-]{1,40}$`, otherwise `undefined`.
    - `uuidOrUndefined(value)`: a real 8-4-4-4-12 hex UUID, lowercased, otherwise `undefined`.
  - [ ] `src/core/log/domain-events.ts` (new): `doctorCheck`, `discoverFinish`, `authLogin`, `authLoginFailed`, `authLogout`, and `authFailureReason(err)`.
    - `check` must match `^[a-z0-9-]{1,40}$`, otherwise it becomes `other`.
    - `provider` goes through `cleanProvider`; if that returns `undefined` the field is omitted.
    - `user` goes through `uuidOrUndefined`; if that returns `undefined` the field is omitted.
    - `authFailureReason`: `AuthError` code `invalid_credentials` → `invalid-credentials`, `unreachable` → `unreachable`, `unknown` → `unknown`; anything else → `unexpected`.
  - [ ] `src/core/log/guard-events.ts` (new): `imapLogin`, `imapLoginFailed`, `guardChallenge`, `guardBlock`.
    - `provider` goes through `cleanProvider`; if it returns `undefined` the value is `custom`.
    - `acct` goes through `uuidOrUndefined`; if that returns `undefined` the field is omitted.
  - [ ] `src/core/security/events.ts`:
    - New `authTargetKey(masterKey)`: HKDF-SHA256 with info `mm-auth-target-v1`, 32 bytes; random when there is no key.
    - New `authEmailTarget(key, input)`: returns `'invalid'` unless `parseEmail(input)` accepts the input; otherwise `HMAC-SHA256(key, normalised address)` as 64 hex characters. The normalised address is trimmed, lowercased and IDN → ASCII, the same as `parseEmail`.
  - [ ] Both new modules are exported from `src/core/log/index.ts`, and there are no name collisions.

  **CLI (shell)**

  - [ ] `src/cli/commands/auth.ts`, `login`:
    - Emits `auth.login` (user id only) after `auth.login()` succeeds.
    - Emits exactly one `auth.login-failed` when `auth.login()` throws.
    - Target key: `authTargetKey(masterKey)`, where `masterKey` comes from `validateMasterKeyEnv(process.env)` if it is `ok`, otherwise `undefined`. The key is derived **inside** the `safeEmit` closure, so it can never change login output.
    - No auth event when the command stops before the password is submitted: no TTY, empty e-mail, Ctrl+C at a prompt, or a `ConfigError` from `authService()`.
  - [ ] `auth.ts`, `logout` and `whoami`: `logout` emits `auth.logout` with its result; `whoami` emits nothing.
  - [ ] Output and exit codes of `login`, `logout` and `whoami` are byte-identical to before.
  - [ ] `src/cli/commands/doctor.ts`:
    - `registerDoctor(program, ctx)`.
    - After `runDoctor` it emits one `doctor.check` per result, in order, the `logs` check included.
    - `src/cli/index.ts` passes `ctx`.
  - [ ] `src/cli/commands/discover.ts`: exactly one `discover.finish` per completed run.
    - `outcome` = `result.status`.
    - `source` for found, needs-host and blocked.
    - `provider` = the preset id: `'provider' in result ? result.provider?.id : undefined`, or the picked `chosen.provider?.id`.
    - `domainProblem` when set.
    - `choice` when the picker ran; `cancelled` when it returned null. The internal return type of `report()`/`choose()` carries `code`, `choice?` and `provider?`.
    - A `DiscoveryInputError` → `outcome: 'invalid'` only.
    - No `discover.finish` on Ctrl+C (ExitPromptError) or on unexpected errors.
    - Never the address, domain, host or username. Output and exit codes unchanged.

  **Log file + doctor (4a follow-ups, cap)**

  - [ ] `src/core/log/file-event-log.ts`:
    - The option `maxSecurityFileBytes` defaults to 150 MiB. The cap, the 80 % debug drop and the marker are applied per kind, with that kind's cap.
    - Pruning runs once on the first `emit`/`appendRecord`, even if the level filters the line out, but only when the folder already exists as a real directory (`lstat`). The folder is never created just to prune.
  - [ ] `src/core/log/health.ts`, when the log folder is missing at `MM_LOG_LEVEL=warn|error`:
    - Walk up at most 64 levels to the nearest existing ancestor. Use `stat` for ancestors, which follows symlinks such as macOS `/tmp` or a symlinked home; the log folder itself keeps `lstat`.
    - If that ancestor is a directory with `W_OK|X_OK` → OK "no logs yet". Security lines at info are always written, so the text no longer claims "writes only warnings and errors".
    - Otherwise → warn "logs are not being written …".
  - [ ] `health.ts`, writability: check both `app-<today>.log` and `security-<today>.log`. A non-regular or unwritable file → warn.

  **Guard + guardedOpenSession**

  - [ ] `src/core/security/login-guard.ts`, construction and block events:
    - The constructor takes `log?: EventLog` instead of `sink?`.
    - Block events go out as `safeEmit(log, () => guardBlock(...))`, with no `ts`: the log's clock stamps it.
    - Fields, emission points and all three kinds are unchanged, and so are policy and counters.
  - [ ] `login-guard.ts`, challenge decision: `GuardDecision`'s challenge variant is `{ kind: 'challenge-required'; attempts: number }`.
    - `attempts` = the pair's failures in the window.
    - If mailbox-wide failures triggered the challenge, it is the mailbox count.
    - With only a lockout history, it is the pair count (may be 0).
  - [ ] `login-guard.ts`, `identify`: new public `identify(a): { ip; target }`, with the same normalisation and HMAC as the store keys.
  - [ ] `src/core/security/events.ts`: `SecurityEvent`, `SecurityEventSink`, `MemoryEventSink`, `LineEventSink` and `formatEventLine` are removed. `grep -rn "SecurityEventSink\|MemoryEventSink\|LineEventSink\|formatEventLine" src tests` is empty.
  - [ ] `src/core/imap/guarded-session.ts`, options:
    - Adds `log?: EventLog` (default `NullEventLog`), `provider: string` and `acct?: string`.
    - `log`, `provider` and `acct` are destructured **before** the `...sessionOptions` spread, so they never reach `open()`.
  - [ ] `guarded-session.ts`, emission on each path:
    - `challenge-required` → `login-guard.challenge`, then `onChallenge`.
    - `blocked` at check → `imap.login-failed` (`reason: 'blocked'`, `counted: false`), then `LoginBlockedError`. No `open`, no new block event.
    - `ImapSessionError` from `open` → `imap.login-failed` (`reason = err.reason`, `counted = COUNTED_REASONS.has(reason)`) **before** `recordFailure`.
    - Any other error from `open` → `imap.login-failed` (`reason: 'unexpected'`, `counted: false`).
    - Success → `imap.login` after `recordSuccess`.
    - `recordSuccess` throws → logout as today, no `imap.login`.
    - `guard.check`, `onChallenge` or `recordFailure` throws → no event beyond what was already emitted. The error propagates unchanged; this is documented and tested.
    - All emission goes through `safeEmit`. Behaviour is otherwise unchanged: one `open`, the same errors, the same guard calls.
  - [ ] `tests/support/test-ground/live-env.ts`: passes the constant `provider: 'custom'` and no log. The seed/unseed scripts are unchanged.

  **Docs + checks**

  - [ ] `docs/LOGGING.md`:
    - The catalog rows for the 9 events are updated: real fields; `imap.*`/`login-guard.*` "Emitted from" `M1b-4b`, wired to a file in M1c.
    - The stale "(existing `SecurityEvent`)" mentions are gone.
    - The per-kind caps: 5 MB app, 150 MB security, with the per-user explanation.
    - The resolved open question on the security cap.
    - The pruning and doctor follow-ups.
    - The `auth.login-failed` target rule: valid address → HMAC, otherwise `invalid`.
  - [ ] `docs/SECURITY.md` (the section around lines 77–80): describes `EventLog` and the rendered line with the envelope, instead of the removed sinks. It adds that `security-*.log` exists locally, kept 90 days.
  - [ ] `docs/milestones/M1-auth-accounts.md`: line ~66 no longer mentions the sinks; a new "M1b-4b (implemented)" section covers design, verification and Logging.
  - [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and `npm run format:check` pass.

- **Summary:** The catalog gains 9 events. `mm doctor` writes one `doctor.check` per check, and `mm discover` one `discover.finish` (outcome/source/preset id/domain problem/choice, never address/domain/host). `mm login`/`logout` write `auth.*` security lines — the typed e-mail only as an HMAC with its own HKDF key and only when it is a valid address (else `invalid`). `LoginGuard` emits `login-guard.block` through `EventLog` (old sinks removed, fail2ban line format/regex unchanged), exposes `identify()` and challenge `attempts`; `guardedOpenSession` emits `imap.login`/`imap.login-failed`/`login-guard.challenge` without changing login behavior. Every builder allowlists every field at runtime. Security files get a 150 MB cap; pruning and the doctor quiet-level check were fixed (4a follow-ups).
- **Grade / mode:** L (auth/security code) — solo + test writer (user downgraded from sliced: 4a uncommitted, no worktrees). The test writer wrote 8 new test files (293 + 159 tests) from spec + pinned interfaces; two of its first-round failures were real bugs, fixed in code (`authFailureReason` returned undefined for a forged code; guard builders passed ip/target/addr/until through unchecked).
- **Verification:**
  - Baseline: 43 files / 1614 tests, all checks green. Now: 51 files / 2097 tests; typecheck, lint, build, format:check green. `grep -rn "SecurityEventSink\|MemoryEventSink\|LineEventSink\|formatEventLine" src tests` → empty.
  - CLI regression (pre-4b snapshot vs current, offline, no env, temp `MM_CONFIG_DIR`): `login` (no TTY), `login --email x@y.eu`, `logout`, `whoami`, `discover not-an-email`, `discover` (no arg), `--help`, `doctor`, unknown command → stdout/stderr/exit byte-identical (run twice, after the last fix too).
  - Real CLI: `logout` → `security-<date>.log` 600 with `mm-security {"event":"auth.logout","outcome":"not-logged-in",…}`; `discover not-an-email` → `discover.finish` `invalid`; doctor at `MM_LOG_LEVEL=warn` with `MM_CONFIG_DIR`=a file → WARN, fresh deep path → OK `no logs yet`.
  - Mutation checks (each reverted): typed e-mail hashed regardless (17 fail), no `imap.login-failed` (24), challenge after `onChallenge` (4), no prune when filtered (2), discover `choice` dropped (6), doctor skips ancestor walk (3), no `auth.login-failed` (7), `oneOf` passthrough (64), `creatable` ignores the log path (9), doctor without `safeEmit` (1), security default = app cap (1).
  - Independent review: 0 CRITICAL/HIGH/MEDIUM; 72 mutants of its own, survivors fixed by new tests. Findings resolved: dangling-symlink doctor false OK (fixed with the audit's L2); CLI throwing-log tests, 150 MiB default and exact `no logs yet` text tests added; LOGGING.md doctor text; throw behavior documented; M1c same-log note; TESTING.md entries. Informational: password-shaped input with `@` and a dotted domain is still hashed (per the user's rule — only valid addresses).
  - Security audit (`security-auditor`): safe to merge; leaks, guard integrity (6 sink variants → identical store state), fail2ban forging (0 matches), files/prune/symlinks, availability all held. Fixed: L1 runtime enum allowlists, L2 doctor vs writer on dangling symlinks/loops. L3 (block lines dropped at the cap / unbounded `blocked` lines once a server logs real IPs) → documented as an M6a requirement in LOGGING.md.
  - **Out-of-scope finding for the user:** `secrets-scan` flags commit `0ed2604` (2026-09-22, public on origin) — a `.test.users.cred` value and the test-mailbox domain in `.claude/changes.md`/`TODO.md`/milestone doc; `accepted-history.txt` records no rotation.
  - Not verified: live `mm login` (success path and real Supabase failure) — only via a pty against an unreachable URL (reviewer); `guardedOpenSession` with a file log in a real command (M1c); Windows; the real fail2ban binary (regex port only).
- **Deviations:**
  - Execution downgraded from sliced to solo + test writer (user decision; 4a not committed).
  - Guard builders also allowlist `ip`/`target`/`addr`/`until`; runtime enum allowlists in every builder (audit L1).
  - `authFailureReason` default branch; doctor `creatable()` judged like the writer (audit L2).
  - Existing tests migrated: `CHALLENGE` uses `objectContaining`; lock test expects the challenge first; 4a security-marker test uses `maxSecurityFileBytes`.
  - LOGGING.md gains the M6a requirement (audit L3); future-dated files are still not pruned (informational).
  - `TODO.md` ticks and "Current milestone" lines are left to `/review-changes` / `/release`.

---
