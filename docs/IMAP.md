# IMAP reference for Mail Manager

Research notes: IMAP versions, the extensions that matter to this app, how to detect them, what they do, how to use them via imapflow, and what to do when a server lacks one.

- **Library facts verified against imapflow 2.0.5 source** (`dist/esm/…`, 2026-09-21). imapflow is not yet a dependency (added in M1). Re-check this doc if the pinned version differs.
- **Provider capability lists are expected values, not measured ones.** M1's `mm account test` stores the real list in `mail_accounts.capabilities`. Update §7 from those results.

---

## 1. Versions and history

| Version         | RFC(s)                                | Year      | Status / notes                                                                                                                                                                                                       |
| --------------- | ------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMAP2           | RFC 1064 → RFC 1176                   | 1988–1990 | Historic. Nobody runs it.                                                                                                                                                                                            |
| IMAP3           | RFC 1203                              | 1991      | Never adopted. Historic.                                                                                                                                                                                             |
| IMAP4           | RFC 1730                              | 1994      | First IMAP4. Replaced by rev1.                                                                                                                                                                                       |
| **IMAP4rev1**   | RFC 2060 (1996) → **RFC 3501** (2003) | 2003      | **What almost every server speaks.** Baseline for this app.                                                                                                                                                          |
| **IMAP4rev2**   | **RFC 9051**                          | 2021      | rev1 plus many extensions folded into the base, some legacy removed. Servers advertise `IMAP4rev1 IMAP4rev2` together; clients opt in with `ENABLE IMAP4rev2`. Adoption is partial (Dovecot, Stalwart, some others). |
| JMAP (not IMAP) | RFC 8620, RFC 8621                    | 2019      | JSON/HTTP successor. Fastmail, Stalwart, Cyrus. Not in scope, but a possible future backend.                                                                                                                         |

### What IMAP4rev2 folds into the base

A rev2 server must support all of these even if it doesn't list them separately:
`ENABLE`, `ESEARCH`, `IDLE`, `LIST-EXTENDED`, `LIST-STATUS`, `LITERAL-`, `MOVE`, `NAMESPACE`, `SASL-IR`, `SEARCHRES`, `SPECIAL-USE`, `STATUS=SIZE`, `UIDPLUS`, `UNSELECT`, plus `BINARY` fetch and `UTF-8` mailbox names.

Rev2 also **removes** some things: the `\Recent` flag and the `RECENT` STATUS item, `LSUB` (use `LIST (SUBSCRIBED)` instead), `CHECK`, and `SEARCH CHARSET` other than UTF-8/US-ASCII. Modified UTF-7 mailbox names are replaced by UTF-8.

imapflow: when the server advertises `IMAP4rev2`, it sends `ENABLE … IMAP4rev2`. After that, `hasCapability()` treats the folded list above as present (`tools.js: IMAP4REV2_FOLDED_CAPABILITIES`). `disableIMAP4rev2: true` turns this off.

**Our rule:** assume **IMAP4rev1 + extensions** and decide by capability. Never rely on the rev2 label alone.

### Related protocols (not IMAP)

- **POP3.** Downloads the inbox only. No folders, no server-side search, no flags. Not useful for a management tool.
- **Gmail API / Microsoft Graph.** Proprietary REST APIs with richer features (batch delete, labels, true thread IDs). Possible alternatives to IMAP for those two providers; see §8.

---

## 2. Server families (what you'll actually connect to)

| Family                                    | Typical users                                        | Character                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gmail** (Google proprietary)            | gmail.com, Google Workspace                          | Labels exposed as folders. Rich but non-standard (`X-GM-EXT-1`). No `SORT`/`THREAD`/`QRESYNC`. Bandwidth and connection limits.               |
| **Microsoft Exchange Online / Outlook**   | outlook.com, hotmail, M365                           | Minimal extension set. OAuth2 only. Folder names localised. No `QUOTA`, no `CONDSTORE`.                                                       |
| **Dovecot**                               | Most hosting / ISPs / self-hosted, many EU providers | The most standards-complete server. Nearly every extension, including `QRESYNC`, `SORT`, `THREAD`, `STATUS=SIZE`, often `IMAP4rev2` (2.3.x+). |
| **Cyrus**                                 | Fastmail, universities                               | Very complete. `OBJECTID`, `QRESYNC`, `SORT`, `THREAD`.                                                                                       |
| **Yahoo / AOL** (proprietary)             | yahoo.com, aol.com                                   | Fairly basic. `MOVE`, `UIDPLUS`, `ID`, `XLIST`/special-use. Throttles aggressively.                                                           |
| **iCloud** (proprietary)                  | icloud.com, me.com                                   | Basic. `UIDPLUS`, `IDLE`, `QUOTA`. Historically no `MOVE`. Verify.                                                                            |
| Courier, Zimbra, hMailServer, Stalwart, … | Small hosts, self-hosted                             | Varies widely. Courier and hMailServer are older and may lack `MOVE` / `UIDPLUS`. Stalwart is modern (rev2 + JMAP).                           |

GMX, Seznam, Zoznam, Azet and Centrum run their own or Dovecot-based servers. Their capabilities are unknown until M1 tests them.

---

## 3. How to detect features

### 3.1 Sources of truth

1. **`CAPABILITY` response.** Returned by the `CAPABILITY` command. Often also sent in the greeting (`* OK [CAPABILITY …]`) and in the tagged OK after login.
   - **Capabilities change after authentication.** Pre-auth lists `AUTH=…`, `STARTTLS`, `LOGINDISABLED`. Post-auth lists the real feature set. Always use the post-login list. imapflow refreshes it automatically after LOGIN/AUTHENTICATE.
2. **`ENABLE` result.** Some extensions only take effect after the client enables them: `CONDSTORE`, `QRESYNC`, `UTF8=ACCEPT`, `IMAP4rev2`. The server's `* ENABLED …` reply says what actually turned on.
3. **Per-mailbox response codes on `SELECT`/`EXAMINE`.** These can differ per folder even when the capability is advertised:
   - `[UIDVALIDITY n]`, `[UIDNEXT n]`
   - `[PERMANENTFLAGS (…)]`. If `\*` is absent, custom keywords can't be stored. If `\Deleted` is absent, you can't delete here.
   - `[HIGHESTMODSEQ n]` or `[NOMODSEQ]`. The second means CONDSTORE is unusable in this folder.
   - `[UIDNOTSTICKY]` (UIDPLUS). UIDs in this folder aren't persistent. Treat as unsafe for plans.
   - `[READ-ONLY]`
   - `[APPENDLIMIT n]`, `[MAILBOXID (…)]` (OBJECTID)
