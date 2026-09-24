# Security

Mail Manager holds the keys to people's mailboxes and can delete their mail. Two things matter above all: **credentials must not leak** and **mail must never be deleted unintentionally**.

## Threat model

| Threat                                     | Impact                                                    | Mitigation                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase DB leaked / misconfigured RLS     | Attacker gets account rows                                | Secrets encrypted with a key **not in the DB**; RLS on every table; two-user RLS test                                                                           |
| Laptop / `.env.local` stolen (local phase) | Master key + session → decrypt all of that user's secrets | `.env*` gitignored, file perms 600; session file 600; document "revoke app passwords" procedure                                                                 |
| Master key lost                            | Stored passwords unrecoverable                            | Documented: users re-enter passwords; key backup is the operator's responsibility                                                                               |
| Accidental mass delete (bug or user error) | Irreversible mail loss                                    | Plan → confirm → exact-UID execution; Trash default; UIDVALIDITY guard; backup-before-expunge; audit                                                            |
| Malicious / malformed filter input         | Wrong messages selected, injection                        | zod validation; criteria passed as imapflow objects (library quotes/escapes); never build raw IMAP strings                                                      |
| MITM on IMAP connection                    | Credential theft                                          | Implicit TLS port 993 only, `rejectUnauthorized: true`, no STARTTLS-downgrade / plaintext fallback                                                              |
| Secrets in logs / error messages           | Leak via terminal, CI, bug reports                        | Typed, allowlisted log events only ([LOGGING.md](LOGGING.md)) + canary tests; never log config objects; user-facing errors are whitelisted text, never password |
| Compromised npm dependency                 | Code execution with access to secrets                     | Few deps, committed lockfile, `npm audit` in CI, pin versions, review new deps                                                                                  |
| Secrets committed to git                   | Permanent exposure                                        | `.gitignore`, `.env.example` only, gitleaks in CI (M0), optional local gitleaks                                                                                 |
| Web UI (M6): CSRF / XSS / exposed port     | Session hijack, remote delete                             | Bind `127.0.0.1`, helmet + strict CSP, CSRF token, JWT verified per request, rate limiting                                                                      |
| App used to guess mailbox passwords        | Brute force against third parties; user's IP banned       | No automatic login retry (M1b-2a); login guard (M1b-2b, `guardedOpenSession`): challenge → pair lock → IP block → permanent; Turnstile/WAF when hosted (M6a)    |
| App used to probe hosts/accounts           | Host/port scanning, account enumeration                   | One generic login-failure message (no code); precise reason only inside core                                                                                    |
| SSRF / DNS rebinding via a typed IMAP host | Server connects to internal addresses                     | IP/localhost hosts refused today; resolve-and-pin guard for private ranges deferred to M6a                                                                      |
| Hostile IMAP server data                   | Oversized/odd data stored or printed                      | Capabilities sanitised + capped before `mail_accounts.capabilities`; server text never printed                                                                  |

## Credential encryption

- **Algorithm:** AES-256-GCM (Node `crypto`), authenticated encryption — tampering makes decryption fail.
- **IV:** 12 random bytes per encryption, never reused. Stored with the row.
- **Tag:** 16 bytes, stored separately; decryption must verify it.
- **AAD (additional authenticated data):** `mail_accounts:<user_id>:<account_id>` (`accountAad()` in `src/core/crypto.ts`), so a ciphertext copied into another row or another user's account fails to decrypt. `id` and `user_id` are immutable at the DB level (column-level grants) to keep the binding stable.
- **Key:** `MM_MASTER_KEY` — 32 random bytes, base64, from env. Validated at startup (exact length).
- **Rotation:** `key_version` column; see DATA_MODEL.md.
- **In memory:** decrypt right before connecting, don't cache plaintext longer than the operation.
- **Later:** envelope encryption with a KMS / secrets manager (per-row data keys wrapped by a KMS key) when hosted.

## Auth

