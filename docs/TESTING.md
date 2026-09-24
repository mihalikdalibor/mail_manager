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
- `providers/*` — email/host validation (IDN, IP literals, injection characters), presets file validity + MX-suffix matching (label boundary, longest wins), autoconfig/ISPDB XML parsing (SSL/993 only, placeholders, malformed/hostile XML), discovery order and fallthrough, HTTPS-only redirects, body cap, timeouts (fetch/DNS faked); CLI provider picker + manual host entry (prompts faked).
- `filters/schema` + `compile` — each criterion → expected imapflow SearchObject; AND/OR/NOT nesting; date/size edge cases; invalid input rejected.
- `stats` — aggregation over fixture envelopes; Gmail `All Mail` de-duplication.
- `planner` — UID sets, totals, UIDVALIDITY recorded; plan serialisation.
- `delete` — with a **mocked session interface**: batching, UIDVALIDITY change aborts, no-UIDPLUS refuses expunge, never calls folder-wide expunge, audit written for ok/partial/failed.
- `backup` — manifest generation, sha256 verify, incremental skip, filename sanitisation (path traversal in folder names / subjects).

Design for testability: core modules depend on small interfaces (`ImapSession`, repos, `CredentialProvider`) so unit tests pass fakes.

## Integration tests (real IMAP)

- **Dedicated throwaway mailbox only.** Never a personal account.
- Configured via `MM_TEST_IMAP_HOST/PORT/USER/PASS`; tests `skip` when unset. `MM_TEST_IMAP_USER` alone enables the discovery test (`tests/integration/discover.test.ts`, live DNS only, no login). `tests/integration/presets-live.test.ts` needs no env, only internet: every preset host must answer on 993 with a valid certificate and an IMAP greeting (no login).
- Tests may only touch folder **`mm-test`** (and its Trash moves). A guard in the test helper refuses any other folder.
- `tests/integration/seed.ts` creates `mm-test` and `APPEND`s synthetic messages: varied senders/domains, dates across years, sizes (1 KB → 5 MB), with/without attachments, seen/flagged states.
- Cleanup after run: delete `mm-test` contents.
- Keep runs small — provider rate limits (Gmail bandwidth/connection limits).
- **IMAP session test** (`tests/integration/imap-session.test.ts`, needs `MM_TEST_IMAP_USER` + `MM_TEST_IMAP_PASS`; `MM_TEST_IMAP_HOST` only as a fallback when discovery finds nothing): the host comes from discovery (real DNS, no HTTP) → login → features (UIDPLUS, MOVE, QUOTA on Websupport) → logout, then **exactly one** wrong-password attempt → `auth-failed` with the generic message. All stdout/stderr and every inspected session/error is checked for the password.
- **One wrong attempt per run, no retries.** Providers ban IPs after repeated failures (fail2ban). Never add more wrong-password cases and never enable vitest `retry` in `vitest.integration.config.ts` or that file. Don't run the suite in a loop.

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

- Grep all test output/logs for the test password → must be absent. Leak check without printing the value (run from the repo root; `$SCRATCH` = any temp dir):

  ```bash
  npx vitest run --config vitest.integration.config.ts --reporter=verbose > "$SCRATCH/it.log" 2>&1; echo "exit $?"
  node --input-type=module -e "
  import { config } from 'dotenv'; import { readFileSync } from 'node:fs';
  const e = {}; config({ path: '.env.local', processEnv: e, quiet: true });
  const u = e.MM_TEST_IMAP_USER ?? '', p = e.MM_TEST_IMAP_PASS ?? '';
  const log = readFileSync(process.argv[1], 'utf8');
  if (!log.includes('imap session (live)')) { console.log('IMAP suite did not run'); process.exit(3); }
  const forms = [p, JSON.stringify(p).slice(1, -1), Buffer.from('\\0' + u + '\\0' + p).toString('base64'), Buffer.from(p).toString('base64')];
  console.log(p.length < 4 ? 'PASS not set' : forms.some((f) => f.length >= 4 && log.includes(f)) ? 'LEAK' : 'clean');" "$SCRATCH/it.log"
  ```

- Unit tests use canary passwords/server texts and assert they never appear in any error message, `String`, `util.inspect`, JSON or CLI text (`tests/unit/imap-*.test.ts`).
- Logs (from M1b-4, [LOGGING.md](LOGGING.md#keeping-it-complete)): every event builder is fed canary passwords/addresses/hosts/subjects and none may appear in a log line; the event names in code must match the LOGGING.md catalog; every registered command must write `command.start` + `command.finish`; the fail2ban regex must still match `login-guard.block` lines. After an integration run, the value-blind leak check above also runs over the log folder.
- RLS: two Supabase users; B reads A's rows → 0 rows; B inserts with A's user_id → rejected.