4. **Runtime refusal.** The server answers `BAD` (syntax / unknown command) or `NO` (refused). Some servers advertise a feature but implement it badly. Handle errors instead of trusting the list completely.
5. **`ID` (RFC 2971).** Server name and version (e.g. `"name" "Dovecot"`). Useful for diagnostics and quirk tables. Never use it instead of capability checks.

### 3.2 In imapflow

```ts
client.capabilities; // Map<string, boolean | number>, post-login. Keys uppercase, e.g. 'UIDPLUS', 'APPENDLIMIT' → number
client.enabled; // Set<string>: extensions confirmed by ENABLE (CONDSTORE, UTF8=ACCEPT, QRESYNC, IMAP4rev2)
client.serverInfo; // ID response or null
client.mailbox; // MailboxObject after mailboxOpen/getMailboxLock: uidValidity (bigint), uidNext, exists,
//                 highestModseq?, noModseq?, permanentFlags?, readOnly?, appendlimit?, mailboxId?
```

- imapflow's own `hasCapability()` (rev2 folding) is internal. It isn't part of the public types.
- **Plan:** `src/core/imap/session.ts` exposes a typed `ServerFeatures` object built once per connection, e.g. `{ uidplus, move, specialUse, quota, statusSize, condstore, qresync, esearch, objectId, gmail, idle, rev2 }`. Build it from `capabilities` + `enabled`, folding rev2 the same way imapflow does.
- Core code checks `features.uidplus`, never a raw string. Store the raw list in `mail_accounts.capabilities` (M1) for diagnostics.

### 3.3 What imapflow does automatically on connect (verified)

| Step                                                                                | Effect for us                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sends `ID` if the server has `ID`                                                   | Fine. Set `clientInfo: { name: 'mail-manager', version }`. Send no personal data.                                                                                                           |
| Runs `NAMESPACE`                                                                    | Gives the personal-namespace prefix/delimiter (e.g. `INBOX.` on Courier).                                                                                                                   |
| `ENABLE CONDSTORE UTF8=ACCEPT [QRESYNC] [IMAP4rev2]` unless `disableAutoEnable`     | CONDSTORE is on wherever supported. QRESYNC only with `qresync: true`.                                                                                                                      |
| `COMPRESS=DEFLATE` unless `disableCompression`                                      | Less bandwidth on big fetches. Keep it on.                                                                                                                                                  |
| **Auto-IDLE after 15 s of inactivity** unless `disableAutoIdle`                     | Harmless for a CLI, but pointless. Set `disableAutoIdle: true` for short-lived CLI sessions.                                                                                                |
| STARTTLS: **if `doSTARTTLS` is unset and not `secure`, it upgrades "if available"** | That is opportunistic and downgradable. **Always pass `secure: true`, port 993**, and `tls: { rejectUnauthorized: true }` (SECURITY.md). Combining `secure` with `doSTARTTLS: true` throws. |

---

## 4. Core IMAP4rev1 commands (always available)

Every IMAP4rev1 server has these. Commands marked "UID" have a `UID` form that takes UIDs instead of sequence numbers. **Always use the UID form** (`{ uid: true }` in imapflow), because sequence numbers shift when other clients expunge.

| Command                  | What it does                                                                                                                                                                                                                                                                                                              | imapflow                                                                                                          | App use                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `CAPABILITY`             | Lists the server's features                                                                                                                                                                                                                                                                                               | automatic → `client.capabilities`                                                                                 | M1                                                                             |
| `LOGIN` / `AUTHENTICATE` | Plain login, or a SASL mechanism (`PLAIN`, `XOAUTH2`, `OAUTHBEARER`). `LOGINDISABLED` means LOGIN is forbidden.                                                                                                                                                                                                           | `auth: { user, pass }` or `{ user, accessToken }`                                                                 | M1 / M6 (OAuth)                                                                |
| `LIST` / `LSUB`          | Lists folders (flags `\Noselect`, `\HasChildren`, …). LSUB = subscribed only (removed in rev2).                                                                                                                                                                                                                           | `list()`, `listTree()`                                                                                            | M2                                                                             |
| `STATUS`                 | Counters for a folder **without selecting it**: `MESSAGES`, `UNSEEN`, `UIDNEXT`, `UIDVALIDITY`, (`RECENT`)                                                                                                                                                                                                                | `status(path, { messages, unseen, uidNext, uidValidity })`                                                        | M2 (never STATUS the currently selected folder; RFC advises against it)        |
| `SELECT` / `EXAMINE`     | Opens a folder read-write / read-only. Returns UIDVALIDITY, EXISTS, flags.                                                                                                                                                                                                                                                | `mailboxOpen(path, { readOnly })`, `getMailboxLock(path, { readOnly })`                                           | All. **Use EXAMINE (readOnly) for everything except M4 execute.**              |
| `SEARCH` (UID)           | Server-side search. Criteria: `ALL`, `FROM/TO/CC/BCC/SUBJECT/BODY/TEXT <str>`, `HEADER <f> <str>`, `BEFORE/ON/SINCE <date>` (internal date), `SENTBEFORE/SENTON/SENTSINCE` (Date: header), `LARGER/SMALLER <n>`, flags (`SEEN`, `UNSEEN`, `FLAGGED`, `DELETED`, `ANSWERED`, `DRAFT`, `KEYWORD`), `UID <set>`, `OR`, `NOT` | `search({ from, since, larger, or: [...], not: {...} }, { uid: true })`                                           | M3                                                                             |
| `FETCH` (UID)            | Per-message data: `UID`, `FLAGS`, `INTERNALDATE`, `RFC822.SIZE`, `ENVELOPE`, `BODYSTRUCTURE`, `BODY.PEEK[…]` (headers/parts/full)                                                                                                                                                                                         | `fetch(range, { uid, size, envelope, internalDate, bodyStructure, headers, source }, { uid: true })`              | M2, M3, M5                                                                     |
| `STORE` (UID)            | Sets/adds/removes flags (`+FLAGS \Deleted`)                                                                                                                                                                                                                                                                               | `messageFlagsAdd/Remove/Set(range, flags, { uid: true })`                                                         | M4                                                                             |
| `COPY` (UID)             | Copies messages to another folder                                                                                                                                                                                                                                                                                         | `messageCopy(range, dest, { uid: true })`                                                                         | M4 fallback                                                                    |
| `EXPUNGE`                | **Permanently removes every message flagged `\Deleted` in the selected folder**, including ones other clients flagged                                                                                                                                                                                                     | (called inside `messageDelete`; see §6)                                                                           | **Forbidden** (CLAUDE.md)                                                      |
| `CLOSE`                  | Deselects **and silently expunges** `\Deleted` messages                                                                                                                                                                                                                                                                   | imapflow sends CLOSE in `mailboxClose()`, and in `mailboxRename()`/`mailboxDelete()` when that folder is selected | **Avoid** `mailboxClose()` in a writable folder. Release the lock and log out. |
| `APPEND`                 | Uploads a message into a folder (restore/migration)                                                                                                                                                                                                                                                                       | `append(path, content, flags, idate)`                                                                             | Later (restore)                                                                |
| `CREATE/DELETE/RENAME`   | Folder management                                                                                                                                                                                                                                                                                                         | `mailboxCreate/Delete/Rename`                                                                                     | Test setup (`mm-test`)                                                         |
| `NOOP`, `LOGOUT`         | Keepalive/poll; clean close                                                                                                                                                                                                                                                                                               | `noop()`, `logout()`                                                                                              | All                                                                            |

