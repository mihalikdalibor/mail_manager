# Providers & account discovery

Goal: the user types an email address and (usually) a password — the app figures out the rest.

## Discovery order

1. **Built-in presets** (`src/core/providers/presets.json`) matched by email domain.
2. **Mozilla ISPDB** — `https://autoconfig.thunderbird.net/v1.1/<domain>` (XML; take the `imap` + `SSL` entry).
3. **Provider autoconfig** — `https://autoconfig.<domain>/mail/config-v1.1.xml` (same format).
4. **DNS SRV** — `_imaps._tcp.<domain>` (RFC 6186).
5. **MX-based guess** — if MX points to Google / Microsoft, use that preset (covers custom domains on Google Workspace / M365).
6. **Manual entry** — host, port (993), username.

Every discovered result is shown to the user and **login-tested** before saving. Only implicit TLS (993) results are accepted; STARTTLS-only (143) servers are out of MVP scope (documented, revisit if needed).

## Preset format (draft)

```json
{
  "gmail": {
    "name": "Gmail",
    "domains": ["gmail.com", "googlemail.com"],
    "imap": { "host": "imap.gmail.com", "port": 993 },
    "auth": ["app_password", "oauth2"],
    "hint": "Enable 2-Step Verification, then create an App Password.",
    "helpUrl": "https://support.google.com/accounts/answer/185833",
    "quirks": ["gmail_labels"],
    "verified": true
  }
}
```

`verified: false` presets are shown with a warning until checked against official docs.

## Initial preset list

| Provider                     | Host                        | Auth for IMAP                                        | Status     |
| ---------------------------- | --------------------------- | ---------------------------------------------------- | ---------- |
| Gmail / Google Workspace     | imap.gmail.com              | App password (needs 2FA) or OAuth2                   | well known |
| Outlook.com / Hotmail / Live | outlook.office365.com       | **OAuth2 effectively required** (basic auth retired) | well known |
| Yahoo                        | imap.mail.yahoo.com         | App password                                         | well known |
| iCloud                       | imap.mail.me.com            | App-specific password                                | well known |
| GMX                          | imap.gmx.com / imap.gmx.net | Password (IMAP must be enabled in settings)          | verify     |
| Seznam.cz                    | imap.seznam.cz              | Password (IMAP may need enabling)                    | verify     |
| Zoznam.sk                    | _to verify_                 |                                                      | verify     |
| Azet.sk                      | _to verify_                 |                                                      | verify     |
| Centrum.sk / .cz             | _to verify_                 |                                                      | verify     |

**Task (M1):** verify every "verify" row against the provider's official help page, record the URL in `helpUrl`, then set `verified: true`.

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
- Cache ISPDB lookups? (Proposal: in-memory per run only.)
