import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { recordAudit } from './audit.js';
import { CredentialError, type CredentialProvider } from './credentials.js';
import { CryptoError } from './crypto.js';
import {
  RepoError,
  type AccountsRepo,
  type AuditEntry,
  type AuditRepo,
  type MailAccount,
} from './db/repos.js';
import { ImapSessionError } from './imap/errors.js';
import type { CapabilityRecord, ServerFeatures } from './imap/features.js';
import { guardedOpenSession } from './imap/guarded-session.js';
import type { ImapSession, OpenSessionOptions } from './imap/session.js';
import {
  accountEvent,
  cleanProvider,
  safeEmit,
  type AccountEventName,
  type AccountFailureReason,
  type EventLog,
} from './log/index.js';
import { hasUnsafeChars } from './providers/email.js';
import { PRESETS } from './providers/presets.js';
import type { ImapSettings } from './providers/settings.js';
import { MemoryAttemptStore } from './security/attempt-store.js';
import { guardTargetKey } from './security/events.js';
import { LoginBlockedError, LoginGuard } from './security/login-guard.js';

// Mailbox accounts (M1c-1): add, test, update the password, remove. Prompt-free — the CLI asks
// and prints. Every login goes through guardedOpenSession (login guard, no automatic retry);
// nothing is saved unless the login worked. Events and audit rows carry ids, a preset id and
// reason codes only — never the address, host, username or password.

export type AccountErrorCode = 'duplicate' | 'not-found' | 'secret-unreadable' | 'unsupported';

const ACCOUNT_ERROR_MESSAGES: Record<AccountErrorCode, string> = {
  duplicate: 'This mailbox is already saved',
  'not-found': 'Mailbox not found',
  'secret-unreadable': "The saved password can't be decrypted",
  unsupported: "This saved mailbox uses settings Mail Manager can't use",
};

/** A typed account problem; the CLI maps the code to text. Messages are fixed. */
export class AccountError extends Error {
  readonly code: AccountErrorCode;
  /** The existing account, for `duplicate` when it is known. */
  readonly accountId: string | undefined;

  constructor(code: AccountErrorCode, accountId?: string) {
    super(ACCOUNT_ERROR_MESSAGES[code]);
    this.name = 'AccountError';
    this.code = code;
    this.accountId = accountId;
  }
}

/** The short id `mm account list` shows. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

const accountRefSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().regex(/^[0-9a-f-]{4,36}$/));

/** A typed account reference (UUID prefix of ≥ 4 chars, or the full UUID), or null. */
export function parseAccountRef(ref: unknown): string | null {
  const parsed = accountRefSchema.safeParse(ref);
  return parsed.success ? parsed.data : null;
}

export type AccountRefResult =
  | { kind: 'found'; account: MailAccount }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'invalid' };

export function resolveAccountRef(
  accounts: readonly MailAccount[],
  ref: unknown,
): AccountRefResult {
  const prefix = parseAccountRef(ref);
  if (prefix === null) return { kind: 'invalid' };
  const matches = accounts.filter((a) => a.id.toLowerCase().startsWith(prefix));
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', count: matches.length };
  const [account] = matches;
  return account === undefined ? { kind: 'none' } : { kind: 'found', account };
}

/** Login settings of a saved account; rows Mail Manager can't use are refused. */
export function settingsOf(account: MailAccount): ImapSettings {
  // A stored username with control characters can't be sent (and can't be retyped either).
  if (account.port !== 993 || account.authType !== 'password' || hasUnsafeChars(account.username)) {
    throw new AccountError('unsupported');
  }
  return { host: account.host, port: 993, username: account.username };
}

/** What every login needs. */
export interface LoginDeps {
  guard: LoginGuard;
  log: EventLog;
  clientVersion: string;
  /** The guard asked for a challenge (CLI: a short announced wait). */
  onChallenge: () => Promise<void>;
  /** Session opener; tests pass a fake. */
  open?: (options: OpenSessionOptions) => Promise<ImapSession>;
}

/** What every stored change needs. */
export interface StoreDeps {
  repo: AccountsRepo;
  audit: AuditRepo;
  log: EventLog;
  /** Ties audit rows to the run's log lines. */
  runId?: string | undefined;
  now?: () => number;
}

export type AccountDeps = LoginDeps &
  StoreDeps & { credentials: CredentialProvider; newId?: () => string };

/** One guard per command (in-memory: the counters live for this run). */
export function createLocalGuard(masterKey: Buffer | undefined, log: EventLog): LoginGuard {
  return new LoginGuard({
    store: new MemoryAttemptStore(),
    targetKey: guardTargetKey(masterKey),
    log,
  });
}

export interface LoginCheck {
  capabilities: CapabilityRecord;
  features: ServerFeatures;
}

