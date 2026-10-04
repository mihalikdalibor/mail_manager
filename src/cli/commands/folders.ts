import type { Command } from 'commander';
import { z } from 'zod';
import {
  accountFailureReason,
  openAccountSession,
  parseAccountRef,
  withAccountSession,
  type AccountDeps,
} from '../../core/accounts.js';
import { loadEnvFiles, projectRoot } from '../../core/config.js';
import { createLocalCredentialProvider } from '../../core/credentials.js';
import type { MailAccount } from '../../core/db/repos.js';
import {
  browseFinish,
  capabilityFallback,
  foldersList,
  safeEmit,
  unexpectedError,
  type AccountFailureReason,
  type BrowseOutcome,
} from '../../core/log/index.js';
import { basketTotals } from '../../core/mailbox/basket.js';
import { listFolders, type FolderTree, type SizeProgress } from '../../core/mailbox/folders.js';
import {
  fail,
  guarded,
  interactive,
  loggedIn,
  loginDeps,
  pickAccount,
} from '../account-session.js';
import { accountErrorText, accountLabel, REF_INVALID_TEXT } from '../account-text.js';
import {
  createBrowser,
  type Browser,
  type BrowserSession,
  type BrowseResult,
} from '../browser/controller.js';
import { openTerminal, type Terminal } from '../browser/terminal.js';
import {
  browseSummary,
  folderHeader,
  folderLines,
  footerLines,
  foldersJson,
  quotaLine,
  totalsLine,
} from '../folders-text.js';
import type { CliContext } from '../index.js';

// `mm folders [id]` (M2a, M2b-2): the folder tree of a saved mailbox — read-only. A thin shell
// over listFolders (src/core/mailbox/folders.ts): one guarded login, then LIST/STATUS/EXAMINE
// only. `folders.list` is logged once the mailbox is known; the fallbacks the core used are
// logged here, once each. Folder names are never logged.
//
// In a terminal (stdin + stdout a TTY, TERM not dumb, neither --plain nor --json) the tree is
// printed, then the fullscreen browser (src/cli/browser/) runs on the same session until q or
// Ctrl+C, and one summary line follows. `browse.finish` is logged once per browser run — from
// the terminal's exit hook on a signal or crash. Otherwise the output is the M2a one.

const optionsSchema = z.strictObject({
  json: z.boolean().optional(),
  plain: z.boolean().optional(),
  // commander's --no-size: true unless the flag is given.
  size: z.boolean(),
});

/** Exit hook codes that mean "stopped": Ctrl+C from outside, SIGHUP, SIGTERM. Others failed. */
const INTERRUPT_CODES: ReadonlySet<number> = new Set([130, 129, 143]);

/** `Sizing folder 3/42 … 5000/12345` on one rewritten stderr line; only for a terminal. */
function progressLine(enabled: boolean): { show: (p: SizeProgress) => void; clear: () => void } {
  let shown = false;
  return {
    show: (p) => {
      if (!enabled) return;
      shown = true;
      process.stderr.write(
        `\r\x1b[KSizing folder ${p.folder}/${p.folders} … ${p.done}/${p.total} messages`,
      );
    },
    clear: () => {
      if (shown) process.stderr.write('\r\x1b[K');
      shown = false;
    },
  };
}

/** The M2a tree, totals, quota and footer. */
function printTree(tree: FolderTree, sizes: boolean): void {
  console.log(folderHeader(tree, { sizes }));
  for (const line of folderLines(tree, { sizes })) console.log(line);
  console.log('');
  console.log(totalsLine(tree, { sizes }));
  console.log(quotaLine(tree));
  for (const line of footerLines(tree)) console.log(line);
}

interface BrowseRun {
  ctx: CliContext;
  account: MailAccount;
  deps: AccountDeps;
  tree: FolderTree;
  sizes: boolean;
  /** The listing's session; the browser replaces it on a reconnect. Logged out at the end. */
  sessions: { current: BrowserSession };
}

/**
 * The browser on the listing's session: the terminal is closed before anything is printed (the
 * summary, a reconnect failure, or — via `guarded` — the error), and the current session is
 * logged out at the end, also after an error.
 */