- Supabase Auth, email + password (MVP), **invite-only**: public signups disabled in the Supabase dashboard (verified live: `/auth/v1/settings` → `disable_signup: true`), users created there. No `mm signup`. `mm doctor` fails its `signup` check if signups are re-enabled. MFA (TOTP) in beta.
- Every Supabase request has a timeout (10 s; 5 s inside `mm doctor`) and PostgREST auto-retries are off, so a paused or unreachable project fails fast with "Supabase unreachable" instead of hanging.
- `mm login` prompts for the password (hidden) and refuses to run without a TTY.
- CLI stores the Supabase session in `session.json` under `$MM_CONFIG_DIR`, `$XDG_CONFIG_HOME/mail-manager` or `~/.config/mail-manager` — dir 700, file 600, written atomically (tmp file 600 → rename). A corrupt file counts as logged out.
- `mm logout` always deletes the local session, even offline (server-side revocation is best effort). Without a local session (missing or corrupt file) it says "Not logged in" and sends nothing to Supabase.
- Table privileges: `anon` has none on `mail_accounts`; `authenticated` has no TRUNCATE and can't update `id`/`user_id`/`created_at` (see DATA_MODEL.md).
- CLI uses the publishable key (formerly "anon") + user JWT → RLS applies. Service-role key never leaves the server.

## IMAP session (M1b-2a)

All logins go through `openSession` (`src/core/imap/session.ts`):

- Implicit TLS on 993, `rejectUnauthorized: true`, `minVersion: 'TLSv1.2'`, SNI = host. No STARTTLS, no plaintext. The host is re-validated (no IP literals, no `localhost`).
- `logger: false`: imapflow's log lines can contain server text. Client ID sends only `name` + `version`.
- **One attempt, no retry.** A failed login is never repeated automatically.
- The password is removed from the imapflow client options as soon as `connect()` settles (success or failure). The session object never exposes it (`toJSON` / `inspect` show host, username, server name, features only).
- Username/password with CR, LF, NUL (or invisible characters in the username) are rejected before any network activity, so they can't break out of an IMAP command.
- Every failure becomes an `ImapSessionError` with a reason and a whitelisted code token. No `cause`, no server text, no executed command. `src/cli/bin.ts` shows only whitelisted core error classes (`errorText`); everything else is "Unexpected error".
- Known gap, accepted: imapflow sends the password (AUTHENTICATE PLAIN, or LOGIN) even to a server that advertises `LOGINDISABLED` together with `AUTH=PLAIN`, or only `AUTH=XOAUTH2`. Over verified TLS to the user's own provider this is acceptable.
- Server capabilities are untrusted: names must match `[A-Z0-9][A-Z0-9=+-._/]*` (≤ 64 chars), values `true` or a non-negative integer, at most 256 entries. The repo guards `mail_accounts.capabilities` with the same bounds (`recordCheck` and row parsing; names matched case-insensitively there, `sanitizeCapabilities` always writes upper case). An invalid stored record makes the row fail to parse (strict on purpose: only `recordCheck` writes it).

## Login guard (M1b-2b)

From M1c on, every IMAP login the app makes goes through `guardedOpenSession` (`src/core/imap/guarded-session.ts`) → `LoginGuard` (`src/core/security/login-guard.ts`); no command logs in yet. A blocked attempt never reaches the mail server.

| Counter                | Rule                          | Result                                                          |
| ---------------------- | ----------------------------- | --------------------------------------------------------------- |
| (IP + mailbox) pair    | 2 counted failures in 15 min  | challenge (CLI: 5 s announced wait; server: Turnstile in M6a)   |
| (IP + mailbox) pair    | 5 counted failures in 15 min  | pair locked 15 min ("too many wrong passwords", end time)       |
| (IP + mailbox) pair    | a lockout in the last 24 h    | challenge on every attempt (no free guesses after a lock)       |
| IP                     | 3 pair lockouts in 24 h       | IP blocked 24 h, all mailboxes                                  |
| IP                     | 3 IP blocks in 30 days        | permanent ("contact Mail Manager support")                      |
| mailbox across all IPs | 10 counted failures in 15 min | challenge only — never a lock, so nobody can lock the owner out |

