# M6 — Beta: web UI, scheduler, migration, OAuth2

Large milestone — split into sub-milestones, each shippable alone.

## M6a — Local HTML page

- **Goal:** the CLI's features in a simple browser page, same core.
- Fastify on `127.0.0.1`, helmet + strict CSP, CSRF token, Supabase JWT per request, rate limit.
- Pages: login, accounts (add with discovery), stats, filter builder, plan preview + confirm, backups, audit.
- Plain HTML + small vanilla JS (design work comes later; keep markup semantic for a later redesign).
- **Acceptance:** every M1–M5 flow doable in the browser; destructive flows show the same plan + typed confirmation.

## M6b — Scheduler (`mm worker`)

- Migration `jobs` / `job_runs`; `mm job add|list|pause|remove`.
- Job types: scheduled backup (incremental), scheduled cleanup (trash only by default, `--max` required).
- croner-based loop; one job per account at a time; results in `job_runs`; failure notifications (log only in beta).
- **Acceptance:** a daily backup job runs unattended for 3 days on the test mailbox, incremental, verified.

## M6c — IMAP→IMAP migration (old address → new address)

- `mm migrate <from-account> <to-account> [filter] [--folder-map]`.
- `APPEND` with original flags + internal date; folder mapping (special-use aware); dedupe by Message-ID in target; resumable; audit `migrate`.
- Optional "delete from source after verified copy" → goes through the M4 protocol.
- **Acceptance:** migrate seeded `mm-test` between two test mailboxes; counts, flags, dates match; re-run copies 0.

## M6d — OAuth2 (Gmail, Microsoft)

- XOAUTH2 via imapflow; refresh tokens encrypted like passwords (`auth_type = oauth2`).
- Local phase: loopback redirect (`http://127.0.0.1:<port>/callback`) with PKCE.
- **Risk:** Google restricted scope → verification + CASA assessment for public use (see SECURITY.md). Beta uses "testing" mode with named test users.
- **Acceptance:** add Outlook.com and Gmail accounts via OAuth; token refresh works after expiry.

## Also in beta

- MFA (TOTP) for app login.
- Docker (DEPLOYMENT.md stage 3) and hermetic IMAP tests in CI.

## Open questions

- Order of sub-milestones (proposal: a → c → b → d).
- Hosted beta (DEPLOYMENT.md stage 4) in M6 or a separate M7? (Proposal: separate M7, after GDPR prerequisites.)
