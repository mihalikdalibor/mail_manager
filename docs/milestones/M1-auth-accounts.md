# M1 — Auth, credential encryption, accounts

## Goal

A user can log in and connect one or more IMAP mailboxes with minimal typing; credentials are stored encrypted and each account can be login-tested.

## In scope

- Supabase migration `0001_init.sql`: `mail_accounts` with RLS (see DATA_MODEL.md).
- `crypto.ts`: AES-256-GCM encrypt/decrypt with AAD (`user_id:account_id`), `key_version`.
- `CredentialProvider` interface + local implementation (decrypts via `crypto.ts`).
- Repos: `AccountsRepo` interface + Supabase implementation.
- Provider presets + discovery (PROVIDERS.md order), with SK/CZ presets verified.
- `imap/session.ts`: connect with TLS policy, capability detection, clean logout, timeouts, friendly error mapping (auth failed, host not found, TLS error, IMAP disabled).
- CLI:
  - `mm login` / `mm logout` / `mm whoami` (Supabase email+password; `mm signup` for first user).
  - `mm account add [email]` — discover → show settings → prompt password (hidden) → test login → encrypt → save.
  - `mm account list` · `mm account test <id|email>` · `mm account remove <id|email>` (confirm) · `mm account update-password`.

## Out of scope

OAuth2 (M6), STARTTLS/143, any mailbox reading beyond login + capabilities.

## Design notes

- Account id needed for AAD before insert → generate uuid client-side, then insert.
- Store capabilities (`UIDPLUS`, `MOVE`, `QUOTA`, `SPECIAL-USE`, `X-GM-EXT-1`, …) in `mail_accounts.capabilities` after a successful test.
- Session file `~/.config/mail-manager/session.json`, mode 600; custom supabase-js storage adapter.
- Provider hints shown before password prompt (e.g. Gmail app password link). Outlook.com → explain OAuth needed, not yet supported.
- Error messages include host + username, never the password.

## Risks & open questions

- Microsoft users unsupported until M6 — acceptable for MVP?
- Signup: allow open signup in the Supabase project or invite-only? (Proposal: disable public signup; create users manually during local phase.)
- Account removal: also delete audit rows? (Proposal: keep, `account_id` set null.)

## Tasks

See `TODO.md` → M1.

## Acceptance criteria

- Crypto unit tests (round trip, wrong key, tampering, AAD mismatch, IV uniqueness) pass.
- Discovery unit tests pass with mocked fetch/DNS.
- Against the test mailbox: `account add` saves, `account test` succeeds, wrong password fails and saves nothing.
- In Supabase: `secret_ciphertext` is not readable plaintext; second user sees 0 accounts of the first (RLS).
- Test password appears nowhere in logs/output.

## Verification steps

1. `mm signup/login` → `mm whoami`.
2. `mm account add <test-address>` → `mm account list` → `mm account test`.
3. Re-run with wrong password → clear error.
4. Two-user RLS check in Supabase SQL editor / second CLI profile.
