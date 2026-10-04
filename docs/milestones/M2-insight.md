# M2 — Mailbox insight

## Goal

Show the user what is in their mailbox and what takes up space — the core "aha" of the product. Read-only: nothing in M2 changes the mailbox.

## Split (2026-10-01)

Decided with the user: three parts, each shipped and reviewed on its own.

- **M2a — folder tree + `mm folders`** (plain output, `--json`): the read-only foundation.
- **M2b — interactive folder browser**: `mm folders` in a terminal opens a fullscreen browser; marks go into a local basket that M4 acts on. Split again (2026-10-01): **M2b-1** browser core (paging, basket, state reducer, renderer — no visible change) → **M2b-2** terminal (raw-mode loop, `mm folders` switch, reconnect, `browse.finish`).
- **M2c — `mm stats`**: sender/domain/year/largest aggregations, measured on a large mailbox. Split again (2026-10-02): **M2c-1** `mm stats` (read-only command) → **M2c-2** the user measures a large mailbox and decides on a local cache.

Shared decisions:

- **All folders are shown** (resolves the old "all folders or INBOX only?" question): the summary covers every folder; details per folder come later via `--folder` (M2c).
- Unsubscribed folders are shown too, tagged "(hidden)".
- The account id is optional when exactly one mailbox is saved (the output names the mailbox).
- The delete "double check" is a **local basket** (folder + UIDVALIDITY + UIDs, in memory) that feeds the M4 plan/confirm flow (confirmed 2026-10-01). A server-side review folder may come later in M4 as an opt-in mode only (see [M4](M4-safe-delete.md#design-notes)).
- The app shell (one long-running interactive program) comes after M3.
- One guarded login per command (`openAccountSession` / `withAccountSession` in `src/core/accounts.ts`), reused by M2a/M2b/M2c; a browser reconnect (M2b-2) is one more, started by the user.

## M2a — Folder tree + `mm folders` (read-only)

### In scope

- Core `src/core/mailbox/folders.ts` → `listFolders(session, { sizes, onProgress?, only?, batchSize? })`:
  - LIST of all folders (unsubscribed included, marked), `\NonExistent` dropped; at most 5,000 folders (`truncated` beyond that).
  - Role: `INBOX` from the path; otherwise special-use with its source (`extension` / `name` / `user`). `\Noselect` → not selectable, counts unknown.
  - Tree by the LIST delimiter: parent before child; INBOX first, then special-use folders, then by path. A child whose parent wasn't listed hangs under the nearest listed ancestor (no placeholders).
  - Counts (messages, unseen): LIST-STATUS when advertised, otherwise our own `STATUS` per folder (so the cap bounds the STATUS commands and progress is possible).
  - Size: `STATUS=SIZE` when the server returns it; otherwise read-only (EXAMINE) `FETCH (RFC822.SIZE)` in sequence-range batches of 5,000, streamed and summed (only running totals kept: memory doesn't grow with the message count); a sum that comes back short is not shown (size unknown, see the design notes). A missing `size` is treated as unsupported even if the capability is advertised. `sizeSource: 'server' | 'sum'`. A server size is shown as is; our own sum carries a "~" with a footer note "~ = added up from the message sizes" (decided 2026-10-01 after checking Websupport's STATUS=SIZE equals the exact byte sum of `mm-test`; RFC 8438 only promises ≥ the sum of RFC822.SIZE, so other servers may show a little more).
  - Quota via `GETQUOTA` when `QUOTA` is supported (`storage.usage` / `storage.limit`, bytes — imapflow converts KiB); otherwise — or when the server supports QUOTA but sets no limit (Websupport: the limit is on the hosting plan, mail + web + databases) — one text, "Quota: not available from the mail server" (decided 2026-10-01); the Total line already shows what the mailbox uses.
  - Gmail: total = `\All` + `\Trash` + `\Junk`; other selectable folders are labels, flagged "overlapping" and left out of the total; only `\All`/`\Trash`/`\Junk` are sized. No `\All` listed (hidden from IMAP) → totals unknown, with a hint to enable it.
  - One folder whose STATUS or size fails → its values are unknown ("—"); the listing continues and the footer counts them. `status.error` is never read or shown.
  - Failures after a successful login: `MailboxError` (`list-failed` | `connection-lost`), with its own texts — never the generic login text.
- `withAccountSession(deps, account, fn)` in `src/core/accounts.ts`: one guarded login → fn → logout.
- `mm folders [id] [--json] [--no-size]`:
  - no id: 0 mailboxes → "No mailboxes yet"; 1 → used and named ("Mailbox: …"); ≥2 → asks for an id and prints the account table (exit 1);
  - indented tree: role tag, messages, unread, size, "(hidden)" / "(overlapping)" / "(not selectable)"; totals + quota line;
  - progress (`Sizing folder 3/42 …`) on stderr, only when stderr is a terminal and not `--json`;
  - `--json`: one versioned object `{ v: 1, account, folders, totals, quota, truncated, unreadable }`; nothing else on stdout;
  - `--no-size`: no size fallback, no size column.
- Every server string (folder names, delimiter) goes through `sanitize` and is cut to 200 characters for display; JSON carries the sanitised name too.

### Design notes

- The CLI helpers `guarded`, `loggedIn`, `findAccount`, `checkRef`, `loginDeps`, `interactive`, `fail` moved unchanged from `commands/account.ts` to `src/cli/account-session.ts` (shared by `mm account` and `mm folders`), plus `pickAccount` (the 0/1/≥2 rule).
- `ImapClientLike` gains `list`, `status`, `getQuota`, `getMailboxLock`, `fetch` and `mailbox`, typed from imapflow. imapflow's d.ts names the quota field `used`; the code sets `usage` — we read `usage`.
- Subscription state: imapflow only ever sets `subscribed: true`; an unsubscribed folder comes back with it undefined, so only `true` counts as subscribed.
- Gmail roles count for totals only when the server reported them (`roleSource: 'extension'`): when Spam/Trash are hidden from IMAP, imapflow guesses roles from names, and a user label called "Spam" must not be summed. With All Mail hidden nothing is sized by the fallback (totals are unknown anyway).
- A folder left out of the LIST-STATUS reply is asked with its own STATUS. With more than 5,000 folders the totals say "(first 5,000 folders only)".
- The FETCH sum is all or nothing: when the FETCH returns fewer sizes than the folder has messages (a message without `RFC822.SIZE`, mail expunged by another client, or a range the server never answered — imapflow gives up on a throttled FETCH after 4 retries without an error and the range yields nothing), that folder's size is unknown ("—") and it counts in "could not be read"; its message and unread counts are still shown. A response counts only when its sequence number is inside the range asked for and wasn't counted in that range yet, so a repeated answer (imapflow reissues a throttled FETCH) is summed once and can't hide a missing message. A server `NO` for mail expunged while sizing gives the same result (M2-fix, C-028).
- STATUS always runs before any EXAMINE (never STATUS the selected folder, [IMAP.md §4](../IMAP.md#4-core-imap4rev1-commands-always-available)).
- `session.closed` is checked after LIST, after each STATUS and around each size fallback, so a dropped connection is never shown as a list of "—".
- The core logs nothing here: it returns the fallbacks it used and the CLI emits the events.
- `only` (core option, used by the live test): folders outside it keep their LIST data but are never STATUSed or sized; with it, LIST-STATUS is skipped so nothing outside is STATUSed.

### Logging

Events ([LOGGING.md](../LOGGING.md#mailbox-insight-m2a)):

- `folders.list` (`acct`, `folders`, `ms`, `outcome`, `reason?`) — once per `mm folders` run that got as far as an account.
- `imap.capability-fallback` (`feature`: `status-size` | `quota` | `list-status`; `fallback`: `fetch-size-sum` | `folder-sum` | `status-per-folder`) — at most once per feature per run, kind `app` (unlike the other `imap.*` events, which are security events).

Never logged: folder names, the address, host, counts per folder.

### Acceptance

- Counts match webmail; `mm-test` = manifest (150 messages, seen count, bytes); Gmail not double-counted; size-fallback memory bounded (batches of 5,000, running totals only).
- Unit tests (fake client) cover tree, roles, Gmail, size-fallback batches, quota missing, hostile names, folder cap, STATUS failure, connection loss.

### Verification

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`.
2. `npm run test:integration` once (live: only `mm-test` is STATUSed and sized).
3. Manual (external terminal): `npm run dev -- folders` → tree, compare counts with webmail; `… folders <id> --json | jq '.folders | length'`; `… folders <id> --no-size`; `npm run dev -- logs --since 10m` shows `folders.list` without names, address or host.

## M2b — Interactive folder browser (needs M2a)

A full-terminal view (like `less`/`htop`, inside the terminal — not a desktop or HTML app).

### In scope

- `mm folders` in a terminal (stdin and stdout a TTY, `TERM` not `dumb`) prints the M2a tree as before, then opens a fullscreen browser on the same session. `--plain` (new in M2b-2), `--json` or no TTY → the M2a output only, byte for byte. `--no-size` also hides the browser's folder size column.
- Keys: ↑/↓, PgUp/PgDn scroll; Enter opens a folder; Backspace/← back; Space marks a mail (on a folder: "only mails can be marked"); `a` marks/unmarks every mail on the screen; `q`/Esc quits — with marks it asks "Quit and drop N marks? (y/N)"; Ctrl+C (M2b-2) quits at once. Status bar: "marked: N mails, X MB" + key help; header: path + folder total.
- Folder view: subfolders first, then mails newest **arrived** first; mails loaded page by page (200, bounded cache) via read-only EXAMINE — opening never sets `\Seen`.
- Mail row: received date, from, subject, size + attachment marker — displayed only, never stored or logged.
- Basket: marks (folder + UIDVALIDITY + UID) in memory with a running count/size; M4 acts on it.
- Idle close → "Connection closed - reconnect? (y/N)" (one new guarded login, never automatic); N keeps browsing what is loaded ("Offline - showing what is loaded (r = reconnect)."): moving over rows that aren't loaded shows "not loaded (offline)" without asking again, only opening a folder whose mails aren't loaded asks; `r` reconnects while offline.
- After `q` / Ctrl+C one line on stdout: "Folder browser closed — nothing was changed on the server." or "Folder browser closed — 12 marks (4.1 MB) dropped, nothing was changed on the server." Exit 0 after `q`, 130 after Ctrl+C; an error → screen restored, its text, exit 1.

**M2b-1 — browser core (no visible change):** `src/core/mailbox/messages.ts` (`openFolder`, `loadPage`), `src/core/mailbox/basket.ts`, the pure state reducer `src/cli/browser/state.ts` and the pure renderer `src/cli/browser/render.ts` (+ `width.ts`), all unit-tested. No command changes behaviour.

**M2b-2 — terminal:** the raw-mode loop and the controller that runs the reducer's effects, `mm folders` TTY switch + `--plain`, alternate screen, resize, signals, reconnect login (challenge display), quit summary, `browse.finish`.

### Design notes

- **Own raw-mode loop on `node:readline`** (decided 2026-10-01, no new dependency) — replaces the earlier `@inquirer/core` idea: its inline renderer doesn't fit a full-height, resizable view, and the reconnect challenge would draw over it. Ink was rejected earlier as heavier.
- Alternate screen, always restored on exit, error or signal (M2b-2).
- **Arrival order**: mails newest arrived first = sequence numbers descending (cheap, bounded). Sorting by date/size stays in TODO "Later". The date shown is INTERNALDATE (when the server received the mail), which matches that order.
- **Snapshot paging**: a folder is paged by sequence number against a snapshot `{ path, uidValidity, exists }`; page `k` = sequences `max(1, n−200(k+1)+1) … n−200k`. Every `loadPage` takes the read-only lock and sends **NOOP before reading the snapshot** (imapflow's lock skips EXAMINE when the folder is already selected, and a non-UID FETCH may carry no EXPUNGE — without NOOP new or expunged mail would go unseen). NOOP brings EXISTS / EXPUNGE, not a UIDVALIDITY change: imapflow reads UIDVALIDITY only on SELECT/EXAMINE, so a reset folder is seen after a reconnect or after another folder was selected (M4 re-EXAMINEs before acting). A different count or UIDVALIDITY → `changed` (nothing fetched): the browser drops the loaded pages, keeps the marks (UID-based) and reloads page 0 with "Folder changed on the server - reloaded.".
- **UIDVALIDITY**: kept as a decimal string; missing → the folder counts as unavailable (marks would be unsafe). A UIDVALIDITY change clears that folder's marks and says how many.
- **Cache**: at most 5 pages (1,000 mails) of the open folder; loading a 6th evicts the loaded page farthest from the cursor that isn't on screen (a page on screen is never evicted, so no load→evict→load loop); an evicted page is reloaded when scrolled back to. Going back drops the folder's mails. One load in flight; a page that failed is marked failed (no automatic retry) until the folder is reopened or the connection is re-established.
- **Stale results**: every open/back/reconnect bumps a generation; a result for an older generation or another folder is ignored. The controller (M2b-2) starts effects in order without waiting and imapflow queues lock holders, so at most two requests overlap — harmless, the older result is dropped.
- **Attachment marker** `+`: any part with disposition `attachment`, a forwarded mail (`message/rfc822`), or a named part (`filename` / `name` parameter) that isn't an inline image — Apple Mail sends PDFs as `inline; filename=…`, while an inline image is usually a logo in an HTML mail; an iterative walk capped at 1,000 BODYSTRUCTURE nodes (server data). Marks are `[x]` / `[ ]` — ASCII, no ambiguous-width emoji.
- **Server strings** (`from`, `subject`) are capped at 500 code points in core; the renderer sanitises them (`sanitize`) and fits them to the width (wide/combining characters measured). Nothing is stored or logged.
- **Errors**: a folder that can't be opened (deleted/renamed elsewhere, refused) → `MailboxError('folder-unavailable')` — on a fresh open the browser goes back to the parent with a message, on a later page that page shows "couldn't load". A dropped connection → `connection-lost` → the reconnect question.
- **Gmail**: the same mail marked in a label folder and in All Mail counts twice in the basket totals — M4 de-duplicates by `X-GM-MSGID` before acting.
- **Busy folder**: a `changed` result moves the cursor back to the first mail (the loaded pages are gone). After 3 `changed` results in a row (mail arriving faster than a page loads) the browser stops reloading and says "This folder keeps changing on the server - reopen it to try again.".
- **Window too small** (below 40×8): only "Window too small - need at least 40x8" is shown ("Too small - need 40x8" below 37 columns, so it stays whole down to 21) and, while browsing, only quit acts — nothing can be marked unseen. A pending question is shown on the line below that text (`Drop N marks? (y/N)`, `Reconnect? (y/N)`, `Reconnecting...`), or in place of it when the window has only one row, so `q` / `y` / `r` always answer a visible question; at the reconnect question `r` counts as `y` even while the window is too small (M2b-2).
- **Width**: graphemes are measured code point by code point (CJK 2, non-spacing marks 0, spacing marks and everything else 1), so Indic conjuncts and spacing vowel signs never overflow. An emoji grapheme counts 2 plus the width of any non-emoji characters that joined it (spacing marks, extenders like U+FF9E, Prepend characters such as U+0D4E); its emoji parts (pictographs, ZWJ, variation selectors, regional indicators, keycap, tags) add nothing (M2b-2). A skin tone (U+1F3FB–1F3FF) adds nothing only directly after an emoji that takes one (thumbs up + tone = 2); anywhere else it counts 2, so a chain of tones — any number of them join one grapheme — is cut like any long text (M2-fix, C-028).
- **Sender column** (M2b-2): at least 8 columns wide; on a narrow screen the subject shrinks instead.
- **ASCII screen text** (decided with the user 2026-10-02): everything the browser draws itself is plain ASCII — `-` for unknown, `...` when text is cut, `Up/Down move`, `Left back`, `40x8` — because `—`, `…`, arrows and `×` take two columns in terminals set to "ambiguous = wide" (some CJK setups) and would overflow the line. Server text (names, senders, subjects) is shown as it is, measured by its real width.
- **Known limits** (display only, marks are UID-based and stay correct): one expunge plus one new mail between two page loads leaves the count unchanged, so neighbouring pages may show a mail twice or skip one until the next change.

**M2b-2 — terminal and controller:**

- **Terminal** (`src/cli/browser/terminal.ts`): raw mode on `process.stdin` (readline keypress events), then `ESC[?1049h ESC[?25l ESC[?7l ESC[2J` (alternate screen, cursor hidden, wrap off, clear). Each frame is one write: `ESC[H` + the lines joined by `\r\n`, every line prefixed with `ESC[2K` (erase the whole line, so a line drawn narrower than measured leaves no stale cells — not a trailing `ESC[K`, which with wrap off would erase the last cell); the cursor row in reverse video (`ESC[7m … ESC[27m`). A resize clears (`ESC[2J`) and redraws at the new size. `restore()` writes `ESC[0m ESC[?7h ESC[?25h ESC[?1049l`, turns raw mode off and pauses stdin — once; failing writes (a terminal gone after SIGHUP) are ignored. `close()` = restore + remove every listener.
- **Exit paths**: until `close()`, process hooks are prepended (they run before `runCli`'s own): `exit` restores the screen and logs `browse.finish`; an external SIGINT → exit 130, SIGTERM → exit 143, SIGHUP → exit 129; `uncaughtException` / `unhandledRejection` restore the screen before "Unexpected error" is printed. Raw mode turns Ctrl+C into a key, which the controller handles. On these exit paths nothing is logged out: the process ends synchronously and the sockets close with it.
- **Controller** (`src/cli/browser/controller.ts`): keys → reducer → one frame → effects. Loads run on the current session; results from a replaced session or after the end are dropped. Ctrl+C ends at once in every mode (also while reconnecting and while the window is too small). `r` reconnects while offline, counts as `y` at the reconnect question, cancels the quit question, and is ignored while reconnecting.
- **Session lifetime**: `openAccountSession` (`src/core/accounts.ts`) is the one guarded login with the saved password; the caller logs out (`withAccountSession` is built on it). In browser mode the listing's session stays open for the browser; a reconnect logs out the old session first, then makes one more `openAccountSession` call. The current session is logged out when the browser ends, also after an error. An idle close (5 minutes, no keep-alive) is noticed only when the next load is needed.
- **Reconnect texts**: the login guard's challenge wait is a status notice "Several wrong passwords - waiting 5 seconds before trying again." (not stderr, which would draw over the screen); a failed reconnect shows "Couldn't reconnect - showing what is loaded. Details after you quit." and after quit stderr gets "Reconnecting failed — " + the full login text (as `mm account test` prints it). A later successful reconnect clears it. No login starts after the browser ended (Ctrl+C during the old session's logout or the challenge wait).
- **Known limits** (M2b-2):
  - keys typed while the folders are listed reach the browser;
  - no Ctrl+Z suspend;
  - no keep-alive (the server closes an idle connection after about 5 minutes);
  - a half-open connection (e.g. after laptop sleep) leaves a load on "Loading..." until imapflow's 5-minute socket timeout — `q` / Ctrl+C still work;
  - `TERM=dumb` gets the plain output;
  - a held `r` (or a quick second `r`) after a failed reconnect starts another login. Keys are ignored while a login runs, and the login guard bounds the rest: 2 quick failures, then a 5-second wait before each try, then the mailbox locks for 15 minutes after 5 failures;
  - the width table can overestimate (e.g. `❤️` counts 2, some terminals draw 1); each frame line is erased first, so a short line leaves no stale cells;
  - offline, a folder's `not loaded (offline)` line shows below its subfolders only when they leave a free line in the body; when the subfolders fill the body, only the status line says the browser is offline.

### Logging

`browse.finish` (M2b-2, app log, info / warn when failed): `acct`, `folders` (opened with Enter), `mails` (loaded), `marked`, `bytes` (known sizes of the marked mails), `reconnects`, `ms`, `outcome` (`ok` = `q`; `interrupted` = Ctrl+C or an exit hook with 130 / 129 / 143; `failed` = an error in the browser or an exit hook with any other code), `reason?` (failed only). Once per browser run, before `command.finish`; none when the browser never opened. After SIGTERM / SIGHUP it says `interrupted` while `command.finish` says `failed (exit 143/129)` — intended (see `docs/LOGGING.md`). Catalog + canary test. M2b-1 adds no events; the new `folder-unavailable` code is an allowlisted account failure reason (`ACCOUNT_FAILURE_REASONS`, `docs/LOGGING.md`). No names, subjects or addresses.

### Acceptance / verification

- **M2b-1:** unit tests for the messages core (fake client: paging ranges, newest first, changed folder, open failure, connection drop, read-only lock), basket, reducer (navigation, paging/eviction, marks, UIDVALIDITY change, quit confirm, reconnect states) and renderer (widths, truncation, sanitising, too small); lint, typecheck, tests, build, format:check green; no command changes behaviour.
- **M2b-2:** unit tests for the terminal (fake streams and process: escape sequences, raw mode, idempotent restore, signal/exit/crash hooks, listeners removed), the controller (fake terminal and sessions: loads, stale results, reconnect y/N/failure/challenge, `r`, Ctrl+C in every mode) and `mm folders` (TTY → tree + browser + summary + exit codes + `browse.finish` before `command.finish`; `--plain`, `--json`, no TTY, `TERM=dumb` → the M2a output, terminal never opened); lint, typecheck, tests, build, format:check green; a pty smoke run (fake session) shows the screen and the tty modes restored after `q` and Ctrl+C.
- **M2b-2 manual walk** (external terminal, test mailbox; live logins rationed):
  1. `npm run dev -- folders`: tree, then the browser. Open INBOX and `mm-test`, scroll, `a`, Space, resize the window (also below 40×8 and back), `q` → `y` → summary, terminal normal.
  2. Again, Ctrl+C in the browser → summary, `echo $?` = 130.
  3. Again, `kill -TERM <pid>` from another terminal → terminal normal, exit 143.
  4. Leave the browser idle > 5 min, then scroll to an unloaded page or open a folder → reconnect question → `y` → loads.
  5. Webmail: the mails shown are still unread.
  6. `npm run dev -- logs --since 15m` → `folder browser: …` lines, no names.
  7. `npm run dev -- folders --plain` and `… | cat` → the M2a output.

## M2c — `mm stats` (needs M2a)

Split (2026-10-02, with the user): **M2c-1** builds `mm stats`; **M2c-2** is the user's measurement on a large mailbox and the local-cache decision. Decisions: a full per-folder table; Trash/Spam included in every stat; `--folder` takes the full path only (2026-10-03; the error points to `mm folders --json`) — the real path, or the path as `mm folders --json` / `mm stats --json` print it (M2-fix amendment, C-028; see the Scope note below).

### M2c-1 — In scope

- Shared scan helper `scanFolder(session, path, query, onMessage, opts?)` in `src/core/mailbox/scan.ts`: read-only lock (EXAMINE), sequence ranges of 5,000 (`SIZE_BATCH`, `sizeRanges` moved here, re-exported from `folders.ts`), every message streamed to a callback with its range; progress once per range. M2a's size fallback runs on it unchanged.
- Core `src/core/mailbox/stats.ts`, one streaming pass of `FETCH (ENVELOPE INTERNALDATE RFC822.SIZE)` (no UID, no flags, no body — nothing sets `\Seen`):
  - `statsScope(tree, gmail, folder?, displayPath?)` — which folders are read, and how many are "not scanned";
  - `createStatsAggregator({ timeZone, maxKeys?, topN? })` — totals, per folder, per year, top 10 senders and domains by count and by size, the 10 largest mails;
  - `collectStats(session, tree, { folder?, timeZone, onProgress?, displayPath? })` — the scan over the scope.
- `mm stats [id] [--folder <path>] [--json]` (`src/cli/commands/stats.ts`, text/JSON in `src/cli/stats-text.ts`): id optional with one saved mailbox; one guarded login; LIST + quota only (no STATUS); progress `Reading folder 3/12 … 5000/12345 messages` on stderr (terminal only, not with `--json`).
- New mailbox codes `folder-not-found` and `gmail-all-hidden`, each with its own text.

### M2c-1 — Design notes

- **Scope.** Without `--folder`: every selectable folder in tree order, Trash/Spam/Junk included. A server-reported `\All` / `\Flagged` (`roleSource: 'extension'`) outside Gmail is a virtual view of other folders' mail and is skipped (a folder merely _named_ "All" is read). Gmail: only All Mail + Trash + Spam (the folders M2a sums; labels are in All Mail, so nothing is counted twice without a per-message id set); All Mail hidden from IMAP → `gmail-all-hidden` (hint: show it in IMAP, or use `--folder`). Skipped selectable folders are counted in a "Not scanned" line. With `--folder`: (1) the folder with exactly that path; (2) INBOX in any case; (3) otherwise the one folder whose path as `mm folders --json` / `mm stats --json` print it (sanitised: invisible characters such as a soft hyphen, ZWNJ or ZWJ removed) equals the value — the core takes that display function as a parameter (`displayPath`), the CLI passes `sanitize`; none, or more than one → `folder-not-found` (also for `\Noselect`, a short name, or a folder past the 5,000-folder cap inherited from M2a — the first line then says "first 5,000 folders only"). On Gmail any listed folder may be named, a label too. Known limit: of two folders that differ only in invisible characters, the one whose real path is the plain text is reachable (the exact path wins), the other is not; when both carry invisible characters, neither is reachable by its printed path (M2-fix, C-028).
- **FETCH filter.** A response counts only when its sequence number is inside the range asked for, wasn't seen in that range yet (a set of at most one batch) and carries a stats field: unsolicited FETCH responses (e.g. another client changing flags) are ignored.
- **Failures per folder.** A folder that fails before any message (EXAMINE refused) is "unreadable" (`—`); one that fails after some messages (e.g. a server `NO [EXPUNGEISSUED]` for mail expunged during the scan) is "partial" and keeps what was counted. A scan that ends **without** an error but with fewer messages counted (after the FETCH filter) than the folder holds (the count from EXAMINE) is marked the same way — partial, or unreadable when nothing was counted: imapflow gives up on a throttled FETCH after 4 retries without an error and that range yields nothing; mail expunged by another client that the server silently leaves out counts too (any shortfall, no threshold) (M2-fix, C-028). The scan goes on with the next folder. A dropped connection ends the run (`connection-lost`); an exception in the aggregation itself is a bug and surfaces as "Unexpected error", never as an unreadable folder. Mail that arrives during a long scan is not counted (the folder's message count is taken once, at EXAMINE); mail that goes during it usually leaves the folder partial — the report says sizes are approximate.
- **Aggregation.** Sender key = the first From address, trimmed, lowercased, cut to 320 characters; none → "(no address)"; domain = after the last `@`. At most 50,000 distinct senders and 50,000 domains are kept (exact up to there); later new ones go to "others" and the lists say "(approximate)". The 10 largest mails are kept as a sorted list (ties: first seen); a mail without a size counts 1 message and 0 bytes and never enters it. No per-message list is kept: memory is bounded by the caps.
- **Time zone.** Years come from INTERNALDATE in the computer's time zone (the core takes the zone as a parameter; an invalid one falls back to UTC); outside 1900–2200 or missing → "unknown", listed last. The largest-mail dates use the same zone.
- **Text.** Sections: the "Scanned N folders, M messages, X — sizes are approx. (message sizes, not the quota)" line (+ unreadable / partial / truncation notes, "Not scanned"), the folder table (full path; `—` unreadable, `(partial)`), PER YEAR, TOP SENDERS / DOMAINS BY MESSAGES / BY SIZE (keys cut to 60 characters; `others` row, and `(approximate)` per list — only on a list whose own map overflowed, so 60,000 senders across 300 domains mark the sender lists only; a null key is `(no address)` in the sender lists and `(no domain)` in the domain lists, e.g. for a sender without `@`), LARGEST MAILS (date — `-` when unknown or outside 1900–2200 in the time zone, like PER YEAR —, size, sender trimmed and cut to 40 or `(no address)`, subject cut to 80, folder), then the quota line for a whole-mailbox run. Empty sections print `(none)`. Server strings are sanitised and cut.
- **JSON.** `{ v: 1, account, scope: { folder, gmail }, folders, notScanned, totals, years, senders, domains, largest, approximate, unreadable, partial, truncated, quota }`; `received` is ISO UTC or null; `quota` is null with `--folder`; strings sanitised (paths not cut, so they can be passed to `--folder`).
- **Ctrl+C** ends the process (exit 130) and the session with it; nothing is resumed.

### M2c-1 — Known limits

- Ctrl+C mid-scan leaves the progress line on stderr (as in `mm folders`; there is no exit hook).
- A run where every folder fails still prints the report, with "N folders couldn't be read", and exits 0.
- A server that splits one message's data over several FETCH responses would have that message counted under year `unknown` and `(no address)` (totals stay right); no mainstream server is known to do this.
- Sanitising removes control and bidi characters, so two different server strings (folder paths, senders, subjects) can look alike in the output.
- The text cuts senders and domains at 60 characters, so two long keys sharing a 59-character prefix can look the same there (the JSON keeps them whole).

### M2c-1 — Logging

`stats.finish` (app log, info / warn when failed): `acct`, `folders` (rows scanned), `messages`, `bytes`, `ms`, `outcome` (`ok` / `failed`), `reason?` (failed only). Once per run that got as far as an account, before `command.finish`; on failure the counts are 0. Nothing on Ctrl+C (`command.finish` says interrupted). No `imap.capability-fallback`: the listing skips STATUS, so its fallback flags don't describe a sizing path. Catalog ([LOGGING.md](../LOGGING.md#mailbox-stats-m2c-1)) + canary test. Never logged: folder names, senders, domains, subjects, addresses, the host.

### M2c-1 — Acceptance / verification

- `mm-test` = manifest (150 messages, bytes, per year, per domain); Gmail not double-counted; memory bounded (no per-message list); `mm stats --json | jq` parses.
- Unit tests: `mailbox-scan` (ranges, streaming, lock release, progress), `mailbox-stats` (aggregator, scope, collect over a fake session, the memory stand-in), `cli-stats` (text, JSON, `--folder`, errors, progress, log canary).
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`.
- `npm run test:integration` once with the live env: `stats-live` (one login; `collectStats` over `mm-test` in UTC = manifest).
- Manual (the user, test mailbox): `npm run dev -- stats`, `… stats --folder <mm-test path> --json | jq .totals`, then `npm run dev -- logs --since 15m` → `mailbox stats: …` without names.

### M2c-2 — Measure (the user)

- Run `mm stats` on a large mailbox (≥ 100k messages): time and memory.
- If too slow, a local metadata cache (SQLite) becomes a candidate (TODO "Later").

## Tasks

See `TODO.md` → M2.
