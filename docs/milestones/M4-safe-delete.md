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
- Audit: rows in the existing `audit_log` (created in M1b-4, [DATA_MODEL.md](../DATA_MODEL.md#audit_log-m1b-4d-migration-20260929063314_audit_logsql)); one row per folder per run, actions `mail.trash` / `mail.expunge` / `mail.move`.
- CLI: `mm delete <account> [filter flags] [--expunge] [--max N] [--list-file <path>] [--no-backup]`, `mm audit [--account]`.
- Confirmation UX ([IMAP.md §6.4](../IMAP.md#64-confirmation-flow-for-every-delete)): notices (fallback, Trash folder, Gmail) → **full paged list of every message** → `y/N` → type the count (`DELETE <n>` for permanent). Interactive only (refuses without a TTY), no `--yes`.
- Trash selection ([IMAP.md §6.5](../IMAP.md#65-choosing-the-trash-folder)): server-marked `\Trash`, otherwise our own name scan → root-Trash ranking → user picks. Always printed. Choice saved on the account (new migration: `trash_path`, `trash_source`, `trash_confirmed_at`).
- Input can also be the M2b basket (folder + UIDVALIDITY + UIDs, marked in the browser) → the same plan/confirm flow (decided 2026-10-01).

## Out of scope

Undo beyond Trash; scheduled cleanups (M6).

## Design notes

- Gmail: delete plans contain only messages that both the standard search and `X-GM-RAW` return ([IMAP.md §5.6](../IMAP.md#56-gmail-search-x-gm-raw-checked-against-our-own-search)); disagreements are listed separately and can be added explicitly.
- Gmail: target folder must be `\Trash` via special-use; deleting "from a label" is explained to the user (label removal vs delete). Default for Gmail: operate on `\All` to truly delete.
- Messages already in Trash + default mode → skip or offer `--expunge`.
- `--expunge` implies backup-first (M5) → until M5 lands, `--expunge` requires `--no-backup` explicitly acknowledged. (Alternatively ship M4 with trash-only and enable expunge after M5 — **decide before implementing**.)
- Partial failure: stop at first failed batch, audit `partial`, print resume command.
- **Re-EXAMINE before acting** on a basket or plan (added 2026-10-02 with M2b-2): NOOP never brings a UIDVALIDITY change (imapflow reads UIDVALIDITY only on SELECT/EXAMINE), and imapflow skips EXAMINE for an already selected folder — so M4 must select the folder afresh and compare UIDVALIDITY before the first batch, not rely on the browser's snapshot.
- **Double check = the local M2b basket** (decided 2026-10-01, confirmed again the same day after comparing the options): marks → plan → full list → two confirmations → move to Trash (default). Trash is the server-side safety net the user can see in webmail.
- **Optional review folder (later in M4, not the default)** — a dedicated server folder (e.g. "Mail Manager – to delete") the user can check in webmail/phone before it is emptied. Only as an opt-in mode, with these conditions:
  - Mail Manager keeps a **local record of each mail's original folder** (folder + UIDVALIDITY + UID → new UID via COPYUID, plus Message-ID) — the move itself loses the origin — and adds `mm restore` to put them back;
  - **only on servers with MOVE and UIDPLUS** (no COPY + EXPUNGE fallback, never a folder-wide EXPUNGE);
  - **not on Gmail** (folders are labels: moving only relabels, deleting from the folder only removes the label);
  - emptying it goes through the same plan → full list → two confirmations flow; a crash midway resumes from the local record.
  - Why not the default: two server moves instead of one, frees no space until emptied (same as Trash), the folder syncs to other devices while half-filled.

## Risks & open questions

- **From the M1c-2 security audit** ([SECURITY.md](../SECURITY.md#credential-encryption)): the AAD doesn't bind `email`, `provider` or `capabilities` — confirmations must name the mailbox by `username@host`, capabilities must come from the live server response, and the `@` check on folder names must be unicode-aware (NFKC + wider DB regex).
- Order M4/M5: ship expunge only after backup exists? (Proposal: yes — M4 = trash only + expunge behind flag after M5.)
- Very large plans (100k UIDs): compress UID ranges (`1:500,742,...`) in plan files.
- Concurrent changes by other clients between plan and execute: UIDs are stable within a UIDVALIDITY; already-gone UIDs are skipped silently and reported.

## Logging

Events ([LOGGING.md](../LOGGING.md)): `delete.plan` (plan id, count, bytes, folders), `delete.confirm`, `delete.batch` (`debug`, one per ~500 UIDs), `delete.finish` (`ok` / `partial` / `failed` / `aborted`, `reason: uidvalidity-changed`), `trash.select` (`source`: extension / name / user), notices shown (which fallback). Audit rows as above; `audit.write-failed` if a row can't be written. UIDs, subjects and senders stay in the local plan file — log lines reference it by plan id. `mm delete --resume` can offer runs that `mm logs` shows as interrupted.

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
