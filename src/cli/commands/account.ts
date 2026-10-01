import { confirm, input, password } from '@inquirer/prompts';
import type { Command } from 'commander';
import {
  AccountError,
  addAccount,
  assertNotDuplicate,
  createLocalGuard,
  parseAccountRef,
  removeAccount,
  resolveAccountRef,
  storedSecretReadable,
  testAccount,
  updatePassword,
  type AccountDeps,
} from '../../core/accounts.js';
import type { AuthUser } from '../../core/auth.js';
import { loadEnvFiles, validateMasterKeyEnv } from '../../core/config.js';
import { createLocalCredentialProvider } from '../../core/credentials.js';
import type { MailAccount } from '../../core/db/repos.js';
import {
  createSupabaseServices,
  FileSessionStorage,
  type SupabaseServices,
} from '../../core/db/supabase/index.js';
import { ImapSessionError } from '../../core/imap/errors.js';
import { configDir } from '../../core/paths.js';
import {
  defaultDiscoveryDeps,
  discover,
  SOURCE_LABEL,
  type DiscoveryResult,
} from '../../core/providers/discover.js';
import type { ImapSettings } from '../../core/providers/settings.js';
import { COUNTED_REASONS } from '../../core/security/login-guard.js';
import {
  accountErrorText,
  accountLabel,
  accountTable,
  featuresLine,
  idOf,
  NO_ACCOUNTS_TEXT,
  REF_INVALID_TEXT,
  refAmbiguousText,
  refMissingText,
  refNoneText,
  serverLabel,
} from '../account-text.js';
import {
  domainProblemText,
  foundVia,
  line,
  printHelp,
  printProvider,
  printSettings,
  printTried,
  warn,
} from '../discovery-text.js';
import { imapErrorText } from '../imap-errors.js';
import type { CliContext } from '../index.js';
import { cliChallenge } from '../login-guard-text.js';
import { sanitize } from '../log-text.js';
import { chooseImapSettings, inquirerPrompts } from '../prompts/imap-settings.js';
import { reportError } from '../report-error.js';
import { VERSION } from '../version.js';

// `mm account …` (M1c-1): a thin shell over src/core/accounts.ts — it asks, the core decides.
// Checks run cheapest first (terminal, id format, key, then the network), so a mistake is
// reported before anything is sent anywhere.

const DISCOVERY_TIMEOUT_MS = 5000;

/** Prompts only when both ends are a terminal. */
function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

