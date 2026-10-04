# Logging

What Mail Manager records, where, for how long, and how it's read. **Status:** design (2026-09-23); the log core and run logging are built (**M1b-4a**, 2026-09-28: `src/core/log/`, `src/cli/run.ts`), and `mm logs` reads them back (**M1b-4c**, 2026-09-30). **M1b-4 — Logging foundation** ([milestone](milestones/M1-auth-accounts.md#m1b-4--logging-foundation)) was split on 2026-09-28 into 4a log core + run logging → 4b domain and security events → 4c `mm logs` → 4d audit trail; every later milestone adds its own events (see [Event catalog](#event-catalog)).

**Goal:** answer the questions we will actually ask — _who logged in, what did this command change, why did it fail, is someone attacking?_ — without creating a new place where passwords, mail content or personal data can leak. "Log everything" is not the goal: more lines mean more noise, more leak surface, more cost (hosted logs are billed per GB) and more GDPR exposure.

## Decisions (2026-09-23)

- Four kinds of records, split by **purpose and reader** (not by subject): audit trail, security events, app log, and — only once hosted — metrics/errors/uptime.
- Order: **M1b-3 test ground → M1b-4 logging foundation → M1c account commands**, so every command that manages mailboxes logs from day one.
- The cloud **`audit_log` table is created in M1b-4** (not M4): adding/removing accounts is audited from M1c on; M4 only adds delete rows.
- Local files live in `<config dir>/logs/` (same folder resolution as the session file).
- Events are **typed and allowlisted** — no free-form "log this object".

## Principles

