# Architecture

## Overview

```
            ┌──────────────┐        ┌──────────────────┐
  user ───▶ │  CLI (mm)    │        │ HTML page (M6)   │
            └──────┬───────┘        └────────┬─────────┘
                   │  thin shell              │  Fastify (localhost)
                   ▼                          ▼
            ┌───────────────────────────────────────────┐
            │                src/core                   │
            │  providers · imap session · filters       │
            │  stats · planner · delete · backup        │
            │  crypto · CredentialProvider · repos      │
            └──────┬───────────────────────┬────────────┘
                   │ TLS 993                │ HTTPS (JWT, RLS)
                   ▼                        ▼
            IMAP servers             Supabase cloud
            (mail content)           (users, accounts, filters,
                                      jobs, audit — no mail content)
                   │
                   ▼
            local disk: backups/ (.eml + manifest)
```

## Layers

| Layer                   | Responsibility                                                  | Must not                     |
| ----------------------- | --------------------------------------------------------------- | ---------------------------- |
| `src/cli`               | Parse args, prompts, confirmations, tables/progress output      | Talk to IMAP or DB directly  |
| `src/server` (M6)       | HTTP routes, auth middleware, static HTML                       | Contain business logic       |
| `src/core`              | All logic: connect, search, stats, plan, delete, backup, crypto | Know about terminals or HTTP |
| `src/core/db/repos.ts`  | Repository **interfaces**                                       | Import Supabase              |
| `src/core/db/supabase/` | Supabase implementations                                        | Leak Supabase types upward   |

Core functions take plain typed inputs and return plain results plus progress callbacks, so the CLI, the server and tests all use them the same way.

## Core modules (planned)

