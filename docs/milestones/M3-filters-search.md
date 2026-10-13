# M3 — Filters & search

## Goal

Detailed, combinable filters that select exactly the mail the user means — the foundation for delete (M4) and backup (M5).

## Slices

- **M3a — filter core and filter line in the app.** Implemented 2026-10-13 (C-034); not reviewed or released yet. The filter model, the compiler, the typed line, a read-only search of one folder, and the app's `/` line with order and mark-all. Detailed below.
- **M3b — `mm search`.** The command line on the same core: count, total size, top senders, sample table; the sent date; body search. Not started.
- **M3c — saved filters.** Migration `0002_saved_filters.sql`; `mm filter save | list | show | delete`. Not started.
- **M3d — Gmail and the test ground.** `X-GM-RAW` compiled and cross-checked against the standard search; one seeded case per mapping row. Not started.

## M3a — filter core and filter line in the app

### Decisions (2026-10-12)

- **Dates mean received:** the server's internal date, in this computer's time zone — the date the mail list and the stats show. The sent date comes with `mm search` (M3b).
- **One typed line** in the app. A bare word works without any syntax; the keys mirror the future `mm search` flags.
- **The open folder only**, with the standard IMAP search on every provider. Gmail's `X-GM-RAW` is M3d.
- **App only.** `mm folders` and its tests are unchanged. No body search in the line (`--body` in M3b).
- Asked for in the same answer: the list can be **ordered** (newest, oldest, largest), a **date from–to** key, and one key **marks every match**.
- One assignment, core and app together (a split was offered and declined).
- Out of M3a: largest mails with and without attachments on the stats screen (backlog M2d-6); strip attachments (M5b).

### The model

A filter is a tree, version 1: `all` (AND), `any` (OR) and `not` around leaves. Each leaf is one criterion:

| Kind                                            | Value                                                  |
| ----------------------------------------------- | ------------------------------------------------------ |
| `from`, `to`, `cc`                              | a list of addresses, `@domain`s or plain words         |
| `subject`, `body`, `text`, `word`               | a text                                                 |
| `since`, `before`                               | a calendar day, `YYYY-MM-DD`, from 1970 to 2100        |
| `olderThan`, `newerThan`                        | an age: `30d`, `2w`, `6m`, `2y` (a count of 1 to 9999) |
| `larger`, `smaller`                             | a size in bytes, 1 to 1 TB                             |
| `seen`, `flagged`, `answered`, `hasAttachments` | true or false                                          |

Limits: a text is trimmed and at most 200 code points, with no control character and no `"`; a `from` / `to` / `cc` leaf holds at most 20 values, and a leaf holds either only plain words or only addresses and domains; a filter holds at most 50 nodes, nested at most 6 deep. Anything else is rejected.

The folder is not part of the model. The caller picks it: the app's line searches the open folder, and `mm search` (M3b) picks its own.

### What we check and what the server decides

A leaf is either **checked** on our side or **decided by the server**. The server term only narrows the candidates; the check decides.

- **Checked on our side:**
  - `from`, `to`, `cc` with an exact address or an exact domain. `@shop.example` matches senders at that domain only, not at `shop.example.evil.test` or `sub.shop.example`.
  - `since`, `before`, `older`, `newer` and the `date` range, to the instant, in this computer's time zone: day borders are local midnight. `older` and `newer` compare with the time of the search, minus the age (days and weeks as 24 hours and 7 days; months and years as UTC calendar steps, the day clamped to the month's length). A mail without a received date never matches a date criterion.
  - `att` (`hasAttachments`): the body structure rule — an attachment, a forwarded mail, or a named part that isn't an inline image.
- **Decided by the server** (substring search, as the server implements it): a plain word in `from` / `to` / `cc`, `subject`, and a bare word (sender or subject); `larger` and `smaller` (RFC 822 size); `unread`, `read`, `flagged`.

Dates are checked on our side because IMAP's day terms differ by server (`WITHIN` gives seconds, without it days): one filter must mean one thing on every server. The server gets a term that only narrows, widened by a day, so servers with and without `WITHIN` give the same result.

### The limit on checked criteria