### Key semantics

- **UID + UIDVALIDITY** together identify a message within a folder. If UIDVALIDITY changes, every stored UID for that folder is invalid; abort (SECURITY.md). imapflow returns `uidValidity` as a **`bigint`**. zod and the DB must handle it (store as a string or `numeric`, never a JS `number`).
- **`RFC822.SIZE`** is the size of the message in RFC 822 form, as the server reports it. It doesn't exactly match quota usage (dedup, compression, Gmail labels). Label it "approximate" (M2).
- **`INTERNALDATE`** = when the server received the message. The `Date:` header = what the sender claims. For "older than" filters, `BEFORE/SINCE` (internal date) is the more robust default. Offer `SENTBEFORE` as an option.
- **IMAP dates are day-granular** (no time) and interpreted in the server's timezone.
- **Search charset:** non-ASCII search strings need `CHARSET UTF-8`. imapflow adds it automatically. Some old servers reject it (`BADCHARSET`).
- **Substring matching:** `FROM "@example.com"` is a case-insensitive **substring** match on the header. `@example.com.evil` also matches. This is why M3 plans an exact client-side domain post-filter.
- **`BODY`/`TEXT` search** can be very slow or incomplete, depending on server indexing (Dovecot with FTS is fast; Exchange is limited; Gmail is good). Warn in output (M3).
- **Sequence-number traps:** plain `FETCH 1:*` is fine for reading. For mutations, only ever pass explicit UID sets.

---

## 5. Extension catalogue

Columns: **Detect** = token in CAPABILITY (★ = folded into rev2). **If missing** = our fallback. **Needed in** = milestone.

### 5.1 Safety-critical (delete / move)