| Module                                            | Purpose                                                                                                                                                                                                                                                            | Milestone |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `config.ts`                                       | zod-validated env loading                                                                                                                                                                                                                                          | M0        |
| `crypto.ts`                                       | AES-256-GCM encrypt/decrypt secrets, key versioning                                                                                                                                                                                                                | M1        |
| `providers/presets.json`, `providers/discover.ts` | IMAP settings lookup                                                                                                                                                                                                                                               | M1        |
| `imap/session.ts`                                 | Open/close connections, TLS policy, capability detection, folder listing, batching helpers                                                                                                                                                                         | M1–M2     |
| `credentials.ts`                                  | `CredentialProvider` interface + local implementation                                                                                                                                                                                                              | M1        |
| `security/`                                       | Login guard, IP buckets, security event records                                                                                                                                                                                                                    | M1b-2b    |
| `log/`, `paths.ts`                                | Typed log events, `EventLog` + file sink, config/log folder ([LOGGING.md](LOGGING.md))                                                                                                                                                                             | M1b-4     |
| `mailbox/`                                        | Folder tree, counts, sizes, quota (`folders.ts`); typed `MailboxError`; shared guards (`guards.ts`); read-only message paging (`messages.ts`) and the basket of marked mails (`basket.ts`)                                                                         | M2a, M2b  |
| `mailbox/scan.ts`, `mailbox/stats.ts`             | Read-only streaming scan of a folder in sequence ranges (`scan.ts`, shared with the M2a size fallback); `mm stats` scope and aggregation: per folder, year, sender, domain, largest mails                                                                          | M2c-1     |
| `filters/schema.ts`, `filters/compile.ts`         | Filter model → imapflow SearchObject + client-side post-filters; with `--sent` (M3b) the date checks read the `Date:` header                                                                                                                                       | M3        |
| `filters/line.ts`                                 | Typed filter line (the app's `/` line) → filter model; a typed error for each term it can't read; `printFilterLine` (M3c) prints a filter as the line that parses back to it, or null                                                                              | M3a       |
| `mailbox/search.ts`                               | Read-only search of one folder: UID SEARCH, one streaming pass over the candidates (the checks decide), matches with their size and received date, and a page of matches by UID                                                                                    | M3a       |
| `mailbox/search-mailbox.ts`                       | Read-only `mm search` over the stats scope: one search per folder (a refused folder is kept as a failed row), per-folder matches with snapshot and UIDVALIDITY, top senders, the sample list read by UID                                                           | M3b       |
| `saved-filters.ts`                                | Saved filters (M3c): the name rule, the 200 limit, save (duplicate refused unless `replace`) / list / get / delete over `FiltersRepo`; a `filter.*` event per attempt and an audit row on success; no printing. The Supabase side is `db/supabase/filters-repo.ts` | M3c       |
| `planner.ts`                                      | Immutable action plan (folder, UIDVALIDITY, UID set, totals)                                                                                                                                                                                                       | M4        |
| `delete.ts`                                       | Execute plan: move to Trash / UID EXPUNGE, batched, resumable                                                                                                                                                                                                      | M4        |
| `backup.ts`                                       | Stream messages to `.eml`, manifest, verify, incremental                                                                                                                                                                                                           | M5        |

CLI side of the folder browser (M2b): `src/cli/browser/` — a pure state reducer (`state.ts`, keys → new state + effects for the shell to run), a pure renderer (`render.ts`, state → plain-text lines) and display-width helpers (`width.ts`); `terminal.ts` (raw mode, alternate screen, frames, keys, and a restore that runs on every exit path) and `controller.ts` (runs the reducer's effects: page loads on the current session, reconnect, quit) (M2b-2). `mm folders` prints the tree and then opens the browser when stdin and stdout are a terminal.

CLI side of the app (M2d): `src/cli/app/` — what plain `mm` opens in a terminal (`mm app`, `src/cli/commands/app.ts`). Pure reducers for the sign-in page, Home and the mailbox screen (`sign-in.ts`, `home.ts`, `mailbox.ts`, joined in `reduce.ts`; types and helpers in `state.ts`), a pure renderer (`render.ts`, with the mailbox screen's totals, quota and usage bars in `mailbox-render.ts`) and `controller.ts`, which runs the reducers' effects — session check, sign-in, sign-out, the mailbox list — through the core interfaces (`AuthService`, `AccountsRepo`). It reuses the browser's terminal (`terminal.ts`) and the layout helpers in `src/cli/browser/layout.ts`. The e-mail addresses of earlier sign-ins come from the core `src/core/remembered-users.ts` (`users.json` in the config folder).

The mailbox screen (M2d-2) opens a saved mailbox with one guarded login (`openAccountSession`; the login guard is made once per app run in `commands/app.ts`), reads its folders with `listFolders` and, inside a folder, reads pages with `loadPage` — the same core calls as `mm folders`. Inside a folder the M2b browser's reducer and renderer run as part of the app (`openEmbedded` in `src/cli/browser/state.ts`): the browser's own controller is not used, the app's controller runs its page loads and its reconnect. That controller owns the IMAP session and logs it out on every way out of the mailbox.

The stats screen (M2d-3) reads on a second guarded login of the same mailbox with the core `collectStats` (as `mm stats`); the controller owns that session too, stops a read by logging it out, and runs the logins of one mailbox one after another, each checking right before it starts that its visit is still open (`mailbox-stats.ts`, `stats-render.ts`). The logs screen (M2d-5) shows core `readLogs` through `formatReport` of `src/cli/log-text.ts` (`logs.ts`, `logs-render.ts`). Adding a mailbox (M2d-4) is the `mm account add` flow as steps (`add.ts`, `add-render.ts`): the reducer validates with the core's pure validators (`parseEmail`, `validateManualHost`, `validateManualUsername`, `settingsFromPreset`, `manualSettings`), and the controller reaches `discover`, `assertNotDuplicate` and `addAccount` through functions wired in `commands/app.ts` — no IMAP or DB logic in `src/cli/app/`.

## Key decisions

### 1. Email content never goes to the cloud DB

Supabase holds only: account records (with encrypted secret), saved filters, jobs, audit rows (counts, bytes, filter JSON). Message bodies, subjects and message sender/recipient addresses stay on the IMAP server and in the user's local backups.

- **Why:** smaller breach impact, simpler GDPR story, less storage cost.
- **Cost:** every query is a live IMAP query (slower on huge mailboxes). A local metadata index is a post-MVP optimisation (see TODO "Later").

### 2. Live IMAP queries, server-side search

Filters compile to IMAP `UID SEARCH` where possible (server does the work). Criteria IMAP cannot express (e.g. "has attachments") run client-side on fetched `BODYSTRUCTURE`, only over the already-narrowed UID set. Fetches are batched (~500 UIDs) to bound memory. Dates and exact addresses are checked on the fetched data too (M3a): the server term only narrows, so these criteria are decided on our side. The M3a search pass sends sets of up to 5,000 UIDs (4,000 characters) instead, see [M3](milestones/M3-filters-search.md). `mm search` (M3b) runs the same pass over every folder of the stats scope, one at a time, and reads its sample list by UID.

### 3. Master-key location (important future constraint)

- **Local phase (M0–M5):** the CLI reads `MM_MASTER_KEY` from `.env.local` (or `.env`) and decrypts credentials itself. Acceptable because the user runs everything on their own machine.
- **Hosted phase (M6+):** the key must live **only on the server**. The CLI can no longer decrypt; it must call the API, which performs IMAP operations server-side.
- **Mitigation now:** all decryption goes through one `CredentialProvider` interface; nothing else touches ciphertext. Switching to a remote provider / API client is then a contained change.

### 4. Repository layer for DB portability

Supabase is the starting point, not the end state. Repos expose domain operations (`accounts.list(userId)`, `audit.append(entry)`), never raw query builders. RLS is still the security boundary while on Supabase; after migration the server enforces ownership.

### 5. Plans as data

Destructive actions are two-step: `planner` produces a serialisable plan; `delete`/`backup` consume it. This enables dry runs, confirmation UI, resume after interruption, and testing without a server.

## Alternatives considered (briefly)

- **Python/FastAPI, .NET/MailKit, Go** — rejected in favour of one language across CLI → web UI → future SMTP, and imapflow's quality. MailKit remains the reference if we ever need a second implementation.
- **Caching all headers in Supabase** — rejected (privacy, see decision 1).
- **Direct IMAP from the browser** — impossible (browsers can't open raw TCP/TLS) and would expose credentials.

## Open questions

- Concurrency: how many parallel IMAP connections per account? (Providers limit this — Gmail ~15. Default to 1–2.)
- When to introduce the local metadata index (SQLite) — decide after measuring M2/M3 on a large mailbox (≥100k messages).