A checked criterion (an exact address or domain, a date, `att`) can't sit inside an `any`, nor inside a `not` together with anything other than that one leaf. The compiler refuses such a filter ("This combination of criteria is not supported yet"), and nothing is sent to the server. A `not` around one checked leaf at the top level is allowed: `-att`, `-from:@shop.example`.

The filter line can't produce the refused shape. The reason is that a mixed `or` can't be decided per mail without one search per term. `mm search --filter-file` (M3b) may lift the limit.

### The filter line

Type `/` in a folder's mail list, type the filter, press Enter. Words are separated by spaces; `"` quotes a phrase that contains spaces. The terms are combined with AND. Keys and flags are not case-sensitive.

| Written                                              | Means                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `shop.sk`                                            | a word: the sender or the subject contains it (the server decides)                                        |
| `"faktura 2023"`                                     | a phrase: the word with its space                                                                         |
| `from:anna@example-test-domain.eu`                   | an exact address                                                                                          |
| `from:@shop.example`                                 | an exact domain (no subdomains)                                                                           |
| `from:@shop.example,a@news.example`                  | several addresses and domains, separated by commas                                                        |
| `from:shop`                                          | a plain word after `from:` (a substring of the sender, the server decides)                                |
| `to:`, `cc:`                                         | as `from:`                                                                                                |
| `subject:"faktura 2023"`                             | the subject contains the phrase                                                                           |
| `older:1y`, `newer:30d`                              | older / newer than an age: `d` days, `w` weeks, `m` months, `y` years                                     |
| `since:2023-01-31`, `before:2023-06`                 | received since the first day / before the first day of a day, a month or a year                           |
| `date:2023`, `date:2023-02`, `date:2023-01..2023-06` | a range: since the first day of the first period, before the day after the last day of the second         |
| `larger:5mb`, `smaller:500kb`                        | a size: `b`, `kb`, `mb`, `gb`, base 1024 (`1,5mb` is read as `1.5mb`)                                     |
| `unread`, `read`, `flagged`, `att`                   | the flag, or an attachment                                                                                |
| `-` in front of a term                               | the term turned around: `-shop`, `-from:@shop.example`, `-att`, `-unread` (= read), `-older:1y`, `-"a b"` |

A `-` in front of `date:` is refused: write `since:` and `before:` instead. `10:30` is a word, since no key is spelled `10`.

Examples, as the parser reads them:

- `shop.sk older:1y larger:1mb` — the word `shop.sk`, older than a year, larger than 1 MB.
- `from:@shop.example,a@news.example -att` — from that domain or that address, without an attachment.
- `subject:"faktura 2023" larger:500kb` — the subject contains the phrase, and the mail is larger than 500 KB.
- `date:2023-01..2023-06 unread` — received from January to June 2023, not read.

A line that can't be read keeps the line open and shows what is wrong. Nothing is searched. The texts:

| What is wrong                        | Text, for `form:x`, `older:soon`, `from:@shop.example,shop`, `-date:2023`, `date:2023-12..2023-01`, `subject:"abc` |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| unknown key                          | Don't know "form:x" - the keys are from: to: cc: subject: older: newer: since: before: date: larger: smaller:      |
| bad age                              | Can't read "older:soon" - write an age like older:30d, older:6m or older:2y.                                       |
| addresses and plain words in one key | "from:@shop.example,shop" mixes addresses and plain words - use one kind per key.                                  |
| `-` on `date:`                       | "-date:2023" can't be turned around - use since: and before: instead.                                              |
| bad date                             | Can't read "date:2023-12..2023-01" - write a date like since:2023-01-31 or date:2023-01..2023-06.                  |
| unclosed quote                       | A quote (") is not closed.                                                                                         |

The other texts: an empty value (`from:`) needs a value; a bad size asks for a size like `larger:500kb`; a line over 200 code points, or with more than 20 terms, is too long; a filter the compiler refuses (see the limit above, or more than 20 addresses in one key) reads "This filter isn't supported yet - try a simpler one."

Edge cases: `from:@shop.example` doesn't match `@shop.example.evil.test`; `-att` is the mails without an attachment; `date:2100` is refused, because the day after its last day is outside the range.

### The order, the marks and the list

- **`o` cycles the order:** newest → oldest → largest → newest. Newest and oldest use the received date (a mail without one sorts last in both); largest uses the known size (a mail without one sorts last). Ties go by UID: higher first for newest and largest, lower first for oldest.
- **`o` on a result** orders it again without a new search. **`o` on the plain list** reads the folder once, as a search without criteria. **`o` while the search runs** only sets the order the result will get.
- **`m` marks every match**; when they are all marked already, `m` unmarks them. Space and `a` work on the filtered list. Marks stay when the filter changes or is cleared.
- **The header** reads `N of M mails, SIZE`: N the matches, M the folder's count when it was searched, SIZE the sum of the known sizes. The **filter row** under it shows `Filter: <the line>` with the order on the right (`newest first`, `oldest first`, `largest first`); an order without a filter shows `Filter: (none)`.
- Subfolder rows are hidden while a listing is on.
- **Esc / Left clears a filter or an order first:** back to the plain list, no leave. The next Esc goes back as before. **Esc while "Filtering..." stops the search**; the mail list shows the plain list at once.
- **A connection lost while the line is open** keeps the line open: what you type stays text. Enter then asks to reconnect instead of searching; Esc closes the line and the list stays offline.
- The search reads only: the folder is examined read-only, and the server gets UID SEARCH and a fetch of UID, size, received date and, when a check needs them, the envelope or the structure — never a body or a flag, so `\Seen` is not set.

Texts on the screen: `No mails match.`; `Filtering...` (with `5000/12000` while it runs); `The mail server couldn't run this filter - try a simpler one.`; `More than 500,000 mails to go through - narrow the filter.`; `m marks every mail of a filtered list - press / and type a filter first.`; `Too many mails to mark at once (N) - narrow the filter.`; `Marked N mails.` / `Unmarked N mails.`; `N mails couldn't be read - the list may be incomplete (/ and Enter tries again).` (a mail expunged meanwhile, or a read the server cut short).

### Limits

| Limit                                  | Value                          | What happens                                         |
| -------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| Filter line                            | 200 code points, 20 terms      | too long (the line stays open)                       |
| Text values                            | 200 code points each           | refused by the filter model                          |
| Addresses per `from` / `to` / `cc` key | 20                             | refused (unsupported)                                |
| Candidates of one search               | 500,000                        | "More than 500,000 mails…", checked before any fetch |
| Marks made at once (`m`)               | 100,000                        | "Too many mails to mark at once…", nothing is marked |
| UIDs in one server set                 | 5,000 UIDs or 4,000 characters | internal: the pass sends several sets                |
| Rows of the list                       | 200 per page, read by UID      | internal                                             |

A search is stopped between batches (Esc). A UID SEARCH on a server without an index can't be interrupted; the stop takes effect when that search returns.

### Logging

`search.finish` (app log, kind A; [LOGGING.md](../LOGGING.md#filters-m3a)) is written once per search that ended: `ok` with the count, bytes, duration and the criteria, or `failed` with zeros and the reason (`search-failed`, `too-many-matches`, `connection-lost`, `unexpected`). A search that was stopped writes nothing, and re-ordering a result writes nothing. `criteria` lists the names of the criteria used (`from`, `olderThan`, `larger`, …), never their values. Never logged: the filter text, addresses, words, dates, sizes or folder names. `mm logs` reads it as `mail filter: 37 mails found in 1.2 s (from, larger)`, or `mail filter failed: search failed`.

### Design choices

- **Dates are checked here**, to the instant (see above): one filter, one meaning on every server.
- **Checked criteria only at the top level**: a mixed `or` needs one search per term; that is M3b's, if it's needed.
- **One pass after the search** gives the sizes (total, largest order, marks), the dates (order and checks) and — only when a check needs them — senders and structure. It stops between batches and is bounded at 500,000 candidates.
- **The plain list is untouched.** Without a filter and with the order "newest", the browser pages by sequence number as before. A listing exists only while a filter or another order is on.

### Files

- `src/core/filters/schema.ts`, `compile.ts`, `line.ts` — the model, the compiler and the typed line.
- `src/core/mailbox/search.ts` — the read-only search and the page reader (`searchFolder`, `loadMatches`); `messages.ts` and `errors.ts` get the shared bits (`SearchStopped`, two mailbox codes).
- `src/core/log/` — `search.finish`; `src/cli/log-text.ts` — its line in `mm logs`.
- `src/cli/filter-text.ts` — the line's error texts and the order names.
- `src/cli/browser/state.ts`, `render.ts`, `field.ts` — the listing, the filter row and the keys of the list (also the reducer of `mm folders`, which takes none of the new keys).
- `src/cli/app/` — the `/`, `o` and `m` keys, the search effects and the controller that runs the search on the mailbox's session.

### Acceptance criteria

- **(1) Model:** every node kind parses; unknown keys, control characters, a `"` in a text, text over 200 code points, more than 20 address values, a mix of words and addresses, an impossible day, a bad age, a size of 0 or over 1 TB, an empty `any`, more than 50 nodes and a depth over 6 are rejected.
- **(2) Compiler:** every criterion gives the query and checks of the compile table; the queries mean AND, OR and NOT in imapflow's own compiler; no `OLDER 0` / `YOUNGER 0` on a server with `WITHIN`.
- **(3) Refusals:** a checked criterion inside `any` or a compound `not` gives "not supported"; nothing is sent.
- **(4) Line:** every key, flag, phrase, `-`, comma list and date form reads as above; each error carries its token; a filter the line returns always compiles.
- **(5) Search:** EXAMINE; one UID SEARCH; fetches by UID in sets of 5,000 UIDs and 4,000 characters; never a body or a flag; the matches UID descending, with the sum of their known sizes.
- **(6) Search errors:** a stop between batches ends with no fetch after it and the lock released; more than the limit of candidates fails before any fetch; a refused search is `search-failed`; a lost connection is `connection-lost`.
- **(7) Pages:** `loadMatches` returns the asked rows in the asked order, leaves out what the server no longer has, and reports `changed` only on another UIDVALIDITY.
- **(8) Log:** `search.finish` has its builder, reader and `mm logs` text; the catalog lists it under M3a; no filter value reaches a line.
- **(9) App:** `/` opens the line; Enter shows "Filtering..." and then the matches; the header reads `N of M mails, X`; the filter row shows the filter with the order on the right; subfolder rows are hidden.
- **(10) Errors in the line:** a line that can't be read keeps the line open, shows its message and searches nothing.
- **(11) Order:** `o` cycles newest → oldest → largest → newest; on a result it orders again without a search; on the plain list the folder is read once; back at newest without a filter, the plain list returns.
- **(12) Marks:** `m` marks every match (all marked → unmarks them); over 100,000 nothing is marked; on the plain list it only hints; Space and `a` work on the list.
- **(13) Leaving:** Esc / Left clear a filter or an order first; Esc while "Filtering..." stops the search and logs nothing; Esc in the line cancels the edit and keeps what was shown.
- **(14) Results:** no match gives its text; a refused search or too many mails gives its text and the plain list; a UIDVALIDITY change under a page filters again, up to 3 times in a row; a lost connection gives the plain list and the reconnect question.
- **(15) Once per search:** `search.finish` once per search that ended, none for a stopped one; `browse.finish` unchanged.
- **(16) `mm folders`:** `/`, `o` and `m` do nothing there; its browser tests pass unchanged.
- **(17) Live:** on `mm-test`, every case of `tests/integration/search-live.test.ts` returns the count and the byte sum computed from the manifest. Passed in the live run of 2026-10-13.
- **(18) Gates:** typecheck, build and unit tests are green; lint and format fail only on the untracked `scripts/bulk.mjs` (and `prices.json` for format), as before.
- **(19) Docs:** this file, `M2d-app-shell.md`, `LOGGING.md`, `IMAP.md` (the WITHIN note), `ARCHITECTURE.md`, `README.md`, `CLAUDE.md` and `TODO.md` say what was built.
- **(20) Manual walk** (the user): in a real terminal on the test mailbox, a bare word, `from:`, `older:`, `date:`, `larger:`, `unread`, `att`, `o` and `m`; the counts equal webmail's; opened mails are still unread.

### Verification

1. `npm run typecheck`, `npm run build`, `npm test`; `npm run lint` and `npm run format:check` fail only on the baseline files (`scripts/bulk.mjs`, and `prices.json` for format).
2. Once, live: `npm run test:integration` runs `search-live.test.ts` against `mm-test` (needs `MM_TEST_IMAP_*`). Never in a loop.
3. Manual walk (the user, an external terminal, `npm run dev`, the test mailbox): the list of AC (20).

## M3b — `mm search`

Not started. The material that goes here:

- `mm search <account> [flags]` → count, total size, top senders, a sample table (`--limit`, `--json`).
- CLI flags: `--from`, `--to`, `--subject`, `--body`, `--since`, `--before`, `--older-than`, `--larger`, `--smaller`, `--unread`, `--flagged`, `--has-attachments`, `--folder`; `--filter <name>` or `--filter-file <json>` for complex AND/OR (this lifts the limit on checked criteria, see M3a).
- **Sent date:** `--by sent` uses the `Date:` header (`SENTBEFORE` / `SENTSINCE`). Received is the default (decided in M3a). How the sent date is checked on our side is designed in M3b.
- **Body search:** `--body` (`BODY` / `TEXT`) can be slow or incomplete on some servers; the output warns.
- The result of a search, for the M4 planner: `{ folder, uidValidity, uids[] }[]`.
- Acceptance: against the seeded `mm-test`, each criterion returns its seeded set; at least three searches match webmail's counts.
- Verification: `mm search <account> --from @example.com --older-than 1y --larger 1MB` on `mm-test`.

## M3c — saved filters

Not started.

- Migration `0002_saved_filters.sql`; `mm filter save <name> [flags]`, `mm filter list`, `mm filter show <name>`, `mm filter delete <name>`.
- Logging: `filter.save` / `filter.delete` (app log and an `audit_log` row, filter id only). The saved values stay in `saved_filters`, never in a log.
- Open question: should saved filters be account-specific or global? Proposal: global, with an optional default account.
- Verification: `mm filter save big-old ...`, then `mm search --filter big-old`.

## M3d — Gmail and the test ground

Not started.

- Filters also compile to `X-GM-RAW` on Gmail (`features.gmail`) and are cross-checked against the standard search; `mm search` prints the comparison, and `--gmail-only` skips the standard search. The mapping, the known differences and the procedure are in [IMAP.md §5.6](../IMAP.md#56-gmail-search-x-gm-raw-checked-against-our-own-search).
- Gmail-only criteria (`category:` and the like) are allowed but marked as unverifiable.
- Logging: `gmail.search-mismatch` (warn, counts only).
- Acceptance: on the Gmail test account, one seeded case per mapping row; standard and `X-GM-RAW` results are equal except for the documented differences, and an unexpected difference fails the test.
- The seeded test mail gets its missing criteria (`cc` is not seeded yet: unit tests only until this slice). This changes the test ground, so `SEED_VERSION` is bumped here.

## Out of scope

- Any modification of mail (delete, move, flags: M4).

## Risks & open questions

- **Internal date or Date header:** decided — received by default; the sent date comes with `mm search` (M3b).
- **Server-defined matching:** subject, word and the plain words of `from:` are substring searches as the server implements them. The live test assumes Dovecot's case-insensitive substring match on the decoded header; a difference is reported, not loosened.
- **Body search** is slow or incomplete on some servers (M3b warns).
- **`cc`** is covered by unit tests only until the seed has a `Cc` (M3d).
- **Saved filters:** account-specific or global (M3c, open).

## Logging

Events ([LOGGING.md](../LOGGING.md)):

- `search.finish` (M3a): `acct`, `count`, `bytes`, `ms`, `criteria` (the criterion names), `outcome`, `reason` on failure.
- `gmail.search-mismatch` (M3d): warn, counts only.
- `filter.save` / `filter.delete` (M3c): the filter id; plus an `audit_log` row.

## Tasks

See `TODO.md` → M3.
