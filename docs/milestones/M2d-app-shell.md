# M2d — App shell: plain `mm` opens the app

## Goal

Plain `mm` in a terminal opens a full-screen app (the `mm folders` kind of screen) instead of printing the help: sign in, pick a mailbox, see what is in it. The commands stay for scripts; the app is the way in for people who don't want to learn them.

## Decisions (2026-10-04)

Pulled ahead of M3 with the user (was "Later: app shell, after M3").

- Plain `mm` in a terminal opens the app. **Every existing command stays as it is** (scripts, `--json`, tests).
- The first page is **sign in**. No account creation and no password reset in the app (signup is invite-only, see [M1](M1-auth-accounts.md)).
- "Remembered" = the signed-in user continues without a password until Log out, and the e-mail addresses of earlier sign-ins stay in a local list — addresses only, no passwords, no extra tokens.
- Stats are read **automatically** when a mailbox opens (M2d-3), then measured (CPU, memory, time); if that slows things down they become on demand.
- Screen text stays plain ASCII (decided for the browser on 2026-10-02, C-024).
- Not in the app for now: test login, change password, remove mailbox, doctor, discover — they stay commands.
- Five slices, each planned, built and reviewed on its own. M2d-1 is one assignment (it touches sign-in and stores a new local file).

## Slices

- **M2d-1 — App frame, sign-in page, Home** (detailed below; C-030).
- **M2d-2 — Mailbox screen** (detailed below; C-031): Enter on a mailbox → one guarded login, "Reading folders... n/m", the folders with a usage bar (share of the summed mailbox size), percent, size and messages; quota line; Enter on a folder opens the M2b browser inside the app. The bars are not shown in `mm folders` (decided 2026-10-05): that command is unchanged.
- **M2d-3 — Stats screen** (detailed below; C-032): years, top senders, top domains, largest mails, read in the background on a second guarded login when a mailbox opens.
- **M2d-4 — Add a mailbox in the app** (detailed below; C-032): the `mm account add` flow as full-screen steps.
- **M2d-5 — Logs screen** (detailed below; C-032): the `mm logs` report as a scrollable page.

M2d-3, M2d-5 and M2d-4 were planned and built as one assignment, in that order (decided 2026-10-07: the three share the app's state, renderer and controller, so they can't be built side by side).

## Screens

```text
Sign in ──► Home ──┬──► Mailbox (usage bars, totals, quota) ──┬──► Mails (the M2b browser)
                   │                                           └──► Stats
                   ├──► Add a mailbox
                   └──► Logs
```

Every screen is one frame: a header line, the body, a status line (questions and messages) and a key help line. The sign-in list, the sign-in form (after "Sign in as another user" and a wrong password) and Home (M2d-1) at 72 columns, empty body lines left out:

```text
Mail Manager <version>                                           Sign in
    anna@example-test-domain.eu                              signed in
    ben@example-test-domain.eu
    Sign in as another user

Up/Down move  Enter choose  f forget  q quit
```

```text
Mail Manager <version>                                           Sign in
    E-mail:    dana@example-test-domain.eu
    Password:  (nothing is shown while you type)

Wrong e-mail or password - try again.
Enter sign in  Tab switch field  Esc back  Ctrl+C quit
```

```text
Mail Manager - anna@example-test-domain.eu                   2 mailboxes
    anna@example-test-domain.eu       Gmail   checked 2026-10-03 18:22
    office@example-test-domain.eu     Custom  checked 2026-09-30 09:05
    + Add a mailbox
    Logs
    Log out

Up/Down move  Enter open  Esc back  q quit
```

The mailbox screen (M2d-2) while it opens, with its folders, with one folder that couldn't be read, and after a failed read:

```text
Mail Manager - anna@example-test-domain.eu

Reading folders... 2/5
Esc back  q quit
```

```text
Mail Manager - anna@example-test-domain.eu                    tree order
Total: 12545 messages, 37 unread, 950.0 MB
Quota: [#####.....] 46%  950.0 MB of 2.0 GB
    INBOX                            [######....]  64%  612.0 MB  8210
    Archive                                                    -     -
      2023                           [###.......]  25%  240.0 MB  3100
    Sent                             [#.........]  10%   96.0 MB  1204
    Trash                            [#.........]  <1%    2.0 MB    31
    Old lists (hidden)               [..........]   0%       0 B     0

Up/Down move  Enter open  o sort  Esc back  q quit
```

```text
Mail Manager - anna@example-test-domain.eu                    tree order
Total: - messages, - unread, -, 1 folder couldn't be read
Quota: [#####.....] 46%  950.0 MB of 2.0 GB
    INBOX                                               612.0 MB  8210
    Archive                                                    -     -
      2023                                              240.0 MB  3100
    Sent                                                 96.0 MB  1204
    Trash                                                 2.0 MB    31
    Old lists (hidden)                                         -     -

Up/Down move  Enter open  o sort  Esc back  q quit
```

```text
Mail Manager - anna@example-test-domain.eu
    The connection to the mail server was lost while reading folders -
    try again.

r try again  Esc back  q quit
```

Inside a folder the frame is the M2b browser's own (as in `mm folders`), with `Esc/Left back` in its key help. With a filter on (M3a) the mail list has a filter row under the header, and the header counts the matches — an example:

```text
me@example-test-domain.eu / INBOX        37 of 4521 mails, 48.2 MB
Filter: shop.sk older:1y larger:1mb                  newest first
[ ] 2023-03-02  Shop.sk   Faktura 2023-118              1.4 MB +
```

The filter line, its syntax, the order and the marks are described in [M3 — Filters & search](M3-filters-search.md).

The bars while the stats are read (M2d-3; afterwards the status line says `Stats ready - press s`), and the stats screen — years, top senders, largest mails:

```text
Mail Manager - anna@example-test-domain.eu                    tree order
Total: 12545 messages, 37 unread, 950.0 MB
Quota: [#####.....] 46%  950.0 MB of 2.0 GB
    INBOX                            [######....]  64%  612.0 MB  8210
    Archive                          [###.......]  25%  240.0 MB  3100
    Sent                             [#.........]  10%   96.0 MB  1204
    Trash                            [#.........]  <1%    2.0 MB    31

Stats: reading folder 3/4 - 5000/12545 messages
Up/Down move  Enter open  o sort  s stats  Esc back  q quit
```

```text
Mail Manager - anna@example-test-domain.eu               Years - by size
Scanned 4 folders, 12545 messages, 950.0 MB (approx.)
    2024                             [####......]  40%  379.0 MB  5040
    2023                             [###.......]  35%  330.0 MB  4400
    2022                             [###.......]  25%  240.0 MB  3100
    unknown                          [#.........]  <1%    1.0 MB     5

1-4 section  o size/messages  r read again  Esc back  q quit
```

```text
Mail Manager - anna@example-test-... Top senders - by size (approximate)
Scanned 4 folders, 12545 messages, 950.0 MB (approx.)
    ben@example-test-domain.eu                          301.0 MB   610
    news@example-test-domain.eu                          88.0 MB  2140
    (no address)                                          1.0 MB     5
    others                                              560.0 MB  9790

1-4 section  o size/messages  r read again  Esc back  q quit
```

```text
Mail Manager - anna@example-test-domain.eu                 Largest mails
Scanned 4 folders, 12545 messages, 950.0 MB (approx.)
    24.0 MB  2024-03-14  Ben Example - Photos from the trip (INBOX)
    18.0 MB  2022-11-02  Office - Scanned contract (Archive)
     9.0 MB  -           (no address) - (no subject) (Sent)

1-4 section  o size/messages  r read again  Esc back  q quit
```

The logs screen (M2d-5), and with both filters on over 7 days:

