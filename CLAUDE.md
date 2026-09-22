# CLAUDE.md — Mail Manager

IMAP-only mailbox **management** tool (filters, size insight, safe delete, backup/migration prep). No SMTP. TypeScript + Node 22 + imapflow + Supabase cloud. CLI first, then a simple local HTML page.

## Current state

- **Current milestone: M1b-2b (login guard) — not started.** M0, M1a (v0.0.1), M1b-1 provider discovery (v0.1.0, C-004…C-008) and M1b-2a IMAP session (v0.2.0, C-009, C-010) done and reviewed; then M1b-3 (test ground). `TODO.md` is the source of truth for progress.
- Docs: `docs/ARCHITECTURE.md`, `DATA_MODEL.md`, `SECURITY.md`, `PROVIDERS.md`, `IMAP.md` (protocol/capability research), `TESTING.md`, `DEPLOYMENT.md`, `docs/milestones/Mx-*.md`.

## Workflow rules

- Implement **one milestone at a time**. Do not start the next milestone without the user's go-ahead.
- A milestone is done only when its **acceptance criteria and verification steps** (in its milestone doc) pass.
- When finishing work: tick boxes in `TODO.md`, update the milestone doc if the design changed, update "Current milestone" above.
- Open questions in a milestone doc must be resolved (with the user) before implementing the affected part.

## Architecture rules

- **Core library first** (`src/core`). CLI (`src/cli`) and server (`src/server`) are thin shells: parse input → call core → format output. No IMAP or DB logic in the shells.
- **All DB access goes through repository interfaces** (`src/core/db/repos.ts`); Supabase code lives only in `src/core/db/supabase/`. This keeps a future migration off Supabase contained.
- **Credential decryption stays behind one core interface** (`CredentialProvider`) so the CLI can later switch from local decryption to calling the hosted API.
- **No email content in the cloud DB**: never store message bodies, subjects, or sender/recipient addresses of messages in Supabase. Allowed: accounts (encrypted secrets), saved filters, jobs, aggregate audit data (counts, bytes, filter definition).

## User-facing errors (target users are non-technical)

- Users are mostly amateurs who want to tidy mailboxes and download backups: **simple, working, well-managed errors**.
- Every error the user can hit says **what happened and what to do next**, in plain words. Raw codes (`ENOTFOUND`, HTTP status) may follow in brackets in _distinct_ messages, never alone — and never in the generic login message below.
- Core returns a typed reason; the CLI/server shell maps it to text (`src/cli/imap-errors.ts`, `src/cli/error-text.ts`).
- **IMAP login/connection failures** (decided 2026-09-22): wrong password, wrong address, host not found, unreachable/refused/reset/timeout (GeoIP, fail2ban bans), app password needed, password expired, "contact admin" all get **one generic message** (address + password/app password + IMAP server + GeoIP hint, no code), so the app can't be used to probe accounts or hosts ("password expired" would confirm the password). Distinct messages only for: no internet on our side (confirmed by a connectivity check), invalid TLS certificate, OAuth-only provider, server-reported unavailable/throttled, our own input validation, too many attempts (login guard).
- **Discovery** (before any login, public DNS data) keeps its distinct messages: domain doesn't exist, DNS error at the domain, DNS unreachable.
- Hints are informational, never a dead end: a check that could be wrong (e.g. "domain doesn't exist" for an expired domain whose mailbox still works) must still let the user continue (pick the provider / enter the host). Don't warn about missing MX records — IMAP doesn't depend on MX.
- Never show stack traces or raw library/server messages (they can leak data and confuse users); unexpected errors get a generic message. `src/cli/bin.ts` prints only whitelisted core error classes (`errorText`); anything else is "Unexpected error".
- **GeoIP hint on failed IMAP connections** (`geoIpNotice` in `src/core/providers/geoip.ts`): the CLI names "this computer's" country; the server passes `{ kind: 'server', region }`. **Wherever the server is deployed (local now, later Vercel or a VPS), configure that hosting country so the message names the right country** — without it the text falls back to "the country where the Mail Manager server is hosted".

## Safety rules (destructive operations)