/** One guarded login, then logout. Errors (ImapSessionError, LoginBlockedError) propagate. */
export async function checkLogin(
  deps: LoginDeps,
  o: { settings: ImapSettings; password: string; provider: string; acct?: string },
): Promise<LoginCheck> {
  const session = await guardedOpenSession({
    settings: o.settings,
    password: o.password,
    clientVersion: deps.clientVersion,
    guard: deps.guard,
    clientIp: 'local',
    onChallenge: deps.onChallenge,
    provider: knownProvider(o.provider),
    ...(o.acct !== undefined && { acct: o.acct }),
    log: deps.log,
    ...(deps.open !== undefined && { open: deps.open }),
  });
  try {
    return { capabilities: session.capabilities, features: session.features };
  } finally {
    await session.logout();
  }
}

/** The reason code an account event / audit row carries for a failure. */
export function accountFailureReason(err: unknown): AccountFailureReason {
  if (err instanceof ImapSessionError) return err.reason;
  if (err instanceof LoginBlockedError) return 'blocked';
  if (err instanceof AccountError) return err.code;
  if (err instanceof RepoError) return 'database';
  if (err instanceof CredentialError || err instanceof CryptoError) return 'secret-unreadable';
  return 'unexpected';
}

/**
 * The provider id that may be logged or audited: a known preset id, else `custom`. Stored rows
 * are untrusted (anyone with the user's session can write them), so a slug-shaped value that
 * isn't a preset never reaches a log line or audit row.
 */
export function knownProvider(provider: string): string {
  const id = cleanProvider(provider);
  return id !== undefined && PRESETS.some((p) => p.id === id) ? id : 'custom';
}

function auditProvider(provider: string): { provider: string } {
  return { provider: knownProvider(provider) };
}

function emit(
  log: EventLog,
  name: AccountEventName,
  f: { acct?: string | undefined; provider: string; err?: unknown },
): void {
  safeEmit(log, () =>
    accountEvent(name, {
      acct: f.acct,
      provider: knownProvider(f.provider),
      outcome: f.err === undefined ? 'ok' : 'failed',
      ...(f.err !== undefined && { reason: accountFailureReason(f.err) }),
    }),
  );
}

async function audit(deps: StoreDeps, entry: Omit<AuditEntry, 'runId'>): Promise<void> {
  await recordAudit(
    deps.audit,
    { ...entry, ...(deps.runId !== undefined && { runId: deps.runId }) },
    deps.log,
  );
}

/** A failed add: event + audit row without an account id (nothing was saved). */
async function addFailed(deps: StoreDeps, provider: string, err: unknown): Promise<void> {
  emit(deps.log, 'account.add', { provider, err });
  await audit(deps, {
    action: 'account.add',
    details: auditProvider(provider),
    result: 'failed',
    reason: accountFailureReason(err),
  });
}

/**
 * Refuses an address + host that is already saved: emits the failed `account.add`, writes its
 * audit row and throws `AccountError('duplicate', existingId)`. The CLI calls it before asking
 * for the password; `addAccount` calls it again.
 */
export async function assertNotDuplicate(
  deps: StoreDeps,
  o: { email: string; host: string; provider: string },
): Promise<void> {
  const host = o.host.toLowerCase();
  let existing: MailAccount | undefined;
  try {
    existing = (await deps.repo.findByEmail(o.email)).find((a) => a.host.toLowerCase() === host);
  } catch (err) {
    await addFailed(deps, o.provider, err); // the lookup failed: logged and audited like any add
    throw err;
  }
  if (existing === undefined) return;
  const err = new AccountError('duplicate', existing.id);
  await addFailed(deps, o.provider, err);
  throw err;
}

/** Best effort: the account is saved either way; the next test fills it in. */
async function recordCheckQuietly(
  deps: StoreDeps,
  id: string,
  capabilities: CapabilityRecord,
): Promise<void> {
  try {
    await deps.repo.recordCheck(id, capabilities, new Date((deps.now ?? Date.now)()));
  } catch {
    // Deliberately ignored: capabilities are a cache, not part of the account.
  }
}

/**
 * Tests the login, then encrypts and saves the account. Nothing is created when the login
 * fails; every failure is logged and audited (`result: failed`, no account id) and rethrown.
 */