```text
Mail Manager - Logs                                                 24 h
--- 2026-10-07 ---
18:20:11  account add   mailbox login (websupport)
18:20:12  account add   mailbox added (websupport)
18:20:12  account add   finished in 6.2 s
--- 2026-10-08 ---
09:14:40  app           started
09:14:41  app           Mail Manager login
09:14:55  app           mailbox login (websupport)
09:14:56  app           server reports no quota - quota not available
09:14:58  app           mailbox stats: 12 folders, 7447 messages read in
          1.1 s

1 24 h  2 7 days  3 30 days  s security  w warnings  Esc back  q quit
```

```text
Mail Manager - Logs                         7 days - security - warnings
No log lines in the last 7 days.

1 24 h  2 7 days  3 30 days  s security  w warnings  Esc back  q quit
```

Add a mailbox (M2d-4): the address, what was found, a server from an unsigned DNS record, nothing found, the provider list, the password, and Home afterwards:

```text
Mail Manager - Add a mailbox
    E-mail of the mailbox: dana@example-test-domain.eu_

Enter next  Esc back  Ctrl+C quit
```

```text
Mail Manager - Add a mailbox
    Provider:  Websupport
    Server:    imap.example-test-domain.eu:993 (TLS)
    Username:  dana@example-test-domain.eu
    Found via: built-in preset (email domain)
    Hint:      Log in with your full address.
    Help:      https://help.example-test-domain.eu/imap

Enter use these  c provider list  m enter server  Esc back  q quit
```

```text
Mail Manager - Add a mailbox
    Server:    imap.elsewhere-test-domain.eu:993 (TLS)
    Username:  dana@example-test-domain.eu
    Found via: DNS SRV record - _imaps._tcp.example-test-domain.eu
! The username is a guess (full email address); SRV records do not
  specify it.
! Warning: this server is not under example-test-domain.eu and comes
  from an unsigned DNS record, which someone on your network could fake.
  Only continue if you know your provider uses
  imap.elsewhere-test-domain.eu.

y use this server  c provider list  m enter server  Esc back  q quit
```

```text
Mail Manager - Add a mailbox
    No IMAP settings found for example-test-domain.eu.
    Tried:     built-in preset (email domain): no known provider
    Tried:     built-in preset (MX record): nothing found
    Tried:     Mozilla ISPDB: nothing found
    Tried:     the domain's autoconfig file: nothing found
    Tried:     DNS SRV record: nothing found

c provider list  m enter server  Up/Down scroll  Esc back  q quit
```

```text
Mail Manager - Add a mailbox
    Slovakia / Czechia
      Active24
      Atlas.cz
      Atlas.sk
      Azet (unverified)
      Centrum.cz
      ...

Up/Down move  Enter choose  m enter server  Esc back  q quit
```

```text
Mail Manager - Add a mailbox
    Provider:  Websupport
    Server:    imap.example-test-domain.eu:993 (TLS)
    Username:  dana@example-test-domain.eu
    Hint:      Log in with your full address.

    Password:  (nothing is shown while you type)

Enter add mailbox  Esc back  Ctrl+C quit
```

```text
Mail Manager - anna@example-test-domain.eu                   2 mailboxes
    anna@example-test-domain.eu               Gmail / Google Workspace
    dana@example-test-domain.eu               Websupport
    + Add a mailbox
    Logs
    Log out

Added dana@example-test-domain.eu.
Up/Down move  Enter open  Esc back  q quit
```

These frames are printed by the renderer (72 columns; empty body lines and, in the provider list, the rows after the fifth left out).

## Keys

