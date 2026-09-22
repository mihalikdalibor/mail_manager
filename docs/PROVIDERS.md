# Providers & account discovery

Goal: the user types an email address and (usually) a password — the app figures out the rest.

## Three tiers (decided 2026-09-22)

1. **Autodetect** — `discover()` in `src/core/providers/discover.ts`, no login, no password. Sources are tried **one after another** and discovery stops at the first hit:
   1. **Preset by email domain** (`presets.json` `domains`) — offline.
   2. **Preset by MX suffix** — the domain's MX records, lowest preference first, matched on a label boundary against `mxSuffixes` (longest suffix wins). This is the main path for custom domains on SK/CZ hostings, e.g. MX `mx10.websupport.sk` / `mx20.websupport.sk` → Websupport → `imap.m1.websupport.sk`. Google Workspace and Microsoft 365 domains are recognised the same way.
   3. **Mozilla ISPDB** — `https://autoconfig.thunderbird.net/v1.1/<domain>`.
   4. **Provider autoconfig, HTTPS only** — `https://autoconfig.<domain>/mail/config-v1.1.xml`, then `https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml`.
   5. **DNS SRV** — `_imaps._tcp.<domain>` (RFC 6186; target `.` = not offered).
2. **Provider picker** — when autodetect finds nothing (e.g. proxied DNS / a mail gateway in front of the hosting), the user picks the provider from the preset list (SK/CZ first, then global; blocked providers are shown but can't be selected).
3. **Manual entry** — IMAP host (host name only; IP literals, `localhost`, ports and URLs are refused; port is always 993) and username (default: the full email address).

`mm discover <email>` runs all three tiers; `mm account add` (M1c) reuses `discover()` and the CLI prompt helper `chooseImapSettings()`.

Rules:

- **Implicit TLS on 993 only.** Results that offer only STARTTLS/143 or another port are skipped with a notice. STARTTLS-only servers remain out of MVP scope.
- Every result is shown to the user and (from M1c) **login-tested before saving**. Settings from ISPDB/autoconfig/SRV carry a notice that they aren't a built-in preset, so the host can be checked before a password is typed.
- **Privacy:** ISPDB receives only the domain; autoconfig requests go to the domain's own servers and don't include the address (no `?emailaddress=`). Because lookups are sequential, later sources are never contacted after a hit — a Websupport MX match never reaches Mozilla.
- **Untrusted input:** every host from DNS or XML and every redirect target passes a strict host-name check (no IP literals, `localhost`, control characters, non-default ports); redirects are followed manually and only to `https:` (at most 3), and the deadline covers the response body too; printed text (usernames, domains) may not contain control, zero-width or bidi-override characters; response bodies are capped at 256 KiB; XML is validated before parsing (fast-xml-parser, entity processing and value coercion off). Why a dependency: the XML comes from servers the domain owner controls, and a maintained parser (MIT, small, no native code) is safer than hand-rolled parsing. Only error codes, validated host names (IP addresses in any form — including hex/octal like `0x7f.0x1` — are refused) and a server-provided username whose template must be one printable-ASCII token (no spaces, no Unicode look-alikes or blank characters; the user's own validated address is filled in afterwards) reach the output; no free server text.
- **SSRF note:** autoconfig hosts are controlled by the domain owner and may resolve to private addresses. Acceptable for the local CLI; must be blocked before discovery runs on a server (M6, see `docs/milestones/M6-beta.md`).

## Domain check (plain-language errors)

The MX lookup also tells us about the domain itself (`domainProblem` on the result); `mm discover` explains it in plain words. These hints are **informational and never block** the provider picker or manual entry. Missing MX records (`ENODATA`, null MX) are deliberately **not** reported: IMAP doesn't depend on MX, and a mailbox can work on a domain without them.

| DNS answer               | Meaning                    | What the user is told                                                                                                                                                                    | Discovery                                                                  |
| ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ENOTFOUND`              | domain doesn't exist       | "…does not exist. Check the email address for typos. If the domain has expired but the mailbox still exists at your provider, you can still choose the provider or enter its IMAP host." | online lookups stop (nothing sent to Mozilla); picker/manual still offered |
| `ESERVFAIL` / `EREFUSED` | the domain's DNS is broken | "…answered with an error… try again later, or ask whoever manages the domain."                                                                                                           | continues                                                                  |
| timeout / other          | DNS unreachable            | "Could not reach DNS… check your internet connection."                                                                                                                                   | continues (picker/manual still work)                                       |

Preset hosts are checked live by `tests/integration/presets-live.test.ts` (TLS on 993, valid certificate, IMAP greeting; no login).

## GeoIP hint (on connection failure)

Some mail hosts let the mailbox owner restrict IMAP logins by country (GeoIP). A blocked login looks like a network failure (timeout / connection refused) even with the right host and password. Discovery results carry **no** GeoIP text. From M1b-2 on, when a connection fails, `geoIpNotice()` (`src/core/providers/geoip.ts`) is printed: _"The connection was not successful. First check that the email address, password and IMAP server are correct. If they are, check whether GeoIP (country) security is turned on for this mailbox at your mail host. If it is, allow &lt;country&gt;, or turn GeoIP off while Mail Manager connects."_ The CLI names the country of this computer's public IP; the server variant names the server's country, with an optional region because the hosting isn't decided yet (local now, later Vercel or a VPS). Wherever the server is deployed, that hosting country must be configured so the message names it (CLAUDE.md).

## Preset format

`src/core/providers/presets.json`, validated by the zod schema in `presets.ts` when the module loads (unknown keys rejected; ids, domains and MX suffixes unique across presets):

```json
{
  "id": "websupport",
  "name": "Websupport",
  "group": "sk-cz",
  "domains": [],
  "mxSuffixes": ["websupport.sk"],
  "imap": { "host": "imap.m1.websupport.sk", "port": 993 },
  "altHosts": ["imap.websupport.sk"],
  "auth": ["password"],
  "hint": "Log in with your full email address and mailbox password.",
  "helpUrl": "https://www.websupport.sk/podpora/kb/postove-protokoly/",
  "verified": true
}
```

- `group`: `sk-cz` | `global` (picker grouping). `domains`: public mailbox domains (empty for pure hostings). `mxSuffixes`: label suffixes of the MX hosts customers point their domain to.
- `imap: null` + `hostHint`: the host differs per mailbox (WEDOS) — the user is asked for it.
- `auth`: `password` | `app_password` | `oauth2`. `blocked`: the provider is recognised but unusable today (Outlook until M6 OAuth); the reason is shown.
- `verified: true` only with an official `helpUrl` stating the host with SSL on 993. `verified: false` presets are shown with a warning.
- Presets log in with the full email address. Settings from ISPDB/autoconfig use the username template the document gives (e.g. only the local part); manual entry lets the user type any username.

## Presets (researched 2026-09-22)

Every host was resolved and a TLS handshake on 993 with certificate verification succeeded (greeting only, no login).

| Provider                    | id             | IMAP host             | Email domains                               | MX suffixes                                             | Auth                   | Verified                                                                                                                                             |
| --------------------------- | -------------- | --------------------- | ------------------------------------------- | ------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Websupport                  | `websupport`   | imap.m1.websupport.sk | —                                           | websupport.sk                                           | password               | ✔ [source](https://www.websupport.sk/podpora/kb/postove-protokoly/)                                                                                  |
| WebHouse                    | `webhouse`     | mail.webhouse.sk      | —                                           | webhouse.sk                                             | password               | ✔ [source](https://helpdesk.webhouse.sk/468268-Ako-nastavi%C5%A5-Mozilla-Thunderbird-pre-pr%C3%ADjem-a-odosielanie-po%C5%A1ty)                       |
| Webglobe (CZ)               | `webglobe-cz`  | mail.webglobe.cz      | —                                           | webglobe.cz                                             | password               | ✔ [source](https://www.webglobe.cz/poradna/jake-parametry-pro-nastaveni-emailoveho-klienta-pouzit)                                                   |
| Webglobe (SK)               | `webglobe-sk`  | mail.webglobe.sk      | —                                           | mx-hub.sk, mx-hub.cz, mx-hub.net, mx-hub.eu             | password               | ✔ [source](https://www.webglobe.sk/poradna/manualne-nastavenie-mail-klienta)                                                                         |
| Active24                    | `active24`     | email.active24.com    | —                                           | active24.com                                            | password               | ✔ [source](https://faq.active24.com/eng/503249-POP-and-IMAP---email-client-settings-Outlook-Thunderbird-Apple)                                       |
| HostCreators                | `hostcreators` | imap.hostcreators.sk  | —                                           | hostcreators.sk                                         | password               | ✔ [source](https://www.hostcreators.sk/pomoc/e-mail/ako-si-precitat-e-maily.html)                                                                    |
| Forpsi                      | `forpsi`       | imap.forpsi.com       | —                                           | forpsi.com                                              | password               | ✔ [source](https://support.forpsi.com/kb/a3969/email-clients-settings.aspx)                                                                          |
| WEDOS                       | `wedos`        | _per mailbox_         | —                                           | wedos.net                                               | password               | ✔ [source](https://kb.vedos.cz/maily-smtp-pop3-imap/)                                                                                                |
| Seznam.cz                   | `seznam`       | imap.seznam.cz        | seznam.cz, email.cz, post.cz, spoluzaci.cz  | seznam.cz                                               | password, app_password | ✔ [source](https://o-seznam.cz/napoveda/email/mohlo-by-se-hodit/postovni-programy-a-aplikace/)                                                       |
| Zoznam                      | `zoznam`       | imap.zoznam.sk        | zoznam.sk                                   | —                                                       | password               | ✘ unverified                                                                                                                                         |
| Azet                        | `azet`         | imap.azet.sk          | azet.sk                                     | —                                                       | password               | ✘ unverified                                                                                                                                         |
| Centrum.sk                  | `centrum-sk`   | imap.centrum.sk       | centrum.sk                                  | —                                                       | password               | ✔ [source](https://pomoc.centrum.sk/problem-category/other/emailClientAccess)                                                                        |
| Atlas.sk                    | `atlas-sk`     | imap.atlas.sk         | atlas.sk                                    | —                                                       | password               | ✔ [source](https://pomoc.centrum.sk/problem-category/other/emailClientAccess)                                                                        |
| Pobox.sk                    | `pobox-sk`     | imap.pobox.sk         | pobox.sk                                    | —                                                       | password               | ✔ [source](https://pomoc.centrum.sk/problem-category/other/emailClientAccess)                                                                        |
| Centrum.cz                  | `centrum-cz`   | imap.centrum.cz       | centrum.cz                                  | —                                                       | password               | ✔ [source](https://freemail.help.economia.cz/articles/44668-adresy-postovnich-serveru)                                                               |
| Atlas.cz                    | `atlas-cz`     | imap.atlas.cz         | atlas.cz                                    | —                                                       | password               | ✔ [source](https://freemail.help.economia.cz/articles/44668-adresy-postovnich-serveru)                                                               |
| Volny.cz                    | `volny-cz`     | imap.volny.cz         | volny.cz                                    | —                                                       | password               | ✔ [source](https://freemail.help.economia.cz/articles/44668-adresy-postovnich-serveru)                                                               |
| Gmail / Google Workspace    | `gmail`        | imap.gmail.com        | gmail.com, googlemail.com                   | google.com, googlemail.com                              | app_password, oauth2   | ✔ [source](https://developers.google.com/workspace/gmail/imap/imap-smtp)                                                                             |
| Outlook.com / Microsoft 365 | `outlook`      | outlook.office365.com | outlook.com, hotmail.com, live.com, msn.com | mail.protection.outlook.com, olc.protection.outlook.com | oauth2                 | ✔ [source](https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040) · **blocked** |
| Yahoo Mail                  | `yahoo`        | imap.mail.yahoo.com   | yahoo.com                                   | —                                                       | app_password           | ✔ [source](https://help.yahoo.com/kb/SLN4075.html)                                                                                                   |
| iCloud Mail                 | `icloud`       | imap.mail.me.com      | icloud.com, me.com, mac.com                 | mail.icloud.com                                         | app_password           | ✔ [source](https://support.apple.com/en-us/102525)                                                                                                   |
| GMX (gmx.com)               | `gmx-com`      | imap.gmx.com          | gmx.com                                     | —                                                       | password               | ✔ [source](https://support.gmx.com/pop-imap/imap/server.html)                                                                                        |
| GMX (gmx.net / gmx.de)      | `gmx-net`      | imap.gmx.net          | gmx.net, gmx.de, gmx.at, gmx.ch             | —                                                       | password               | ✔ [source](https://hilfe.gmx.net/pop-imap/imap/imap-serverdaten.html)                                                                                |
| Hostinger                   | `hostinger`    | imap.hostinger.com    | —                                           | hostinger.com                                           | password               | ✔ [source](https://www.hostinger.com/support/1575756-how-to-get-email-account-configuration-details-for-hostinger-email/)                            |

Notes:

- **Webglobe:** CZ and SK mailboxes live on different servers but share the `mx-hub.*` MX infrastructure, so an MX match can't tell them apart. The MX match proposes `mail.webglobe.sk` and lists `mail.webglobe.cz` under "Also try".
- **Centrum/Atlas/Pobox/Volny:** one preset per domain (each has its own host); no MX suffix because they all share `eco-mx.cz`.
- **Yahoo, GMX:** no MX suffix (`yahoodns.net` also serves AOL with a different host; GMX custom domains aren't a product).
- **Zoznam, Azet:** unverified — the official help pages are unreachable (Zoznam, HTTP 403) or don't list IMAP settings (Azet). Azet's pre-login greeting advertises neither UIDPLUS nor MOVE; re-check after login in M1b-2 (permanent delete depends on UIDPLUS).
- MX suffixes backed by DNS only (no official statement): WebHouse `webhouse.sk`, iCloud `mail.icloud.com`; Outlook's `msn.com` domain likewise.

## Provider quirks that affect features

### Gmail

- **Labels are folders.** One message appears in every label folder + `[Gmail]/All Mail`. Summing folder sizes **double-counts** → stats must use `All Mail` for totals (identified by special-use `\All`) and show per-label figures as "overlapping".
- **Deleting from a label folder only removes the label.** Real delete = move to `[Gmail]/Trash` (special-use `\Trash`). Folder names are localised — always use special-use flags, never hard-coded names.
- **Download limit:** ~2500 MB/day via IMAP. Large backups must be resumable across days; show an estimate up front.
- **Connection limit:** ~15 simultaneous IMAP connections per account.
- **Extensions:** `X-GM-RAW` (Gmail search syntax), `X-GM-LABELS`, `X-GM-MSGID` — optional speed-ups, not required for MVP.

### Microsoft

- OAuth2 only for practical purposes → Outlook.com users can't be supported until M6 OAuth. MVP shows a clear message.

### General

- Special-use folders (`\Trash`, `\Sent`, `\Junk`, `\All`, `\Archive`) via LIST extension; fallback to name heuristics (`Trash`, `Deleted Items`, `Kôš`, `Koš`, …) with user confirmation.
- `QUOTA` (RFC 2087/9208) not everywhere → quota shown only when available.
- `MOVE` / `UIDPLUS` not everywhere → capability-driven behaviour (see SECURITY.md).

## Open questions

- Support STARTTLS on 143 for self-hosted servers? (Proposal: later, opt-in, still certificate-verified.)
- ~~Cache ISPDB lookups?~~ Decided 2026-09-22: no cache for now (one lookup per source per run); a per-domain lookup cache is planned around M4–M5 (TODO).
