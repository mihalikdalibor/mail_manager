# Testing

## Layers

| Layer                 | Tool                          | Runs                            | Touches network?      |
| --------------------- | ----------------------------- | ------------------------------- | --------------------- |
| Unit                  | Vitest                        | always (`npm test`)             | no                    |
| Integration (IMAP)    | Vitest, `tests/integration`   | only when `MM_TEST_IMAP_*` set  | test mailbox          |
| Integration (DB)      | Vitest                        | only when Supabase test env set | Supabase test project |
| Manual E2E            | checklist below               | per milestone                   | yes                   |
| Hermetic IMAP (later) | GreenMail / Dovecot in Docker | CI, once Docker arrives         | local container       |

## Commands

- `npm test` — unit tests (`tests/unit`, config `vitest.config.ts`).
- `npm run test:integration` — integration tests (`tests/integration`, config `vitest.integration.config.ts`); passes when there are none.

## Unit test targets

- `config` — env validation (missing / malformed master key rejected).
- `crypto` — round trip; wrong key fails; tampered ciphertext/tag/IV fails; AAD mismatch fails; IV unique across calls.
- `providers/discover` — preset match, ISPDB XML parsing, SRV parsing, MX guess, fallthrough order (fetch/DNS mocked).
- `filters/schema` + `compile` — each criterion → expected imapflow SearchObject; AND/OR/NOT nesting; date/size edge cases; invalid input rejected.
- `stats` — aggregation over fixture envelopes; Gmail `All Mail` de-duplication.
- `planner` — UID sets, totals, UIDVALIDITY recorded; plan serialisation.
- `delete` — with a **mocked session interface**: batching, UIDVALIDITY change aborts, no-UIDPLUS refuses expunge, never calls folder-wide expunge, audit written for ok/partial/failed.
- `backup` — manifest generation, sha256 verify, incremental skip, filename sanitisation (path traversal in folder names / subjects).

Design for testability: core modules depend on small interfaces (`ImapSession`, repos, `CredentialProvider`) so unit tests pass fakes.

## Integration tests (real IMAP)

- **Dedicated throwaway mailbox only.** Never a personal account.
- Configured via `MM_TEST_IMAP_HOST/PORT/USER/PASS`; tests `skip` when unset.
- Tests may only touch folder **`mm-test`** (and its Trash moves). A guard in the test helper refuses any other folder.
- `tests/integration/seed.ts` creates `mm-test` and `APPEND`s synthetic messages: varied senders/domains, dates across years, sizes (1 KB → 5 MB), with/without attachments, seen/flagged states.
- Cleanup after run: delete `mm-test` contents.
- Keep runs small — provider rate limits (Gmail bandwidth/connection limits).

## IMAP server differences to test against

- SEARCH `SINCE`/`BEFORE` use the server's **internal date** at **day granularity** (timezone of the server). Filters need clear semantics ("before = strictly before that day").
- `SENTSINCE`/`SENTBEFORE` use the Date header instead — offer both? (Open question M3.)
- `TEXT`/`BODY` search: slow or partial on some servers; Gmail tokenises words.
- `FROM "@domain.com"` is a substring match — may over-match (`@domain.com.evil`). Post-filter on parsed address for exact domain match.
- `STATUS=SIZE`, `QUOTA`, `MOVE`, `UIDPLUS`, special-use: not universal.

Target at least: Gmail, one SK/CZ provider (Seznam), one standard Dovecot (later, Docker).

## Manual E2E checklist (grows per milestone)

- [ ] M1: `mm login`; `mm account add` Gmail app password → saved; `mm account test` ok; wrong password → clear error, nothing saved.
- [ ] M2: `mm stats` totals match webmail within rounding; Gmail labels not double-counted.
- [ ] M3: `mm search --from … --before …` count matches a webmail search.
- [ ] M4: `mm delete` dry run shows plan; confirm moves exactly N to Trash (check webmail); `--expunge` only removes planned UIDs; audit row exists.
- [ ] M5: `mm backup` → `.eml` files open in Thunderbird; manifest verify passes; re-run skips existing.

## Security tests

- Grep all test output/logs for the test password → must be absent.
- RLS: two Supabase users; B reads A's rows → 0 rows; B inserts with A's user_id → rejected.
