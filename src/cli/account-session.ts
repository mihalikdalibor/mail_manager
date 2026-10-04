import {
  createLocalGuard,
  parseAccountRef,
  resolveAccountRef,
  type AccountDeps,
} from '../core/accounts.js';
import type { AuthUser } from '../core/auth.js';
import { validateMasterKeyEnv } from '../core/config.js';
import { createLocalCredentialProvider } from '../core/credentials.js';
import type { MailAccount } from '../core/db/repos.js';
import {
  createSupabaseServices,
  FileSessionStorage,
  type SupabaseServices,
} from '../core/db/supabase/index.js';
import { configDir } from '../core/paths.js';
import {
  accountErrorText,
  accountTable,
  NO_ACCOUNTS_TEXT,
  REF_INVALID_TEXT,
  refAmbiguousText,
  refMissingText,
  refNoneText,
} from './account-text.js';
import type { CliContext } from './index.js';
import { cliChallenge } from './login-guard-text.js';
import { reportError } from './report-error.js';
import { VERSION } from './version.js';

// Shared by the commands that work on a saved mailbox (`mm account …`, `mm folders`): the
// login check, account lookup, login deps and the error/exit-code wrapper. Moved unchanged
// from commands/account.ts (M2a); `pickAccount` is new.

/** Prompts only when both ends are a terminal. */
export function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

/** Runs a command body: Ctrl+C → 130, other errors → their text (and `error.unexpected`). */
export async function guarded(
  ctx: CliContext,
  body: (state: { account?: MailAccount }) => Promise<void>,
): Promise<void> {
  const state: { account?: MailAccount } = {};
  try {
    await body(state);
  } catch (err) {
    if (err instanceof Error && err.name === 'ExitPromptError') {
      process.exitCode = 130;
      return;
    }
    reportError(err, ctx.log, (e) => accountErrorText(e, state.account));
    process.exitCode = 1;
  }
}

/** The ref argument, validated before anything goes over the network; null after printing. */
export function checkRef(ref: string | undefined, command: string): string | null {
  if (ref === undefined || ref.trim() === '') {
    fail(refMissingText(command));
    return null;
  }
  const parsed = parseAccountRef(ref);
  if (parsed === null) fail(REF_INVALID_TEXT);
  return parsed;
}

export interface Session {
  services: SupabaseServices;
  user: AuthUser;
}

/** Services + the logged-in user; null after "Not logged in". */
export async function loggedIn(): Promise<Session | null> {
  const services = createSupabaseServices(
    process.env,
    new FileSessionStorage(configDir(process.env)),
  );
  const user = await services.auth.currentUser();
  if (user === null) {
    fail('Not logged in — run `mm login`');
    return null;
  }
  return { services, user };
}

/** The saved account a ref points at; null after printing why not. */
export async function findAccount(session: Session, ref: string): Promise<MailAccount | null> {
  const result = resolveAccountRef(await session.services.accounts.list(), ref);
  switch (result.kind) {
    case 'found':
      return result.account;
    case 'none':
      fail(refNoneText(ref));
      return null;
    case 'ambiguous':
      fail(refAmbiguousText(ref, result.count));
      return null;
    case 'invalid':
      fail(REF_INVALID_TEXT);
      return null;
  }
}

/** Everything a login needs. The key and the guard are made once per command. */
export function loginDeps(session: Session, ctx: CliContext): AccountDeps {
  const credentials = createLocalCredentialProvider(process.env);
  const env = validateMasterKeyEnv(process.env);
  return {
    repo: session.services.accounts,
    audit: session.services.audit,
    log: ctx.log,
    runId: ctx.run,
    credentials,
    guard: createLocalGuard(env.ok ? env.value.masterKey : undefined, ctx.log),
    clientVersion: VERSION,
    onChallenge: () => cliChallenge(),
  };
}

/**
 * The mailbox a command works on. With a ref: that account. Without: the only saved one;
 * none → "No mailboxes yet"; several → asks for an id and shows the table. null after printing.
 */
export async function pickAccount(
  session: Session,
  ref: string | undefined,
  command: string,
): Promise<MailAccount | null> {
  if (ref !== undefined) return findAccount(session, ref);
  const accounts = await session.services.accounts.list();
  const [only] = accounts;
  if (accounts.length === 1 && only !== undefined) return only;
  if (accounts.length === 0) {
    fail(NO_ACCOUNTS_TEXT);
    return null;
  }
  fail(`Several mailboxes saved — run \`mm ${command} <id>\` with one of these ids:`);
  for (const row of accountTable(accounts)) console.error(row);
  return null;
}