1. **Allowlisted, typed events.** Each event is a TypeScript type with only the fields it may carry, so a password or a subject has no field to land in. The catalog lives in `src/core/log/events.ts` (including the login guard's `login-guard.block`, formerly its own `SecurityEvent` type). Core emits events through an `EventLog` interface; the shell decides where they go (file, stdout, table) — core never prints.
2. **Never logged, anywhere** — local files included, because users send them to support: see [Never logged](#never-logged).
3. **IDs instead of names:** Supabase user id, account UUID, preset provider id (`websupport`, `custom`), plan/backup id, typed reason codes, counts, bytes, durations, and an HMAC for login targets.
4. **Logging never breaks the app.** A failed write is swallowed (the command still works); `mm doctor` reports an unwritable log folder. Every line is under 4 KB (fields are capped), so parallel `O_APPEND` writes from two `mm` runs don't interleave. Lines are built with `JSON.stringify`, which escapes newlines, so input can't forge a second line (log injection).
5. **Summaries, not firehoses.** Long operations log one summary line (and one `debug` line per batch of ~500), never one line per message.
6. **Structural, not remembered.** Command start/finish is logged automatically for every command; tests check that the code's events and this catalog match (see [Keeping it complete](#keeping-it-complete)).

## Four kinds of records

| Kind                      | Answers                                                                                           | Reader                   | Where (local phase → hosted)                                                                                              | Retention                     |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Audit trail               | What did the user change? (account added/removed, filter saved, N messages to Trash, backup made) | the user, support        | Supabase `audit_log` — append-only (RLS select + insert, no update/delete) — [DATA_MODEL.md](DATA_MODEL.md)               | while the user account exists |
| Security events           | Who logged in, what failed, who got challenged or blocked?                                        | operator, fail2ban / WAF | local `security-*.log` (`mm-security {json}`) → server: fixed `security.log` for fail2ban + `security_events` table (M6a) | 90 days (contains IPs)        |
| App log                   | What did this run do, how long did it take, why did it fail?                                      | developer, support       | local `app-*.log` (JSON Lines) → server: stdout → platform / log service                                                  | 30 days                       |
| Metrics / errors / uptime | Is it healthy right now? Tell me when it isn't.                                                   | operator                 | hosted only (M6a/M7): log-derived metrics, error tracking, uptime checks, cron heartbeats                                 | per service                   |

**Already logged elsewhere — don't rebuild:** Supabase Auth records every app sign-in, sign-out, token refresh and failure (user id, IP, user agent). Its Logs Explorer keeps them **1 day on the free plan, 7 days on Pro**; optionally they are also written to `auth.audit_log_entries` in our database (Authentication → Configuration → Audit Logs). That is the central "who logged in to Mail Manager" record for the operator. Decided 2026-09-29: the database copy is **on** (set in the dashboard by the user), kept 90 days (IPs) — the cleanup job comes later (TODO → Later).

## Never logged

In no log, no audit row and no event field — local or cloud:

- passwords, app passwords, OAuth tokens, Supabase session/refresh tokens, `MM_MASTER_KEY`, any key material;
- message bodies, subjects, message sender/recipient addresses, attachment names, Message-IDs;
- the mailbox address, its domain and the IMAP host (they identify a person) — use the account UUID, the provider id and the login-guard HMAC target instead;
- what the user typed into a **failed** login (people type the password into the address field) — only an HMAC target, and only when the input is a valid address (otherwise `target: "invalid"`: a hashed password could be guessed offline by anyone who can read both the log and `.env.local`). `mm login` uses its own key (HKDF info `mm-auth-target-v1`), so these hashes never match mailbox targets;
- raw server replies, raw library error messages, `String(err)` of unknown errors;
- command-line option **values** (only option names), environment variables, config objects;
- absolute paths containing the home directory (stack frames are logged relative to the package root).

Allowed in the **cloud** audit trail: counts, bytes, folder names, the saved-filter definition (user-authored config, see [SECURITY.md](SECURITY.md#data-minimisation)), result and a typed reason. Per-message detail (UIDs, dates, subjects) stays in local artifacts — the plan file (M4) and the backup manifest (M5) — and log lines point to them by id.

## Record format

**JSON Lines**, one event per line, UTC ISO-8601 timestamps with milliseconds. `security` lines carry the `mm-security ` prefix (already used by the login guard and its fail2ban filter); `app` lines are plain JSON (works with `jq` and every log shipper).

| Field     | In                    | Meaning                                                                                 |
| --------- | --------------------- | --------------------------------------------------------------------------------------- |
| `ts`      | every line            | event time, UTC ISO-8601 with ms                                                        |
| `event`   | every line            | event name from the catalog, e.g. `command.finish`                                      |
| _fields_  | per event             | the event's own allowlisted fields (catalog)                                            |
| `level`   | every line            | `debug` · `info` · `warn` · `error` (syslog / OpenTelemetry severities map 1:1)         |
| `run`     | every line            | random run id: one `mm` invocation (server: one request / job run); ties start → finish |
| `v`       | every line            | schema version (starts at 1; bump on incompatible change)                               |
| `cmd`     | command events        | command path, e.g. `account add`                                                        |
| `user`    | when known            | Supabase user id (UUID) — never the e-mail                                              |
| `acct`    | account-scoped events | mail account UUID                                                                       |
| `outcome` | finish events         | `ok` · `failed` · `partial` · `aborted` · `interrupted` · `blocked` (per event)         |
| `reason`  | failures              | typed reason code (e.g. `ImapFailureReason`), never text                                |
| `ms`      | finish events         | duration                                                                                |

**Key order:** `ts`, `event` first, then the event's fields in a fixed order, then `level`, `run`, `v`. Fixed order keeps line filters stable: `FAIL2BAN_FAILREGEX` anchors on `ts, event, kind, reason, ip, addr` of `login-guard.block` — new fields are only ever appended at the end, and a test checks the regex still matches.

**Naming:** `<area>.<action>`, lower-case, kebab-case inside a part (`login-guard.block`, `auth.login-failed`, `account.password-update`). The catalog maps each security event to the [OWASP Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html).

**Reading back:** log lines are untrusted input (anyone with file access can edit them). `mm logs` checks every line against its event's strict zod schema; malformed lines are skipped and counted, never printed raw ([Reading the logs](#reading-the-logs)).

Examples (a `mm discover` run; a failed `mm login`):

```text
{"ts":"2026-09-23T10:15:02.123Z","event":"command.start","cmd":"discover","opts":[],"ver":"0.3.0","node":"22.13.0","os":"linux","level":"info","run":"5f3a9c1e2b7d4a60","v":1}
{"ts":"2026-09-23T10:15:03.655Z","event":"discover.finish","outcome":"found","source":"preset-mx","provider":"websupport","level":"info","run":"5f3a9c1e2b7d4a60","v":1}
{"ts":"2026-09-23T10:15:03.660Z","event":"command.finish","cmd":"discover","outcome":"ok","exit":0,"ms":1537,"level":"info","run":"5f3a9c1e2b7d4a60","v":1}
mm-security {"ts":"2026-09-23T10:20:11.004Z","event":"auth.login-failed","reason":"invalid-credentials","target":"<64 hex>","level":"warn","run":"0c9e2d7a41b3f865","v":1}
```

## Event catalog

Kind: **A** = app log, **S** = security log, **Au** = also an audit row (`audit_log.action` in brackets). Fields exclude the envelope (`ts`, `event`, `level`, `run`, `v`). "Emitted from" = the milestone whose code first produces the event.

### Foundation (M1b-4)

| Event                   | Kind | Level                     | Fields                                                                                                                                                                                                        | OWASP                  | Emitted from |
| ----------------------- | ---- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------ |
| `command.start`         | A    | info                      | `cmd`, `opts` (option names), `ver`, `node`, `os`                                                                                                                                                             | —                      | M1b-4a       |
| `command.finish`        | A    | info/warn                 | `cmd`, `outcome` (`ok`/`failed`/`interrupted`), `exit`, `ms`                                                                                                                                                  | —                      | M1b-4a       |
| `error.unexpected`      | A    | error                     | `errClass`, `code`, `stack` (frames only, relative paths, no message)                                                                                                                                         | `sys_crash` (≈)        | M1b-4a       |
| `log.truncated`         | A    | info                      | — (a day file reached its cap: 5 MB app, 150 MB security; nothing more is written to it that day)                                                                                                             | —                      | M1b-4a       |
| `doctor.check`          | A    | info/warn                 | `check` (fixed check name), `status` (`ok`/`warn`/`fail`) — one per check                                                                                                                                     | —                      | M1b-4b       |
| `discover.finish`       | A    | info                      | `outcome` (`found`/`needs-host`/`blocked`/`manual`/`invalid`), `source?`, `provider?` (preset id), `domainProblem?`, `choice?` (`picked`/`host-entered`/`manual`/`cancelled`) — never address, domain or host | —                      | M1b-4b       |
| `audit.write-failed`    | A    | error                     | `action` (audit action, or `other`), `reason` (`forbidden`/`unavailable`/`conflict`/`not-found`/`unknown`/`invalid`) — the action happened but its `audit_log` row couldn't be written                        | —                      | M1b-4d       |
| `auth.login`            | S    | info                      | `user?` (Supabase user id)                                                                                                                                                                                    | `authn_login_success`  | M1b-4b       |
| `auth.login-failed`     | S    | warn                      | `reason` (`invalid-credentials`/`unreachable`/`unknown`/`unexpected`), `target` (HMAC of the typed e-mail with its own key, or `invalid` when the input isn't an address)                                     | `authn_login_fail`     | M1b-4b       |
| `auth.logout`           | S    | info                      | `outcome` (`logged-out`/`not-logged-in`) — no user id (no network call)                                                                                                                                       | `session_expired`      | M1b-4b       |
| `imap.login`            | S    | info                      | `acct?`, `provider`, `ip`, `target`                                                                                                                                                                           | `authn_login_success`  | M1b-4b       |
| `imap.login-failed`     | S    | warn                      | `acct?`, `provider`, `reason` (`ImapFailureReason` or `blocked`), `counted`, `ip`, `target`                                                                                                                   | `authn_login_fail`     | M1b-4b       |
| `login-guard.challenge` | S    | warn                      | `ip`, `attempts`, `target`                                                                                                                                                                                    | `authn_login_fail_max` | M1b-4b       |
| `login-guard.block`     | S    | warn (`permanent`: error) | `kind`, `reason`, `ip`, `addr`, `attempts`, `until`, `target`                                                                                                                                                 | `authn_login_lock`     | M1b-4b       |

The `imap.*` and `login-guard.*` events are emitted by `LoginGuard` / `guardedOpenSession` since M1b-4b (unit-tested with a fake opener); M1c is the first command that logs in to a mailbox, so it passes a file log and they reach `security-*.log` from then on. Runs that never reach a command — `--help`, `--version`, an unknown command or option, a missing argument — write no lines (commander stops before the `preAction` hook, and a finish is only written after a start).

### Account commands (M1c-1)

| Event                     | Kind                               | Level     | Fields                                                                                                                                                                                                                                                                                                                             | OWASP | Emitted from |
| ------------------------- | ---------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| `account.add`             | A + Au (`account.add`)             | info/warn | `acct?` (UUID, only once saved), `provider` (preset id or `custom`), `outcome` (`ok`/`failed`), `reason?` (failed only: an `ImapFailureReason`, `blocked`, `duplicate`, `not-found`, `secret-unreadable`, `unsupported`, `database`, `unexpected`) — audit row for ok **and** failed attempts (failed: `account_id` null + reason) | —     | M1c-1        |
| `account.test`            | A                                  | info/warn | same fields as `account.add` — no audit row (a test changes nothing)                                                                                                                                                                                                                                                               | —     | M1c-1        |
| `account.password-update` | A + Au (`account.password-update`) | info/warn | same fields — audit row on success                                                                                                                                                                                                                                                                                                 | —     | M1c-1        |
| `account.remove`          | A + Au (`account.remove`)          | info/warn | same fields — audit row on success, written after the delete with `account_id` null                                                                                                                                                                                                                                                | —     | M1c-1        |

Since M1c-2 the audit rows of an existing account carry its UUID in `details.account` (`account.add` ok, `account.password-update` ok, `account.remove`), and `mm account update-password` refusing an unreadable stored secret emits the failed `account.password-update` (`secret-unreadable`) from core (`assertSecretReadable`) — no new events, and still no audit row for a failed password update.

The account commands log in through `guardedOpenSession` with the run's file log, so `imap.login`, `imap.login-failed`, `login-guard.challenge` and `login-guard.block` reach `security-*.log` (the same log is passed to the `LoginGuard`). `mm account add` emits `account.add`, not `discover.finish`.

### Mailbox insight (M2a)

| Event                      | Kind | Level     | Fields                                                                                                                                                                                                                                      | OWASP | Emitted from |
| -------------------------- | ---- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| `folders.list`             | A    | info/warn | `acct?` (UUID), `folders` (number listed), `ms`, `outcome` (`ok`/`failed`), `reason?` (failed only: an account failure reason, or a mailbox code `list-failed` / `connection-lost` / `folder-unavailable`) — no audit row (nothing changes) | —     | M2a          |
| `imap.capability-fallback` | A    | warn      | `feature` (`status-size` / `quota` / `list-status`), `fallback` (`fetch-size-sum` / `folder-sum` / `status-per-folder`) — at most once per feature per run                                                                                  | —     | M2a          |

`imap.capability-fallback` goes to the **app** log, unlike the other `imap.*` events (security log): it describes the server's features, not a login. The core returns the fallbacks it used and the CLI emits the events, so the core logs nothing while reading folders. Never logged: folder names, per-folder counts, the address or host. `mm folders` logs in through `guardedOpenSession`, so its `imap.login` / `imap.login-failed` reach the security log as for the account commands.

### Folder browser (M2b-2)

| Event           | Kind | Level     | Fields                                                                                                                                                                                                                                                                                                                                                         | OWASP | Emitted from |
| --------------- | ---- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| `browse.finish` | A    | info/warn | `acct?` (UUID), `folders` (folders opened with Enter), `mails` (mail rows loaded), `marked` (marks in the basket at the end), `bytes` (known sizes of the marked mails), `reconnects`, `ms`, `outcome` (`ok` / `interrupted` / `failed`), `reason?` (failed only: an account failure reason, a mailbox code, or `unexpected`) — no audit row (nothing changes) | —     | M2b-2        |

`browse.finish` is written once per browser run of `mm folders` — after `q`, after Ctrl+C, and through the terminal's exit hook on signals and crashes — and always before `command.finish`. None when the browser never opened (no terminal, `--plain`, `--json`, failed login or listing). `ok` = quit with `q`; `interrupted` = Ctrl+C or an exit hook with code 130, 129 (SIGHUP) or 143 (SIGTERM); `failed` = an error in the browser (its reason) or an exit hook with any other code (`unexpected`). After SIGTERM/SIGHUP it says `interrupted` while `command.finish` says `failed (exit 143/129)`: `command.finish` derives its outcome from the exit code, where only 130 counts as interrupted — intended. Never logged: folder names, subjects, senders, addresses or the host; no audit row (the browser changes nothing). A reconnect logs in through `guardedOpenSession`, so its `imap.login` / `imap.login-failed` reach the security log.

### Mailbox stats (M2c-1)

| Event          | Kind | Level     | Fields                                                                                                                                                                                                                                                                                                                          | OWASP | Emitted from |
| -------------- | ---- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| `stats.finish` | A    | info/warn | `acct?` (UUID), `folders` (folder rows scanned), `messages`, `bytes` (sum of the message sizes read), `ms`, `outcome` (`ok`/`failed`), `reason?` (failed only: an account failure reason, a mailbox code such as `connection-lost` / `folder-not-found` / `gmail-all-hidden`, or `unexpected`) — no audit row (nothing changes) | —     | M2c-1        |

`stats.finish` is written once per `mm stats` run, in the command's `finally` once the account is known — after a failed login, listing or scan too, before `command.finish`. On failure `folders`, `messages` and `bytes` are 0 (no partial result is returned). Nothing on Ctrl+C: `runCli`'s SIGINT exit ends the process and `command.finish` says interrupted. `mm stats` emits no `imap.capability-fallback`, deliberately: its listing skips STATUS (LIST + quota only) and reads sizes from its own FETCH, so `listFolders`' `list-status` / `quota` fallback flags don't describe a sizing path. Never logged: folder names, senders, domains, subjects, addresses or the host. The login goes through `guardedOpenSession`, so `imap.login` / `imap.login-failed` reach the security log.

### Later milestones (planned — each milestone doc has a "Logging" section)

| Milestone | Events                                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M3        | `search.finish` (`acct`, `count`, `bytes`, `ms`, `criteria` = criterion **names** only) · `gmail.search-mismatch` (warn: counts only) · `filter.save` / `filter.delete` (A + Au: filter id)                                                                                          |
| M4        | `delete.plan` (plan id, `count`, `bytes`, `folders`) · `delete.confirm` · `delete.batch` (debug) · `delete.finish` (`outcome` incl. `aborted` + `reason: uidvalidity-changed`) → Au `mail.trash` / `mail.expunge` / `mail.move` · `trash.select` (`source`: extension / name / user) |
| M5        | `backup.start` · `backup.finish` (backup id, `count`, `bytes`) · `backup.verify` (`ok`, `hashFailures`) → Au `backup`                                                                                                                                                                |
| M6a       | `http.request` (method, route template, status, `ms`, request id — no query string, no body) · `http.csrf-failed` (`malicious_csrf`) · `http.csp-violation` (`malicious_csp_violation`) · `http.session-invalid` (`session_use_after_expire`)                                        |
| M6b       | `job.start` · `job.finish` (job id, `outcome`, `count`, `bytes`, `ms`) → `job_runs` row + heartbeat ping                                                                                                                                                                             |
| M6c       | `migrate.finish` (copied / skipped / failed / bytes, like imapsync's run summary) → Au `migrate`                                                                                                                                                                                     |
| M6d       | `oauth.token-refresh` · `oauth.token-revoked` (`authn_token_revoked`) — never token values                                                                                                                                                                                           |

## Where logs live

### Local CLI (M0–M5)

- Folder: `<config dir>/logs/` — `$MM_CONFIG_DIR` → `$XDG_CONFIG_HOME/mail-manager` → `~/.config/mail-manager` (same resolution as `session.json`; tests override one variable). Dir **700**, files **600**.
- One file per **UTC** day (the date of the line's `ts`) and kind: `app-2026-09-23.log`, `security-2026-09-23.log`. Caps per file and kind: **5 MB** for `app-*`, **150 MB** for `security-*` (decided 2026-09-28: dropping security lines would hide a login flood exactly when it matters; local logs are per OS user and machine and normal use writes a few lines per login, so only a script loop or a bug gets near it — the cap can be lowered later). From 80 % of the cap `debug` lines are dropped; at the cap one `log.truncated` marker is written (it bypasses the level threshold, takes the file's prefix, and is found again by reading the file's last 4 KB, so two runs don't both write it) and the rest of the day is skipped.
- The folder is created on the first write (never for `--help`); `chmod` is re-applied (700/600) and symlinks are never followed. A folder that can't be created or written (e.g. `MM_CONFIG_DIR` points at a file) only means no logs — the command's output and exit code don't change.
- **Housekeeping at startup** (the CLI has no daemon, so on the first event of a run — even when the level filters it out, but only if the folder already exists; it is never created just to prune): delete `app-*` files older than 30 days and `security-*` files older than 90 days (by the date in the name — no need to read them; a file exactly 30 days old stays, future dates and other files are never touched).
- Writes are **synchronous** (one `writeSync` per line on a file opened with `O_APPEND | O_NOFOLLOW`): `src/cli/bin.ts` ends every run with `process.exit()`, which would drop buffered async writes. An `exit` handler records `command.finish` even when a command exits directly. `interrupted` = exit code 130 (Ctrl+C inside a prompt: inquirer raises `ExitPromptError`, the command exits 130) or a SIGINT signal (Ctrl+C elsewhere: a handler writes the finish line and exits 130). Uncaught exceptions and unhandled rejections print "Unexpected error" (no stack) and log `error.unexpected`.
- Level threshold: `info` by default; `MM_LOG_LEVEL=debug|info|warn|error` (zod-validated in `config.ts`; an invalid value falls back to `info` and `mm doctor` warns). It applies to the app log only — security lines are always written. There is no `off` (decided 2026-09-28).
- Volume estimate: a run writes 2–10 lines (≈ 1–3 KB); a 100k-message delete at `debug` adds ~200 batch lines. Well under the caps.

### Local web UI and worker (M6a, M6b)

Same folder and files. Fastify's built-in logger (pino) writes `http.request` lines through the same `EventLog` interface (async is fine in a long-running process; flush on shutdown).

### Hosted — Vercel first

- stdout/stderr become Vercel **Runtime Logs**: kept **1 hour on Hobby, 1 day on Pro** (3 days Enterprise; 30 days with Observability Plus). Keeping more needs a **Log Drain** — Pro/Enterprise only, **$0.50 per GB** — to a log service (Axiom, Better Stack, Grafana Cloud, Sentry…).
- Serverless instances share no disk: security events go to the Supabase **`security_events`** table (M6a; RLS, service role, 90-day retention job), which also feeds the Vercel Firewall rules.
- Supabase's own logs (API, Postgres, Auth): 1 day on free, 7 on Pro, 28 on Team; longer only through Supabase log drains.

### Hosted — VPS later

- Files under `/var/log/mail-manager/` rotated by logrotate; the security log is a **fixed** `security.log` so fail2ban can follow it (`FAIL2BAN_FAILREGEX`).
- A shipper (Grafana Alloy or Vector) sends the JSON lines to Grafana Cloud Loki or a self-hosted Loki.

### Retention summary

| Record                      | Retention                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| local `app-*.log`           | 30 days                                                                                               |
| local `security-*.log`      | 90 days (IP addresses are personal data)                                                              |
| `audit_log` (Supabase)      | while the user exists; removing a mail account sets `account_id` null; deleting the user deletes rows |
| `security_events` (M6a)     | 90 days, deleted by a scheduled job                                                                   |
| Supabase Auth logs          | platform: 1 day (free) / 7 days (Pro); `auth.audit_log_entries` copy: on, 90 days (cleanup job later) |
| hosted log / error services | set per service at M7; never longer than the table above                                              |

## Reading the logs

- **`mm logs`** (M1b-4c) — a flat list of the last 24 h, one line per event in time order, local time (`HH:MM:SS`; a date header before each day when the list spans days or isn't today). Plain words from the event's real fields only (`src/cli/log-text.ts`), never ids, IPs or targets:

  ```text
  10:15:58  login         started
  10:16:03  login         Mail Manager login failed: invalid credentials
  10:16:03  login         failed (exit 1) after 5.2 s
  10:17:40  discover      interrupted or still running
  ```

  - **Filters:** `--since 30m|24h|7d` (1 minute … 90 days), `--level debug|info|warn|error` (a minimum, default info), `--security` (security lines only), `--run <16 hex>` (one run; searches all retained files unless `--since` is given), `--json`.
  - **`--json`:** one **validated, re-serialized** record per line (canonical key order, catalog fields only) — never the raw lines; footers go to stderr, so stdout parses with `jq`/`JSON.parse`. Interrupted markers are never printed, so they don't use up the 5,000-record cap (`readLogs` option `interrupted: false`).
  - **Empty result:** "No log lines in the last <window>." — "No matching log lines …" when a filter is active (`--level warn|error`, `--security`, or `--run` together with `--since`; `--level debug|info` aren't filters); `--run` alone: "No log lines for run <id>.".
  - **Columns:** the command column fits the longest command shown (at least 12, at most 32 characters; a longer name isn't cut, it pushes the text right), measured after sanitizing.
  - **Untrusted files:** a log file can be edited by anyone with access to it. Only regular `app-`/`security-` day files are opened (no symlinks, no FIFOs, nothing larger than the security cap + 1 MB; the folder itself is never followed through a symlink), lines are split by bytes with a cap (a huge line can't exhaust memory), and every line must pass its event's strict schema (`validateRecord` in `src/core/log/event-schemas.ts` — the same allowlists the builders use): the right fields and types, the level the writer derives, the file's kind and UTC day. Anything else is skipped and counted ("N unreadable lines skipped"; another schema version or an unknown event: "N unknown events skipped (newer Mail Manager?)"). Every printed string is also stripped of control, bidi and invisible characters.
  - **Interrupted runs:** a run with a start and no finish shows as `interrupted or still running` at its last line's time (another `mm` may still be running; `kill -9` leaves no finish). Not shown with `--security`, at `--level error`, outside the window, or when that day's file hit its size cap (`log.truncated`). Ctrl+C is a normal finish (`interrupted after …`). The reading run itself is never shown.
  - **Output cap:** the newest 5,000 lines, interrupted markers included ("N older lines not shown — narrow with --since, --level, --security or --run", minus the flags already given); files are read one UTC day at a time. At most 100,000 runs are tracked (only from start/finish lines); beyond that interrupted runs aren't marked and a footer says so. A log folder that is a symlink, a file or unreadable gets a plain message and exit 1 — not "No log lines".
  - `mm logs path` prints the folder. `mm logs clear` deletes the regular day files after a confirmation (default no; without a terminal it refuses unless `--yes`); it never follows symlinks, refuses a symlinked folder and any `logs` option (`--since`, `--json`, …), and reports the count. The folder's identity is checked again before each delete: swapped for a symlink or another folder while the prompt was open → it stops. The run's own finish line then starts today's app file again.

- **Closed pipe / exit:** `mm <anything> | head` is not an error: `runCli` listens for 'error' on stdout/stderr — EPIPE (and `ERR_STREAM_DESTROYED`) is ignored (exit code as the command set it, no "Unexpected error", no `error.unexpected`); any other stream error exits 1 quietly. An error arriving after `command.finish` was written can make the real exit 1 while the log keeps the earlier code (the log can't be rewritten). **`log.truncated`** takes the `ts` of the record that hit the cap, so the marker lands in (and matches) that record's UTC day file.
- **Support:** the user runs `mm logs --json --since 1d` and sends the output. It is safe to share **by construction** ([Never logged](#never-logged)) — no redaction step needed. `--json` keeps the ids (`run`, `user`, `acct`, `target` HMACs, `ip` bucket — `local` in the CLI) so support can connect lines; they are pseudonymous but linkable across tickets (review at M6a, see open questions).
- **`mm doctor`** gets a `logs` check: folder exists and is writable, today's `app-` and `security-` files are writable regular files, modes 700/600, total size, oldest file. At `MM_LOG_LEVEL=warn|error` a missing folder is OK ("no logs yet") only if it could be created — nothing may sit at the log path (not even a dangling symlink) and the nearest existing ancestor must be a writable directory; otherwise it warns, like at `info`.
- **Operator (local phase):** there is no central view of CLI logs — they stay on each user's computer (sending them would be telemetry and needs consent). Centrally the operator has the Supabase Auth logs and the `audit_log` table.

## Monitoring and alerting (hosted, M6a/M7)

Logs are records; **monitoring** is something that watches them and tells a person. Set up with hosting, tools chosen at M7 (the logger stays vendor-neutral — plain JSON lines work with all of them):

| Need                   | Candidates (free tiers as of 2026-09; recheck at M7)                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Log search + retention | Axiom (~500 GB/month, 30 days; Vercel integration) · Grafana Cloud Loki (50 GB, 14 days) · Better Stack (small free tier) |
| Error tracking         | Sentry (5k errors/month, 30 days; **EU data region**; scrub PII, no request bodies) · GlitchTip (self-hosted)             |
| Uptime                 | UptimeRobot · Better Stack Uptime                                                                                         |
| Scheduled jobs (M6b)   | Healthchecks.io heartbeat — alerts when a backup job **didn't** run (self-hostable, open source)                          |

**Alert on:** any `login-guard.block` with `kind: permanent`; a spike of `ip-blocked` or `auth.login-failed`; error rate (`error.unexpected`, 5xx); a worker job failing or missing its heartbeat; Supabase unreachable; `audit.write-failed`.

## Keeping it complete

Logging for new features must not depend on memory:

1. **Automatic command logging:** a commander `preAction` hook plus `src/cli/bin.ts` write `command.start` / `command.finish` for **every** command, including future ones. A unit test walks all registered commands and asserts both lines.
2. **Catalog test:** every event name in the TypeScript event union appears in this file's catalog tables, and every catalog name marked as emitted exists in code.
3. **Canary test:** every event builder is fed canary passwords, addresses, hosts and subjects; none may appear in any line (same technique as the IMAP error tests).
4. **Milestone docs:** each milestone doc has a **Logging** section; a new feature adds its events there and to this catalog in the same change.
5. **Rules:** CLAUDE.md "Logging rules" and the SECURITY.md per-milestone checklist.

## How other tools do it

| Tool                      | What it logs                                                                                                                        | Lesson for us                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Dovecot `mail_log` plugin | mailbox events (delete, expunge, copy, save, mailbox rename/delete, flag change) with uid, box, msgid, size — from/subject optional | A per-operation mail audit is standard; we keep counts + plan id, not subjects               |
| Dovecot auth + fail2ban   | `imap-login: Login: user=<…>, rip=…, session=<…>` and counted auth failures                                                         | A session id ties lines together; a stable line format lets fail2ban ban (our `mm-security`) |
| Roundcube webmail         | separate `userlogins.log` (successes/failures) and `errors.log`; `imap_debug` dumps full IMAP traffic, off by default               | Separate files by purpose; protocol dumps leak mail content — we never write them            |
| imapsync                  | one log file per run with a summary (transferred, skipped, errors, bytes, time); passwords masked; file name contains both logins   | Run summaries are great — but no user names in file names                                    |
| Thunderbird               | Activity Manager in the UI ("Deleted 23 messages…"); protocol logs only via `MOZ_LOG`                                               | Users want a readable activity list → `mm logs`                                              |
| Gmail / Microsoft 365     | "Last account activity" (time, IP, access type); M365 mailbox audit (HardDelete, SoftDelete, MoveToDeletedItems)                    | Show users their own sign-ins and deletes                                                    |
| Nextcloud / GitLab        | separate audit log vs structured JSON application log with a request id                                                             | The audit / security / app split                                                             |
| Supabase / Vercel         | platform logs with short retention; drains for longer                                                                               | Know what the platform already logs; ship out only what must be kept                         |

## Open questions

- ~~Keep Supabase Auth sign-ins in `auth.audit_log_entries`?~~ Decided 2026-09-29: on, deleted after 90 days (cleanup job later).
- ~~Cap for `security-*.log`?~~ Decided 2026-09-28: its own 150 MB cap (was 5 MB, shared with the app log); alerting on `log.truncated` in a security file comes with hosting (M6a/M7).
- **M6a requirement (security audit 2026-09-29):** once a server logs real client IPs, (1) `login-guard.block` lines must never be dropped by a cap (exempt them, or write them to their own small fixed file for fail2ban), and (2) repeated `imap.login-failed` `blocked` lines per (ip, target) and time window must be collapsed into a count — today every refused attempt writes a line (~300 B), so one client hammering its locked pair could fill a capped file and hide later IP blocks. In the CLI this can't matter (bucket `local`, `addr: null`, never matched by fail2ban).
- **M6a (security audit of M1b-4c, 2026-09-30):** before real client IPs can reach local files, decide whether `mm logs --json` drops `ip`/`addr`/`target`; tighten the reader's stack-frame rule to the writer's frame grammar (today any printable ASCII up to 200 chars passes, so a hand-edited line can carry an address in `--json`; the writer only produces relative paths, `node:` module paths and `<external>`); consider an HMAC chain if local logs ever serve as evidence; the writer's `prune()`/`chmod` path TOCTOUs (same-user only).
- ~~For M1b-4c (`mm logs`): `parseLogLine` validates only the envelope~~ Done in M1b-4c: per-event strict schemas (`validateRecord`) and sanitized output.
- ~~Should users be able to turn local logging off (`MM_LOG_LEVEL=off`)?~~ Decided 2026-09-28: no `off` for now; security lines are always written. Revisit if a user asks.
- M4: if the audit row can't be written after a delete, is a warning enough, or must the user see it before the command ends? Proposal: warn at the end + `audit.write-failed`; the action itself is never rolled back.
- Hosted tool choice (log service, error tracking, uptime) — at M7, with GDPR (EU region, data-processing agreements).

## References

- OWASP: [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), [Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html), [Top 10:2025 A09 Security Logging and Alerting Failures](https://owasp.org/Top10/2025/A09_2025-Security_Logging_and_Alerting_Failures/)
- Vercel: [Runtime Logs](https://vercel.com/docs/logs/runtime), [Drains](https://vercel.com/docs/drains), [pricing](https://vercel.com/pricing)
- Supabase: [Auth audit logs](https://supabase.com/docs/guides/auth/audit-logs), [Logging](https://supabase.com/docs/guides/telemetry/logs), [pricing](https://supabase.com/pricing)
- Dovecot [mail_log plugin](https://doc.dovecot.org/main/core/plugins/mail_log.html) · imapsync [log file FAQ](https://imapsync.lamiral.info/FAQ.d/FAQ.Logfile.txt) · Roundcube [failed-login logging issue](https://github.com/roundcube/roundcubemail/issues/2400)
- Free tiers (recheck at M7): [Grafana Cloud](https://grafana.com/products/cloud/free-tier/), [Axiom](https://axiom.co/pricing), [Sentry](https://costbench.com/software/developer-tools/sentry/free-plan/), [Better Stack](https://www.modern-datatools.com/tools/better-stack/pricing)
