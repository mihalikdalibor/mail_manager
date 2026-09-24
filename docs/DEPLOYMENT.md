# Deployment

Staged — each stage only when the previous one is stable.

## Stage 1 — Local CLI (M0–M5)

- Runs on the developer's machine: `npm run dev -- <command>` or `npm link` → `mm`.
- Supabase **cloud** project (EU region) for auth + DB. No Docker.
- `.env.local` (or `.env`) with `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `MM_MASTER_KEY`. `mm doctor` checks them.
- Backups written to local disk (`./backups` by default, gitignored).
- Logs (from M1b-4): `<config dir>/logs/` — `app-<date>.log` (30 days), `security-<date>.log` (90 days); read with `mm logs`. See [LOGGING.md](LOGGING.md).

## Stage 2 — Local web UI + worker (M6)

- `mm serve`: Fastify on `127.0.0.1:<port>`, static HTML page, same core.
- `mm worker`: long-running process executing scheduled jobs (croner). Run manually or via systemd user service.
- Still single-machine; master key still local.

## Stage 3 — Docker

- Multi-stage `Dockerfile` (build → slim runtime), runs as **non-root**, read-only filesystem where possible, backups on a mounted volume.
- `docker-compose.yml`: `api` + `worker` services; `.env` via env_file (never baked into images).
- Optional: local Supabase (`supabase start`) for offline dev.
- Hermetic test IMAP server (GreenMail/Dovecot) in compose for CI.

## Stage 4 — Hosted beta

- Host: small VPS (Hetzner, EU) or PaaS (Fly.io / Railway) — decide at the time based on cost and worker support.
- HTTPS only (Caddy / platform TLS), HSTS.
- `MM_MASTER_KEY` + service-role key in the platform secret store; **CLI becomes an API client** (see ARCHITECTURE.md decision 3).
- Backups for hosted users: download as archive, or push to user-owned storage — **design needed** (don't keep users' mail on our servers by default).
- Monitoring: uptime check, structured logs, error tracking, alerting — what is logged where, retention and tool candidates in [LOGGING.md](LOGGING.md) (Vercel runtime logs last 1 h on Hobby / 1 day on Pro, so a log drain or shipper is needed).
- Legal prerequisites from SECURITY.md (GDPR) must be done first.

## Stage 5 — Beyond Supabase

- Self-hosted Postgres + own auth (or keep Supabase Auth only). Repository layer makes the DB swap contained; RLS policies become server-side ownership checks.
- Then SMTP (Nodemailer) → full mail client.

## CI (GitHub Actions, from M0)

Defined in `.github/workflows/ci.yml`:

1. `npm ci`
2. `npm run lint`
3. `npm run format:check`
4. `npm run typecheck`
5. `npm test` (unit; integration runs separately with secrets)
6. `npm run build`
7. `npm audit --audit-level=high`
8. gitleaks secret scan (pinned `ghcr.io/gitleaks/gitleaks` image, separate job)

## Open questions

- Git hosting: GitHub (assumed for Actions)?
- Hosted phase: where do scheduled backups of hosted users end up?
