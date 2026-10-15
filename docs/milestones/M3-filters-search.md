# M3 — Filters & search

## Goal

Detailed, combinable filters that select exactly the mail the user means — the foundation for delete (M4) and backup (M5).

## Slices

- **M3a — filter core and filter line in the app.** Implemented 2026-10-13 (C-034); not reviewed or released yet. The filter model, the compiler, the typed line, a read-only search of one folder, and the app's `/` line with order and mark-all. Detailed below.
- **M3b — `mm search`.** Implemented 2026-10-14 (C-035); not reviewed or released yet. The app's filter line on the command line: count, total size, folders, top senders, a sample list; `--sent` and `--body`. Detailed below.
- **M3c — saved filters.** Implemented 2026-10-15 (C-036); not reviewed or released yet. A filter kept under a name (`mm filter save | list | show | delete`), used with `mm search --filter <name>`. Detailed below.
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

Dates are checked on our side because IMAP's day terms differ by server (`WITHIN` gives seconds, without it days): one filter must mean one thing on every server. The server gets a term that only narrows, widened by a day, so servers with and without `WITHIN` give the same result. With `--sent` (M3b) the narrowing is widened by two days instead.

### The limit on checked criteria

A checked criterion (an exact address or domain, a date, `att`) can't sit inside an `any`, nor inside a `not` together with anything other than that one leaf. The compiler refuses such a filter ("This combination of criteria is not supported yet"), and nothing is sent to the server. A `not` around one checked leaf at the top level is allowed: `-att`, `-from:@shop.example`.

The filter line can't produce the refused shape. The reason is that a mixed `or` can't be decided per mail without one search per term. Lifting the limit (a filter file, a mixed `or`) is in Later; `mm search` keeps the same rule.

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
- **Checked criteria only at the top level**: a mixed `or` needs one search per term; lifting that is in Later, if it's needed.
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

### Decisions (2026-10-14)

- **The filter line is the argument**: the app's syntax, so one syntax for the app and the command. No flag per criterion. Words may come unquoted and are joined with spaces: `mm search from:@shop.sk -att` works. Quote the whole filter when a phrase has spaces.
- **The mailbox is `--account <id>`**, optional with one saved mailbox. The id is a flag, not a word, so a filter word such as `cafe` is never read as an id.
- **The whole mailbox by default**: the scope of `mm stats` (every folder, Trash and Spam included; on Gmail All Mail, Trash and Spam). `--folder <path>` searches one folder.
- **Standard IMAP search on every provider.** Gmail's `X-GM-RAW` is M3d. Read-only.
- **In M3b:** `--sent` and `--body`. **Not in M3b:** `--filter <name>` (M3c, below); `--filter-file` and a mixed `or` with checked criteria (Later).

### Usage

```text
mm search "<filter>" [--account <id>] [--folder <path>] [--sent] [--body <text>]
          [--order newest|oldest|largest] [--limit <n>] [--json]
```

