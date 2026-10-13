import type { Command } from 'commander';
import {
  AccountError,
  addAccount,
  assertNotDuplicate,
  createLocalGuard,
  openAccountSession,
} from '../../core/accounts.js';
import { loadEnvFiles, projectRoot, validateMasterKeyEnv } from '../../core/config.js';
import { createLocalCredentialProvider } from '../../core/credentials.js';
import { createSupabaseServices, FileSessionStorage } from '../../core/db/supabase/index.js';
import { readLogs, safeEmit, unexpectedError } from '../../core/log/index.js';
import { configDir, logDir } from '../../core/paths.js';
import { defaultDiscoveryDeps, discover } from '../../core/providers/discover.js';
import { FileRememberedUsers } from '../../core/remembered-users.js';
import { authEmailTarget, authTargetKey } from '../../core/security/events.js';
import { fail, guarded, interactive } from '../account-session.js';
import { accountErrorText, accountLabel } from '../account-text.js';
import { createApp, type App, type AppResult } from '../app/controller.js';
import { openTerminal, type Terminal } from '../browser/terminal.js';
import { errorText } from '../error-text.js';
import type { CliContext } from '../index.js';
import { VERSION } from '../version.js';

// `mm app` (M2d), also what plain `mm` runs in a terminal: the full-screen app - sign in, Home
// with the user's mailboxes, adding one, and a mailbox's folders and mails (read-only). A thin
// shell: it wires the Mail Manager services, the remembered-users file, the mailbox login and
// the terminal into the controller (src/cli/app/). The whole time the app is open is one run
// (`command.start` / `command.finish`); inside it a sign-in, a failed sign-in and a log out
// write `auth.login`, `auth.login-failed` and `auth.logout` exactly as `mm login` / `mm logout`
// do, and a mailbox writes what `mm folders` writes (`imap.login*`, `folders.list`,
// `imap.capability-fallback`, `browse.finish`). Its stats are read behind the bars on a second
// login (one more `imap.login*`) and write `stats.finish` as `mm stats` does - once per read
// that ended, none for one stopped by leaving. The Logs row shows the local log files as
// `mm logs` reads them - this run's lines too - and writes nothing. Adding a mailbox is the
// core's `addAccount`, as in `mm account add`: `account.add` and its audit row, `imap.login*`
// of the login check, no `discover.finish`. Nothing typed is logged.

const NO_TERMINAL =
  'mm app needs a terminal — run it in a terminal window, or use the commands in `mm --help`.';
const DISCOVERY_TIMEOUT_MS = 5000;

export function registerApp(program: Command, ctx: CliContext): void {
  program
    .command('app')
    .description(
      'Open the Mail Manager app: sign in, add mailboxes and look into them (plain `mm` in a terminal does the same)',
    )
    .action(() =>
      guarded(ctx, async () => {
        loadEnvFiles();
        if (!interactive() || process.env['TERM'] === 'dumb') {
          fail(NO_TERMINAL);
          return;
        }
        // A broken config fails here, before any screen is opened.
        const services = createSupabaseServices(
          process.env,
          new FileSessionStorage(configDir(process.env)),
        );
        // One key for the whole run: without MM_MASTER_KEY it is random, and two failed
        // sign-ins of one run must still get the same target.
        const env = validateMasterKeyEnv(process.env);
        const masterKey = env.ok ? env.value.masterKey : undefined;
        const targetKey = authTargetKey(masterKey);
        // One login guard for the whole run too: wrong passwords counted while one mailbox
        // was open still count when it is opened again - and while one is being added.
        const guard = createLocalGuard(masterKey, ctx.log);
        // Without a usable key no mailbox can be added: the add screen says why, and signing
        // in, Home and the logs work as before.
        let addProblem: string | null = null;
        try {
          createLocalCredentialProvider(process.env);
        } catch (err) {
          addProblem = errorText(err);
        }
        const store = {
          repo: services.accounts,
          audit: services.audit,
          log: ctx.log,
          runId: ctx.run,
        };

        let terminal: Terminal | undefined;
        let app: App | undefined;
        let result: AppResult;
        try {
          terminal = openTerminal({
            // A signal or crash ends the process synchronously: log the line, never log out here.
            onExit: (code) => app?.onExit(code),
          });
          app = createApp({
            terminal,
            version: VERSION,
            auth: services.auth,
            listMailboxes: () => services.accounts.list(),
            remembered: new FileRememberedUsers(configDir(process.env)),
            log: ctx.log,
            loginTarget: (email) => authEmailTarget(targetKey, email),
            onUnexpected: (err) => {
              safeEmit(ctx.log, () => unexpectedError(err, projectRoot()));
            },
            findAccount: async (id) => {
              const account = await services.accounts.get(id);
              if (account === null) throw new AccountError('not-found');
              return account;
            },
            // A missing or broken key shows its text on the mailbox screen, not at the start:
            // signing in and Home need no key.
            openSession: (account, onChallenge) =>
              openAccountSession(
                {
                  credentials: createLocalCredentialProvider(process.env),
                  guard,
                  log: ctx.log,
                  clientVersion: VERSION,
                  onChallenge,
                },
                account,
              ),
            // As `mm logs`, but with this run's own lines: what just happened in the app.
            readLogs: (o) =>
              readLogs(logDir(process.env), {
                now: Date.now(),
                sinceMs: o.sinceMs,
                level: o.level,
                ...(o.securityOnly && { securityOnly: true }),
              }),
            ...(ctx.run !== undefined && { ownRun: ctx.run }),
            addProblem,
            discover: (address, onProgress) =>
              discover(address, { ...defaultDiscoveryDeps(DISCOVERY_TIMEOUT_MS), onProgress }),
            assertNotSaved: (o) => assertNotDuplicate(store, o),
            // The core tests the login through the run's guard and saves only when it works.
            addMailbox: (o, onChallenge) =>
              addAccount(
                {
                  ...store,
                  credentials: createLocalCredentialProvider(process.env),
                  guard,
                  clientVersion: VERSION,
                  onChallenge,
                },
                o,
              ),
          });
          result = await app.run();
        } finally {
          // The screen is given back before guarded() prints an error or anything else is
          // printed, and a sign-out or a mailbox logout that was in flight is finished before
          // the command returns (the process exits right after).
          terminal?.close();
          await app?.settled();
        }
        if (result.reconnectError !== undefined) {
          const why = accountErrorText(result.reconnectError, result.reconnectAccount);
          // Named: the user may have worked in another mailbox since.
          const what =
            result.reconnectAccount === undefined
              ? 'Reconnecting'
              : `Reconnecting to ${accountLabel(result.reconnectAccount)}`;
          console.error(`${what} failed — ${why}`);
        }
        if (result.end === 'interrupt') process.exitCode = 130;
      }),
    );
}
