# Security playbook — Mail Manager

Project-specific input for the `security-auditor` agent (and `/security`). The agent reads this
**before** mapping the app, runs the probes, then extends them for whatever changed. Repo is
**public**: nothing in this folder may contain a real address, host, key or password.

## Scope and test resources

| Resource                                                               | Allowed use                                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Repo source, `npm run dev -- <cmd>`, built CLI                         | read, run                                                                                           |
| Supabase cloud project (from `.env.local`)                             | read-only anon probes (`supabase-live.mjs`); two-user RLS suite `npm run test:integration`          |
| Supabase test users `MM_TEST_SUPABASE_A/B_*`                           | only through the integration suite (it cleans up its rows)                                          |
| Test mailbox `MM_TEST_IMAP_*`                                          | **at most one** login per run, only folder `mm-test`; never a wrong password (provider bans the IP) |
| Everything else (real mailboxes, other users' rows, third-party hosts) | **out of scope**                                                                                    |

Hostile-domain probes use fakes, or reserved names (`.invalid`, `example.com`) — never real
third-party domains.

## Secret files — never `cat`, `sed -n`, `head`, `grep` without `-c`/`-l`

`.env.local`, `.env`, `supabase_pass`, `.test.users.cred`, `~/.config/mail-manager/session.json`.
Names only: `sed 's/=.*/=<set>/' .env.local`. Probes may load values **in-process** to compare
(value-blind) and print only the variable name — see `secrets-scan.mjs`.

## Probes (`.claude/security/probes/`)

Run from the repo root. `run-all.sh <scratchpad-dir> [--live]` runs them all and saves outputs.
Output lines: `ok` / `FIND` (finding) / `LEAD` (verify by reading code) / `GAP` (known,
accepted gap — report only if it got worse) / `info`. Exit code ≠ 0 = findings.

| Probe                    | Covers                                                                                                                                                                                                                                                                                                          | Network                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `static-rules.sh`        | grep leads for CLAUDE.md rule breaks: TLS off, STARTTLS/143, login retry, logger on, EXPUNGE paths, raw IMAP strings, `.or/.filter/.rpc`, shell/eval, raw error printing, `Math.random`, service-role key in CLI                                                                                                | none                    |
| `secrets-scan.mjs`       | value-blind scan of tracked + untracked files **and full git history** for real env/cred values and the test-mailbox domain; JWT / `sb_secret_` / private-key / 32-byte-key shapes; `.gitignore` coverage                                                                                                       | none                    |
| `input-fuzz.mts`         | host/email/username/password validators: SSRF literals (decimal/hex/octal IPv4, IPv6, metadata IP), URL smuggling, CRLF/NUL, bidi/zero-width, IDN homographs, ReDoS timing; `--no-dns` skips the rebinding check                                                                                                | DNS A/AAAA only         |
| `discovery-ssrf.mts`     | `discover()` with fake DNS/fetch: redirects to http/IP/localhost/port/file, redirect loops, 5 MB + stalled bodies, entity bomb, `__proto__`, CRLF/free-text usernames, STARTTLS, SRV/MX to localhost/IP/143, ISPDB privacy. Has a positive control                                                              | none                    |
| `imap-session.mts`       | `openSession` with a fake client: TLS 993 / verify / TLS1.2+ / SNI, logger off, one connect (no retry), password dropped on success+failure, no server text or password in error/inspect/JSON/CLI text, **one identical generic message** for all probe-able failures, bad input refused before a client exists | none                    |
| `crypto-local-files.mts` | AES-GCM IV uniqueness, AAD row/user binding, tamper/truncated tag, wrong key/version, generic errors; strict master-key parsing; `session.json` 600 / dir 700 under umask 000, planted-symlink write, corrupt file, prototype pollution                                                                         | none                    |
| `supply-chain.sh`        | `npm audit` (runtime + all), `npm audit signatures`, lockfile registry/integrity/install scripts, loose ranges, imapflow pinned, `.npmrc`, GitHub Actions (SHA pins, permissions, `pull_request_target`, script injection, `persist-credentials`)                                                               | npm registry            |
| `cli-surface.mjs`        | black-box CLI with hostile args (ANSI/OSC, CRLF, bidi, 10k chars, format strings) and broken env/session: no stack traces, paths, raw library errors, echoed escapes or secret values. Throwaway `MM_CONFIG_DIR`                                                                                                | own Supabase (doctor)   |
| `supabase-live.mjs`      | publishable key is not a secret key, signups disabled, anon OpenAPI/RPC exposure, anon select/insert/update/delete on `mail_accounts`, GraphQL introspection, storage buckets                                                                                                                                   | own Supabase, read-only |
| `local-hygiene.mjs`      | secret file modes (600) and config dir (700), credentials in git remotes/config, npm tokens, secret **values** in shell histories, this project's Claude transcripts/memory, `dist/`, `coverage/`, `backups/`, `*.log` (value-blind). Skipped in CI                                                             | none                    |

Also run the project's own guards: `npm test`, `npm run lint`, `npm run typecheck`, and (if
`MM_TEST_*` is set) `npm run test:integration` followed by the leak check in
`docs/TESTING.md` (value-blind grep of the test log for the test password).

