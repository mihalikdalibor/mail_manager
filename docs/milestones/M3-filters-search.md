# M3 — Filters & search

## Goal

Detailed, combinable filters that select exactly the mail the user means — the foundation for delete (M4) and backup (M5).

## In scope

- `filters/schema.ts` — zod filter model (versioned):
  - `from`, `to`, `cc`: address or `@domain` (list allowed)
  - `subject`, `body` / `text` contains
  - `date`: `since`, `before`, `olderThan` (e.g. `6m`, `2y`), `newerThan`
  - `size`: `larger`, `smaller` (e.g. `5MB`)
  - `seen`, `flagged`, `answered` (true/false)
  - `hasAttachments`
  - `folders` (list, default: all except Trash/Junk)
  - combinators: `all` (AND), `any` (OR), `not`
- `filters/compile.ts` — filter → imapflow SearchObject + list of client-side post-filters.
- `mm search <account> [flags]` → count, total size, top senders, sample table (`--limit`, `--json`).
- CLI flag syntax: `--from`, `--to`, `--subject`, `--body`, `--since`, `--before`, `--older-than`, `--larger`, `--smaller`, `--unread`, `--flagged`, `--has-attachments`, `--folder`, plus `--filter <name>` or `--filter-file <json>` for complex AND/OR.
- Saved filters: migration `0002_saved_filters.sql`; `mm filter save <name> [flags]`, `mm filter list`, `mm filter show <name>`, `mm filter delete <name>`.

## Out of scope

Any modification of mail; GUI filter builder (M6).

## Design notes

- Gmail: filters also compile to `X-GM-RAW` and are cross-checked against the standard search (mapping, known differences and procedure: [IMAP.md §5.6](../IMAP.md#56-gmail-search-x-gm-raw-checked-against-our-own-search)). `mm search` prints the comparison; `--gmail-only` skips the standard search. Gmail-only criteria (`category:` …) are allowed but marked as unverifiable.
- Server-side where possible (`UID SEARCH`); post-filters only for: exact domain match on parsed address, `hasAttachments` (BODYSTRUCTURE), anything unsupported by the server.
- Domain filter: IMAP `FROM "@shop.com"` is a substring → post-filter parsed address `endsWith("@shop.com")` (optionally subdomains).
- Date semantics documented: `before 2022-01-01` = internal date strictly before that day; `olderThan` computed from "now" at plan time.
- Result = `{ folder, uidValidity, uids[] }[]` — exactly what the M4 planner consumes.
- Size parsing: `KB/MB/GB` base 1024, documented.

## Risks & open questions

- Internal date vs Date header (`SINCE` vs `SENTSINCE`) — offer `--by sent|received`? (Proposal: received/internal by default.)
- Body search is slow/partial on some servers → warn in output.
- Should saved filters be account-specific or global? (Proposal: global with optional default account.)

## Logging

Events ([LOGGING.md](../LOGGING.md)): `search.finish` (account id, count, bytes, ms, `criteria` = the criterion **names** used, never their values), `gmail.search-mismatch` (warn, counts only), `filter.save` / `filter.delete` (filter id) → app log + `audit_log` row. Saved-filter values stay in `saved_filters`, not in logs.

## Tasks

See `TODO.md` → M3.

## Acceptance criteria

- Unit tests: every criterion compiles correctly; nested AND/OR/NOT; invalid inputs rejected with helpful messages.
- Against seeded `mm-test`: each criterion returns the expected seeded set.
- Webmail comparison: at least 3 real-ish searches match counts.
- Gmail test account: one seeded case per mapping row; standard vs `X-GM-RAW` results are equal except for the documented expected differences (an unexpected difference fails the test).

## Verification steps

1. Seed `mm-test`; run the integration suite.
2. `mm search <account> --from @example.com --older-than 1y --larger 1MB`.
3. `mm filter save big-old ...` → `mm search --filter big-old`.
