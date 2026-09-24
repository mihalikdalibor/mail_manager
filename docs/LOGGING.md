# Logging

What Mail Manager records, where, for how long, and how it's read. **Status:** design (2026-09-23). Implementation starts in **M1b-4 — Logging foundation** ([milestone](milestones/M1-auth-accounts.md#m1b-4--logging-foundation)); every later milestone adds its own events (see [Event catalog](#event-catalog)).

**Goal:** answer the questions we will actually ask — _who logged in, what did this command change, why did it fail, is someone attacking?_ — without creating a new place where passwords, mail content or personal data can leak. "Log everything" is not the goal: more lines mean more noise, more leak surface, more cost (hosted logs are billed per GB) and more GDPR exposure.

## Decisions (2026-09-23)

- Four kinds of records, split by **purpose and reader** (not by subject): audit trail, security events, app log, and — only once hosted — metrics/errors/uptime.
- Order: **M1b-3 test ground → M1b-4 logging foundation → M1c account commands**, so every command that manages mailboxes logs from day one.
- The cloud **`audit_log` table is created in M1b-4** (not M4): adding/removing accounts is audited from M1c on; M4 only adds delete rows.
- Local files live in `<config dir>/logs/` (same folder resolution as the session file).
- Events are **typed and allowlisted** — no free-form "log this object".

## Principles

1. **Allowlisted, typed events.** Each event is a TypeScript type with only the fields it may carry, so a password or a subject has no field to land in. This extends the existing `SecurityEvent` (`src/core/security/events.ts`). Core emits events through an `EventLog` interface; the shell decides where they go (file, stdout, table) — core never prints.
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

**Already logged elsewhere — don't rebuild:** Supabase Auth records every app sign-in, sign-out, token refresh and failure (user id, IP, user agent). Its Logs Explorer keeps them **1 day on the free plan, 7 days on Pro**; optionally they are also written to `auth.audit_log_entries` in our database (Authentication → Configuration → Audit Logs). That is the central "who logged in to Mail Manager" record for the operator. Whether to keep the database copy, and for how long, is an [open question](#open-questions).

## Never logged

In no log, no audit row and no event field — local or cloud:

- passwords, app passwords, OAuth tokens, Supabase session/refresh tokens, `MM_MASTER_KEY`, any key material;
- message bodies, subjects, message sender/recipient addresses, attachment names, Message-IDs;
- the mailbox address, its domain and the IMAP host (they identify a person) — use the account UUID, the provider id and the login-guard HMAC target instead;
- what the user typed into a **failed** login (people type the password into the address field) — only an HMAC target;
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

**Reading back:** log lines are untrusted input (anyone with file access can edit them). `mm logs` parses every line with a zod schema; malformed lines are skipped and counted, never printed raw.

Examples (a `mm discover` run; a failed `mm login`):

```text
{"ts":"2026-09-23T10:15:02.123Z","event":"command.start","cmd":"discover","opts":[],"ver":"0.3.0","node":"22.13.0","os":"linux","level":"info","run":"5f3a9c1e2b7d4a60","v":1}
{"ts":"2026-09-23T10:15:03.655Z","event":"discover.finish","outcome":"found","source":"mx","provider":"websupport","level":"info","run":"5f3a9c1e2b7d4a60","v":1}
{"ts":"2026-09-23T10:15:03.660Z","event":"command.finish","cmd":"discover","outcome":"ok","exit":0,"ms":1537,"level":"info","run":"5f3a9c1e2b7d4a60","v":1}
mm-security {"ts":"2026-09-23T10:20:11.004Z","event":"auth.login-failed","reason":"invalid-credentials","target":"<64 hex>","level":"warn","run":"0c9e2d7a41b3f865","v":1}
```

## Event catalog

Kind: **A** = app log, **S** = security log, **Au** = also an audit row (`audit_log.action` in brackets). Fields exclude the envelope (`ts`, `event`, `level`, `run`, `v`). "Emitted from" = the milestone whose code first produces the event.

### Foundation (M1b-4)

| Event                   | Kind | Level                     | Fields                                                                                               | OWASP                  | Emitted from |
| ----------------------- | ---- | ------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------- | ------------ |
| `command.start`         | A    | info                      | `cmd`, `opts` (option names), `ver`, `node`, `os`                                                    | —                      | M1b-4        |
| `command.finish`        | A    | info/warn                 | `cmd`, `outcome` (`ok`/`failed`/`interrupted`), `exit`, `ms`                                         | —                      | M1b-4        |
| `error.unexpected`      | A    | error                     | `errClass`, `code`, `stack` (frames only, relative paths, no message)                                | `sys_crash` (≈)        | M1b-4        |
| `doctor.check`          | A    | info/warn                 | `check`, `status` (`ok`/`warn`/`fail`)                                                               | —                      | M1b-4        |
| `discover.finish`       | A    | info                      | `outcome` (found / needs-host / blocked / manual / no-domain / invalid), `source`, `provider`        | —                      | M1b-4        |
| `audit.write-failed`    | A    | error                     | `action`, `reason` — the action happened but its audit row couldn't be written                       | —                      | M1b-4        |
| `auth.login`            | S    | info                      | `user`                                                                                               | `authn_login_success`  | M1b-4        |
| `auth.login-failed`     | S    | warn                      | `reason` (invalid-credentials / unreachable / rate-limited / …), `target` (HMAC of the typed e-mail) | `authn_login_fail`     | M1b-4        |
| `auth.logout`           | S    | info                      | `user?`, `outcome` (`logged-out` / `not-logged-in`)                                                  | `session_expired`      | M1b-4        |
| `imap.login`            | S    | info                      | `acct?`, `provider`, `ip`, `target`                                                                  | `authn_login_success`  | M1c          |
| `imap.login-failed`     | S    | warn                      | `acct?`, `provider`, `reason`, `counted`, `ip`, `target`                                             | `authn_login_fail`     | M1c          |
| `login-guard.challenge` | S    | warn                      | `ip`, `attempts`, `target`                                                                           | `authn_login_fail_max` | M1c          |
| `login-guard.block`     | S    | warn (`permanent`: error) | `kind`, `reason`, `ip`, `addr`, `attempts`, `until`, `target` (existing `SecurityEvent`)             | `authn_login_lock`     | M1c          |

