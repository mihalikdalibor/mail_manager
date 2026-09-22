# M4 — Safe delete

## Goal

Delete mail by filter (range, sender, age, size…) with near-zero risk of deleting the wrong thing.

## In scope

- `planner.ts` — from a search result build an immutable plan: per folder `{ uidValidity, uids, count, bytes }`, totals, top senders, samples, created_at, filter.
- `delete.ts` — execute a plan per the protocol in SECURITY.md:
  - default: move to Trash (`UID MOVE`, fallback COPY + `\Deleted` + `UID EXPUNGE`; neither MOVE nor UIDPLUS → COPY + `\Deleted`, no expunge);
  - `--expunge`: `\Deleted` + `UID EXPUNGE <uids>`, **only with UIDPLUS**; without it → notice + offer Trash instead;
  - every fallback is announced and confirmed ([IMAP.md §6.2](../IMAP.md#62-delete-strategy-matrix));
  - UIDVALIDITY re-check before each batch; batches ~500; progress.
- Resumability: plan saved to `~/.config/mail-manager/plans/<id>.json`; `mm delete --resume <id>`.
- Audit: migration `0003_audit_log.sql`; one row per folder per run.
- CLI: `mm delete <account> [filter flags] [--expunge] [--max N] [--list-file <path>] [--no-backup]`, `mm audit [--account]`.
- Confirmation UX ([IMAP.md §6.4](../IMAP.md#64-confirmation-flow-for-every-delete)): notices (fallback, Trash folder, Gmail) → **full paged list of every message** → `y/N` → type the count (`DELETE <n>` for permanent). Interactive only (refuses without a TTY), no `--yes`.
- Trash selection ([IMAP.md §6.5](../IMAP.md#65-choosing-the-trash-folder)): server-marked `\Trash`, otherwise our own name scan → root-Trash ranking → user picks. Always printed. Choice saved on the account (new migration: `trash_path`, `trash_source`, `trash_confirmed_at`).

## Out of scope

Undo beyond Trash; scheduled cleanups (M6).

## Design notes

- Gmail: delete plans contain only messages that both the standard search and `X-GM-RAW` return ([IMAP.md §5.6](../IMAP.md#56-gmail-search-x-gm-raw-checked-against-our-own-search)); disagreements are listed separately and can be added explicitly.
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

- Unit tests with fake session: exact UIDs only; UIDVALIDITY change aborts; no-UIDPLUS turns expunge into a confirmed Trash move; without MOVE/UIDPLUS `messageDelete`/`messageMove`/`EXPUNGE`/`CLOSE` are never called; no execution without both confirmations; Trash ranking picks the root candidate and always asks when it was found by name; audit results correct.
- On `mm-test`: delete of seeded subset moves exactly that subset to Trash (verified by UID/Message-ID); non-matching messages untouched.
- Interrupted run resumes and finishes without duplicates.

## Verification steps

1. `mm delete <acc> --folder mm-test --from @spam.test` → check the Trash notice → page through the full list → confirm twice.
2. Check Trash in webmail; check remaining messages.
3. `mm audit` shows the row.
4. Kill mid-run (large seeded set) → `--resume`.