- **Counted:** only credential failures — `auth-failed`, `app-password-required`, `password-expired`, `contact-admin`, `server-rejected`. Timeouts, refused/reset, TLS, no internet, OAuth-only and input validation never count (a flaky network must not lock anyone out). A success resets the pair's failure counter; lockout/block history stays.
- **Keys:** the mailbox is `HMAC-SHA256(key, [normalised host, trimmed lower-cased username])`, key = HKDF(`MM_MASTER_KEY`, `mm-login-guard-v1`) (random per process without a master key). Stores and records never contain a plain address, host or password.
- **IP buckets** (`normalizeIp`, `src/core/security/ip.ts`): IPv4 and every IPv4-in-IPv6 form (mapped in any spelling, IPv4-compatible, NAT64 `64:ff9b::/96`) → the IPv4 address; other IPv6 → its /64; zone ids ignored; anything unparsable → `invalid`. `local` is the CLI's own bucket — the server must pass the socket (or trusted proxy) address and never accept `local` from a request.
- **Known gaps:** a different host name for the same server (an alias/CNAME) gives a different mailbox target, so the pair/mailbox counters start again — the IP tier still applies; the server (M6a) should use the discovered host. In-memory entries are pruned only when their key is used again; the hosted store needs TTLs.
- **Concurrency:** in-process, attempts for the same pair are serialised (`withPairLock`, not re-entrant) and every counter update runs one at a time, so parallel attempts on different pairs can't skip the IP block or the mailbox challenge. The hosted store (M6a) must make each read-modify-write atomic (transaction / Redis script).
- **Where it's effective:** the store is in-memory for now. In the CLI the counters live for one `mm` run (M1c's password retries); IP blocks and the permanent tier matter once the server has a persistent store (M6a). Known limit until then: no unblock procedure — a permanently blocked shared/NAT IP needs M6a's support tooling.
- **Block records:** one `SecurityEvent` per block (pair lock, IP block, permanent) to a `SecurityEventSink`; `LineEventSink` writes one line per event:

  ```text
  mm-security {"ts":"2026-09-22T14:17:00.000Z","event":"login-guard.block","kind":"ip-blocked","reason":"auth-failed","ip":"203.0.113.7","addr":"203.0.113.7","attempts":3,"until":"2026-09-23T14:17:00.000Z","target":"<64 hex>"}
  ```

  `ip` is the counting bucket (IPv4, IPv6 /64, `local`, `invalid`); `addr` is one concrete address a firewall can ban, or `null`. fail2ban filter (`FAIL2BAN_FAILREGEX` in `src/core/security/events.ts`; `<ADDR>` needs fail2ban ≥ 0.10) — matches only `ip-blocked` and `permanent`, never a single mailbox lock, and never a line without a bannable `addr`:

  ```ini
  [Definition]
  failregex = ^.*mm-security \{"ts":"[^"]+","event":"login-guard\.block","kind":"(?:ip-blocked|permanent)","reason":"[a-z-]+","ip":"[^"]+","addr":"<ADDR>"
  ```

  Behind Cloudflare, the client IP must come from `CF-Connecting-IP` (and the ban go through Cloudflare's API / WAF rules), not the socket address (M6a).

- **Where they go:** from M1b-4 the CLI writes them to the local security log (`<config dir>/logs/security-<date>.log`, dir 700 / file 600) together with the other security events (`auth.*`, `imap.login*`, `login-guard.challenge`); on a VPS a fixed `security.log` for fail2ban, on Vercel the `security_events` table (M6a). Details: [LOGGING.md](LOGGING.md).
- **Retention:** records contain IP addresses (personal data under GDPR): keep them at most **90 days**, then delete.

## Database access (injection audit, 2026-09-22)

- All Supabase access is in `src/core/db/supabase/` and uses only the parameterised supabase-js builders (`insert`, `select`, `eq`, `update`, `delete`, `order`). No `.or()`/`.filter()` strings, no `.rpc()`, no raw SQL, so no SQL or PostgREST-filter injection through user input.
- Account ids are validated as UUIDs before any request (`get` → `null`, `updateSecret`/`recordCheck`/`remove` → `false`).
- Keep it that way: any future `.or()`/`.filter()` with user input needs escaping and a test; prefer the typed builders.

## Destructive-operation protocol

1. **Plan:** resolve filter → exact UID set per folder, record `UIDVALIDITY`, totals, samples. No changes.
2. **Confirm** (details: [IMAP.md §6.4](IMAP.md#64-confirmation-flow-for-every-delete)):
   - **Notices** the user must accept: any capability fallback, which Trash folder is used and how it was found, and Gmail search disagreements.
   - The **full list of every planned message** (folder, date, from, subject, size), paged, optionally written to a local file (600). Shown locally only, never sent to Supabase.
   - **Two confirmations:** `y/N`, then type the exact count (`DELETE <n>` for permanent).
   - Interactive only. No `--yes`. `--max N` is a ceiling.
3. **Execute** (strategy per capability: [IMAP.md §6.2](IMAP.md#62-delete-strategy-matrix)):
   - Default: `UID MOVE` to the Trash folder: server-marked `\Trash`, or one the user confirmed ([IMAP.md §6.5](IMAP.md#65-choosing-the-trash-folder)). Fallback: `UID COPY` + `\Deleted` + `UID EXPUNGE`. Neither MOVE nor UIDPLUS: `UID COPY` + `\Deleted` without expunge, after a notice.
   - Permanent (`--expunge`): set `\Deleted` on planned UIDs, then `UID EXPUNGE <uids>` (requires **UIDPLUS**).
   - **No UIDPLUS → no permanent delete.** The user is told and offered a move to Trash instead. A plain `EXPUNGE` would also remove unrelated messages that were already flagged `\Deleted` by another client.
   - **Never** call imapflow's `messageDelete`/`messageMove` without UIDPLUS/MOVE, or `mailboxClose()` on a writable folder: they fall back to a folder-wide `EXPUNGE`/`CLOSE` ([IMAP.md §6.1](IMAP.md#61-messagedelete-and-messagemove-can-issue-a-folder-wide-expunge)).
   - Re-check `UIDVALIDITY` before each batch; if changed → abort, nothing further touched.
   - Batches of ~500 UIDs, progress, resumable from the plan.
4. **Backup-first:** on by default for `--expunge`.
5. **Audit:** one `audit_log` row per folder per run with result `ok|partial|failed|aborted`.

**Gmail specifics:** a message in a label folder is the same message as in `[Gmail]/All Mail`. Removing it from a label folder only removes the label. Real deletion = move to `[Gmail]/Trash` (Gmail empties it after 30 days, or expunge there).

## Data minimisation

- No message content, subjects or message addresses in Supabase.
- Saved filters may contain addresses the user typed — accepted, user-authored config.
- Local backups contain full mail: output directories created with mode 700, files 600; README warns the user to store them safely. Optional encrypted archives: later.

## Compliance (GDPR — project is EU-based)

- Local single-user phase: user processes their own data.
- **Before hosting other people's mailboxes:** privacy policy, legal basis, data-processing agreement with Supabase / hosting provider, EU region, account + data deletion flow, breach procedure.

## OAuth2 (M6) — cost & timeline risk

- Google classifies full Gmail IMAP access (`https://mail.google.com/`) as a **restricted scope**. A public app needs Google verification **and an annual third-party security assessment (CASA)** — significant cost and weeks of lead time. Until then: app passwords, or OAuth in "testing" mode limited to explicitly added test users.
- Microsoft (Outlook.com / M365) requires an Azure app registration with `IMAP.AccessAsUser.All`; lighter process, still needs publisher verification for broad use.

## Checklist per milestone

- [ ] No secret in logs (grep test output for the test password — see the leak check in TESTING.md).
- [ ] New commands/operations have their events in the [LOGGING.md](LOGGING.md) catalog and the milestone's Logging section; canary test covers them; state changes write an `audit_log` row.
- [ ] New tables have RLS + policies in the same migration.
- [ ] New inputs validated by zod.
- [ ] `npm audit` clean (or justified).