## Rules to verify (from CLAUDE.md / docs/SECURITY.md)

- IMAP: implicit TLS 993 only, cert verification on, TLS 1.2+, all logins via `openSession`, **no automatic retry**, password dropped after connect, logger off.
- Errors: core returns typed reasons; `src/cli/bin.ts` prints only whitelisted classes (`errorText`); login/connection failures share **one generic message** with no code; distinct messages only for the listed exceptions.
- DB: all access via `src/core/db/repos.ts` interfaces, Supabase code only in `src/core/db/supabase/`; typed builders only; RLS + policies on every table in the same migration; `anon` has no grants; no TRUNCATE; immutable `id`/`user_id`.
- No email content (bodies, subjects, message addresses) in Supabase.
- Destructive ops: plan → notices → full list → two confirmations → exact UIDs → audit; no folder-wide `EXPUNGE`, no `messageDelete`/`messageMove`/`mailboxClose` fallbacks, UIDVALIDITY guard, UIDPLUS required for permanent delete.
- Secrets never logged; `MM_MASTER_KEY` only in env; service-role key never in CLI.
- Public repo: no real test address/domain/host in tracked files **or commit messages**.

## Known, accepted gaps (report only if they got worse)

- Hostnames that **resolve** to private IPs (`localtest.me`, `*.nip.io`) are accepted; resolve-and-pin guard deferred to M6a (docs/SECURITY.md). `input-fuzz.mts` prints them as `GAP`. Becomes **CRITICAL** the moment a server (M6) connects on a user's behalf.
- imapflow sends the password even when the server advertises `LOGINDISABLED` + `AUTH=PLAIN` (docs/SECURITY.md, IMAP session).
- gitleaks CI image pinned by tag, not digest; `actions/checkout` without `persist-credentials: false` (read-only token, low risk).

## Preventive controls (what is enforced, where)

Hard limits beat instructions. The auditor checks these are still in place (method step 7).

| Control                                                                                                               | Enforced by                                                                                                 | Stops                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Deny `Read`/`Edit` of `.env*`, `supabase_pass`, `*.cred`, `~/.config/mail-manager/**`; deny force-push, `npm publish` | `.claude/settings.json` (Claude Code harness, every agent)                                                  | an agent printing or changing secrets, rewriting public history |
| `pre-commit`: staged secret files, real secret values, secret-shaped strings                                          | `.claude/security/hooks/` via `git config core.hooksPath .claude/security/hooks` (**per clone — run once**) | the `0ed2604` class of leak                                     |
| `commit-msg`: same scan on the message                                                                                | same                                                                                                        | test address/domain in commit messages (public)                 |
| lint, typecheck, unit tests, `npm audit --audit-level=high`, offline probes, gitleaks (full history)                  | `.github/workflows/ci.yml`                                                                                  | regressions of every probe-covered guard                        |
| RLS + column grants, no `anon` grants                                                                                 | `supabase/migrations`                                                                                       | cross-user reads/writes with the public key                     |
| secret files mode 600, config dir 700                                                                                 | `chmod` + `local-hygiene.mjs`                                                                               | other local users reading secrets                               |

**Enable on GitHub (user, repo Settings → Code security):** secret scanning + **push
protection**, Dependabot alerts (+ security updates), private vulnerability reporting, and a
branch ruleset on `master` (require CI, block force-push). Add a `SECURITY.md` policy at the
repo root when others start using the app.

## Where changes map to probes