| Extension     | RFC      | What it does                                                                                                                                                                                      | Detect                                 | imapflow                                                                                                                                | If missing                                                                                                                     | Needed in                                        |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **UIDPLUS**   | 4315 (★) | `UID EXPUNGE <set>`: expunges **only** the listed UIDs. Also `APPENDUID` / `COPYUID` response codes (new UIDs after append/copy/move) and `UIDNOTSTICKY`.                                         | `UIDPLUS`                              | Used inside `messageDelete(range, { uid: true })`, **only if present; otherwise plain `EXPUNGE`** (see §6)                              | **Refuse permanent delete** (existing rule). For move-to-Trash without MOVE, see §6.2.                                         | M4                                               |
| **MOVE**      | 6851 (★) | `UID MOVE <set> <folder>`: atomic copy + delete + expunge **of only those UIDs**. Returns `COPYUID`.                                                                                              | `MOVE`                                 | `messageMove(range, dest, { uid: true })`, but **without MOVE it falls back to COPY + `messageDelete` → plain `EXPUNGE` if no UIDPLUS** | `UID COPY` → `UID STORE +FLAGS \Deleted` → `UID EXPUNGE` (needs UIDPLUS). Neither MOVE nor UIDPLUS: §6.2.                      | M4                                               |
| **CONDSTORE** | 7162     | Per-message modification sequence (`MODSEQ`). `HIGHESTMODSEQ` per folder. `FETCH … (CHANGEDSINCE n)`. `STORE … (UNCHANGEDSINCE n)` = conditional store that fails for messages changed since `n`. | `CONDSTORE` (auto-ENABLEd by imapflow) | `client.mailbox.highestModseq`, `fetch(..., { changedSince })`, `search({ modseq })`, store option `unchangedSince`                     | Rely on UIDVALIDITY + exact UIDs only (current design). Also `[NOMODSEQ]` per folder.                                          | M4 (optional hardening), M5 (incremental backup) |
| **QRESYNC**   | 7162     | Fast resync: `SELECT … (QRESYNC (uidvalidity modseq))` returns changes **and** `VANISHED` (expunged UIDs) since last time.                                                                        | `QRESYNC`                              | `qresync: true` option; expunges then arrive as `VANISHED` via the `expunge` event                                                      | Compare UID lists (`UID SEARCH ALL`) against the cached state.                                                                 | Later (local cache / incremental backup)         |
| **UNSELECT**  | 3691 (★) | Deselects a folder **without** the implicit expunge that `CLOSE` does.                                                                                                                            | `UNSELECT`                             | **not used by imapflow** (switching is done with a new SELECT, which never expunges)                                                    | Select another folder or `EXAMINE` (switching folders doesn't expunge), or just `LOGOUT`. **Never use `CLOSE` as a fallback.** | M4                                               |

### 5.2 Folder discovery & insight

| Extension         | RFC          | What it does                                                                                              | Detect                            | imapflow                                                                                                                                      | If missing                                                                                                                                                                                                             | Needed in |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **SPECIAL-USE**   | 6154 (★)     | LIST returns `\All \Archive \Drafts \Flagged \Junk \Sent \Trash` on system folders. Language-independent. | `SPECIAL-USE`                     | `list()` → `specialUse` + **`specialUseSource: 'extension' \| 'name' \| 'user'`**. Uses legacy `XLIST` automatically if it's the only option. | imapflow already guesses from localised names (`specialUseSource: 'name'`). **Treat `'name'` as unconfirmed: ask the user to confirm the Trash folder before any delete.** Override with the `specialUseHints` option. | M2, M4    |
| XLIST             | Gmail legacy | Old Google precursor of SPECIAL-USE                                                                       | `XLIST`                           | used automatically only if SPECIAL-USE is absent                                                                                              | —                                                                                                                                                                                                                      | —         |
| **LIST-STATUS**   | 5819 (★)     | `LIST … RETURN (STATUS (MESSAGES UNSEEN SIZE))`: counts for all folders in **one** round trip             | `LIST-STATUS`                     | `list({ statusQuery: { messages: true, unseen: true, size: true } })` → `entry.status`                                                        | imapflow falls back to one `STATUS` per folder. Transparent, just slower.                                                                                                                                              | M2        |
| **LIST-EXTENDED** | 5258 (★)     | LIST selection/return options (`SUBSCRIBED`, `CHILDREN`, `SPECIAL-USE`)                                   | `LIST-EXTENDED`                   | used automatically                                                                                                                            | plain LIST + LSUB                                                                                                                                                                                                      | M2        |
| **STATUS=SIZE**   | 8438 (★)     | `STATUS … (SIZE)` = total bytes of a folder in one call                                                   | `STATUS=SIZE`                     | `status(path, { size: true })` → `size`. **Silently dropped if unsupported**, so check `result.size !== undefined`.                           | `UID FETCH 1:* (RFC822.SIZE)` in batches, summed (M2 plan). O(messages).                                                                                                                                               | M2        |
| **QUOTA**         | 2087 → 9208  | `GETQUOTAROOT` / `GETQUOTA`: used/limit for `STORAGE` (KiB) and sometimes `MESSAGE`                       | `QUOTA` (9208 adds `QUOTA=RES-*`) | `getQuota(path?)` → `{ storage: { used, limit, usage }, messages? }` or **`false` if unsupported**                                            | Don't show quota. Show the sum of folder sizes as "approximate" (Gmail: use `\All`, see PROVIDERS.md).                                                                                                                 | M2        |
| **NAMESPACE**     | 2342 (★)     | Personal/other/shared namespace prefix + delimiter (e.g. `INBOX.` on Courier)                             | `NAMESPACE`                       | automatic; paths normalised                                                                                                                   | Assume `""` prefix, delimiter from LIST                                                                                                                                                                                | M2        |
| **CHILDREN**      | 3348         | `\HasChildren` / `\HasNoChildren` on LIST                                                                 | `CHILDREN`                        | automatic flags                                                                                                                               | Infer from paths                                                                                                                                                                                                       | M2        |
| UTF8=ACCEPT       | 6855         | UTF-8 folder names and headers instead of modified UTF-7                                                  | `UTF8=ACCEPT` (auto-ENABLEd)      | automatic; paths always unicode to us                                                                                                         | imapflow encodes/decodes modified UTF-7                                                                                                                                                                                | —         |

### 5.3 Search & fetch performance

| Extension            | RFC               | What it does                                                                       | Detect                | imapflow                                                                           | If missing                                                                                                                           | Needed in                           |
| -------------------- | ----------------- | ---------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| **ESEARCH**          | 4731 (★)          | `SEARCH RETURN (MIN MAX COUNT ALL)`: compact result (UID ranges, count only)       | `ESEARCH`             | `search(q, { uid: true, returnOptions: ['COUNT', 'MIN', 'MAX'] })`                 | Plain `SEARCH` returns all UIDs, so count them client-side. Fine up to ~100k UIDs. imapflow derives the values, except PARTIAL.      | M3                                  |
| SEARCHRES            | 5182 (★)          | `SEARCH RETURN (SAVE)`, then `$` refers to the result set in the next command      | `SEARCHRES`           | not exposed                                                                        | Pass explicit UID sets (we must anyway for plans)                                                                                    | —                                   |
| **WITHIN**           | 5032              | `OLDER <sec>` / `YOUNGER <sec>`: relative-time search with second precision        | `WITHIN`              | **imapflow silently turns `before`/`since` into OLDER/YOUNGER when WITHIN exists** | Day-granular `BEFORE/SINCE`. **Results can differ slightly between servers at day edges.** Acceptable; document in M3.               | M3                                  |
| SORT                 | 5256              | Server-side sorted `UID SORT (REVERSE SIZE) UTF-8 …`                               | `SORT`                | **not supported by imapflow**                                                      | Fetch `size`/`internalDate` and sort client-side (what we do anyway for "top N largest")                                             | —                                   |
| THREAD               | 5256              | Server-side threading                                                              | `THREAD=…`            | not supported                                                                      | Not needed                                                                                                                           | —                                   |
| **BINARY**           | 3516 (★)          | Fetch parts already decoded (no base64 on the wire); `APPEND` with binary literals | `BINARY`              | used automatically in `download()` / append (`disableBinary` to turn off)          | Transfer-encoded fetch, decoded client-side                                                                                          | M5                                  |
| **COMPRESS=DEFLATE** | 4978              | Compresses the whole connection                                                    | `COMPRESS=DEFLATE`    | auto-negotiated                                                                    | Uncompressed (slower backups)                                                                                                        | M5                                  |
| LITERAL+ / LITERAL-  | 7888 (LITERAL- ★) | Non-synchronising literals (fewer round trips)                                     | `LITERAL+`/`LITERAL-` | automatic                                                                          | Synchronising literals                                                                                                               | —                                   |
| PARTIAL              | 9394              | Paged SEARCH/FETCH results                                                         | `PARTIAL`             | via `returnOptions` only with ESEARCH                                              | Slice UID lists client-side                                                                                                          | —                                   |
| **OBJECTID**         | 8474              | Stable `EMAILID` (same across folders/moves), `THREADID`, `MAILBOXID`              | `OBJECTID`            | fetch `emailId`, `threadId`; search `emailId`/`threadId`; `mailbox.mailboxId`      | Gmail: `X-GM-MSGID`/`X-GM-THRID` (imapflow maps to the same fields). Otherwise use the `Message-ID` header + size as the dedupe key. | M5 (dedupe), M4 (verify after move) |
| APPENDLIMIT          | 7889              | Max message size APPEND accepts                                                    | `APPENDLIMIT=n`       | checked in `append()`; `mailbox.appendlimit`                                       | Try and handle `NO [TOOBIG]`                                                                                                         | Restore                             |
| MULTIAPPEND          | 3502              | Many messages in one APPEND                                                        | `MULTIAPPEND`         | not exposed                                                                        | One APPEND per message                                                                                                               | —                                   |

### 5.4 Session & auth

| Extension                               | RFC             | What it does                                                     | Detect                                   | imapflow                                                              | If missing                                                                                                                      | Needed in   |
| --------------------------------------- | --------------- | ---------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **AUTH=PLAIN / LOGIN**                  | 4616            | Username/password over TLS                                       | `AUTH=PLAIN`, absence of `LOGINDISABLED` | `auth: { user, pass }`, chosen automatically                          | —                                                                                                                               | M1          |
| **AUTH=XOAUTH2** / **AUTH=OAUTHBEARER** | Google/MS, 7628 | OAuth2 access token instead of password                          | `AUTH=XOAUTH2`, `AUTH=OAUTHBEARER`       | `auth: { user, accessToken }`                                         | Password / app password. Outlook.com effectively has no fallback (PROVIDERS.md).                                                | M6          |
| SASL-IR                                 | 4959 (★)        | Initial SASL response in the same command (one fewer round trip) | `SASL-IR`                                | automatic                                                             | extra round trip                                                                                                                | —           |
| **ENABLE**                              | 5161 (★)        | Client opt-in for extensions (CONDSTORE, QRESYNC, UTF8, rev2)    | `ENABLE`                                 | automatic; result in `client.enabled`                                 | CONDSTORE is still implicitly enabled by the first CONDSTORE-using command                                                      | —           |
| **IDLE**                                | 2177 (★)        | Server pushes new/expunged messages in real time                 | `IDLE`                                   | auto-IDLE; `idle()`; `missingIdleCommand: 'NOOP'\|'SELECT'\|'STATUS'` | Poll with NOOP/STATUS. **Not needed for a CLI; set `disableAutoIdle: true`.** Relevant to M6 jobs only if they watch mailboxes. | —           |
| ID                                      | 2971            | Exchange client/server name+version                              | `ID`                                     | `clientInfo`; `client.serverInfo`                                     | —                                                                                                                               | Diagnostics |
| STARTTLS                                | 3501            | Upgrade a plaintext 143 connection to TLS                        | `STARTTLS`                               | `doSTARTTLS`                                                          | **Out of scope** (993 implicit TLS only, PROVIDERS.md open question)                                                            | —           |

### 5.5 Gmail: `X-GM-EXT-1`

One capability token covers all of these:

| Feature       | What it does                                                                                               | imapflow                                                                           | Use                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `X-GM-RAW`    | Gmail web search syntax on the server: `larger:5M older_than:2y from:x has:attachment category:promotions` | `search({ gmraw: '…' })`. **Throws `MissingServerExtension` on non-Gmail servers** | Big M3 win: `has:attachment` and `category:` done server-side. Optional speed-up. Standard criteria must still work. |
| `X-GM-MSGID`  | Stable message ID across all labels                                                                        | fetch `emailId`                                                                    | Dedupe in stats/backups; verify a delete                                                                             |
| `X-GM-THRID`  | Thread ID                                                                                                  | fetch `threadId`                                                                   | —                                                                                                                    |
| `X-GM-LABELS` | Read/change labels on a message                                                                            | fetch `labels`; `messageFlagsAdd(range, labels, { useLabels: true })`              | Show the labels a message carries before delete                                                                      |

Gmail behaviour that isn't a capability: see PROVIDERS.md (labels = folders, `\All` for totals, delete = move to `\Trash`, 2500 MB/day, ~15 connections). Also, Gmail's IMAP settings ("Auto-Expunge", "when a message is marked deleted") change what `\Deleted` + EXPUNGE do in label folders. The only unambiguous delete path is **move to `\Trash`**.

### 5.6 Gmail search (`X-GM-RAW`) checked against our own search

**Decision (2026-09-22):** on Gmail, filters also compile to `X-GM-RAW`. Gmail's result is never trusted on its own; it is cross-checked against the standard IMAP search (below).

`X-GM-RAW` runs Gmail's web search syntax inside the **selected folder** (Google: arguments are "interpreted in the same manner as in the Gmail web interface"). Folder scope therefore comes from which folder we open. We never use the `in:` or `label:` operators.

#### Mapping: our filter → Gmail operator, and known differences

| Our filter                                                     | Standard IMAP (our definition)                                  | `X-GM-RAW`                                        | Where the two can disagree                                                                                                                                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from` address / `@domain`                                     | `FROM "<value>"` (substring) + exact-address/domain post-filter | `from:<value>`                                    | IMAP matches substrings; Gmail matches tokens and display names, may include subdomains. **Both paths go through the same exact post-filter**, so the remaining difference should be zero.  |
| `to` / `cc` / `bcc`                                            | `TO` / `CC` / `BCC` substring + post-filter                     | `to:` / `cc:` / `bcc:`                            | Same as `from`. Gmail does no alias expansion in API search (Google docs).                                                                                                                  |
| `subject` contains                                             | `SUBJECT "<text>"` (substring)                                  | `subject:"<text>"`                                | Gmail matches words: `invoice` may miss `invoices` or `prefix-invoice`. Expected difference.                                                                                                |
| `body` / `text`                                                | `BODY` / `TEXT` (server-dependent)                              | `"<text>"`                                        | Word vs substring; IMAP `TEXT` also searches headers. Expected difference.                                                                                                                  |
| `since` / `before` (date)                                      | `SINCE` / `BEFORE` (internal date, whole days, server timezone) | `after:<epoch>` / `before:<epoch>`                | Gmail reads plain dates as **midnight PST** (Gmail API docs), so we always send **epoch seconds**. IMAP is day-granular, so messages near midnight can differ. Expected, at the edges only. |
| `olderThan` / `newerThan`                                      | converted to a date once, at plan time                          | converted to the same epoch (not `older_than:`)   | Both paths use the same "now". Same day-edge caveat.                                                                                                                                        |
| `larger` / `smaller`                                           | `LARGER` / `SMALLER` (RFC822.SIZE)                              | `larger:<bytes>` / `smaller:<bytes>`              | Gmail's size may be computed differently. Expect differences only near the threshold.                                                                                                       |
| `seen` / `flagged`                                             | `SEEN`/`UNSEEN`, `FLAGGED`/`UNFLAGGED`                          | `is:read`/`is:unread`, `is:starred`/`-is:starred` | Should be identical.                                                                                                                                                                        |
| `answered`                                                     | `ANSWERED`                                                      | none                                              | No Gmail operator: this part always runs as standard IMAP.                                                                                                                                  |
| `hasAttachments`                                               | client-side `BODYSTRUCTURE` check                               | `has:attachment`                                  | Gmail's definition (inline images, calendar invites, forwarded `.eml`) differs from ours. **The criterion most likely to differ.**                                                          |
| `all` / `any` / `not`                                          | AND / `OR` / `NOT`                                              | space / `OR` or `{a b}` / `-`, parentheses        | Should be identical.                                                                                                                                                                        |
| Gmail-only (`category:`, `filename:`, `list:`, `is:important`) | none                                                            | as written                                        | **Cannot be cross-checked.** Allowed in search; before a delete the user is told these criteria have no independent check (they still review every message, §6.4).                          |

**Building the query:** the Gmail query is built only from validated filter fields, never from raw user text. Values are wrapped in double quotes; values containing `"` are rejected, because that would let a value inject extra Gmail operators. imapflow sends the string as an IMAP literal with `CHARSET UTF-8` when needed, so IMAP-level quoting is handled.

#### Cross-check procedure

1. For each folder, in the same session and under the same UIDVALIDITY, run both:
   - **S** = standard `UID SEARCH` + post-filters
   - **G** = `X-GM-RAW` + the same post-filters
2. Compare:
   - **S = G** → "verified by both searches".
   - Otherwise report `only in Gmail search: n`, `only in standard search: m`, with sample rows. Explain the likely cause using the table above (e.g. "subject word vs substring").
3. What the result is used for:
   - **`mm search` (read-only):** shows S, plus the comparison line. `--gmail-only` skips S for speed when the user accepts Gmail's semantics.
   - **Delete plans:** the plan contains **only S ∩ G**, the messages both searches agree on. Messages found by only one search appear in a separate "excluded: searches disagree" list. The user can add them explicitly after seeing them. Gmail-only criteria (no S) → G is used, with the notice above.
4. **Tests.** The seeded `mm-test` folder on the Gmail test account covers each mapping row with a case built to sit on the known edge. The integration test asserts `S = G` except for a documented list of expected differences. An **unexpected difference fails the test**. That list lives next to the test and doubles as the user-facing explanation.

---

## 6. Deleting safely

### 6.1 `messageDelete()` and `messageMove()` can issue a folder-wide EXPUNGE

- `messageDelete(range, { uid: true })` (`commands/expunge.js`):
  1. Adds `\Deleted` to the range.
  2. Sends `UID EXPUNGE <range>` **only if the server has `UIDPLUS`**. **Otherwise it sends plain `EXPUNGE`.** That permanently removes _every_ `\Deleted` message in the folder, including ones another client flagged.
- `messageMove(range, dest, { uid: true })` (`commands/move.js`):
  1. Uses `UID MOVE` if the server has `MOVE`.
  2. **Otherwise it calls `messageCopy` + `messageDelete`**, which falls into the same plain-`EXPUNGE` path when UIDPLUS is also missing.
- `mailboxClose()` sends `CLOSE`, which also expunges implicitly.

**Therefore `delete.ts` (M4) must never call these without checking capabilities first.** Rules for the implementation:

- Call `messageMove` only when `features.move` is true. Call `messageDelete` only when `features.uidplus` is true. Otherwise use our own fallback (§6.2).
- Never call `mailboxClose()` on a writable folder, and never rename/delete the selected folder. Release the lock and log out.
- Unit test: a fake session without UIDPLUS/MOVE must never see `messageDelete`/`EXPUNGE`/`CLOSE` (extends the existing M4 test "folder-wide expunge never called").

### 6.2 Delete strategy matrix

Decided with the user on 2026-09-22: when the requested operation isn't supported, the app **says so, explains what it will do instead, and asks**. Nothing falls back silently.

| Server has     | Move to Trash (default)                                                                                                                                                                                                                                                    | Permanent delete (`--expunge`)                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOVE + UIDPLUS | `UID MOVE`                                                                                                                                                                                                                                                                 | `UID STORE +FLAGS \Deleted` → `UID EXPUNGE <set>`                                                                                                                                              |
| MOVE only      | `UID MOVE`                                                                                                                                                                                                                                                                 | **Notice:** "This server can't permanently delete only selected messages (UIDPLUS missing). The messages will be **moved to Trash instead**." Confirm → Trash path. Decline → nothing happens. |
| UIDPLUS only   | `UID COPY` → `UID STORE +FLAGS \Deleted` → `UID EXPUNGE <set>`, with a notice that the move is done as copy + delete                                                                                                                                                       | `\Deleted` → `UID EXPUNGE <set>`                                                                                                                                                               |
| neither        | **Notice + confirm:** "This server can't move messages. They will be **copied to Trash** and **marked deleted** in the original folder; most mail apps hide them, and they disappear the next time any mail app empties deleted messages." See §6.3 for the other options. | **Notice:** permanent delete isn't possible → offer the Trash copy + mark path above.                                                                                                          |
| Gmail (any)    | `UID MOVE` to `\Trash` (never `\Deleted` in a label folder)                                                                                                                                                                                                                | Move to `\Trash`, then `UID EXPUNGE <set>` **in Trash**                                                                                                                                        |

Every notice is shown **before** the message list and the two confirmations (§6.4). Declining means nothing is changed.

Before every batch: UIDVALIDITY check (existing rule). Optional hardening with CONDSTORE: `STORE … (UNCHANGEDSINCE <modseq-at-plan>)` so messages that changed after planning are skipped and reported. imapflow returns the modified set.

Check `[UIDNOTSTICKY]` / `mailbox.readOnly` / `permanentFlags` lacking `\Deleted` on SELECT. If any is present, refuse to execute in that folder and say why.

### 6.3 Deleting when the server has neither MOVE nor UIDPLUS

IMAP4rev1 has only one command that removes messages from a folder: `EXPUNGE`, which is folder-wide. (`CLOSE` does the same implicitly.) There is no targeted delete without UIDPLUS. The possible approaches:

| Option                                             | How                                                                                                                                                                    | Risk                                                                                                                                                                                                       | Status                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **A. Copy to Trash + mark `\Deleted`, no expunge** | `UID COPY` → `UID STORE +FLAGS \Deleted`. The source copies stay, flagged. Most clients hide or strike them through, and they go at the next expunge by any client.    | None to other mail. The source folder still holds the data until something expunges it.                                                                                                                    | **Default** for this case (§6.2)                                                                          |
| **B. Guarded plain `EXPUNGE`**                     | 1. Mark planned UIDs `\Deleted`. 2. `UID SEARCH DELETED`. 3. **Only if the result equals exactly the planned set**, send `EXPUNGE`. Otherwise un-flag ours and stop.   | A message another client flags `\Deleted` in the milliseconds between step 2 and 3 would also be expunged. That message was already marked for deletion by that client, but its "undelete" chance is lost. | **Not allowed today.** CLAUDE.md says "never issue a folder-wide EXPUNGE". Needs an explicit rule change. |
| C. Foreign `\Deleted` messages present             | Variant of B when step 2 finds messages flagged by someone else: show them to the user. Choices: cancel, or include them (they're listed and confirmed like the rest). | The user decides with full information.                                                                                                                                                                    | Only together with B                                                                                      |
| D. Un-flag others, expunge, re-flag                | Temporarily remove `\Deleted` from foreign messages, expunge, restore the flags.                                                                                       | Changes other clients' state and has its own race. **Rejected.**                                                                                                                                           | Rejected                                                                                                  |
| E. Delete a whole folder                           | `DELETE <folder>` removes the folder and everything in it.                                                                                                             | Only valid when the user wants that entire folder gone. A separate, explicit "delete folder" feature, never a trick for message deletes.                                                                   | Possible later feature                                                                                    |
| F. Provider-side                                   | Webmail "empty Trash", the server's auto-purge of Trash (often 30 days), or the Gmail API / Microsoft Graph.                                                           | Outside our control.                                                                                                                                                                                       | Documented as a hint in the notice                                                                        |

Practically, this case is rare. UIDPLUS is present on every major provider we know of (§7). It matters mainly for old Courier / hMailServer installations.

### 6.4 Confirmation flow for every delete

Decided with the user on 2026-09-22. It applies to both Trash moves and permanent deletes.

1. **Plan** (read-only, `EXAMINE`): exact UIDs per folder, UIDVALIDITY, totals. On Gmail, only messages both searches agree on (§5.6).
2. **Notices**, each needing `y` (default No):
   - **Capability fallback** (§6.2), e.g. "permanent delete not supported → moving to Trash instead".
   - **Trash folder**: always printed, with how it was found (§6.5).
   - Gmail: label-folder semantics; search disagreements; Gmail-only criteria that can't be cross-checked.
3. **Full list of every message** in the plan, not just samples. Columns: folder, date, from, subject, size, plus labels on Gmail. Totals appear at the top and bottom. The list is paged in the terminal (`$PAGER`, otherwise built-in pages of 50). `--list-file <path>` also writes it to a local file (mode 600) for large plans.
   - The list is **only displayed and written locally, never sent to Supabase** (data-minimisation rule).
   - Building it costs an ENVELOPE fetch over all planned UIDs, batched and with progress. For 100k messages this takes minutes. The user is told the estimate first.
4. **Confirmation 1:** "Move 1,234 messages (512 MB) from 3 folders to Trash `Deleted Items`? [y/N]".
5. **Confirmation 2:** type the exact count (`1234`). For permanent delete, type `DELETE 1234`.
6. **Execute** exactly the planned UIDs: UIDVALIDITY re-check before each batch; UIDs already gone are skipped and reported.
7. **Result** summary and audit row.

`mm delete` is **interactive only**. It refuses to run without a TTY, and `--yes` is removed. `--max N` stays as a safety ceiling (abort if the plan is larger). Unattended deletes (M6 scheduled jobs) will need their own approval design.

### 6.5 Choosing the Trash folder

Decided with the user on 2026-09-22: **always tell the user which Trash is used and why.** If it wasn't identified by the server, confirm it. If there are several candidates, find the root one and let the user choose.

1. **Server-marked:** exactly one folder flagged `\Trash` by SPECIAL-USE/XLIST (`specialUseSource: 'extension'`) → use it, and still print "Trash: `Deleted Items` (marked by the server)". If the server flags several → treat them as multiple candidates (step 3).
2. **Name scan:** we run our **own** scan of the full LIST output. imapflow picks a single winner by priority and doesn't report the losers. A candidate is any selectable folder (not `\Noselect`/`\NonExistent`) whose **leaf name** matches a known Trash name, case-insensitively:
   - `Trash`, `Deleted`, `Deleted Items`, `Deleted Messages`, `Bin`
   - `Kôš`, `Koš`, `Odstránené`, `Odstraněné položky`, `Papierkorb`, `Gelöschte Elemente`, `Corbeille`, `Papelera`, `Cestino`, `Kosz`
   - imapflow's list (`special-use.js`) has ~130 localised names and can be used as a reference.
3. **Find the root Trash** among the candidates. Ranking, first rule wins:
   1. **Top level of the personal namespace** (from `NAMESPACE`): `Trash` on most servers, `INBOX.Trash` on Courier-style servers where everything lives under `INBOX.`. Nested ones like `Archive/Trash` or `Projects/Old/Trash` are "probably a user folder".
   2. An exact common name beats a fuzzy match.
   3. Subscribed beats unsubscribed.
   4. **Most recent activity** (newest message's internal date, via `fetch('*', { internalDate })`). Webmail keeps moving deleted mail into the real Trash.
   5. More messages.
4. **Always show every candidate** with path, level, message count, newest message date and the reason it ranked where it did. Mark the proposal and let the user pick (Enter = proposal). This applies even to a single name-found candidate.
   - Typical case: Exchange without SPECIAL-USE, where `Deleted Items` (real) and `Trash` (created by Thunderbird) both exist at the top level. Rule 4 usually separates them, and the user makes the final call.
5. **Remember the choice** on the account: `trash_path`, `trash_source` (`extension` | `name` | `user`), `trash_confirmed_at`. That's account configuration, not message data, so it's allowed in Supabase. Later runs pass it to imapflow as `specialUseHints: { trash }`, still print it, and re-check that it exists. If the server later starts flagging a _different_ folder as `\Trash`, the user is told and asked again.
6. **No candidate found:** say so, list all folders for the user to pick from, or cancel. **Never create a Trash folder automatically**: the provider's webmail wouldn't treat it as Trash.

---

## 7. Expected capabilities by provider (verify in M1)

Best-known values; **not measured by this project yet**. Replace with real `mm account test` output.

| Capability  | Gmail                       | Outlook / M365                        | Yahoo          | iCloud | Dovecot (typical) |
| ----------- | --------------------------- | ------------------------------------- | -------------- | ------ | ----------------- |
| UIDPLUS     | ✔                           | ✔                                     | ✔              | ✔      | ✔                 |
| MOVE        | ✔                           | ✔                                     | ✔              | ?      | ✔                 |
| SPECIAL-USE | ✔ (+XLIST)                  | ?                                     | ✔/XLIST        | ?      | ✔                 |
| QUOTA       | ✔                           | ✘                                     | ?              | ✔      | ✔ (if configured) |
| STATUS=SIZE | ✘                           | ✘                                     | ✘              | ✘      | ✔ (2.3+)          |
| LIST-STATUS | ✔                           | ✘                                     | ?              | ?      | ✔                 |
| CONDSTORE   | ✔                           | ✘                                     | ?              | ✔?     | ✔                 |
| QRESYNC     | ✘                           | ✘                                     | ✘              | ?      | ✔                 |
| ESEARCH     | ✔                           | ✘                                     | ?              | ?      | ✔                 |
| WITHIN      | ✘                           | ✘                                     | ✘              | ✘      | ✔                 |
| OBJECTID    | ✘ (X-GM-MSGID)              | ✘                                     | ✘              | ✘      | ✔ (2.3+)          |
| IMAP4rev2   | ✘                           | ✘                                     | ✘              | ✘      | ✔ (recent)        |
| COMPRESS    | ✔                           | ✘                                     | ?              | ?      | ✔ (if enabled)    |
| IDLE        | ✔                           | ✔                                     | ✔              | ✔      | ✔                 |
| AUTH        | PLAIN, XOAUTH2, OAUTHBEARER | PLAIN*, XOAUTH2 (*basic auth retired) | PLAIN, XOAUTH2 | PLAIN  | PLAIN (+others)   |

Takeaways:

- **UIDPLUS and IDLE are effectively universal** on the providers we target. The "refuse permanent delete" branch will be rare but must exist.
- **STATUS=SIZE is rare**, so the M2 size path will mostly be the `FETCH RFC822.SIZE` fallback. Performance there matters (M2 open question).
- **Outlook is the most minimal**: no QUOTA, no LIST-STATUS, no ESEARCH, no CONDSTORE. Test fallbacks against it once OAuth exists (M6).

---

## 8. Alternatives when IMAP itself isn't enough

| Need                          | IMAP answer                                        | Alternative                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Has attachments" filter      | Fetch `BODYSTRUCTURE`, check client-side (M3 plan) | Gmail `X-GM-RAW has:attachment`. Some servers support the `$HasAttachment` keyword (RFC 8457) → `KEYWORD $HasAttachment` search. Detect via PERMANENTFLAGS / trial. |
| Fast stats on huge mailboxes  | `STATUS SIZE`, else batched `FETCH RFC822.SIZE`    | Local metadata cache with CONDSTORE/QRESYNC incremental sync (TODO "Later"). Gmail API `users.getProfile` / Graph folder `sizeInBytes`.                             |
| Bulk delete of 100k messages  | Batched `UID MOVE` (~500 UIDs)                     | Gmail API `batchDelete` / Graph `$batch`. Needs OAuth with restricted scopes; out of scope.                                                                         |
| Quota when `QUOTA` is missing | —                                                  | Show the approximate folder-size sum; provider web UI link                                                                                                          |
| Outlook without basic auth    | `AUTH=XOAUTH2` (M6)                                | Microsoft Graph Mail API                                                                                                                                            |
| Modern protocol               | —                                                  | JMAP (Fastmail, Stalwart, Cyrus). Possible second backend behind the same core interfaces.                                                                          |

---

## 9. Implementation checklist derived from this research

M1 (`imap/session.ts`):

- [ ] Connect with `secure: true`, port 993, `tls.rejectUnauthorized: true`, `disableAutoIdle: true`, `logger` redacting (imapflow already hides credentials in logs; still wrap it).
- [ ] Build `ServerFeatures` from `capabilities` + `enabled` with rev2 folding. Store the raw list in `mail_accounts.capabilities`. Print it in `mm account test`.
- [ ] Map errors: `AUTHENTICATIONFAILED`, `LOGINDISABLED`, TLS errors, `CONNECT_TIMEOUT`, `MissingServerExtension`.
- [ ] Carry UIDVALIDITY as `bigint` → string at the zod/DB boundary.

M2:

- [ ] Use `list({ statusQuery: { messages, unseen, size } })`. Fall back to batched `fetch({ size })` when `status.size` is undefined.
- [ ] `getQuota()` returning `false` → hide the quota line.
- [ ] Gmail totals from the `\All` folder only.

M3:

- [ ] Compile filters to imapflow `SearchObject` (keys: `from to cc bcc subject body text header before since on sentBefore sentSince sentOn larger smaller seen flagged answered deleted draft keyword uid or not emailId threadId gmraw`).
- [ ] Gmail (`features.gmail`): also compile to `X-GM-RAW` (§5.6: quoted values, epoch dates) and cross-check S vs G. `mm search` prints the comparison; `--gmail-only` skips the standard search.
- [ ] Integration test on the Gmail test account: one seeded case per mapping row; `S = G` except the documented expected differences.
- [ ] Document WITHIN day-edge differences. Use `returnOptions: ['COUNT']` for count-only when ESEARCH is available.

M4:

- [ ] Implement §6.2 with a notice + confirm for every fallback. Never call `messageDelete`/`messageMove`/`mailboxClose` outside their safe preconditions.
- [ ] Confirmation flow §6.4: notices → full paged message list (`--list-file`) → confirm → type the count (`DELETE <n>` for permanent). Interactive only; no `--yes`.
- [ ] Trash selection §6.5: own candidate scan, root ranking, always show, save the choice on the account (new migration: `trash_path`, `trash_source`, `trash_confirmed_at`).
- [ ] Gmail delete plans = S ∩ G; disagreements listed separately.
- [ ] Use `EXAMINE` (readOnly) for planning and `SELECT` only for execute. Check `readOnly`, `permanentFlags`, `UIDNOTSTICKY`.
- [ ] Optional: `UNCHANGEDSINCE` guard when CONDSTORE is enabled and the folder isn't `noModseq`.

M5:

- [ ] Dedupe key: `emailId` (OBJECTID / X-GM-MSGID), otherwise `Message-ID` + size + internal date.
- [ ] `download()` streams, BINARY/COMPRESS automatic. Respect Gmail's daily limit.

## 10. Decisions and open questions

Decided with the user on 2026-09-22:

- Unsupported operation → notice explaining the substitute (e.g. Trash instead of permanent delete), then confirm (§6.2).
- Every delete: full message list + two confirmations (§6.4).
- Trash found only by name: scan all candidates, find the root one, always tell the user (§6.5).
- Gmail: use `X-GM-RAW`, always cross-checked against the standard search (§5.6).

Open:

1. **Guarded plain `EXPUNGE` (§6.3 option B)** for servers with neither MOVE nor UIDPLUS: allow it (it needs a CLAUDE.md rule change), or keep option A (copy + mark deleted) only? Proposal: keep A only. UIDPLUS is near-universal, so B's residual race isn't worth a rule exception.

## References

- RFC 3501 (IMAP4rev1), RFC 9051 (IMAP4rev2), RFC 4315 (UIDPLUS), RFC 6851 (MOVE), RFC 7162 (CONDSTORE/QRESYNC), RFC 6154 (SPECIAL-USE), RFC 5819 (LIST-STATUS), RFC 8438 (STATUS=SIZE), RFC 9208 (QUOTA), RFC 4731 (ESEARCH), RFC 5032 (WITHIN), RFC 5256 (SORT/THREAD), RFC 8474 (OBJECTID), RFC 3516 (BINARY), RFC 4978 (COMPRESS), RFC 2177 (IDLE), RFC 5161 (ENABLE), RFC 3691 (UNSELECT), RFC 2971 (ID), RFC 7889 (APPENDLIMIT), RFC 8457 ($HasAttachment), RFC 7628 (OAUTHBEARER).
- IANA IMAP capabilities registry: https://www.iana.org/assignments/imap-capabilities/
- Gmail IMAP extensions: https://developers.google.com/gmail/imap/imap-extensions
- Gmail search operators and date/timezone rules (Gmail API): https://developers.google.com/gmail/api/guides/filtering · https://support.google.com/mail/answer/7190
- imapflow: https://imapflow.com/ · source verified from npm `imapflow@2.0.5`.
