<h1 align="center">Mail Manager</h1>

<p align="center">
  Manage IMAP mailboxes: see what takes up space, filter mail in detail, delete safely, back up for migration.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue?style=flat-square" alt="Version 0.1.0">
  <img src="https://img.shields.io/badge/status-pre--alpha-orange?style=flat-square" alt="Status: pre-alpha">
  <img src="https://img.shields.io/badge/node-%3E%3D22.13-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >= 22.13">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/Supabase-Auth%20%2B%20Postgres-3FCF8E?style=flat-square&logo=supabase&logoColor=white" alt="Supabase">
</p>

> **Status: pre-alpha (v0.1.0).** Project scaffold, setup checks (`mm doctor`), the Supabase database with row-level security, app login (`mm login` / `whoami` / `logout`) and IMAP settings discovery (`mm discover`) exist; connecting to mailboxes (IMAP login) is not implemented yet. See [TODO.md](TODO.md) for progress.

## What is this

Mail Manager is a tool for **managing IMAP mailboxes**: understand what is taking up space, filter mail in detail, delete safely, and back up / prepare mail for migration. It is **not** a mail client — there is no sending (SMTP). That may come later. It starts as a CLI (`mm`); a simple local HTML page follows in the beta.

Two decisions define it. **Email content never reaches the cloud**: Supabase holds only users, accounts (with passwords encrypted by a key that lives outside the database), saved filters, jobs and aggregate audit data — never message bodies, subjects or addresses. And **nothing is deleted without a plan**: every destructive action goes plan (dry run) → confirm → execute exactly the planned messages → audit log, with Trash as the default.

## Features

Available today:

- **`mm doctor`** — checks Node version, env config, master key, Supabase reachability, database schema and login session; never prints secrets.
- **`mm keygen`** — generates a new `MM_MASTER_KEY` for credential encryption.
- **`mm login` / `mm logout` / `mm whoami`** — sign in to the app (invite-only Supabase users, hidden password prompt).
- **`mm discover <email>`** — finds the IMAP settings for an address without logging in: built-in presets for 24 SK/CZ and global providers (by email domain or the domain's MX records), Mozilla ISPDB, the domain's autoconfig, DNS SRV; if nothing is found, pick your provider from the list or enter the IMAP host manually. Plain-language hints for typos, DNS problems and no internet.

What it looks like in the terminal (email, user ID and project ref replaced with placeholders):

```console
$ mm login
✔ Email: user@example-test-domain.eu
✔ Password:
Logged in as user@example-test-domain.eu

$ mm whoami
user@example-test-domain.eu (00000000-0000-0000-0000-000000000000)

$ mm doctor
OK    node          v22.22.1
OK    supabase-env  SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY set
OK    master-key    valid (version 1)
OK    supabase-api  <project-ref>.supabase.co reachable, key accepted (auth v2.197.0)
OK    database      mail_accounts present, anon blocked
OK    signup        invite-only (signups disabled)
OK    session       logged in as user@example-test-domain.eu
```

Planned MVP features (mailbox features arrive from M1b on — see the roadmap):

- **Easy account connection** — built-in settings for common providers (Gmail, Outlook, Yahoo, iCloud, GMX, Seznam, …) plus automatic discovery; multiple mailboxes per user.
- **Mailbox insight** — messages and size per folder, quota usage, top senders by count and by size, size by year, largest messages.
- **Detailed filters** — sender/recipient (address or domain), subject, body text, date range, "older than", size, read/flagged state, attachments, folders; combinable with AND/OR/NOT; saved filters.
- **Safe delete** — every delete is previewed first (count, size, samples), requires confirmation, moves to Trash by default, and is logged.
- **Backup / migration prep** — export selected mail to `.eml` files with a verified manifest; incremental re-runs.

Later (beta): local web UI, scheduled backups/cleanups, IMAP→IMAP migration between two accounts, OAuth2 login for Gmail/Microsoft.

## Getting started

### Prerequisites

- Node.js 22.13+ (required by @inquirer/prompts and ESLint 10)
- A Supabase cloud project (free tier is fine; EU region recommended)
- A **throwaway test mailbox** with IMAP enabled (for integration tests — never test on a real mailbox)

### Install and run

```bash
npm install
cp .env.example .env.local      # fill in SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY
npm run dev -- keygen           # copy the output into .env.local as MM_MASTER_KEY
npm run dev -- doctor           # checks Node, config and Supabase connectivity

# one-time database setup (interactive; asks for the DB password)
npx supabase login
npx supabase link --project-ref <your-project-ref>
npm run db:push                 # creates the tables (RLS included)

# users are invite-only: create one in the Supabase dashboard (Auth → Users → Add user)
npm run dev -- login
npm run dev -- whoami

# optional: install the `mm` command globally from this checkout
npm run build && npm link
mm --help
```

Available commands so far: `mm login`, `mm logout`, `mm whoami`, `mm keygen`, `mm doctor`, `mm discover`. Mailbox connection arrives with M1b-2 — see the roadmap.

### Environment

Config is read from `.env.local`, then `.env` (real environment variables win). [`.env.example`](.env.example) documents every variable:

| Variable                        | Required | Purpose                                                                                             |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                  | yes      | Supabase project URL                                                                                |
| `SUPABASE_PUBLISHABLE_KEY`      | yes      | Publishable key (formerly "anon"); safe because every table has RLS                                 |
| `MM_MASTER_KEY`                 | yes      | 32 random bytes, base64 — from `mm keygen`; encrypts mailbox passwords                              |
| `MM_MASTER_KEY_VERSION`         | no       | Key version, bump when rotating (default `1`)                                                       |
| `MM_CONFIG_DIR`                 | no       | Where the login session is stored (default `~/.config/mail-manager`)                                |
| `MM_TEST_SUPABASE_A_*` / `_B_*` | tests    | Two test users for the RLS integration suite                                                        |
| `MM_TEST_IMAP_*`                | tests    | Throwaway IMAP mailbox for integration tests (`MM_TEST_IMAP_USER` alone enables the discovery test) |

### Development

| Command                                   | What it does                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `npm run dev -- <args>`                   | Run the CLI from source (tsx)                                            |
| `npm run build`                           | Compile to `dist/`                                                       |
| `npm test`                                | Unit tests                                                               |
| `npm run test:integration`                | Integration tests (skip without `MM_TEST_SUPABASE_*` / `MM_TEST_IMAP_*`) |
| `npm run db:push` / `npm run db:status`   | Apply / list Supabase migrations                                         |
| `npm run lint` / `npm run typecheck`      | ESLint / TypeScript checks                                               |
| `npm run format` / `npm run format:check` | Prettier                                                                 |

## Tech stack

| Concern            | Choice                                                       |
| ------------------ | ------------------------------------------------------------ |
| Language / runtime | TypeScript (strict), Node.js 22                              |
| IMAP               | [imapflow](https://github.com/postalsys/imapflow) (from M1b) |
| Validation         | zod                                                          |
| Users & database   | Supabase (cloud) — Auth + Postgres with Row Level Security   |
| CLI                | commander + @inquirer/prompts                                |
| Tests              | Vitest                                                       |
| Web (beta)         | Fastify + plain HTML                                         |

## Project structure

```
src/
  cli/          thin shell: bin.ts → buildProgram(), commands/ (auth, doctor, keygen)
  core/         all logic: config, crypto, master key, credentials, auth, doctor
    db/         repository interfaces (repos.ts); Supabase code only in db/supabase/
    imap/ providers/ filters/   placeholders for M1b+
  server/       placeholder for the M6 web UI
supabase/migrations/   SQL migrations (applied with npm run db:push)
tests/unit/            Vitest unit tests
tests/integration/     real-Supabase suites (skip without MM_TEST_* env)
docs/                  architecture, security, data model, milestones
```

The CLI (and later the server) only parses input, calls `src/core`, and formats output — no IMAP or database logic in the shells. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

<details>
<summary><strong>Security in one paragraph</strong></summary>

Mailbox passwords are stored **encrypted** (AES-256-GCM, key kept outside the database). Email content is **never** stored in the cloud database. Connections use TLS only. Destructive actions always go plan → confirm → execute exactly the planned messages → audit log. Details in [docs/SECURITY.md](docs/SECURITY.md).

</details>

<details>
<summary><strong>Roadmap</strong></summary>

| Milestone | Scope                                      | Doc                                        |
| --------- | ------------------------------------------ | ------------------------------------------ |
| M0        | Scaffold & tooling                         | [M0](docs/milestones/M0-scaffold.md)       |
| M1a       | Supabase: migration, encryption, login     | [M1](docs/milestones/M1-auth-accounts.md)  |
| M1b       | IMAP, SK/CZ providers, test mailbox        | [M1](docs/milestones/M1-auth-accounts.md)  |
| M1c       | Account commands                           | [M1](docs/milestones/M1-auth-accounts.md)  |
| M2        | Mailbox insight (stats)                    | [M2](docs/milestones/M2-insight.md)        |
| M3        | Filters & search                           | [M3](docs/milestones/M3-filters-search.md) |
| M4        | Safe delete                                | [M4](docs/milestones/M4-safe-delete.md)    |
| M5        | Backup / export                            | [M5](docs/milestones/M5-backup.md)         |
| M6        | Beta: web UI, scheduler, migration, OAuth2 | [M6](docs/milestones/M6-beta.md)           |

</details>

<details>
<summary><strong>Documentation</strong></summary>

- [Architecture](docs/ARCHITECTURE.md)
- [Data model](docs/DATA_MODEL.md)
- [Security](docs/SECURITY.md)
- [Providers](docs/PROVIDERS.md)
- [IMAP](docs/IMAP.md)
- [Testing](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)

</details>

---

<p align="center">
  <a href="TODO.md">Progress / backlog</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/SECURITY.md">Security</a> ·
  <a href="docs/DEPLOYMENT.md">Deployment</a>
</p>