| Changed path                                                                              | Re-run / extend                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/core/providers/**`                                                                   | `input-fuzz`, `discovery-ssrf`                                                 |
| `src/core/imap/**`, `src/cli/imap-errors.ts`                                              | `imap-session`, `static-rules`                                                 |
| `src/core/crypto.ts`, `credentials.ts`, `master-key.ts`, `db/supabase/session-storage.ts` | `crypto-local-files`                                                           |
| `src/core/db/**`, `supabase/migrations/**`                                                | `supabase-live`, `npm run test:integration` (RLS), `static-rules`              |
| `src/cli/**`                                                                              | `cli-surface`, `static-rules`                                                  |
| `package.json`, `package-lock.json`, `.github/**`                                         | `supply-chain`                                                                 |
| docs, `TODO.md`, `.claude/changes.md`, commit messages                                    | `secrets-scan`                                                                 |
| new module with input from users/servers/files                                            | **write a new probe** (template below) and add it to `run-all.sh` + this table |

## Incident runbook — a secret leaked

Order matters: **rotate first** (assume a public push is scraped within minutes), clean up second.

| Leaked                                                         | Do now                                                                                                        | Then                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MM_MASTER_KEY`                                                | `mm keygen` → new key as `MM_MASTER_KEY_VERSION` N+1; re-enter the mailbox passwords so they are re-encrypted | if DB rows could also have been read: treat every stored mailbox password as known → change them at the providers                                                    |
| Supabase secret/service-role key                               | rotate in the dashboard (API keys)                                                                            | check logs for use; nothing in the CLI should hold it                                                                                                                |
| Supabase DB password (`supabase_pass`)                         | reset (Project Settings → Database); re-run `supabase link`                                                   | review DB roles/logs                                                                                                                                                 |
| Supabase test users (`.test.users.cred`, `MM_TEST_SUPABASE_*`) | change passwords in Auth → Users, sign out all sessions                                                       | update `.env.local` / `.test.users.cred`                                                                                                                             |
| Test mailbox password / app password                           | change at the provider; revoke app passwords                                                                  | update `.env.local`                                                                                                                                                  |
| `session.json` (refresh token)                                 | `mm logout` (revokes) or sign out the user in Auth → Users                                                    | —                                                                                                                                                                    |
| Test address / domain (PII, not a credential)                  | nothing to rotate                                                                                             | decide on history rewrite                                                                                                                                            |
| Anything pushed to the public repo                             | rotate as above                                                                                               | optional: `git filter-repo` + force-push + GitHub support to purge cached views (forks keep copies), then list the commit in `accepted-history.txt` if not rewritten |

## Checks to add as milestones land

| Milestone          | Add probes for                                                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1b-2b login guard | limit per account+host and globally; not bypassable by case/whitespace/IDN variants of the address or host, or by a new process (state persisted with safe perms); lockout message distinct but reveals nothing about the account                                                                   |
| M2 insight         | server-supplied folder names/flags printed to the terminal: control/ANSI/bidi stripped; huge folder lists bounded; nothing but counts/bytes to Supabase                                                                                                                                             |
| M3 filters         | filter JSON through zod; criteria only as imapflow objects; `X-GM-RAW` cross-check; ReDoS in any user regex; saved filters stay RLS-scoped                                                                                                                                                          |
| M4 safe delete     | fake-client test: exact planned UIDs only, UIDVALIDITY change aborts, no `EXPUNGE` without UIDPLUS, Gmail label vs Trash, two confirmations cannot be skipped (no `--yes`, no stdin pipe)                                                                                                           |
| M5 backup          | path traversal / absolute paths / reserved names from folder names and attachment filenames, symlink races in the output dir, modes 700/600, disk-fill caps                                                                                                                                         |
| M6 server + web UI | bind 127.0.0.1, **Host-header allowlist** (DNS rebinding against a localhost server), CSRF, CORS, CSP, cookies (`HttpOnly`, `Secure`, `SameSite`), JWT verified per request, rate limits, service-role key never in the bundle, resolve-and-pin SSRF guard; browser checks via the Chrome extension |

## Writing a new probe

Copy the closest existing probe into the scratchpad and adapt it; keep the conventions:

```ts
// <what it covers>. <network: none | which>. Usage (repo root): npx tsx <path>
import { join } from 'node:path';
const root = process.env.MM_REPO ?? process.cwd();
const mod = await import(join(root, 'src/core/<module>.ts')); // tsx resolves .ts sources

let findings = 0;
const find = (m: string): void => {
  findings++;
  console.log(`FIND  ${m}`);
};
const ok = (m: string): void => console.log(`ok    ${m}`);

// Positive control first: prove the harness reaches the code, or every check "passes".
// Fakes over network (inject deps like DiscoveryDeps / createClient), canary strings to detect
// leaks, reserved domains only, cleanup in finally. With fake fetch/sockets keep the event loop
// alive (setInterval) while awaiting — AbortSignal.timeout timers are unref'd.

console.log(findings === 0 ? 'clean' : `${findings} finding(s)`);
process.exitCode = findings === 0 ? 0 : 1;
```

Use `.mts` for TypeScript probes (ESM with top-level await wherever the file lives). Write
string payloads with `\uXXXX` escapes, never literal bidi/zero-width characters (Trojan Source).