The `imap.*` and `login-guard.*` events are built and unit-tested in M1b-4 (`guardedOpenSession` with a fake opener); M1c is the first command that logs in, so it wires them to the file.

### Later milestones (planned — each milestone doc has a "Logging" section)

| Milestone | Events                                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1c       | `account.add` · `account.remove` · `account.password-update` (A + Au, same action name) · `account.test` (A) — fields: `acct`, `provider`, `outcome`, `reason`                                                                                                                       |
| M2        | `stats.finish` (`acct`, `folders`, `messages`, `bytes`, `ms`) · `imap.capability-fallback` (warn: `feature`, `fallback` — e.g. no `QUOTA`, no `STATUS=SIZE`)                                                                                                                         |
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
- One file per day and kind: `app-2026-09-23.log`, `security-2026-09-23.log`. Each file is capped at **5 MB**; past the cap `debug` lines are dropped first, then one `log.truncated` marker is written and the rest of the day is skipped.
- **Housekeeping at startup** (the CLI has no daemon): delete `app-*` files older than 30 days and `security-*` files older than 90 days (by the date in the name — no need to read them).
- Writes are **synchronous** (`appendFileSync`): `src/cli/bin.ts` ends every run with `process.exit()`, which would drop buffered async writes. An `exit` handler records `command.finish` even when a command exits directly; SIGINT (Ctrl+C) → `outcome: interrupted`.
- Level threshold: `info` by default; `MM_LOG_LEVEL=debug|info|warn|error` (zod-validated in `config.ts`).
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
| Supabase Auth logs          | platform: 1 day (free) / 7 days (Pro); `auth.audit_log_entries` copy: see open questions              |
| hosted log / error services | set per service at M7; never longer than the table above                                              |

## Reading the logs

- **`mm logs`** — last 24 h in plain words and local time, newest last. The CLI maps each event to text (`src/cli/log-text.ts`, like `errorText` does for errors), e.g. `10:16 ✗ Mailbox login failed — counted 2 of 5`. Runs with a start but no finish show as **interrupted**.
  - Filters: `--since 7d`, `--level warn`, `--security`, `--run <id>`, `--json` (the raw lines, for scripts and support).
  - `mm logs path` prints the folder; `mm logs clear` deletes the local logs after a confirmation (the user's data, the user's machine).
- **Support:** the user runs `mm logs --json --since 1d` and sends the output. It is safe to share **by construction** ([Never logged](#never-logged)) — no redaction step needed.
- **`mm doctor`** gets a `logs` check: folder exists and is writable, modes 700/600, total size, oldest file.
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

- Keep Supabase Auth sign-ins in `auth.audit_log_entries` (database copy), and for how long? Proposal: on, deleted after 90 days (IPs) — the user checks the dashboard setting in M1b-4.
- Should users be able to turn local logging off (`MM_LOG_LEVEL=off`)? Proposal: no for the security log (it protects them), yes for the app log.
- M4: if the audit row can't be written after a delete, is a warning enough, or must the user see it before the command ends? Proposal: warn at the end + `audit.write-failed`; the action itself is never rolled back.
- Hosted tool choice (log service, error tracking, uptime) — at M7, with GDPR (EU region, data-processing agreements).

## References

- OWASP: [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), [Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html), [Top 10:2025 A09 Security Logging and Alerting Failures](https://owasp.org/Top10/2025/A09_2025-Security_Logging_and_Alerting_Failures/)
- Vercel: [Runtime Logs](https://vercel.com/docs/logs/runtime), [Drains](https://vercel.com/docs/drains), [pricing](https://vercel.com/pricing)
- Supabase: [Auth audit logs](https://supabase.com/docs/guides/auth/audit-logs), [Logging](https://supabase.com/docs/guides/telemetry/logs), [pricing](https://supabase.com/pricing)
- Dovecot [mail_log plugin](https://doc.dovecot.org/main/core/plugins/mail_log.html) · imapsync [log file FAQ](https://imapsync.lamiral.info/FAQ.d/FAQ.Logfile.txt) · Roundcube [failed-login logging issue](https://github.com/roundcube/roundcubemail/issues/2400)
- Free tiers (recheck at M7): [Grafana Cloud](https://grafana.com/products/cloud/free-tier/), [Axiom](https://axiom.co/pricing), [Sentry](https://costbench.com/software/developer-tools/sentry/free-plan/), [Better Stack](https://www.modern-datatools.com/tools/better-stack/pricing)
