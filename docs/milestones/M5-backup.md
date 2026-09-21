# M5 — Backup / export

## Goal

Export selected mail to local files that are complete, verifiable, and usable for migration or archiving.

## In scope

- `backup.ts`: from a plan (same planner as M4) stream each message's raw source to disk.
- Layout: `<out>/<account-email>/<folder>/<YYYY>/<YYYY-MM-DD>_<uid>_<short-hash>.eml`.
- `manifest.json` per backup root: account, created_at, filter, and per message `{ folder, uidValidity, uid, messageId, internalDate, size, sha256, path }`.
- Verification: recount + re-hash; `mm backup verify <dir>`.
- Incremental: skip entries already in manifest (by folder+uidValidity+uid, fallback Message-ID).
- Optional formats: `--format mbox` (per folder), `--zip`.
- Permissions: dirs 700, files 600.
- Integrate with M4: `--expunge` runs backup first by default, and only expunges messages whose backup verified.
- CLI: `mm backup <account> [filter flags] --out <dir> [--format eml|mbox] [--zip]`, `mm backup verify <dir>`.
- Audit row `action=backup`.

## Out of scope

Restore/upload to another account (→ M6 IMAP→IMAP migration), encrypted archives (later), cloud storage targets.

## Design notes

- Stream (`client.download()` / fetch `source`) straight to file + hash in one pass; never buffer whole large messages.
- Filename sanitisation: folder names can contain `/`, `..`, unicode, IMAP modified UTF-7 → decode, then sanitise; no path traversal.
- Write to `*.part`, rename after hash → no half files on crash.
- Gmail daily download limit: estimate size up front; resumable across days thanks to incremental mode.
- `.eml` opens in Thunderbird/Outlook; mbox import supported by most clients.

## Risks & open questions

- Default output dir: `./backups` or `~/MailManagerBackups`? (Proposal: `./backups`, required explicit `--out` for other paths.)
- Duplicate messages across Gmail labels → back up from `\All` only for Gmail by default.
- Disk space check before starting.

## Tasks

See `TODO.md` → M5.

## Acceptance criteria

- Unit tests: manifest, hashing, incremental skip, sanitisation (malicious folder/subject names).
- On `mm-test`: exported count == plan count; every sha256 verifies; files open in a mail client.
- Interrupted backup re-run completes without duplicates.
- Expunge-with-backup only removes verified messages.

## Verification steps

1. `mm backup <acc> --folder mm-test --out ./backups/test`.
2. `mm backup verify ./backups/test`.
3. Open sample `.eml` in Thunderbird.
4. Re-run → "0 new".
