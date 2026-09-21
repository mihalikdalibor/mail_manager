# Security

Mail Manager holds the keys to people's mailboxes and can delete their mail. Two things matter above all: **credentials must not leak** and **mail must never be deleted unintentionally**.

## Threat model

| Threat                                     | Impact                                                    | Mitigation                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Supabase DB leaked / misconfigured RLS     | Attacker gets account rows                                | Secrets encrypted with a key **not in the DB**; RLS on every table; two-user RLS test                      |
| Laptop / `.env.local` stolen (local phase) | Master key + session → decrypt all of that user's secrets | `.env*` gitignored, file perms 600; session file 600; document "revoke app passwords" procedure            |
| Master key lost                            | Stored passwords unrecoverable                            | Documented: users re-enter passwords; key backup is the operator's responsibility                          |
| Accidental mass delete (bug or user error) | Irreversible mail loss                                    | Plan → confirm → exact-UID execution; Trash default; UIDVALIDITY guard; backup-before-expunge; audit       |
| Malicious / malformed filter input         | Wrong messages selected, injection                        | zod validation; criteria passed as imapflow objects (library quotes/escapes); never build raw IMAP strings |
| MITM on IMAP connection                    | Credential theft                                          | Implicit TLS port 993 only, `rejectUnauthorized: true`, no STARTTLS-downgrade / plaintext fallback         |
| Secrets in logs / error messages           | Leak via terminal, CI, bug reports                        | Central redaction; never log config objects wholesale; error messages include host/user, never password    |
| Compromised npm dependency                 | Code execution with access to secrets                     | Few deps, committed lockfile, `npm audit` in CI, pin versions, review new deps                             |
| Secrets committed to git                   | Permanent exposure                                        | `.gitignore`, `.env.example` only, gitleaks in CI (M0), optional local gitleaks                            |
| Web UI (M6): CSRF / XSS / exposed port     | Session hijack, remote delete                             | Bind `127.0.0.1`, helmet + strict CSP, CSRF token, JWT verified per request, rate limiting                 |

## Credential encryption

- **Algorithm:** AES-256-GCM (Node `crypto`), authenticated encryption — tampering makes decryption fail.
- **IV:** 12 random bytes per encryption, never reused. Stored with the row.
- **Tag:** 16 bytes, stored separately; decryption must verify it.
- **AAD (additional authenticated data):** bind ciphertext to `account_id` + `user_id`, so a ciphertext copied into another row fails to decrypt.
- **Key:** `MM_MASTER_KEY` — 32 random bytes, base64, from env. Validated at startup (exact length).
- **Rotation:** `key_version` column; see DATA_MODEL.md.
- **In memory:** decrypt right before connecting, don't cache plaintext longer than the operation.
- **Later:** envelope encryption with a KMS / secrets manager (per-row data keys wrapped by a KMS key) when hosted.

## Auth

- Supabase Auth, email + password (MVP). MFA (TOTP) in beta.
- CLI stores the Supabase session in `~/.config/mail-manager/session.json`, mode 600; refresh tokens handled by supabase-js.
- CLI uses the publishable key (formerly "anon") + user JWT → RLS applies. Service-role key never leaves the server.

## Destructive-operation protocol

1. **Plan:** resolve filter → exact UID set per folder, record `UIDVALIDITY`, totals, samples. No changes.
2. **Confirm:** user sees count, size, top senders, samples; must type the count (or `yes`). Non-interactive `--yes` requires `--max N` as a ceiling.
3. **Execute:**
   - Default: `UID MOVE` to the special-use `\Trash` folder (fallback: `UID COPY` + `\Deleted` + `UID EXPUNGE`).
   - Permanent (`--expunge`): set `\Deleted` on planned UIDs, then `UID EXPUNGE <uids>` (requires **UIDPLUS**).
   - **No UIDPLUS → refuse permanent delete.** A plain `EXPUNGE` would also remove unrelated messages that were already flagged `\Deleted` by another client.
   - Re-check `UIDVALIDITY` before each batch; if changed → abort, nothing further touched.
   - Batches of ~500 UIDs, progress, resumable from the plan.
4. **Backup-first:** on by default for `--expunge`.
5. **Audit:** one `audit_log` row per folder per run with result `ok|partial|failed|aborted`.

**Gmail specifics:** a message in a label folder is the same message as in `[Gmail]/All Mail`. Removing it from a label folder only removes the label. Real deletion = move to `[Gmail]/Trash` (Gmail empties it after 30 days, or expunge there).

## Data minimisation

- No message content, subjects or message addresses in Supabase.
- Saved filters may contain addresses the user typed — accepted, user-authored config.
- Local backups contain full mail: output directories created with mode 700, files 600; README warns the user to store them safely. Optional encrypted archives: later.

## Compliance (GDPR — project is EU-based)

- Local single-user phase: user processes their own data.
- **Before hosting other people's mailboxes:** privacy policy, legal basis, data-processing agreement with Supabase / hosting provider, EU region, account + data deletion flow, breach procedure.

## OAuth2 (M6) — cost & timeline risk

- Google classifies full Gmail IMAP access (`https://mail.google.com/`) as a **restricted scope**. A public app needs Google verification **and an annual third-party security assessment (CASA)** — significant cost and weeks of lead time. Until then: app passwords, or OAuth in "testing" mode limited to explicitly added test users.
- Microsoft (Outlook.com / M365) requires an Azure app registration with `IMAP.AccessAsUser.All`; lighter process, still needs publisher verification for broad use.

## Checklist per milestone

- [ ] No secret in logs (grep test output for the test password).
- [ ] New tables have RLS + policies in the same migration.
- [ ] New inputs validated by zod.
- [ ] `npm audit` clean (or justified).
