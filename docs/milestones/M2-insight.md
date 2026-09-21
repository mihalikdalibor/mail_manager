# M2 — Mailbox insight (stats)

## Goal

Show the user what is in their mailbox and what takes up space — the core "aha" of the product.

## In scope

- `mm folders <account>` — folder tree with special-use role, message count, unread count.
- `mm stats <account> [--folder X]`:
  - per folder: messages, unread, total size;
  - quota used/limit (when `QUOTA` supported);
  - top N senders by count and by size;
  - size & count by year;
  - N largest messages (date, from, subject, size) — displayed only, never stored in the cloud.
- Progress output for large mailboxes; `--json` output for scripting.

## Out of scope

Filtering (M3), any modification.

## Design notes

- Counts: `STATUS (MESSAGES UNSEEN)` per folder (cheap).
- Sizes: `STATUS SIZE` if supported, otherwise `FETCH 1:* (UID RFC822.SIZE)` in batches.
- Sender/year aggregation: `FETCH ENVELOPE INTERNALDATE RFC822.SIZE` in batches; aggregate in memory with a streaming reducer (don't hold all envelopes).
- **Gmail:** totals from the `\All` folder only; label folders marked "overlapping — don't sum". Skip `\Trash`/`\Junk` from totals, show separately.
- Sender key = lowercased address; also a per-domain rollup.
- Connection reuse: one session per command.

## Risks & open questions

- Performance on ≥100k messages: envelope fetch may take minutes. Measure; if too slow → local metadata cache (SQLite) becomes a candidate (see TODO "Later").
- Should `stats` default to all folders or INBOX only? (Proposal: all folders summary; details via `--folder`.)
- Size semantics: RFC822.SIZE ≠ quota bytes exactly — label clearly as "approximate".

## Tasks

See `TODO.md` → M2.

## Acceptance criteria

- Aggregation unit tests (fixtures) incl. Gmail de-duplication pass.
- Against the test mailbox: counts match webmail; totals within rounding of quota/webmail.
- Memory stays bounded on a large folder (batching verified).

## Verification steps

1. `mm folders <account>`; compare with webmail.
2. `mm stats <account>`; compare totals with provider storage page.
3. `mm stats <account> --json | jq` parses.
