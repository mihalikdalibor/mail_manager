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

| Module                                            | Purpose                                                                                    | Milestone |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------- |
| `config.ts`                                       | zod-validated env loading                                                                  | M0        |
| `crypto.ts`                                       | AES-256-GCM encrypt/decrypt secrets, key versioning                                        | M1        |
| `providers/presets.json`, `providers/discover.ts` | IMAP settings lookup                                                                       | M1        |
| `imap/session.ts`                                 | Open/close connections, TLS policy, capability detection, folder listing, batching helpers | M1–M2     |
| `credentials.ts`                                  | `CredentialProvider` interface + local implementation                                      | M1        |
| `stats.ts`                                        | Counts/sizes per folder, sender, year; quota                                               | M2        |
| `filters/schema.ts`, `filters/compile.ts`         | Filter model → imapflow SearchObject + client-side post-filters                            | M3        |
| `planner.ts`                                      | Immutable action plan (folder, UIDVALIDITY, UID set, totals)                               | M4        |
| `delete.ts`                                       | Execute plan: move to Trash / UID EXPUNGE, batched, resumable                              | M4        |
| `backup.ts`                                       | Stream messages to `.eml`, manifest, verify, incremental                                   | M5        |

## Key decisions

### 1. Email content never goes to the cloud DB

Supabase holds only: account records (with encrypted secret), saved filters, jobs, audit rows (counts, bytes, filter JSON). Message bodies, subjects and message sender/recipient addresses stay on the IMAP server and in the user's local backups.

- **Why:** smaller breach impact, simpler GDPR story, less storage cost.
- **Cost:** every query is a live IMAP query (slower on huge mailboxes). A local metadata index is a post-MVP optimisation (see TODO "Later").

### 2. Live IMAP queries, server-side search

Filters compile to IMAP `UID SEARCH` where possible (server does the work). Criteria IMAP cannot express (e.g. "has attachments") run client-side on fetched `BODYSTRUCTURE`, only over the already-narrowed UID set. Fetches are batched (~500 UIDs) to bound memory.

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
