# Changes log

Written by `/implement` and `/fix`, one entry per run. Reviewed by `/review-changes`, which sets each entry's status.

## C-001 — M0 scaffold & tooling (+ mm doctor, mm keygen)

- **Status:** unreviewed
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