export async function addAccount(
  deps: AccountDeps,
  o: { userId: string; email: string; settings: ImapSettings; provider: string; password: string },
): Promise<MailAccount> {
  // Hosts are case-insensitive: one spelling for the login, the binding and the saved row.
  const settings: ImapSettings = { ...o.settings, host: o.settings.host.toLowerCase() };
  // Logs and audits its own failures (duplicate or a failed lookup).
  await assertNotDuplicate(deps, { email: o.email, host: settings.host, provider: o.provider });
  try {
    const id = (deps.newId ?? randomUUID)();
    const check = await checkLogin(deps, {
      settings,
      password: o.password,
      provider: o.provider,
    });
    const secret = deps.credentials.encryptPassword(
      {
        userId: o.userId,
        accountId: id,
        host: settings.host,
        port: 993,
        username: settings.username,
      },
      o.password,
    );
    let account: MailAccount;
    try {
      account = await deps.repo.create({
        id,
        userId: o.userId,
        email: o.email,
        provider: o.provider,
        host: settings.host,
        port: 993,
        username: settings.username,
        authType: 'password',
        secret,
      });
    } catch (err) {
      if (err instanceof RepoError && err.code === 'conflict') throw new AccountError('duplicate');
      throw err;
    }
    await recordCheckQuietly(deps, account.id, check.capabilities);
    await audit(deps, {
      accountId: account.id,
      action: 'account.add',
      details: auditProvider(o.provider),
      result: 'ok',
    });
    emit(deps.log, 'account.add', { acct: account.id, provider: o.provider });
    return account;
  } catch (err) {
    await addFailed(deps, o.provider, err);
    throw err;
  }
}

/** Decrypts the stored password; an unreadable secret never reaches a login. */
function decryptFor(deps: AccountDeps, account: MailAccount): string {
  try {
    return deps.credentials.decryptPassword(account);
  } catch (err) {
    if (err instanceof CredentialError || err instanceof CryptoError) {
      throw new AccountError('secret-unreadable');
    }
    throw err;
  }
}

/**
 * Whether the stored secret still decrypts for this row. If not, the row's server details may
 * have been changed in the database (or the key changed): the CLI must not send a newly typed
 * password to `account.host` without the user confirming that server.
 */
export function storedSecretReadable(
  credentials: CredentialProvider,
  account: MailAccount,
): boolean {
  try {
    credentials.decryptPassword(account);
    return true;
  } catch {
    return false;
  }
}

/** Logs in with the saved password and records the server's capabilities. */
export async function testAccount(
  deps: AccountDeps,
  account: MailAccount,
): Promise<{ features: ServerFeatures }> {
  try {
    const settings = settingsOf(account);
    const password = decryptFor(deps, account);
    const check = await checkLogin(deps, {
      settings,
      password,
      provider: account.provider,
      acct: account.id,
    });
    await recordCheckQuietly(deps, account.id, check.capabilities);
    emit(deps.log, 'account.test', { acct: account.id, provider: account.provider });
    return { features: check.features };
  } catch (err) {
    emit(deps.log, 'account.test', { acct: account.id, provider: account.provider, err });
    throw err;
  }
}

/**
 * Tests the new password first; only then encrypts and saves it. Refused when the stored
 * secret no longer decrypts for this row: then its server details may have been changed in the
 * database, and a typed password must never be sent there (recovery: remove + add, which
 * discovers the server again from the address).
 */
export async function updatePassword(
  deps: AccountDeps,
  account: MailAccount,
  newPassword: string,
): Promise<void> {
  try {
    const settings = settingsOf(account);
    decryptFor(deps, account); // the row's binding must still hold; the old password is unused
    await checkLogin(deps, {
      settings,
      password: newPassword,
      provider: account.provider,
      acct: account.id,
    });
    const secret = deps.credentials.encryptPassword(
      {
        userId: account.userId,
        accountId: account.id,
        host: account.host,
        port: account.port,
        username: account.username,
      },
      newPassword,
    );
    if (!(await deps.repo.updateSecret(account.id, secret))) throw new AccountError('not-found');
    await audit(deps, {
      accountId: account.id,
      action: 'account.password-update',
      details: auditProvider(account.provider),
      result: 'ok',
    });
    emit(deps.log, 'account.password-update', { acct: account.id, provider: account.provider });
  } catch (err) {
    emit(deps.log, 'account.password-update', {
      acct: account.id,
      provider: account.provider,
      err,
    });
    throw err;
  }
}

/** Deletes the saved account (never touches the mailbox). The audit row has no account id. */
export async function removeAccount(deps: StoreDeps, account: MailAccount): Promise<void> {
  try {
    if (!(await deps.repo.remove(account.id))) throw new AccountError('not-found');
    // After the delete the id no longer exists, so the insert policy only accepts null.
    await audit(deps, {
      action: 'account.remove',
      details: auditProvider(account.provider),
      result: 'ok',
    });
    emit(deps.log, 'account.remove', { acct: account.id, provider: account.provider });
  } catch (err) {
    emit(deps.log, 'account.remove', { acct: account.id, provider: account.provider, err });
    throw err;
  }
}
