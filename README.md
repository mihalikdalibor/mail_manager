# Mail Manager

> **Status: pre-alpha.** Project scaffold and setup checks (`mm doctor`) exist; mailbox features are not implemented yet. See [TODO.md](TODO.md) for progress.

Mail Manager is a tool for **managing IMAP mailboxes**: understand what is taking up space, filter mail in detail, delete safely, and back up / prepare mail for migration.

It is **not** a mail client — there is no sending (SMTP). That may come later.

## Planned MVP features

- **Easy account connection** — built-in settings for common providers (Gmail, Outlook, Yahoo, iCloud, GMX, Seznam, …) plus automatic discovery; multiple mailboxes per user.
- **Mailbox insight** — messages and size per folder, quota usage, top senders by count and by size, size by year, largest messages.
- **Detailed filters** — sender/recipient (address or domain), subject, body text, date range, "older than", size, read/flagged state, attachments, folders; combinable with AND/OR/NOT; saved filters.
- **Safe delete** — every delete is previewed first (count, size, samples), requires confirmation, moves to Trash by default, and is logged.
- **Backup / migration prep** — export selected mail to `.eml` files with a verified manifest; incremental re-runs.

Later (beta): local web UI, scheduled backups/cleanups, IMAP→IMAP migration between two accounts, OAuth2 login for Gmail/Microsoft.

## Stack

| Concern            | Choice                                                     |
| ------------------ | ---------------------------------------------------------- |
| Language / runtime | TypeScript (strict), Node.js 22                            |
| IMAP               | [imapflow](https://github.com/postalsys/imapflow)          |
| Validation         | zod                                                        |
| Users & database   | Supabase (cloud) — Auth + Postgres with Row Level Security |
| CLI                | commander + @inquirer/prompts                              |
| Tests              | Vitest                                                     |
| Web (beta)         | Fastify + plain HTML                                       |

## Prerequisites

- Node.js 22.13+ (the CLI itself runs on 22.12+; ESLint 10 needs 22.13+)
- A Supabase cloud project (free tier is fine; EU region recommended)
- A **throwaway test mailbox** with IMAP enabled (for integration tests — never test on a real mailbox)

## Getting started

```bash
npm install
cp .env.example .env.local      # fill in SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY
npm run dev -- keygen           # copy the output into .env.local as MM_MASTER_KEY
npm run dev -- doctor           # checks Node, config and Supabase connectivity

# optional: install the `mm` command globally from this checkout
npm run build && npm link
mm --help
```

Available commands so far: `mm keygen`, `mm doctor`. Mailbox features arrive from M1 on — see the roadmap.

### Development

| Command                                   | What it does                              |
| ----------------------------------------- | ----------------------------------------- |
| `npm run dev -- <args>`                   | Run the CLI from source (tsx)             |
| `npm run build`                           | Compile to `dist/`                        |
| `npm test`                                | Unit tests                                |
| `npm run test:integration`                | Integration tests (need `MM_TEST_IMAP_*`) |
| `npm run lint` / `npm run typecheck`      | ESLint / TypeScript checks                |
| `npm run format` / `npm run format:check` | Prettier                                  |

## Roadmap

| Milestone | Scope                                      | Doc                                        |
| --------- | ------------------------------------------ | ------------------------------------------ |
| M0        | Scaffold & tooling                         | [M0](docs/milestones/M0-scaffold.md)       |
| M1        | Auth, credential encryption, accounts      | [M1](docs/milestones/M1-auth-accounts.md)  |
| M2        | Mailbox insight (stats)                    | [M2](docs/milestones/M2-insight.md)        |
| M3        | Filters & search                           | [M3](docs/milestones/M3-filters-search.md) |
| M4        | Safe delete                                | [M4](docs/milestones/M4-safe-delete.md)    |
| M5        | Backup / export                            | [M5](docs/milestones/M5-backup.md)         |
| M6        | Beta: web UI, scheduler, migration, OAuth2 | [M6](docs/milestones/M6-beta.md)           |

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Data model](docs/DATA_MODEL.md)
- [Security](docs/SECURITY.md)
- [Providers](docs/PROVIDERS.md)
- [Testing](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)

## Security in one paragraph

Mailbox passwords are stored **encrypted** (AES-256-GCM, key kept outside the database). Email content is **never** stored in the cloud database. Connections use TLS only. Destructive actions always go plan → confirm → execute exactly the planned messages → audit log. Details in [docs/SECURITY.md](docs/SECURITY.md).