- **Everywhere:** Esc = one screen back (Left too on Home and the later screens); `q` quits (from M2d-2 on it asks first when mails are marked); Ctrl+C ends at once (exit code 130).
- **Lists:** Up / Down, PgUp / PgDn move; Enter chooses or opens.
- **Sign-in list:** `f` forgets a remembered address; it is the first screen, so Esc quits like `q`.
- **Text fields:** a typed character goes to the active field, so `q` is a letter there; Backspace removes the last character; Ctrl+U empties the field; Tab / Up / Down switch field; Enter = next field, or sign in on the password field; Esc goes back to the list and drops what was typed.
- **Questions** `(y/N)`: `y` = yes, any other key = no.
- **Something couldn't be reached or loaded:** `r` tries again.
- **Home:** Esc / Left / Backspace go back to the sign-in page without signing out.
- **Mailbox screen (M2d-2):** Enter opens the folder under the cursor; `o` changes the order (tree → size → name); Esc / Left / Backspace go back to Home and log out of the mailbox (with marks: `Drop N marks? (y/N)` first); `q` quits (with marks: `Quit and drop N marks? (y/N)`); `r` on the failed screen logs in and reads again.
- **Stats screen (M2d-3):** `s` on the bars opens it; `1` years, `2` top senders, `3` top domains, `4` largest mails; `o` switches by size / by messages (not in Largest mails); Up / Down, PgUp / PgDn scroll; `r` reads again when no read is running; Esc / Left / Backspace go back to the bars (a read goes on); `q` quits (with marks it asks first).
- **Logs screen (M2d-5):** Up / PgUp scroll towards older lines, Down / PgDn back; `1` 24 h, `2` 7 days, `3` 30 days; `s` security lines only on / off; `w` warnings and errors only on / off; `r` reads again; Esc / Left / Backspace go back to Home; `q` quits.
- **Add a mailbox (M2d-4):** Esc goes one step back, from the address field to Home; in a step without a field Left and Backspace do the same and `q` quits, in a field `q` is a letter. What was found: Enter uses it (`y` for a server from an unsigned DNS record), `c` opens the provider list, `m` the server fields. While "Checking the login..." only Ctrl+C acts.
- **Inside a folder (M2d-2):** the keys of the `mm folders` browser — Space marks, `a` marks the screen, Enter opens a subfolder, `r` reconnects when offline — except that Esc goes back like Left and Backspace instead of quitting: one level up, and from the folder that was opened on the bars back to the bars.
- **Mail list (M3a, inside a folder):** `/` filters the mails — the filter line opens, Enter applies it, Esc cancels the edit, Ctrl+U empties it; `o` orders the mails newest → oldest → largest → newest (on the bars `o` still orders the folders); `m` marks every match, or unmarks them when all are marked already. **Esc / Left: clears a filter or an order first**, back to the plain list; the next Esc goes back as before. The filter syntax is in [M3 — Filters & search](M3-filters-search.md#the-filter-line).

## M2d-1 — App frame, sign-in page, Home

Implemented 2026-10-05 (C-030, reviewed 2026-10-05); the manual walk (Verification, step 3) is still open — the user.

### In scope

- **Entry.** Plain `mm` with stdin and stdout a terminal (`TERM` not `dumb`) runs the new `mm app` command. Without a terminal plain `mm` prints the help as today (exit 1, nothing logged). `mm app` without a terminal → "mm app needs a terminal — run it in a terminal window, or use the commands in `mm --help`.", exit 1; the screen is never opened and Mail Manager is not contacted. `mm --help` lists `app` and says that plain `mm` opens it. An unknown command, `--help` and `--version` behave as today.
- **Remembered users**, core `src/core/remembered-users.ts`: the e-mail addresses of earlier sign-ins in `<config dir>/users.json` as `{"v":1,"emails":[...]}` — directory 700, file 600, written through a temp file + rename; at most 10, newest first, no duplicates; `list` / `add` / `remove`. Never passwords or tokens.
- **App frame** `src/cli/app/`: pure state reducers (sign-in, Home) + a pure renderer + a controller on the M2b terminal (`src/cli/browser/terminal.ts`, unchanged); typed and hidden input fields; resize; "Window too small" below 40x8; the screen is given back on quit, signals and crashes.
- **Sign-in page.** Rows: the signed-in user, tagged `signed in` (Enter continues without a password); the remembered addresses (Enter → password only); `Sign in as another user` (e-mail + password). Nobody signed in and nothing remembered → the form opens directly (Esc there shows the list with the single row `Sign in`).
  - Nothing typed into the password field is shown, not even its length: the line always reads `(nothing is shown while you type)`.
  - Wrong e-mail or password → "Wrong e-mail or password - try again." (the e-mail stays, the password field is empty again). Mail Manager unreachable → "Can't reach Mail Manager - check your internet connection and try again."; anything else → "Signing in didn't work - try again later.".
  - Choosing another row while a user is signed in asks `Sign out <e-mail> first? (y/N)` and revokes that session before the form opens.
  - `f` on a remembered address asks `Forget <e-mail>? (y/N)`; on the signed-in one: "Log out first to forget this address.".
  - The sign-in check failing because Mail Manager can't be reached shows the unreachable message; `r` checks again.
- **Home.** Header `Mail Manager - <e-mail>` + the mailbox count. One row per mailbox (e-mail, provider, `checked <YYYY-MM-DD HH:MM>` or `checked never`), then `+ Add a mailbox`, `Logs`, `Log out`. No mailboxes → "No mailboxes yet - add your first one." with the cursor on `+ Add a mailbox`. "Loading your mailboxes..." until the list arrives; "Couldn't load your mailboxes - check your internet connection (r = try again)." when it doesn't; a sign-in that ended meanwhile → back to the sign-in page with "Your sign-in has ended - sign in again.". `Log out` revokes the session and returns to the sign-in page (the address stays remembered). In M2d-1 the mailbox, Add and Logs rows showed a "Coming in a next step" hint; Enter on a mailbox opens it since M2d-2, and the Add and Logs rows open their screens since M2d-4 / M2d-5 (the hints are gone).

### Out of scope

- Opening a mailbox, the usage bars and the mail browser (M2d-2); stats (M2d-3); adding a mailbox in the app (M2d-4); the logs screen (M2d-5).
- Any change to `mm login`, `mm logout`, `mm whoami` or another command. `mm login` does not write `users.json`: the app remembers the signed-in user when it checks the session.
- A new log event; a local rate limit for Mail Manager sign-ins (Supabase limits them); create-account, forgot-password, MFA.
- Cursor movement inside a text field, mouse support, colours.

### Design notes

- **Default command**: `runCli` rewrites the argv before parsing (`withDefaultCommand`: `[..., 'app']` only when interactive **and** no argument follows the program name). A commander root action was probed and rejected: it turns `mm nosuchcmd` into "too many arguments" instead of "unknown command".
- **Reducers and effects**, as in the browser: a pure reducer returns `{ state, effects }`; the controller runs the effects and dispatches their results. Every request (session check, sign-in, sign-out, mailbox list) carries a `generation`; a result for an older generation, or one that arrives after the app ended, changes nothing — so Esc on Home while the mailboxes load simply drops the late list.
- **The password** exists only in the active form field, then in the one sign-in effect and the `auth.login` call. Submitting empties the field; no state object and no controller variable keeps it afterwards. No frame ever contains it, a part of it, or anything that depends on its length. It is sent as typed (leading and trailing spaces kept); the e-mail is trimmed.
- **Remembered addresses** are stored in the form the log target uses (`authEmailTarget`): the name before `@` lower-cased, the domain lower-case ASCII (an international domain in its `xn--` form). Only the address of a user who really signed in is added — never what was typed into a failed sign-in — and text that isn't an address is ignored. The signed-in user's address is also added when the app checks the session, so a user who signed in with `mm login` is still listed after Log out; a user without an e-mail is shown as `(no e-mail)` and not remembered.
- **`users.json` is untrusted input** (it can be edited by hand): a missing, unreadable, corrupt, wrong-version or wrong-shape file is an empty list (more than 100 entries, an entry longer than 320 characters or one that isn't text count as wrong shape); entries that aren't addresses are dropped; at most 10 are shown; everything drawn goes through `sanitize()`. Reading never rewrites the file; the next `add` writes it clean. The file is deleted when the last address is removed.
- **A write that fails never fails a sign-in**: `add` and `remove` swallow every error (the address just isn't remembered, no message). Like `session.json`, every write sets the directory to 700 first — so a config directory the user owns but made read-only is writable again and the address is remembered; only a place that really can't be written (another owner, a read-only disk) loses it.
- **Sign-in page rows**: the signed-in user first (shown as Mail Manager gave the address), then every remembered address that isn't that user, then the last row (`Sign in` when there is nobody else to show). Two addresses are the same user when their stored forms are equal (`normalizeEmail` in `src/core/remembered-users.ts`): letter case doesn't matter, nor whether an international domain is written in Unicode or as `xn--` — so the entry the app itself adds at the session check never becomes a second row. Text that isn't an address is compared without letter case.
- **Switch user**: the old session is revoked first, then the form opens. If the new sign-in fails, nobody is signed in; the old user stays in the list as a remembered row.
- **Home rows at 40 columns**: the right cell is chosen once per frame, the same for every row — provider + "checked ...", else provider only, else nothing — so the e-mail keeps up to 24 columns uncut. A longer address is cut with `...`. Provider names and the "checked ..." texts are padded to the widest one of the frame (the fit is computed with the padded width), so the columns line up when one mailbox says `checked never`.
- **Home messages**: a key clears the message. While the list couldn't be loaded, its message is the one that stays: another message replaces it for one key, then it is back (with `r try again` in the key help all along).
- **A remembered address is a fixed e-mail**: the form has one field to type into, Tab / Up / Down stay on it, and the key help leaves out `Tab switch field`.
- **Text fields are append-only** (no cursor movement inside a field). The e-mail field takes at most 254 code points, the password field 1,024; a very long e-mail keeps its end visible (`fitTail`). A pasted line break acts as Enter. Characters that couldn't be shown (control, bidi, zero-width) are not taken into the e-mail field; the password field takes every character except control characters.
- **Messages** all go on the status line; the lists have no separator rows.
- **Questions keep their end**: when `Sign out <e-mail> first? (y/N)` or `Forget <e-mail>? (y/N)` is wider than the line, the e-mail inside it is shortened (ending in `...`), so ` first? (y/N)` / `? (y/N)` — what is being asked — stays whole, on the status line and on the too-small frame alike. Only when not even one character of the address plus `...` fits is the line cut at its end like any long text; a question that fits is drawn unchanged. Hints and messages are cut at the end as before (their wording is fixed).
- **Window too small** (below 40x8): only "Window too small - need at least 40x8" ("Too small - need 40x8" on a narrow window), plus a pending `(y/N)` question, which is still answered. Otherwise only `q` (on the lists) and Ctrl+C act — nothing can be typed into a form that isn't shown.
- **Ctrl+C** ends the app at once in every mode: screen restored, exit 130. That includes Ctrl+C typed right after Esc: within its escape timeout readline joins the two into one unnamed keypress (Esc byte + Ctrl+C byte), and any keypress whose sequence ends with the Ctrl+C byte counts as Ctrl+C — the Esc in it does not act. (The `mm folders` browser still misses that joined keypress; it is not changed in this slice.) A sign-out that was in flight is still finished before the process exits (the local session is cleared and `auth.logout` is written) — never "Signing out..." followed by a user who is still signed in.
- **Unexpected error**: the screen is restored first, then "Unexpected error", exit 1 (`error.unexpected` logged) — the existing `guarded` / `runCli` path.
- **Shared layout helpers**: `columns`, `centred`, `helpLine`, the too-small frame and the new `fitTail` live in `src/cli/browser/layout.ts` (moved out of `render.ts`, the browser's output unchanged). `lastChecked` is exported from `src/cli/account-text.ts`.
- **Known limits**:
  - SIGTERM / SIGHUP during "Signing out..." end the process at once, so that sign-out may not complete (only Ctrl+C and quit are graceful); the screen is still restored by the terminal's own hooks.
  - A sign-in, a session check or a mailbox list still in flight at Ctrl+C is dropped: its answer is no longer logged, remembered or drawn (only a sign-out is finished).
  - Two apps at once each have their own client over the same `session.json`, as two commands do today.
  - Log out while offline still clears the local session (existing `mm logout` behaviour).

### Logging

Events ([LOGGING.md](../LOGGING.md#foundation-m1b-4)) — **no new event**:

- `command.start` / `command.finish` with `cmd: app` (automatic): the whole time the app is open is one run. `mm app` without a terminal is a failed run; plain `mm` without a terminal prints the help and logs nothing, as today.
- `auth.login` (user id), `auth.login-failed` (`reason`, `target` = HMAC of the typed e-mail, `invalid` when it isn't an address) and `auth.logout` (`outcome`) from the app, exactly as `mm login` / `mm logout` write them. The target key is made once per app run, so two failed sign-ins of one run carry the same target even without `MM_MASTER_KEY`.

Never logged: anything typed (e-mail, password), the user's e-mail, the remembered addresses, the mailbox list. `users.json` is local config, not a log. Canary test: across a failed and a successful sign-in, a log out and a quit, no log line contains the typed e-mail, the password or the user's e-mail, and the only events are `command.start`, `auth.login-failed`, `auth.login`, `auth.logout`, `command.finish`.

### Acceptance criteria

- **Entry:** plain `mm` runs `app` only when interactive and without arguments; with arguments (`nosuchcmd`, `--help`, `--version`, any command) nothing changes. `mm app` without a terminal or with `TERM=dumb` → its message, exit 1, the terminal never opened, no Supabase service created. A config error (e.g. `SUPABASE_URL` missing) prints its existing text, exit 1, no screen. `mm --help` lists `app`; the "Getting started:" block is still there.
- **Remembered users:** `users.json` as described (modes, atomic write, order, cap, de-duplication, validation on read); none of `list` / `add` / `remove` ever throws.
- **Sign-in page:** starts with "Checking your sign-in..."; the rows and their order as above; Enter on the signed-in row opens Home without a password and without a login call; a remembered row opens the form with that e-mail fixed and the password field active; the last row opens an empty form. Field keys as in "Keys"; an empty e-mail → "Type your e-mail address first.", an empty password → "Type your password.". No frame ever shows the password or its length. Success → Home, the address remembered; failure → the form again with the right message, the e-mail kept. Switch user and forget ask first.
- **Home:** header, loading / empty / failed states, rows and hints as above; `Log out` → "Signing out..." → the sign-in list, the address no longer tagged `signed in`; Esc / Left / Backspace → the sign-in list without signing out; `q` quits (exit 0).
- **Frame:** every frame has exactly `rows` lines of exactly `cols` columns; too-small rules as above; a resize redraws; every string from outside (Supabase, `users.json`, provider ids, typed text) passes through `sanitize()`; the fixed text is plain ASCII; stale and late results change nothing; Ctrl+C → exit 130 in every mode.
- **Logging:** as in "Logging" above.
- **Regressions:** the existing browser tests (`browser-render`, `browser-state`, `browser-controller`, `cli-folders*`) pass unchanged; every existing command behaves as before.
- Unit tests: remembered-users store, layout helpers, reducers, renderer, controller (fake terminal, fake auth and accounts), the command, the `runCli` default command.

### Verification

1. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run format:check`.
2. No terminal: `npm run dev -- app < /dev/null` → "mm app needs a terminal …", exit 1; `npm run dev < /dev/null` → the help, exit 1; `npm run dev -- --help | grep -n app`.
3. Manual walk (the user, external terminal, `npm run dev`):
   1. Plain `mm` → "Checking your sign-in...", then the sign-in page. Signed in already: your address is tagged `signed in`; Enter → Home, no password asked.
   2. Home: the mailboxes with provider and last check; Enter on a mailbox, `+ Add a mailbox` and `Logs` opens their screens (since M2d-2 / M2d-4 / M2d-5, see their walks below). Esc → the sign-in page, still signed in; Enter → Home again.
   3. `Log out` → "Signing out..." → the sign-in page; the address is still listed, no longer tagged. `npm run dev -- whoami` in another terminal → "Not logged in — run `mm login`".
   4. Enter on the address → the form with the password field active. Type a wrong password: nothing appears on the password line while typing → "Wrong e-mail or password - try again.", the e-mail still there. Type the right one → Home.
   5. Switch user: Esc to the sign-in page, Enter on `Sign in as another user` → `Sign out <e-mail> first? (y/N)`; any key but `y` → back, still signed in; `y` → the form; sign in as the second user → Home shows that user's mailboxes.
   6. Forget: on the sign-in page `f` on the signed-in row → "Log out first to forget this address."; `f` on a remembered row → `Forget <e-mail>? (y/N)` → `y` → the row is gone, also from `users.json`.
   7. Resize the window, also below 40x8 and back; below it only "Window too small" is shown.
   8. `q` → the terminal is back to normal, `echo $?` = 0. Again, Ctrl+C → normal, 130. Again, `kill -TERM <pid>` from another terminal → normal, 143.
   9. `users.json` in the config folder (`~/.config/mail-manager` unless `MM_CONFIG_DIR` or `XDG_CONFIG_HOME` is set): mode 600, addresses only.
   10. `npm run dev -- logs --since 15m` → the `app` runs with their sign-in, failed sign-in and log-out lines; no address and nothing typed.

## M2d-2 — Mailbox screen: usage bars + mail browser

Implemented 2026-10-07 (C-031, reviewed 2026-10-07); not released yet; the manual walk in a real terminal (Verification, step 3) is pending — the user.

### In scope

- **Opening a mailbox.** Enter on a mailbox row of Home → "Connecting..." (the saved mailbox is looked up by its id, then one guarded login with its saved password) → "Reading folders..." — with "n/m" while folder sizes have to be added up from the messages — → the bars. The login guard is made once per app run: wrong passwords counted during one visit still count in the next.
- **The bars.** Header `Mail Manager - <mailbox e-mail>` with the order on the right. Two lines that don't scroll: the totals (`Total: N messages, N unread, SIZE`, with `, N folders couldn't be read` when there are any) and the quota (`Quota: [bar] NN%  USED of LIMIT`, or `Quota: not available from the mail server` when the server reports none or no limit). Then one row per folder: its name, `(hidden)` for an unsubscribed folder, `(overlapping)` for a Gmail label, and on the right a bar of 10 cells, the percent, the size (`~` when added up from the messages) and the number of messages.
  - The bar is the folder's share of the summed mailbox size. A share above nothing fills at least one cell; below half a percent the text is `<1%`; a folder larger than the sum (it changed since) is a full bar.
  - No bar and no percent: a Gmail label, a folder whose size is unknown (shown as `-`), a folder that can't hold mails, and every folder when the sum is unknown or 0. Gmail with All Mail hidden from IMAP shows `Totals unknown - Gmail hides All Mail from IMAP (Labels > Show in IMAP).` instead of the totals.
  - **One folder that couldn't be read takes every bar away.** A sum with an unknown part is unknown, never silently too small (core `computeTotals`): when the size or the counts of one folder that is added up couldn't be read, the totals show `-` for what is unknown (`Total: - messages, - unread, -, 1 folder couldn't be read`) and no folder has a bar or a percent — the bar and percent columns are left out, sizes and messages stay. `mm folders` says `(some folders unknown)` in the same case. Folders that are not added up don't matter here: one that can't hold mails, and on Gmail every label.
  - More than 5,000 folders: the first 5,000 are shown and the status line says so.
- **Order.** `o` cycles tree order (the last name, indented two columns per level) → by size (largest first, unknown sizes last) → by name (the full path, letter case ignored) → tree again; the cursor stays on the same folder and the header names the order.
- **Narrow windows.** The right cells are chosen once per frame — the widest set that leaves a name 12 columns: bar + percent + size + messages → the same with a 6-cell bar → percent + size + messages → size + messages → size. At 40x8 three folder rows fit and the totals and quota lines are cut to the width.
- **Leaving.** Esc / Left / Backspace → Home as it was (same list, same cursor, nothing loaded again); the mailbox's IMAP session is logged out. With marks the key first asks `Drop N marks? (y/N)`. `q` quits the app (with marks: `Quit and drop N marks? (y/N)`). Ctrl+C ends at once and the session is still logged out before the process exits.
- **Failures.** A failed login or folder read shows its text in the body — what happened and what to do, the same texts the commands print, in ASCII and wrapped to the width — with `r try again`. `r` is one more login + read; nothing is retried by itself. A login the guard blocks shows its text with the time; a mailbox that was removed meanwhile, or a missing `MM_MASTER_KEY`, shows its text the same way.
- **Mails.** Enter on a folder opens the M2b browser inside that folder: the same screen, keys, paging, marks and reconnect as in `mm folders`. Esc / Left / Backspace go up one level and, in the folder it was opened in, back to the bars. A folder that can't be opened returns to the bars with "Couldn't open that folder.". A folder that holds no mails itself opens too and lists its subfolders.
- **Marks belong to the mailbox visit.** They are still marked when a folder is opened again and are counted across folders (`marked: N mails, SIZE` in the browser). They are dropped only by leaving the mailbox, by quitting, or — for one folder — when the server reset that folder (UIDVALIDITY). Nothing on the server is ever changed.

### Out of scope

- Stats and their background read (M2d-3), adding a mailbox (M2d-4), the logs screen (M2d-5).
- Usage bars or any other change in `mm folders`, `mm stats` or `mm account ...`.
- Delete (M4): marks live in memory only. Filters and the order of the mail list arrived with M3a.
- A new log event, table, migration or dependency.
- Remembering the chosen order, a refresh key (`r` only retries after a failure), mouse support, colours.
- Making SIGTERM / SIGHUP wait for the IMAP logout.

### Design notes

- **One controller, one key listener.** The browser inside the app is not a second program: the M2b reducer runs as part of the mailbox screen's state (`MailboxView.browser`), and its effects — a page to load, a reconnect, quit, leave — leave as app effects that the app controller runs. `src/cli/browser/state.ts` gained `openEmbedded`, the optional `BrowserState.embedded` and a `leave` effect; `render.ts` an embedded key help. Without `embedded` nothing differs: the output of `mm folders` is byte for byte what it was.
- **Files.** `src/cli/app/mailbox.ts` (the pure reducer), `mailbox-render.ts` (totals, quota, rows, the failed screen), `state.ts` (`MailboxView`, the new actions and effects, `orderedFolders`, `browserKeyOf`, `asciiText`), `controller.ts` (sessions, effects, logging), `src/cli/commands/app.ts` (wiring).
- **Esc inside a folder goes back**, like Left and Backspace; in `mm folders` it quits. The app maps its own keys to the browser's (`browserKeyOf`).
- **The basket belongs to the mailbox screen**, not to one browser: opening a folder seeds the browser with it, leaving the folder writes it back, together with the counts for `browse.finish`.
- **Two numbers keep late results out.**
  - The controller numbers every open and close of a mailbox (the visit). A login, folder read, progress, page or reconnect result that carries another number is dropped: nothing is shown, nothing is logged, and a session it brings is logged out at once.
  - The reducer gives every browser a token, taken from the app's `generation` when the mailbox is opened and raised by every folder that is opened or left; a page of a browser that was left never reaches the next one. On leaving the mailbox the generation becomes `max(generation, browserToken) + 1`, so a token is never used twice in one app run — `generation + 1` alone would repeat one after a visit that opened two folders.
- **The session belongs to the controller.** It is logged out on every way out — Left, `q`, Ctrl+C, an error that ends the app — and exactly once. A reconnect logs the old session out first, then logs in once; the new session is the mailbox's from then on. After a reconnect that failed there is no session: the next folder that is opened asks "Connection closed - reconnect? (y/N)" again without trying to read.
- **A reconnect that failed is explained when the app ends.** Its status line says "Details after you quit.", so the last such failure is kept together with its mailbox and printed on stderr once the screen is given back: `Reconnecting to <address> (<provider>, id <short id>) failed — <what happened and what to do>`. The line names the mailbox because the text itself is the same for every mailbox, and the user may have worked in another one since (`mm folders` prints `Reconnecting failed — ...`: there the one mailbox was named at the start). It is printed on the terminal only, never written to a log. Leaving the mailbox or opening another one doesn't drop it; a later failed reconnect — in any mailbox — replaces it; a login to that same mailbox that works (opening it again, or a later reconnect) drops it, because the problem is gone then.
- **A mailbox left while it opens** returns to Home at once. A login already under way can't be cancelled: it finishes in the background, its session is logged out as soon as it arrives, and nothing of it is shown or logged — also when it fails, whatever the error. A login that had not started yet is not made (since M2d-3, see "Login order" there): a mailbox left before it was looked up, a login the guard was making wait, and one still waiting for its turn behind another login of the same mailbox.
- **The end of the app waits, but not for long.** `settled()` finishes a sign-out and waits for every mailbox logout and every mailbox login still under way; the mailbox part gives up after 5 seconds (the cap of one IMAP logout), so a slow connect never keeps the process.
- **Failure text goes in the body**, not on the status line: the login message with its country hint is long. It is the text the commands print (`accountErrorText`), with its punctuation in ASCII (`asciiText`: dashes, the ellipsis, curly quotes and the arrow; any other non-ASCII character becomes `?`), line breaks kept, wrapped at spaces; what doesn't fit ends in `...`.
- **An error that isn't one of ours** (not user-facing) from the login, the folder read or a page ends the app through the existing path: screen restored, "Unexpected error", exit 1, `error.unexpected` logged once (by `guarded`, not by the app). From a reconnect it is logged and the browser goes offline, as in `mm folders`.
- **Messages on the bars.** "Couldn't open that folder." is cleared by the next key. "Only the first 5,000 folders are shown." stays, and comes back after another message.
- **A quit question that loses its folder.** `q` with marks, pressed while the folder's first page is still loading, asks the browser's question; if that page then fails, the bars come back with "Couldn't open that folder." and the question is gone — the marks are kept and `q` asks again.
- **Rows.** A deep folder's indent gives way before its name does (the name keeps its 12 columns). A mailbox without any bar doesn't keep the bar and percent columns free. An empty folder shows `0%` and an empty bar. A mailbox over its quota shows the real percent (say `120%`) with a full bar.
- **`browse.finish` counts the visit**, not one folder: `ms` runs from the moment the mailbox was opened (in `mm folders` from the moment the browser opened).
- **Known limits:**
  - SIGTERM / SIGHUP end the process at once: the IMAP session is not logged out (the server drops the connection), only `browse.finish` is still written by the terminal's exit hook. Ctrl+C and `q` log out.
  - A mailbox login that takes longer than 5 seconds after the app ended is abandoned: if it still succeeds, that session is never logged out by us.
  - Leaving a mailbox while its login is under way doesn't stop that one login: it finishes, is counted by the login guard like any other, and is logged out. Corrected in M2d-3 (C-032): the logins of one mailbox now run one after another in the app controller and each checks, right before it starts, that its visit is still open — so Enter, Esc, Enter, Esc, Enter on a slow server makes one login for the first open and one for the visit that is still open, never one per abandoned open, and none after the app ended. The "Connecting..." on screen still waits for the login under way to end (15 seconds at most, the connect timeout).
  - The error texts are the commands' own and may name commands (`mm account list`, `mm keygen`, `mm account remove <id>`); they are shown as they are.
  - At exactly 40 columns `Quota: not available from the mail server` is one column too long and ends in `...`.
  - One unreadable folder leaves the whole mailbox without bars (see "The bars"): the known sizes are still listed, but not compared.
  - Marks are in memory only and are lost with the mailbox visit.

### Logging

Events ([LOGGING.md](../LOGGING.md#mailbox-insight-m2a)) — **no new event**; the app writes what `mm folders` writes:

- `folders.list` once per mailbox open: `ok` with the number of folders, or `failed` with the reason code — also when the mailbox is gone or the login fails. A second line after `r`. None for a mailbox left while it was connecting or reading.
- `imap.capability-fallback` at most once per feature per app run, however many mailboxes are opened.
- `browse.finish` once per mailbox visit in which a folder was opened — when the mailbox is left or the app is quit (`ok`), on Ctrl+C or through the terminal's exit hook with code 130, 129 or 143 (`interrupted`), on an error that ends the app or an exit hook with another code (`failed` + reason). None for a visit that opened no folder. Never twice for one visit.
- `imap.login` / `imap.login-failed` / `login-guard.*` from the guarded login, in the security log, as for every mailbox login.

Never logged: folder names, subjects, senders, the mailbox address, host or username, the text of a failure. Canary test: across a failed login, `r`, a hostile folder name, marks, a lost connection, a failed and a successful reconnect and Ctrl+C, the only lines are `folders.list`, `imap.capability-fallback` and `browse.finish`, and none contains any of those.

### Acceptance criteria

- **Opening:** "Connecting..." → "Reading folders..." (+ "n/m") → the bars; one login per open through `guardedOpenSession`, one guard per run.
- **The bars:** header, totals, quota and rows as in "In scope"; the bar, percent and no-bar rules; `o`; the cell sets of narrow windows; moving, paging and resize keep the cursor on screen.
- **Leaving, failing, retrying:** Home comes back as it was; the session is logged out on every way out, also one that arrives late; the marks questions; `r`; an error that isn't ours ends the app through the existing path.
- **Mails:** the M2b browser inside the folder; Esc / Left / Backspace back; marks kept for the visit; a page of a browser that was left changes nothing; reconnect as in `mm folders` (its failure is printed on stderr after the screen is given back, naming the mailbox: `Reconnecting to <mailbox> failed — ...`).
- **Frame:** every frame has exactly `rows` lines of exactly `cols` columns; the app's own text is plain ASCII; folder names, the address and the failure text pass through `sanitize()`; below 40x8 only "Window too small" and a pending question.
- **Logging:** as in "Logging" above.
- **Regressions:** the `browser-*` and `cli-folders*` tests pass unchanged; every command behaves as before.
- Unit tests: the embedded browser, the mailbox reducer, its renderer, the controller (fake terminal, fake sessions with logout spies, fake login / folder read / page read), the command.

### Verification

1. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run format:check`.
2. No terminal: `npm run dev -- app < /dev/null` → "mm app needs a terminal …", exit 1.
3. Manual walk (the user, external terminal, `npm run dev`, the test mailbox):
   1. Plain `mm` → sign in → Enter on the test mailbox → "Connecting...", "Reading folders...", then the bars. Counts, sizes and the quota line match `npm run dev -- folders --plain`.
   2. `o` three times: by size, by name, tree again — the cursor stays on its folder. Resize the window down to 40x8 and below, and back.
   3. Enter on `mm-test` → its mails. Space marks one, `a` the screen; Esc → the bars; Enter again → still marked.
   4. Esc on the bars → `Drop N marks? (y/N)` → `n` stays, Esc + `y` → Home, the same list and cursor.
   5. Open the mailbox again, press Esc while "Connecting..." → Home at once.
   6. Wrong password (a mailbox saved with one that no longer works): the message in the body, `r` tries once more, Esc → Home.
   7. Ctrl+C while "Reading folders..." → the terminal is back, `echo $?` = 130. `kill -TERM <pid>` inside a folder → the terminal is back, 143.
   8. `npm run dev -- logs --since 15m` → `folders listed`, `folder browser` lines for the `app` runs; no folder name, subject or address.

## M2d-3 — Stats screen

Implemented 2026-10-08 together with M2d-5 and M2d-4 (C-032; one plan, one run); not reviewed or released yet; the manual walk (Verification, step 3) and the large-mailbox measurement are pending — the user.

### In scope

- **Login order** (review follow-up of C-031). The logins the app makes for one saved mailbox — opening it, `r` on its failed screen, the browser's reconnect, the stats read — run one after another. When a login's turn comes it first checks that the visit (or the stats read) that asked for it is still open and that the app has not ended; if not, it is not made. The notice "Several wrong passwords - waiting 5 seconds before trying again." is replaced by "Connecting..." when the wait ends.
- **The read.** Once the folders are shown, the stats are read on a **second guarded login** of their own (decided 2026-10-07: the scan holds a folder for as long as it reads it; on its own session the browser stays responsive and stopping the read is one logout). It starts automatically, whatever the size of the mailbox (the measurement may change that). One login per read, never repeated by itself. Scope as `mm stats`: every folder that can hold mails, Trash and Spam included; on Gmail All Mail + Trash + Spam. Gmail with All Mail hidden makes no login: `Stats can't be read - Gmail hides All Mail from IMAP (Labels > Show in IMAP).`
- **On the bars** the status line says where the read is: `Stats: reading...`, `Stats: reading folder 3/12 - 5000/12345 messages`, then `Stats ready - press s` or `Stats couldn't be read - press s` (`Stats: press s to read` when no read was started). The key help gains `s stats`.
- **The stats screen** (`s`). Header `Mail Manager - <mailbox e-mail>` with the section and order on the right (`Years - by size`, `Top senders - by messages`, `Largest mails`, ...; ` (approximate)` for senders or domains whose list was capped). One summary line that doesn't scroll: `Scanned N folders, M messages, SIZE (approx.)`, plus `, U folders couldn't be read`, `, P folders read only partly`, `, K folders skipped (counted elsewhere)` when there are any. Below it the section:
  - `1` **Years**: newest first, each with a bar, percent, size and messages (the bars' cells and rules); `unknown` last.
  - `2` **Top senders** and `3` **Top domains**: address or domain, size, messages; `(no address)` / `(no domain)`; an `others` row for what the capped list left out.
  - `4` **Largest mails**: size, day, sender - subject, the folder in brackets.
  - `o` switches by size / by messages (sections 1–3). A list with nothing in it shows `(none)`.
- **While reading** the screen's body is empty and the progress is on the status line; after a failure its text is in the body with `r try again`; `r` reads again (one new login) when no read is running.
- **Kept for the visit.** The stats stay while the mailbox is open — across folders, marks and a reconnect of the browser — and are dropped when the mailbox is left. Leaving, quitting or Ctrl+C stops a read: its session is logged out, also one that arrives late.

### Out of scope

- Any change to `mm stats`, `mm folders` or the core scan (`collectStats` is used as it is; it has no cancel — a read is stopped by logging its session out).
- An automatic limit for large mailboxes, or stats only on demand (after the measurement); remembering stats between visits; exporting them.
- A new log event; an `interrupted` outcome for `stats.finish`.

### Design notes

- **`autoStats`.** `AppState.autoStats` decides whether the folders arriving start the read. `mm app` turns it on; the reducer's default is off, which is also the ready switch for "too slow → on demand with `s`" (then `s` on the bars starts the read and opens the screen).
- **The controller owns the stats session** like the mailbox's own: logged out exactly once on every path — the read ended, the mailbox was left, `q`, Ctrl+C, a crash — within the 5 seconds `settled()` gives the mailbox part. The two sessions fail on their own: a lost stats connection doesn't touch the browser, and the browser's reconnect doesn't touch the stats.
- **Late results.** Every read has a token (`statsToken`), raised by `r` — on the stats screen and on the mailbox's failed screen. A progress step or a result with another token, or of a visit that was left, changes nothing.
- **A stats failure never ends the app.** One that is ours shows its text (the commands' own, ASCII, wrapped). One that isn't is logged as `error.unexpected` and shown as `Unexpected error while reading the stats.`; the app goes on.
- **Redraw only when the frame changed**: a progress step that doesn't change what is on screen (e.g. inside a folder) draws nothing.
- **Narrow windows.** Year rows follow the bars' cell sets and keep a 12-column label; when the header's right cell doesn't fit with ` (approximate)`, it is shown without it.
- **Files.** `src/cli/app/mailbox-stats.ts` (the reducer part), `stats-render.ts`, the stats parts of `mailbox.ts`, `mailbox-render.ts`, `state.ts`, `controller.ts`; `src/cli/commands/app.ts` wires `collectStats` and the time zone.
- **Known limits:**
  - Two IMAP connections per open mailbox while the stats are read. A server that limits connections may refuse the second: the stats show that failure, the bars and the browser work on.
  - The login queue is per saved mailbox (its id); the guard's own lock is per server login (host + username). Two saved rows with the same server login therefore queue only in the guard.
  - With more than 5,000 folders the bars keep "Only the first 5,000 folders are shown." on the status line and the stats note is not shown there (`s` still works).
  - Nothing is measured yet on a large mailbox (CPU, memory, time) — the user's open box.

### Logging

Events ([LOGGING.md](../LOGGING.md#mailbox-insight-m2a)) — **no new event**:

- `stats.finish` once per read that ended: `ok` with the account id, folders, messages, bytes and `ms`; `failed` with zeros and the reason code. None for a read stopped by leaving, quitting or Ctrl+C (as `mm stats` on Ctrl+C), and none in the Gmail-hidden case.
- `imap.login` / `imap.login-failed` / `login-guard.*` of the second login, in the security log.

Never logged: senders, domains, subjects, folder names, the mailbox address, host or username. Canary test: across a visit with canary strings as sender, domain, subject and folder name, a failed read, `r`, and leaving during a read, no line contains any of them.

### Acceptance criteria

- **Login order:** on a slow login, Enter / Esc four times and Enter again makes one login while the first is pending and exactly one more after it; with Ctrl+C meanwhile, one in total. The same counts with the real login guard. Everything M2d-2 guaranteed still holds (a login under way is not cancelled, each session is logged out exactly once).
- **The read:** starts with the folders (or with `s` when `autoStats` is off); one login per read; the Gmail-hidden text without a login.
- **Bars and screen:** the status texts, `s stats`, the header cells, the summary line, the four sections and their rows, `o`, scrolling, `r`, back and quit as above; every frame exact in size; names from the mailbox pass through `sanitize()`.
- **Sessions:** the stats session is logged out exactly once on every path; pages keep loading while the stats are read.
- **Logging:** as in "Logging" above.
- Unit tests: login order (also with the real guard), reducer, renderer, controller with fake sessions and logout spies, the canary, the command wiring.

### Verification

1. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run format:check`.
2. No terminal: `npm run dev -- app < /dev/null` → "mm app needs a terminal …", exit 1.
3. Manual walk (the user, external terminal, `npm run dev`, the test mailbox):
   1. Open the mailbox: under the bars the stats note counts up, then `Stats ready - press s`.
   2. `s` → Years; `2`, `3`, `4`; `o` in 1–3; the numbers match `npm run dev -- stats`. Esc → the bars.
   3. Open a folder while the stats are read: pages load as before. `s` + `r` → one new read.
   4. Esc on the bars during a read → Home at once. Ctrl+C during a read → the terminal is back, 130.
   5. `npm run dev -- logs --since 15m` → one `mailbox stats` line per read that ended, none for the stopped ones; no sender, subject or folder name.
4. (the user) Measure CPU, memory and time on a large mailbox, together with M2c-2.

## M2d-5 — Logs screen

Implemented 2026-10-08 (C-032); not reviewed or released yet; the manual walk is pending — the user.

### In scope

- Enter on Home's `Logs` → "Reading the logs..." → the `mm logs` report as a page: the same lines (time, command, text), date headers, "interrupted or still running" markers and footers, oldest first.
- **Anchored at the bottom.** The page opens at its end — the newest line on the last body line; fewer lines than the body start at the top. A line longer than the window wraps: cut at the last space that fits, the rest on rows indented 10 columns (under the command); a single long word is cut at the width.
- **Window and filters.** `1` the last 24 h (default), `2` 7 days, `3` 30 days; `s` security lines only; `w` warnings and errors only; they combine. Every change reads again and opens at the bottom. The header names them: `24 h`, `7 days - security - warnings`.
- **This app run is included** — what just happened in the app is on the page — without an "interrupted or still running" marker for itself.
- A log folder that can't be read shows the text `mm logs` prints for it; no line found → `No log lines in the last 24 h.` (or the window's wording).
- Esc / Left / Backspace → Home as it was: same list, same cursor, nothing loaded again.

### Out of scope

- `mm logs clear`, `--run`, `--json`, `path`: they stay commands. Nothing can be deleted on this screen.
- Following the log live, search, a line cursor, copying lines.

### Design notes

- **Validated records only.** The page is core `readLogs` + `formatReport` (`src/cli/log-text.ts`) — never raw lines — each line through `asciiText`.
- **`narrowWith: 'keys'`**: a new option of `formatReport`; the "older lines" footer then reads `N older lines not shown - choose a shorter time or a filter (s, w)` instead of naming `--flags`. Without it the output of `mm logs` is byte for byte what it was.
- **Late reads.** Every read carries the app's generation; one that was superseded by a newer read, or arrives after Esc, changes nothing. The read itself can't be stopped: a huge log shows "Reading the logs..." until it is done, and Esc leaves at once.
- **Home's list lost behind another screen** (found while building): Home takes keys while its list still loads, and opening Logs or Add drops the list's answer. On the way back, a list that never arrived is asked for again; one that was loaded, or failed, comes back untouched.
- **Files.** `src/cli/app/logs.ts`, `logs-render.ts`, the logs parts of `state.ts`, `reduce.ts`, `render.ts`, `home.ts`, `controller.ts`; `readLogs` wired in `src/cli/commands/app.ts`.
- **Known limits:**
  - At most the newest 5,000 lines of the window are read (the reader's cap); the footer says how many older ones were left out.
  - A late _result_ changes nothing, but a late failure that isn't one of ours (a read that was left or superseded and then throws something unexpected) still ends the app through the crash path. The same holds for the lookup and the duplicate check of Add a mailbox. To decide: drop those too.
  - After the window grew, the first scroll key towards the end can be lost (the position is clamped first); the same on the pages of Add a mailbox.

### Logging

**Nothing is logged** for opening, reading or filtering the logs, and nothing is deleted.

### Acceptance criteria

- The header, "Reading the logs...", the page of `formatReport` with this run's lines and without its own interrupted marker.
- Bottom anchor, wrapping, scrolling clamped at both ends; `1` / `2` / `3`, `s`, `w`, `r` each read again with the right options (level `warn` when `w` is on); back to Home untouched.
- The keys footer; the folder problems' texts; the no-lines text; a late or superseded read changes nothing.
- `mm logs` output unchanged (`cli-logs*`, the existing cases of `log-text.test.ts`).
- Unit tests: reducer, renderer, controller with a fake reader.

### Verification

1. The gates and the no-terminal check as above.
2. Manual walk (the user): `Logs` on Home → the page ends with this run's own lines; Up / PgUp and back; `2`, `s`, `w` → the header names them; `r`; Esc → Home, the cursor still on `Logs`. Compare with `npm run dev -- logs`.

## M2d-4 — Add a mailbox in the app

Implemented 2026-10-08 (C-032); not reviewed or released yet; the manual walk is pending — the user.

### In scope

The `mm account add` flow as steps, each one frame:

1. **Address.** Enter on `+ Add a mailbox`. `MM_MASTER_KEY` missing or broken → its text and nothing is asked. Otherwise the field `E-mail of the mailbox:`, checked like `mm account add`: an empty field → `Type the e-mail address of the mailbox.`, text that isn't an address → the reason, the field stays.
2. **Looking up.** `Looking up settings...`, then `... checking <source>` as the lookup goes on. Esc returns to the address field; the late result changes nothing.
3. **What was found.** Provider (` (unverified preset)` when not verified), `Server: <host>:993 (TLS)`, username, found via, the provider's hint and help link, then every warning on lines starting `! ` — the lookup's notices, a problem with the domain, the warning about a server from an unsigned DNS record. Enter uses the settings; for a server from an unsigned record Enter only says `Press y to use this server, or m to enter another.` and `y` uses it.
   - **Not supported** (a provider that only allows its own sign-in page): the provider and `Not supported yet: <reason>`; only back.
   - **Nothing found:** `No IMAP settings found for <domain>.`, one `Tried:` line per source, the notices; `c` / `m` go on — a hint, never a dead end.
   - **Provider known, host per mailbox:** straight to the host field with the provider's hint.
4. **Provider list** (`c`): `Slovakia / Czechia` and `Global`, each with its presets; ` (unverified)` where it applies; an unsupported one is marked `not supported yet` and Enter on it only says why.
5. **Server by hand** (`m`): `IMAP host:` and `Username:` (the address by default), both validated like `mm account add`; the message names what is wrong and the cursor goes to that field.
6. **Already saved?** `Checking your saved mailboxes...` — the same address + server saved already shows its text, **before any password is asked**.
7. **Password.** The chosen provider, server, username and hint, and `Password:  (nothing is shown while you type)`. Enter → `Checking the login...`: one login through the login guard.
   - The mail server said no → the password field again, empty, with the one generic login message below it. The guard limits the tries: its wait notice replaces "Checking the login..." while it waits; its block text ends the flow.
   - Any other failure → its text on a screen of its own, Esc → Home.
8. **Saved** → Home with the list read again, the cursor on the new mailbox, `Added <address>.` on the status line until the next key. While the list is still loading the cursor is on the first row (`+ Add a mailbox`), never on `Logs` or `Log out`.

Nothing is saved unless the login worked.

### Out of scope

- Any change to `mm account add` or the core (`discover`, `assertNotDuplicate`, `addAccount` are used as they are).
- Test login, change password and remove mailbox in the app: they stay commands.
- OAuth sign-in for providers that need it; picking one of several hosts a lookup found; port or TLS options (993 with TLS only).
- Cursor movement inside a field.

### Design notes

- **The reducer validates** with the core's pure validators (`parseEmail`, `validateManualHost`, `validateManualUsername`, `settingsFromPreset`, `manualSettings`); only the lookup, the duplicate check and the add itself are effects, reached through `AppDeps` (`discover`, `assertNotSaved`, `addMailbox`).
- **One way back.** The view keeps a stack of the steps the user acted in; Esc pops one. So the server fields opened from the provider list go back to the list, and the password goes back to whichever step the settings were chosen in.
- **The password** exists only in the field, then in the one add effect and the `addAccount` call. Enter empties the field; no state object and no controller variable keeps it after its attempt. No frame contains it, a part of it or anything that depends on its length; it is never logged. It is sent as typed; at most 1,024 characters.
- **Nothing is retried by itself.** A rejected login waits for the user to type again; each try is one guarded login, counted by the same guard as every other login of the app run.
- **During "Checking the login..." only Ctrl+C acts**: the login can't be called back, and an Esc that left the screen could still be followed by a saved mailbox.
- **`addProblem`** — the text for a missing or broken `MM_MASTER_KEY` — is worked out once when the app starts; the environment doesn't change during a run.
- **Text from outside** (provider names, hints, notices, what a DNS record says) passes through `sanitize()` and `asciiText`; pages longer than the window scroll, and a long note is wrapped at the end of the body.
- **An error that isn't ours** from the lookup, the check or the add ends the app through the existing path ("Unexpected error", `error.unexpected`).
- **Files.** `src/cli/app/add.ts`, `add-render.ts`, the add parts of `state.ts`, `reduce.ts`, `render.ts`, `home.ts`, `controller.ts`; `src/cli/discovery-text.ts` (`triedText`); the wiring in `src/cli/commands/app.ts`.
- **Known limits:**
  - Ctrl+C during "Checking the login..." ends the app (130) after waiting up to 5 seconds for the call; if the login had just worked, the mailbox may still have been saved.
  - The same address + server saved in another window between the check and the save is refused by the save itself (the duplicate text on the failed screen).
  - `mm account add` writes no `discover.finish`, and neither does the app.

### Logging

Events ([LOGGING.md](../LOGGING.md)) — **no new event**; the app writes what `mm account add` writes:

- `account.add` (`ok` / `failed` + reason) and its `audit_log` row, from the core, with the app's run id.
- `imap.login` / `imap.login-failed` / `login-guard.*` of the login check, in the security log.

Never logged: the typed address, server, username or password. Canary test: across a wrong password, a second try that works, a duplicate and a server typed by hand, no line contains any of them.

### Acceptance criteria

- Each step as in "In scope": its fields, texts, keys and where Esc leads; the key problem screen; the unsigned-record rule (`y`).
- The duplicate check runs before the password step; one `addMailbox` call per Enter on the password; the rejected / blocked / failed paths; nothing saved unless it resolved.
- No frame of any step depends on the password; nothing keeps it after its attempt.
- Saved → Home reloaded, the cursor on the new mailbox, `Added <address>.`
- Late results (lookup, check) after Esc change nothing; the "Coming in a next step" hints are gone and Home is otherwise unchanged.
- **Logging:** as in "Logging" above.
- Unit tests: reducer, renderer, controller with fake discovery / duplicate check / add, the command wiring.

### Verification

1. The gates and the no-terminal check as above.
2. Manual walk (the user, external terminal, the test mailbox — one real login per try, never in a loop):
   1. `+ Add a mailbox` → type the test mailbox's address → what was found → Enter → the password → Home with it under the cursor and `Added ...`.
   2. Again with the same address → the "already saved" text before any password.
   3. `c` → the provider list; `m` → a host that isn't one → its message; Esc step by step back to Home.
   4. A wrong password once → the login message, the field again (don't repeat: the guard counts it).
   5. `npm run dev -- logs --since 15m` → `mailbox added` for the `app` run; no address, host or username.

## Open questions

- **Slow network while switching user.** `SupabaseAuthService.logout()` gives up on the server call after its deadline and clears the local session. If that abandoned call finishes later, it may clear the session of the user who signed in meanwhile: they would have to sign in again; nothing leaks. Accepted for M2d-1 (the auth service is not changed in this slice). To decide later: make an abandoned sign-out unable to touch a newer session.
- **A leftover session under an in-app sign-in.** When the session check says nobody is signed in but `session.json` still holds data (e.g. the auth server answered with an error that isn't a network failure), a sign-in in the app overwrites that stored session without revoking it — while `mm login` refuses in that state ("You're already logged in — run `mm logout` first"). Not fixed in this slice (the auth service isn't changed here). To decide: should the app revoke a leftover session before signing in?
- **A sign-in call abandoned by its deadline.** When the auth service gives up on a sign-in ("Can't reach Mail Manager"), the abandoned call keeps running in this long-lived process and may still store a session later, after the app has shown the failure. The same class as the slow-network question above; not fixed in this slice.

## Tasks

See `TODO.md` → M2d.