| Option            | Meaning                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--account <id>`  | the mailbox's id from `mm account list`; optional with one saved mailbox                                                         |
| `--folder <path>` | only this folder, by its full path (see `mm folders --json`)                                                                     |
| `--sent`          | the date words check the `Date:` header, not the arrival date                                                                    |
| `--body <text>`   | only mails whose body contains the text: one more term, `BODY`, decided by the server and AND-ed with the line                   |
| `--order <order>` | `newest` (default), `oldest` or `largest`: the order of the sample list                                                          |
| `--limit <n>`     | rows of the sample list, 0 to 200 (default 20); `0` shows no list                                                                |
| `--json`          | one versioned JSON object instead of the report; with `--json` the `Mailbox:` line goes to stderr, so stdout is the object alone |

Examples (also in `mm search --help`):

- `mm search "from:@shop.sk older:1y larger:1mb"`
- `mm search "att larger:5mb" --order largest`
- `mm search "date:2023 unread" --folder INBOX --json`
- `mm search "older:2y" --sent`

The checks run before any login, in this order: an unknown `--option` word, `--order`, `--limit`, `--body`, an empty filter, the line (the texts of [the line table](#the-filter-line)), the compiler's refusal, `--account`. A bad request exits 1 and never reaches the network. Only words that start with `--` are refused as options: a mistyped short option such as `-j` is read as a term (`-j` = not `j`). A control character in the filter is refused as an unsupported filter; in `--body` it is refused with the body text.

### Texts

| What is wrong                                               | Text                                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| no filter and no `--body`                                   | Type a filter, e.g. mm search "from:@shop.sk older:1y" — see `mm search --help`.                                                  |
| unknown `--option`                                          | Unknown option "--jsno" — see `mm search --help`.                                                                                 |
| `--limit` not a whole number 0–200                          | --limit takes a whole number from 0 to 200.                                                                                       |
| `--order` not newest, oldest or largest                     | --order takes newest, oldest or largest.                                                                                          |
| `--body` empty, over 200 characters, `"` or control         | The --body text can't be used — up to 200 characters, without quotes (") or control characters.                                   |
| `--account` not an id                                       | A mailbox id is 4–36 characters 0-9, a-f (from `mm account list`).                                                                |
| several mailboxes and no `--account`                        | Several mailboxes saved — run `mm search "<filter>" --account <id>` with one of these ids: (then the list)                        |
| a line that can't be read, or a filter the compiler refuses | the line texts of [the filter line](#the-filter-line); "This filter isn't supported yet - try a simpler one."                     |
| the search itself fails                                     | the mailbox text of `mm stats`' errors (folder not found, Gmail All Mail hidden, search refused, too many mails, connection lost) |
| `--body` used                                               | Body search is done by the mail server — some servers are slow at it or search only part of a mail.                               |

### The report

Plain text, one block per topic; the first block has no blank lines inside:

1. `Filter: <the line>`, then `body:"<text>"` when `--body` was given, then ` — dates are sent dates (the Date: header)` with `--sent`. The typed text is cleaned for the terminal first.
2. `Found N mails, SIZE in K folders — sizes are approx. (message sizes)`, or `No mails match.`
3. Notes, each only when it applies: folders that couldn't be searched (the result may be incomplete); mails that couldn't be read (run it again); `Not searched:` the Gmail labels and virtual folders, whose mail is in the folders above; `First 5,000 folders only.`; the body-search warning; `Dates in the list are received dates.` (with `--sent` and a sample list).
4. `FOLDER` (`MAILS`, `SIZE`): the folders with matches, and the folders that couldn't be searched marked `(couldn't be searched)`, in scope order. Folders without matches are not listed.
5. `TOP SENDERS`: at most 10 rows, `(no address)` for mails without one. `TOP SENDERS (approximate)` with an `others` row when some senders did not fit the key cap.
6. `NEWEST 20 OF 1,234` (or `OLDEST` / `LARGEST`), then one line per mail: date, size, sender, `subject  (folder)`. Then, when some listed mails are gone, `N mails of this list couldn't be shown — gone from the server or not readable now.`

Sizes are the sums of RFC 822 sizes: approximate, not the quota. The sample list is the list of the asked order across all folders, read by UID.