- Every delete/move is: **plan (dry run) → notices (fallbacks, Trash folder) → full list of every message → two confirmations → execute exactly the planned UIDs → audit row**. Interactive only. Details: `docs/IMAP.md` §6.
- Unsupported operation → tell the user and offer the substitute (e.g. Trash instead of permanent delete). Never fall back silently.
- Trash: server-marked `\Trash`, otherwise confirmed by the user (candidate scan, root first). Always tell the user which one is used.
- Gmail searches via `X-GM-RAW` are cross-checked against the standard search; delete plans use only messages both agree on.
- Default action is **move to Trash**. Permanent delete needs an explicit flag and uses `UID EXPUNGE` (UIDPLUS) only.
- **Never** issue a folder-wide `EXPUNGE`. If the server lacks UIDPLUS, refuse permanent delete.
- Abort if `UIDVALIDITY` changed between plan and execute.
- Gmail: deleting from a label folder only removes the label — real delete = move to `[Gmail]/Trash`.
- Integration tests may only touch the `mm-test` folder of the dedicated test mailbox.

## Secrets rules

- Never log passwords, OAuth tokens, `MM_MASTER_KEY`, or message bodies. Redact in errors.
- `MM_MASTER_KEY` lives only in env (`.env.local` or `.env`, both gitignored) — never in Supabase, never in code.
- CLI uses the Supabase publishable key (formerly "anon") + user JWT. Service-role key is server-side only (M6+).
- IMAP: implicit TLS (993) only, certificate verification on. No plaintext fallback. All logins go through `openSession` (`src/core/imap/session.ts`): TLS 1.2+, logger off, password dropped from the client after connect, **never an automatic retry** of a failed login (provider IP bans / brute force).
- This repo is **public**. Never write the real test mailbox address/domain or its IMAP host into tracked files (docs, `TODO.md`, `.claude/changes.md`, code, comments, commit messages). Use a placeholder like `test@example-test-domain.eu` instead — real values belong only in the gitignored `.env.local`.

## Conventions

- TypeScript `strict`, ESM, Node 22. File names kebab-case.
- zod at every boundary (CLI args, API input, filter JSON, env, DB rows).
- Pass IMAP search criteria as imapflow objects — never hand-build IMAP command strings.
- Vitest; core logic requires unit tests. Integration tests skip when their `MM_TEST_*` env is unset; `tests/integration/presets-live.test.ts` needs only internet (TLS greeting on 993 for every preset host, no login).
- Keep dependencies few; justify each new one.
- Commits only when the user asks.

## Commands

```bash
npm run dev -- <args>      # run CLI from source (tsx), e.g. npm run dev -- doctor
npm run build              # tsc -p tsconfig.build.json → dist/
npm start -- <args>        # run the built CLI (dist/cli/bin.js)
npm test                   # unit tests (tests/unit)
npm run test:integration   # integration tests (tests/integration); suites skip without their env (MM_TEST_SUPABASE_*, later MM_TEST_IMAP_*)
npm run db:push            # apply supabase/migrations to the linked cloud project (supabase CLI)
npm run db:status          # local vs remote migrations
npm run lint               # eslint (type-checked)
npm run typecheck          # tsc --noEmit (src + tests + configs)
npm run format             # prettier --write .
npm run format:check       # prettier --check . (run in CI)
```

- Env: `.env.local` then `.env` from the repo root; real env wins. `mm doctor` validates it.
- Supabase: link once with `npx supabase login` + `npx supabase link --project-ref <ref>` (interactive, asks for the DB password — the user runs these). Never edit an applied migration; add a new timestamped file.
- Supabase code only in `src/core/db/supabase/`; everything else uses `createSupabaseServices()` (auth + accounts repo) and the interfaces in `src/core/auth.ts` / `src/core/db/repos.ts`.
- TypeScript is pinned to 6.0.x (typescript-eslint doesn't support 7 yet) — don't bump without checking.
- ESM + NodeNext: relative imports need `.js` extensions.
- CLI entry: `src/cli/bin.ts` (executable) → `buildProgram()` in `src/cli/index.ts`; commands live in `src/cli/commands/`.