async function browseFolders(o: BrowseRun): Promise<void> {
  const { ctx, account, sessions } = o;
  try {
    const browseStart = Date.now();
    let browser: Browser | undefined;
    let finished = false;
    const finish = (outcome: BrowseOutcome, reason?: AccountFailureReason): void => {
      if (finished) return;
      finished = true;
      const st = browser?.state;
      const totals = st === undefined ? { count: 0, bytes: 0 } : basketTotals(st.basket);
      safeEmit(ctx.log, () =>
        browseFinish({
          acct: account.id,
          folders: st?.stats.foldersOpened ?? 0,
          mails: st?.stats.mailsLoaded ?? 0,
          marked: totals.count,
          bytes: totals.bytes,
          reconnects: st?.stats.reconnects ?? 0,
          ms: Date.now() - browseStart,
          outcome,
          reason,
        }),
      );
    };

    let terminal: Terminal | undefined;
    let result: BrowseResult;
    try {
      terminal = openTerminal({
        // A signal or crash ends the process synchronously: log the line, never log out here.
        onExit: (code) => {
          if (INTERRUPT_CODES.has(code)) finish('interrupted');
          else finish('failed', 'unexpected');
        },
      });
      browser = createBrowser({
        terminal,
        title: accountLabel(account),
        folders: o.tree.folders,
        sizes: o.sizes,
        sessions,
        reconnect: (onChallenge) => openAccountSession({ ...o.deps, onChallenge }, account),
        onUnexpected: (err) => {
          safeEmit(ctx.log, () => unexpectedError(err, projectRoot()));
        },
      });
      result = await browser.run();
    } catch (err) {
      finish('failed', accountFailureReason(err));
      throw err; // the finally below closes the terminal first, then guarded() prints
    } finally {
      terminal?.close();
    }

    console.log(browseSummary(basketTotals(result.basket)));
    if (result.reconnectError !== undefined) {
      console.error(`Reconnecting failed — ${accountErrorText(result.reconnectError, account)}`);
    }
    finish(result.end === 'interrupt' ? 'interrupted' : 'ok');
    if (result.end === 'interrupt') process.exitCode = 130;
  } finally {
    await sessions.current.logout();
  }
}

export function registerFolders(program: Command, ctx: CliContext): void {
  program
    .command('folders')
    .description(
      'Show the folders of a mailbox: messages, unread, size and quota; in a terminal, browse folders and mails (read-only)',
    )
    .argument('[id]', 'mailbox id from `mm account list` (optional with one saved mailbox)')
    .option('--json', 'one JSON object (versioned) instead of the tree')
    .option('--plain', 'print the folder tree only, no interactive browser')
    .option('--no-size', 'skip folder sizes (faster on big mailboxes)')
    .action((refArg: string | undefined, rawOpts: unknown) =>
      guarded(ctx, async (state) => {
        loadEnvFiles();
        const parsedOpts = optionsSchema.safeParse(rawOpts);
        if (!parsedOpts.success) {
          fail('Unexpected options — see `mm folders --help`.');
          return;
        }
        const json = parsedOpts.data.json === true;
        const sizes = parsedOpts.data.size;
        const browse =
          !json &&
          parsedOpts.data.plain !== true &&
          interactive() &&
          process.env['TERM'] !== 'dumb';
        let ref: string | undefined;
        if (refArg !== undefined && refArg.trim() !== '') {
          const parsed = parseAccountRef(refArg);
          if (parsed === null) {
            fail(REF_INVALID_TEXT);
            return;
          }
          ref = parsed;
        }
        createLocalCredentialProvider(process.env); // a missing key fails before the network
        const session = await loggedIn();
        if (session === null) return;
        const account = await pickAccount(session, ref, 'folders');
        if (account === null) return;
        state.account = account;
        // stdout stays pure JSON with --json.
        (json ? console.error : console.log)(`Mailbox: ${accountLabel(account)}`);

        const deps = loginDeps(session, ctx);
        const started = Date.now();
        const progress = progressLine(process.stderr.isTTY === true && !json);
        let listed = 0;
        let failure: unknown;
        let tree: FolderTree;
        // Browser mode: the listing's session stays open for the browser.
        let sessions: { current: BrowserSession } | undefined;
        try {
          if (browse) {
            const opened = await openAccountSession(deps, account);
            sessions = { current: opened };
            tree = await listFolders(opened, { sizes, onProgress: progress.show });
          } else {
            tree = await withAccountSession(deps, account, (s) =>
              listFolders(s, { sizes, onProgress: progress.show }),
            );
          }
          progress.clear();
          listed = tree.folders.length;
          for (const feature of tree.fallbacks) {
            safeEmit(ctx.log, () => capabilityFallback(feature));
          }
          if (json) {
            console.log(JSON.stringify(foldersJson(tree, account.id), null, 2));
            return;
          }
          printTree(tree, sizes);
        } catch (err) {
          failure = err;
          await sessions?.current.logout();
          throw err;
        } finally {
          progress.clear();
          safeEmit(ctx.log, () =>
            foldersList({
              acct: account.id,
              folders: listed,
              ms: Date.now() - started,
              outcome: failure === undefined ? 'ok' : 'failed',
              ...(failure !== undefined && { reason: accountFailureReason(failure) }),
            }),
          );
        }
        if (sessions === undefined) return;
        await browseFolders({ ctx, account, deps, tree, sizes, sessions });
      }),
    );
}