With `--json` the object is versioned (`v: 1`): `account` (the id), `filter`, `body`, `dates` (`received` or `sent`), `scope` (`folder` and `gmail`), `totals` (`messages`, `bytes`), `folders` (every scoped folder in scope order; a folder that couldn't be searched has `null` counts and `failed: true`), `notSearched`, `failed`, `missing`, `truncated`, `senders` (`rows`, `others`), and `samples` (`order`, `rows` with folder, uid, received as an ISO date or `null`, from, subject, bytes, attachment; and `gone`). Every server string and the echoed filter go through the same sanitising as the report; none is cut, so a folder path can be passed back to `--folder`.

### Sent dates (`--sent`)

- `--sent` switches **every** date term (`since`, `before`, `older`, `newer`, `date:`) to the `Date:` header. Each is checked to the instant, like the received date.
- The server gets `SENTSINCE` / `SENTBEFORE`, widened by **two days**. imapflow formats those days in UTC, while the server compares the header's own day in its own time zone (up to 14 hours apart). Two days is never wrong, only less narrow; the check decides.
- A mail without a readable `Date:` never matches a date term, with or without a `-` in front of it: the same rule as a mail without a received date.
- `--sent` without a date term changes nothing; the `Filter:` line still shows the sent-date suffix, because it echoes the options given.
- The sample list stays ordered and shown by the **received** date (the page read has no `Date:` header). The report says so.

### Body search (`--body`)

- `--body <text>` adds one `body` term, AND-ed with the line; the server decides (`BODY`). The text is trimmed, and up to 200 code points, without `"` and control characters.
- Body search can be slow or search only part of a mail on some servers, so the report warns once.
- The log lists `body` among the criteria names when it was used (never the text).

### Scope, failures and limits

- **Folders:** the scope of `mm stats`, searched one at a time. A folder the server refuses (`search-failed`) or that is gone (`folder-unavailable`) is noted as a failed row and the rest go on; its mails are not counted in the totals or the senders.
- **All folders failed:** when every folder of a non-empty scope fails, the search fails with the first failed folder's text and exits 1. In practice this is the `--folder` case.
- **Too many mails:** more than 500,000 candidates in one folder end the whole search (`too-many-matches`): a count that silently skipped the rest would mislead. **A lost connection** ends it too (`connection-lost`).
- **Mails that can't be read:** counted in the notes ("run it again"), the rest of the search goes on.
- **Gone samples:** a mail expunged after the search, or a folder whose UIDVALIDITY changed, is counted as "couldn't be shown"; it is not an error.

| Limit                    | Value                            | What happens                                              |
| ------------------------ | -------------------------------- | --------------------------------------------------------- |
| Candidates of one folder | 500,000                          | `too-many-matches`: the whole search fails                |
| Sample rows (`--limit`)  | 0 to 200, default 20             | other values refused before any login                     |
| Top senders              | 10 rows                          | the rest of the matches are in `others`                   |
| Sender keys tallied      | 50,000 (as `mm stats`)           | keys past it go to `others`; the heading says approximate |
| Words of the command     | 100 words, 1,000 characters each | refused as unexpected options                             |
| Filter line and `--body` | 200 code points; 20 terms        | the line texts, or the body text                          |

The core keeps each folder's snapshot (its UIDVALIDITY) and its matches (`searchMailbox` in `src/core/mailbox/search-mailbox.ts`). The report and `--json` show a summary of them; the M4 planner reads them through the core.

### Logging

`mm search` writes `search.finish` (M3a's event, no new one) **once per run that reached the mailbox** — after a failed login, listing or search too, but not when no mailbox was picked. `ok` carries the sums over every folder searched (`count`, `bytes`), the duration and the criteria names, and is also written when some folders couldn't be searched. `failed` carries zeros and the reason. Nothing is written on Ctrl+C. The criteria are names only (`from`, `olderThan`, `larger`, `body`, …). Never logged: the filter, `--body` text, addresses, words, dates, sizes, folder names, subjects or senders. `command.start` lists only the known option names. The login goes through `guardedOpenSession`, so `imap.login` and `imap.login-failed` reach the security log as before.

### Acceptance criteria

- **(B1) Compiler:** `dates: 'sent'` gives `sent` checks with the received instants, and `sentSince` / `sentBefore` widened by two days (omitted when not clearly in the past); the envelope is fetched. Without it the output is M3a's, byte for byte.
- **(B2) Sent checks:** they read the `Date:` header; a missing or invalid date never matches, true or false; the received date is ignored.
- **(B3) Scope:** the stats scope's folders in scope order; `--folder` and the Gmail rules as in `mm stats`.
- **(B4) Failures:** a refused or gone folder is a failed row and the rest go on; when all fail, the first failed code is the error; too many mails and a lost connection end the search at once.
- **(B5) Senders:** at most 10 rows, by messages, then bytes, then key; no address last among equals; keys past the cap go to `others`.
- **(B6) Samples:** at most `--limit` rows across the folders in the asked order; a mail gone since the search is counted, not shown.
- **(B7) Checks first:** every bad request gives its text and exits 1, before any login.
- **(B8) Words:** unquoted words join into the line; a `-` term is a term; an unknown `--` option is refused.
- **(B9) Output:** the report and `--json` as above; every server string sanitised.
- **(B10) Log:** `search.finish` once per run that reached the mailbox, none on Ctrl+C; criteria names only; a canary test over every line.
- **(B11) Unchanged:** `mm --help` lists `mm search` as step 7; `mm stats`, `mm folders` and the app behave as before.
- **(B12) Live on `mm-test`** (`tests/integration/search-mailbox-live.test.ts`, once): a sender domain, an age and size, and `date:2023` with sent dates return the manifest's count and bytes. Passed 2026-10-14.
- **(B13) The user** (pending): `mm search "from:@<domain> older:1y larger:1mb" --folder <mm-test path>` prints the report, and three searches match webmail's counts.
- **(B14) Gates:** typecheck, build and unit tests green; lint and format:check fail only on the baseline files (`scripts/`, `measure_usage.py`, `prices.json`).

### Verification

1. `npm run dev -- search --help` shows the options and examples; `npm run dev -- search "form:x"` prints the unknown key text and exits 1, without a login.
2. Once, live: `npm run test:integration` runs `search-mailbox-live.test.ts` against `mm-test`. Never in a loop.
3. The user, in an external terminal: `mm search "from:@<domain> older:1y larger:1mb" --folder <mm-test path>` and three searches compared with webmail.

## M3c — saved filters

Implemented 2026-10-15 (C-036); not reviewed or released yet. The app does not show saved filters (Later).

### Decisions (2026-10-15)

- **Global per user.** A saved filter belongs to the user, not to a mailbox: it is used with any mailbox (`--account` of `mm search`). No default account.
- **The saved part is the filter line only:** its terms and `--body`. `--sent`, `--folder`, `--order` and `--limit` stay options of `mm search`.
- **`--filter` combines (AND):** the saved terms, then the typed words, then `--body`. Typed words narrow a saved filter; they never replace its terms.
- **Names:** 1–40 of `a-z 0-9 - _`, not starting with `-` (a leading `-` would read as an option). Typed in any case, stored in lower case (`Big-Old` → `big-old`). Unique per user.
- **Replacing:** saving over an existing name needs `--replace`. `--replace` of a name that is not saved just saves it.
- **Not in M3c:** renaming, sharing, a per-mailbox default, `--sent` / folder / order inside a saved filter, saved filters in the app.

### Commands

```text
mm filter save <name> ["<filter>"] [--body <text>] [--replace]
mm filter list [--json]
mm filter show <name> [--json]
mm filter delete <name> [--yes]
mm search ["<filter>"] --filter <name> [--account <id>] [--folder <path>] [--sent] [--body <text>] …
```

| Command  | What it does                                                                                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save`   | Checks first, before any login: the name, the words, `--body` and the compiler, as `mm search` does. Then saves. Output: `Saved "big-old": older:1y larger:1mb` (`Replaced …` with `--replace`), then `Use it: mm search --filter big-old`. The line echoes what was typed, cleaned for the terminal. |
| `list`   | One line per filter, by name: the name, the day it last changed, the filter as a line. `--json`: `{ v: 1, filters: [{ name, line, body, readable, updated }], skipped }`. No filters: the text below, exit 0 (`--json` prints the empty object).                                                      |
| `show`   | `Name:`, `Filter:`, `Saved: <day>` with ` (changed <day>)` when the days differ, `Use it: mm search --filter <name>`. `--json`: `{ v: 1, name, line, body, readable, created, updated }`. A missing name exits 1.                                                                                     |
| `delete` | Prints `Filter: …`, then asks `Delete the saved filter "<name>"? Your mails are not touched.` (default no). Without a terminal and without `--yes` it refuses before any login. `No` prints `Nothing deleted.` (exit 0); yes prints `Deleted "<name>".`                                               |

Dates are the local day on this computer. Options are checked by a strict schema: an unknown one is refused with ``Unexpected options — see `mm filter --help`.``

`mm search --filter <name>` (see below) reads the saved filter after the login, like a typed line. Examples (also in `mm filter --help`):

- `mm filter save big-old "older:1y larger:1mb"`
- `mm filter save shop-mail "from:@shop.sk" --body invoice`
- `mm search --filter big-old --folder INBOX`
- `mm filter list`, `mm filter show big-old --json`, `mm filter delete big-old --yes`

### The line of a saved filter

A stored filter is shown as the line that parses back to it (`printFilterLine` in `src/core/filters/line.ts`). The printer prints the line, then parses it again and compares the result with the filter: it never shows a line that would mean something else. A `--body` term is printed last as `body:"…"`, and it is the only term the line cannot hold.

- `date:2023` prints as `since:2023-01-01 before:2024-01-01`; a size prints in the largest unit that divides it exactly (`larger:1mb`, `larger:1536kb`).
- A filter the line can't express — an OR of terms (`any`), a `not` of a term that has no `-` form (such as `seen`), or two `--body` terms — shows `(can't be shown as a line)`. It still works with `--filter`.
- A row whose stored `filter_json` the schema refuses shows `(can't be read)`; `search --filter` refuses it too.

### Texts

| What is wrong                                                                       | Text                                                                                                                       |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| a name that isn't 1–40 letters, digits, `-` or `_`, not starting with `-` (or none) | A filter name is 1–40 letters, digits, - or _, not starting with - (e.g. big-old).                                         |
| `save` with no filter and no `--body`                                               | Type the filter to save, e.g. mm filter save big-old "older:1y larger:1mb".                                                |
| the name is saved already, no `--replace`                                           | A filter named "big-old" is already saved — add --replace to overwrite it, or pick another name.                           |
| 200 saved filters, a new name                                                       | You have 200 saved filters, the most Mail Manager keeps — delete one first (mm filter delete <name>).                      |
| a name that isn't saved (`show`, `delete`, `search --filter`)                       | No saved filter named "big-old" — see `mm filter list`.                                                                    |
| a saved filter that can't be read, or has an empty group inside (`search --filter`) | The saved filter "big-old" can't be read — save it again with --replace, or delete it.                                     |
| a saved filter with no terms, also with typed words (`search --filter`)             | The saved filter "big-old" has no terms — save it again with --replace, or delete it.                                      |
| `list` with nothing saved                                                           | No saved filters yet — save one with mm filter save <name> "<filter>".                                                     |
| `delete` with no terminal and no `--yes`                                            | mm filter delete needs a terminal to confirm, or --yes                                                                     |
| an unknown `--option`, e.g. before the name                                         | Unknown option "--jsno" — see `mm filter save --help`.                                                                     |
| malformed rows, counted by `list` (`skipped`)                                       | `1 saved filter couldn't be read and is not shown.` (more than one: `N saved filters couldn't be read and are not shown.`) |
| the line, `--body` or the filter the compiler refuses                               | the texts of [the filter line](#the-filter-line) and of [`mm search`](#texts); `save` uses the same ones                   |

The filter lines of `save` are checked as in `mm search`: an unsupported word or a control character is refused before any login. A stored value printed by `list` and `show` is cleaned for the terminal first, as everywhere else.

### Limits

| Limit                  | Value                                                           | What happens                                                                    |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Name                   | 1–40 of `a-z 0-9 - _`, not starting with `-`, typed in any case | the name text, before any login                                                 |
| Saved filters per user | 200                                                             | the 201st new name: the limit text; `--replace` of an existing name still works |
| Stored filter          | a JSON object of at most 16 KB (DB check)                       | refused by the database                                                         |
| Rows read by `list`    | 1,000                                                           | rows beyond are not read                                                        |
| `--body`               | the `mm search` limit (200 characters)                          | the body text                                                                   |
| Words of the command   | 100 words, 1,000 characters each                                | refused as unexpected options                                                   |

The 200 limit is checked by the app, which counts the rows it reads (malformed ones too); the database does not count, because a user can only write their own rows.

### Failures

- A refused save or delete (duplicate, limit, not found) changes nothing: exit 1, no audit row.
- A database error (for example the migration not applied yet) gives the same text as the other commands that use the database (`RepoError`, `src/cli/error-text.ts`).
- A row whose filter the app can't read stays listed as `(can't be read)` and can be replaced (`save --replace`) or deleted.
- A row whose id, name or dates are malformed is not listed; `list` counts it in the note.

### `mm search --filter`

- Option `--filter <name>`: "a saved filter (mm filter list); the words and --body are added to it". Words, `--body`, the checks and their texts are those of M3b, except that the line may be empty when a filter is given.
- After the login, before the mailbox is picked: the saved filter is read. Unknown name → the not-found text, exit 1. Unreadable row, or a row with an empty group inside it (only possible in a row written outside the app) → `unreadableText`, exit 1. A saved filter with no terms at all → `emptySavedText`, exit 1, **also when words are typed** (the filter is refused as saved; save it again). No IMAP login happens before these checks, and no `search.finish` is written.
- The terms are the saved terms, then the typed ones, then `--body` (AND). The compiler checks the combined filter, so the schema's limit of 50 nodes (the root included) applies to the sum; over it, the unsupported text.
- The report's `Filter:` line shows the name and the saved line first: `Filter: big-old (larger:1mb) from:@shop.sk body:"x"`. A body term anywhere in the combined filter (saved or typed) gives the body warning. `--json` has `saved: "big-old"` (`null` without `--filter`).
- `search.finish` is written as before, with the criteria of the combined filter (names only).

### Logging

- `filter.save` and `filter.delete` ([LOGGING.md](../LOGGING.md#saved-filters-m3c)): once per save or delete that reached the database, with the filter's id, `replaced` (ok save only), `outcome` and `reason` on failure (`duplicate`, `not-found`, `limit`, `database`, `unexpected`).
- Audit rows (`audit_log`) on success only: `filter.save` with `{ filter, replaced }`, `filter.delete` with `{ filter }` (ids and a flag, see [DATA_MODEL.md](../DATA_MODEL.md)).
- Never in a log line or an audit row: the name, the terms, the body text. A canary test checks it.
- `mm search --filter` writes no new event.

### Acceptance criteria

- **(C1) Storage:** the migration `20261015132019_saved_filters.sql` is applied; the RLS live test (`tests/integration/supabase-rls.test.ts`, the `saved_filters` block) passes: the owner's rows only, server-set owner and timestamps, the forbidden columns refused, the name and size checks, the duplicate name per user. Passed 2026-10-15.
- **(C2) Printer:** `printFilterLine` round-trips every printable filter (tests in `m3c-spec-filter-print.test.ts`); a filter it can't express shows the text, never a wrong line.
- **(C3) Names and limit:** the name rule, the 200 limit, duplicate without `--replace`, `--replace` of a missing name, delete of a missing name (core tests with a fake repo).
- **(C4) Checks first:** every bad `mm filter` request gives its text and exits 1 before the Supabase session is read; `delete` without a terminal refuses before the login; `delete` with a "no" writes nothing.
- **(C5) Search:** `mm search --filter` combines the terms (AND), refuses unknown and unreadable names and empty filters before any IMAP login, and writes no `search.finish` for them.
- **(C6) Log and audit:** one `filter.save` / `filter.delete` event per save or delete that reached the database; one audit row per successful one; a canary test finds no name or value in any log line or audit row.
- **(C7) Help:** `mm --help` lists step 8, `mm filter save`.
- **(C8) The user:** `mm filter save big-old "older:1y larger:1mb"`, then `mm search --filter big-old --folder <mm-test path>` prints the same report as the typed `mm search "older:1y larger:1mb" --folder <mm-test path>`.
- **(C9) Gates:** typecheck, build and unit tests green; lint and format:check fail only on the baseline files.

### Verification

1. `npm run dev -- filter --help` lists `save`, `list`, `show`, `delete`; `npm run dev -- filter save "Bad Name" x; echo $?` prints the name text and `1`, without a login.
2. Once, live: `tests/integration/supabase-rls.test.ts` (the `saved_filters` block) and `npm run db:status` (the migration remote).
3. The user, in an external terminal: the three commands of (C8), and `mm filter list` / `show` / `delete` on the same name.

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

- **Internal date or Date header:** decided — received by default; `mm search --sent` checks the Date: header (M3b).
- **Server-defined matching:** subject, word and the plain words of `from:` are substring searches as the server implements them. The live test assumes Dovecot's case-insensitive substring match on the decoded header; a difference is reported, not loosened.
- **Body search** is slow or incomplete on some servers (M3b warns).
- **`cc`** is covered by unit tests only until the seed has a `Cc` (M3d).
- **Saved filters:** global per user, used with any mailbox (decided 2026-10-15, M3c).

## Logging

Events ([LOGGING.md](../LOGGING.md)):

- `search.finish` (M3a; M3b writes it once per run as well): `acct`, `count`, `bytes`, `ms`, `criteria` (the criterion names), `outcome`, `reason` on failure.
- `gmail.search-mismatch` (M3d): warn, counts only.
- `filter.save` / `filter.delete` (M3c): the filter id, `replaced` on save, `outcome`, `reason`; plus an `audit_log` row on success (ids only).

## Tasks

See `TODO.md` → M3.
