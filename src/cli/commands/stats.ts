import type { Command } from 'commander';
import { z } from 'zod';
import { accountFailureReason, parseAccountRef, withAccountSession } from '../../core/accounts.js';
import { loadEnvFiles } from '../../core/config.js';
import { createLocalCredentialProvider } from '../../core/credentials.js';
import { safeEmit, statsFinish } from '../../core/log/index.js';
import { listFolders, type SizeProgress } from '../../core/mailbox/folders.js';
import { collectStats } from '../../core/mailbox/stats.js';
import { fail, guarded, loggedIn, loginDeps, pickAccount } from '../account-session.js';
import { accountLabel, REF_INVALID_TEXT } from '../account-text.js';
import type { CliContext } from '../index.js';
import { sanitize } from '../log-text.js';
import { statsJson, statsLines } from '../stats-text.js';

// `mm stats [id] [--folder <path>] [--json]` (M2c-1): where a mailbox's space and mail come
// from — read-only. A thin shell over listFolders (LIST + quota only, no STATUS) and
// collectStats (src/core/mailbox/stats.ts): one guarded login, EXAMINE + FETCH of the
// envelope, date and size. `stats.finish` is logged once the mailbox is known, with counts
// only; senders, subjects and folder names go to stdout, never to a log.

const optionsSchema = z.strictObject({
  folder: z.string().min(1).max(1000).optional(),
  json: z.boolean().optional(),
});

/** `Reading folder 3/12 … 5000/12345 messages` on one rewritten stderr line; only for a terminal. */
function progressLine(enabled: boolean): { show: (p: SizeProgress) => void; clear: () => void } {
  let shown = false;
  return {
    show: (p) => {
      if (!enabled) return;
      shown = true;
      process.stderr.write(
        `\r\x1b[KReading folder ${p.folder}/${p.folders} … ${p.done}/${p.total} messages`,
      );
    },
    clear: () => {
      if (shown) process.stderr.write('\r\x1b[K');
      shown = false;
    },
  };
}

export function registerStats(program: Command, ctx: CliContext): void {
  program
    .command('stats')
    .description(
      'Where the space goes: totals, folders, years, top senders and domains, largest mails (read-only)',
    )
    .argument('[id]', 'mailbox id from `mm account list` (optional with one saved mailbox)')
    .option('--folder <path>', 'only this folder, by its full path (see `mm folders --json`)')
    .option('--json', 'one JSON object (versioned) instead of the report')
    .action((refArg: string | undefined, rawOpts: unknown) =>
      guarded(ctx, async (state) => {
        loadEnvFiles();
        const parsedOpts = optionsSchema.safeParse(rawOpts);
        if (!parsedOpts.success) {
          fail('Unexpected options — see `mm stats --help`.');
          return;
        }
        const json = parsedOpts.data.json === true;
        const folder = parsedOpts.data.folder;
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
        const account = await pickAccount(session, ref, 'stats');
        if (account === null) return;
        state.account = account;
        // stdout stays pure JSON with --json.
        (json ? console.error : console.log)(`Mailbox: ${accountLabel(account)}`);

        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const started = Date.now();
        const progress = progressLine(process.stderr.isTTY === true && !json);
        const counts = { folders: 0, messages: 0, bytes: 0 };
        let failure: unknown;
        try {
          const { tree, stats, gmail } = await withAccountSession(
            loginDeps(session, ctx),
            account,
            async (s) => {
              const listed = await listFolders(s, { sizes: false, only: () => false });
              const result = await collectStats(s, listed, {
                ...(folder !== undefined && { folder }),
                timeZone,
                onProgress: progress.show,
                displayPath: sanitize,
              });
              return { tree: listed, stats: result, gmail: s.features.gmail };
            },
          );
          progress.clear();
          counts.folders = stats.folders.length;
          counts.messages = stats.totals.messages;
          counts.bytes = stats.totals.bytes;
          if (json) {
            const scope = {
              folder: folder === undefined ? null : (stats.folders[0]?.path ?? folder),
              gmail,
            };
            console.log(JSON.stringify(statsJson(stats, tree, account.id, scope), null, 2));
            return;
          }
          const lines = statsLines(stats, tree, { wholeMailbox: folder === undefined, timeZone });
          for (const line of lines) console.log(line);
        } catch (err) {
          failure = err;
          throw err;
        } finally {
          progress.clear();
          const failed = failure !== undefined;
          safeEmit(ctx.log, () =>
            statsFinish({
              acct: account.id,
              folders: failed ? 0 : counts.folders,
              messages: failed ? 0 : counts.messages,
              bytes: failed ? 0 : counts.bytes,
              ms: Date.now() - started,
              outcome: failed ? 'failed' : 'ok',
              ...(failed && { reason: accountFailureReason(failure) }),
            }),
          );
        }
      }),
    );
}
