# M4 — Safe delete

## Goal

Delete mail by filter (range, sender, age, size…) with near-zero risk of deleting the wrong thing.

## In scope

- `planner.ts` — from a search result build an immutable plan: per folder `{ uidValidity, uids, count, bytes }`, totals, top senders, samples, created_at, filter.
- `delete.ts` — execute a plan per the protocol in SECURITY.md:
  - default: move to `\Trash` (`UID MOVE`, fallback COPY + `\Deleted` + `UID EXPUNGE`);
  - `--expunge`: `\Deleted` + `UID EXPUNGE <uids>`, **only with UIDPLUS**;
  - UIDVALIDITY re-check before each batch; batches ~500; progress.
- Resumability: plan saved to `~/.config/mail-manager/plans/<id>.json`; `mm delete --resume <id>`.
- Audit: migration `0003_audit_log.sql`; one row per folder per run.
- CLI: `mm delete <account> [filter flags] [--expunge] [--max N] [--yes] [--no-backup]`, `mm audit [--account]`.
- Confirmation UX: show plan → user types the message count. `--yes` only with `--max N`.

## Out of scope

Undo beyond Trash; scheduled cleanups (M6).

## Design notes

- Gmail: target folder must be `\Trash` via special-use; deleting "from a label" is explained to the user (label removal vs delete). Default for Gmail: operate on `\All` to truly delete.
- Messages already in Trash + default mode → skip or offer `--expunge`.
- `--expunge` implies backup-first (M5) → until M5 lands, `--expunge` requires `--no-backup` explicitly acknowledged. (Alternatively ship M4 with trash-only and enable expunge after M5 — **decide before implementing**.)
- Partial failure: stop at first failed batch, audit `partial`, print resume command.

## Risks & open questions

- Order M4/M5: ship expunge only after backup exists? (Proposal: yes — M4 = trash only + expunge behind flag after M5.)
- Very large plans (100k UIDs): compress UID ranges (`1:500,742,...`) in plan files.
- Concurrent changes by other clients between plan and execute: UIDs are stable within a UIDVALIDITY; already-gone UIDs are skipped silently and reported.

## Tasks

See `TODO.md` → M4.

## Acceptance criteria

- Unit tests with fake session: exact UIDs only; UIDVALIDITY change aborts; no-UIDPLUS refuses expunge; folder-wide expunge never called; audit results correct.
- On `mm-test`: delete of seeded subset moves exactly that subset to Trash (verified by UID/Message-ID); non-matching messages untouched.
- Interrupted run resumes and finishes without duplicates.

## Verification steps

1. `mm delete <acc> --folder mm-test --from @spam.test` → review plan → confirm.
2. Check Trash in webmail; check remaining messages.
3. `mm audit` shows the row.
4. Kill mid-run (large seeded set) → `--resume`.