/** Runs a command body: Ctrl+C → 130, other errors → their text (and `error.unexpected`). */
async function guarded(
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
function checkRef(ref: string | undefined, command: string): string | null {
  if (ref === undefined || ref.trim() === '') {
    fail(refMissingText(command));
    return null;
  }
  const parsed = parseAccountRef(ref);
  if (parsed === null) fail(REF_INVALID_TEXT);
  return parsed;
}

interface Session {
  services: SupabaseServices;
  user: AuthUser;
}

/** Services + the logged-in user; null after "Not logged in". */
async function loggedIn(): Promise<Session | null> {
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
async function findAccount(session: Session, ref: string): Promise<MailAccount | null> {
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
function loginDeps(session: Session, ctx: CliContext): AccountDeps {
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
 * Asks for the password until a login works or the user stops. Only a rejected password (or
 * one that can't be sent) offers another try — the login guard limits how many; other
 * failures end the command. Returns false when the user gave up.
 */
async function passwordLoop(
  message: string,
  attempt: (pw: string) => Promise<void>,
): Promise<boolean> {
  for (;;) {
    const pw = await password({
      message,
      validate: (v) => v.length > 0 || 'Enter the password',
    });
    try {
      await attempt(pw);
      return true;
    } catch (err) {
      const retryable =
        err instanceof ImapSessionError &&
        (COUNTED_REASONS.has(err.reason) || err.reason === 'invalid-credentials-input');
      if (!retryable) throw err;
      console.error(imapErrorText(err.reason, { kind: 'this-computer' }));
      if (!(await confirm({ message: 'Try another password?', default: true }))) {
        process.exitCode = 1;
        return false;
      }
    }
  }
}

interface Chosen {
  settings: ImapSettings;
  provider: string;
}

/** Provider picker / manual host (tiers 2–3); null after "Cancelled". */
async function pick(result: DiscoveryResult): Promise<Chosen | null> {
  const chosen = await chooseImapSettings(result, inquirerPrompts);
  if (chosen === null) {
    fail('Cancelled — nothing saved.');
    return null;
  }
  // Show what was chosen before any password is sent there.
  console.log('');
  if (chosen.provider !== undefined && chosen.source !== 'host-entered') {
    printProvider(chosen.provider);
  }
  printSettings(chosen.settings);
  return { settings: chosen.settings, provider: chosen.provider?.id ?? 'custom' };
}

/** Shows what discovery found and settles the settings to use; null when it can't go on. */
async function settle(result: DiscoveryResult): Promise<Chosen | null> {
  switch (result.status) {
    case 'found': {
      if (result.provider !== undefined) printProvider(result.provider);
      printSettings(result.imap);
      line('Found via', foundVia(result.source, result.via));
      printHelp(result.provider);
      for (const n of result.notices) warn(n);
      if (result.domainProblem !== undefined) {
        warn(domainProblemText(result.domainProblem, result.email.displayDomain));
      }
      if (await confirm({ message: 'Use these settings?', default: true })) {
        return { settings: result.imap, provider: result.provider?.id ?? 'custom' };
      }
      return pick(result);
    }
    case 'blocked':
      printProvider(result.provider);
      line('Found via', foundVia(result.source, result.via));
      printHelp(result.provider);
      for (const n of result.notices) warn(n);
      fail(`Not supported yet: ${result.reason}`);
      return null;
    case 'needs-host':
      printProvider(result.provider);
      line('Found via', foundVia(result.source, result.via));
      for (const n of result.notices) warn(n);
      return pick(result);
    case 'manual':
      if (result.domainProblem !== undefined) {
        console.log(domainProblemText(result.domainProblem, result.email.displayDomain));
      }
      console.log(`No IMAP settings found for ${result.email.displayDomain}.`);
      printTried(result.tried);
      for (const n of result.notices) warn(n);
      return pick(result);
  }
}

function registerAdd(account: Command, ctx: CliContext): void {
  account
    .command('add')
    .description('Connect a mailbox: find its settings, test the password, save it encrypted')
    .argument('[email]', 'email address of the mailbox (asked when omitted)')
    .action((emailArg: string | undefined) =>
      guarded(ctx, async () => {
        loadEnvFiles();
        if (!interactive()) {
          fail('mm account add needs a terminal (password prompt)');
          return;
        }
        createLocalCredentialProvider(process.env); // a missing key fails before any prompt
        const session = await loggedIn();
        if (session === null) return;
        const typed = emailArg ?? (await input({ message: 'Email address:' }));
        const result = await discover(typed, {
          ...defaultDiscoveryDeps(DISCOVERY_TIMEOUT_MS),
          onProgress: (source) => console.error(`checking ${SOURCE_LABEL[source]}…`),
        });
        const chosen = await settle(result);
        if (chosen === null) return;
        const deps = loginDeps(session, ctx);
        const email = result.email.address;
        await assertNotDuplicate(deps, {
          email,
          host: chosen.settings.host,
          provider: chosen.provider,
        });
        let added: MailAccount | undefined;
        const ok = await passwordLoop('Password (or app password):', async (pw) => {
          added = await addAccount(deps, {
            userId: session.user.userId,
            email,
            settings: chosen.settings,
            provider: chosen.provider,
            password: pw,
          });
        });
        if (!ok || added === undefined) {
          console.log('Nothing saved.');
          return;
        }
        const id = idOf(added.id);
        console.log(
          `Added ${sanitize(added.email)} (id ${id}). Test it any time with \`mm account test ${id}\`.`,
        );
      }),
    );
}

function registerList(account: Command, ctx: CliContext): void {
  account
    .command('list')
    .description('List your saved mailboxes (ids for the other account commands)')
    .action(() =>
      guarded(ctx, async () => {
        loadEnvFiles();
        const session = await loggedIn();
        if (session === null) return;
        const accounts = await session.services.accounts.list();
        if (accounts.length === 0) {
          console.log(NO_ACCOUNTS_TEXT);
          return;
        }
        for (const row of accountTable(accounts)) console.log(row);
      }),
    );
}

function registerTest(account: Command, ctx: CliContext): void {
  account
    .command('test')
    .description('Check that the saved password still logs in')
    .argument('[id]', 'mailbox id from `mm account list`')
    .action((refArg: string | undefined) =>
      guarded(ctx, async (state) => {
        loadEnvFiles();
        const ref = checkRef(refArg, 'test');
        if (ref === null) return;
        createLocalCredentialProvider(process.env);
        const session = await loggedIn();
        if (session === null) return;
        const found = await findAccount(session, ref);
        if (found === null) return;
        state.account = found;
        console.log(`Testing ${accountLabel(found)} …`);
        const { features } = await testAccount(loginDeps(session, ctx), found);
        console.log('Login works.');
        console.log(featuresLine(features));
      }),
    );
}

function registerUpdatePassword(account: Command, ctx: CliContext): void {
  account
    .command('update-password')
    .description('Save a new password for a mailbox (tested before it is saved)')
    .argument('[id]', 'mailbox id from `mm account list`')
    .action((refArg: string | undefined) =>
      guarded(ctx, async (state) => {
        loadEnvFiles();
        if (!interactive()) {
          fail('mm account update-password needs a terminal (password prompt)');
          return;
        }
        const ref = checkRef(refArg, 'update-password');
        if (ref === null) return;
        createLocalCredentialProvider(process.env);
        const session = await loggedIn();
        if (session === null) return;
        const found = await findAccount(session, ref);
        if (found === null) return;
        state.account = found;
        console.log(`Mailbox: ${accountLabel(found)}`);
        console.log(`Server:  ${serverLabel(found)}`);
        const deps = loginDeps(session, ctx);
        // An unreadable secret means the row can't be trusted (its host may have been swapped
        // in the database): refuse before asking, so no password is ever typed for it.
        if (!storedSecretReadable(deps.credentials, found)) {
          throw new AccountError('secret-unreadable');
        }
        const ok = await passwordLoop('New password (or app password):', (pw) =>
          updatePassword(deps, found, pw),
        );
        console.log(
          ok ? `Password updated for ${sanitize(found.email)}.` : 'Password not changed.',
        );
      }),
    );
}

function registerRemove(account: Command, ctx: CliContext): void {
  account
    .command('remove')
    .description('Remove a saved mailbox from Mail Manager (its messages are not touched)')
    .argument('[id]', 'mailbox id from `mm account list`')
    .option('--yes', 'remove without asking')
    .action((refArg: string | undefined, opts: { yes?: boolean }) =>
      guarded(ctx, async (state) => {
        loadEnvFiles();
        const ref = checkRef(refArg, 'remove');
        if (ref === null) return;
        const yes = opts.yes === true;
        if (!yes && !interactive()) {
          fail('mm account remove needs a terminal to confirm, or --yes');
          return;
        }
        const session = await loggedIn();
        if (session === null) return;
        const found = await findAccount(session, ref);
        if (found === null) return;
        state.account = found;
        console.log(`Mailbox: ${accountLabel(found)}`);
        if (
          !yes &&
          !(await confirm({
            message: 'Remove this mailbox from Mail Manager? Its messages are not touched.',
            default: false,
          }))
        ) {
          console.log('Nothing removed.');
          return;
        }
        // No key or login needed: removing only deletes the saved row.
        await removeAccount(
          {
            repo: session.services.accounts,
            audit: session.services.audit,
            log: ctx.log,
            runId: ctx.run,
          },
          found,
        );
        console.log(`Removed ${sanitize(found.email)}.`);
      }),
    );
}

export function registerAccount(program: Command, ctx: CliContext): void {
  const account = program
    .command('account')
    .description('Connect and manage mailboxes (add, list, test, update-password, remove)');
  registerAdd(account, ctx);
  registerList(account, ctx);
  registerTest(account, ctx);
  registerUpdatePassword(account, ctx);
  registerRemove(account, ctx);
}
