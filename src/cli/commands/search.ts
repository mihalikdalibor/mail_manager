import type { Command } from 'commander';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { accountFailureReason, parseAccountRef, withAccountSession } from '../../core/accounts.js';
import { loadEnvFiles } from '../../core/config.js';
import { createLocalCredentialProvider } from '../../core/credentials.js';
import type { CompiledFilter } from '../../core/filters/compile.js';
import type { FilterNode } from '../../core/filters/schema.js';
import { safeEmit, searchFinish } from '../../core/log/index.js';
import { listFolders, type SizeProgress } from '../../core/mailbox/folders.js';
import {
  searchMailbox,
  SEARCH_SAMPLES_DEFAULT,
  SEARCH_SAMPLES_MAX,
} from '../../core/mailbox/search-mailbox.js';
import type { SearchOrder } from '../../core/mailbox/search.js';
import {
  filterTerms,
  getSavedFilter,
  hasEmptyGroup,
  savedFilterName,
} from '../../core/saved-filters.js';
import {
  fail,
  guarded,
  loggedIn,
  loginDeps,
  pickAccount,
  type Session,
} from '../account-session.js';
import { accountLabel, REF_INVALID_TEXT } from '../account-text.js';
import { compileTerms, readFilterTerms, UNSUPPORTED_TEXT } from '../filter-args.js';
import type { CliContext } from '../index.js';
import { sanitize } from '../log-text.js';
import {
  emptySavedText,
  FILTER_NAME_TEXT,
  notFoundText,
  savedFilterText,
  unreadableText,
} from '../saved-filter-text.js';
import {
  SEARCH_EMPTY_TEXT,
  SEARCH_LIMIT_TEXT,
  SEARCH_ORDER_TEXT,
  SEARCH_USAGE,
  searchJson,
  searchLines,
  type SearchTextOptions,
  unknownOptionText,
} from '../search-text.js';

// `mm search "<filter>" [--account <id>] [--folder <path>] [--sent] [--body <text>] …` (M3b): the
// app's filter line over the whole mailbox, or one folder — read-only. A thin shell over
// listFolders and searchMailbox (src/core/mailbox/search-mailbox.ts): every word, option and the
// line are checked before the login, so a bad request never reaches the network. One guarded
// login; `search.finish` is logged once the mailbox is known, with counts and criterion names
// only. Filter values, senders, subjects and folder names go to stdout, never to a log.
// `--filter <name>` (M3c) adds a saved filter's terms (AND) to the typed ones; its terms are read
// after the login, the name is checked before it.

const optionsSchema = z.strictObject({
  account: z.string().min(1).max(100).optional(),
  folder: z.string().min(1).max(1000).optional(),
  sent: z.boolean().optional(),
  body: z.string().max(10_000).optional(),
  order: z.string().max(100).optional(),
  limit: z.string().max(100).optional(),
  filter: z.string().max(100).optional(),
  json: z.boolean().optional(),
});
const wordsSchema = z.array(z.string().max(1000)).max(100);

type Options = z.infer<typeof optionsSchema>;

/** Where the run's filter comes from: the typed terms (compiled before the login) or a saved name. */
type FilterPart = { kind: 'typed'; compiled: CompiledFilter } | { kind: 'saved'; name: string };

/** The saved filter a report names: its name, its line and whether the search has a body term. */
type SavedUse = NonNullable<SearchTextOptions['saved']>;

/** The request, checked: what the search runs with and what the report echoes. */
interface SearchRequest {
  /** The filter line as typed (words joined, trimmed); '' with `--body` alone. */
  line: string;
  body: string | null;
  /** The typed terms, the line's then the body: with `--filter` they follow the saved terms. */
  terms: FilterNode[];
  part: FilterPart;
  order: SearchOrder;
  limit: number;
  ref: string | undefined;
}

/** The checked request, or the text that says why it can't run. */
type Checked = { request: SearchRequest } | { text: string };

/** `Searching folder 3/12 … 5000/12345 mails` on one rewritten stderr line; only for a terminal. */
function progressLine(enabled: boolean): { show: (p: SizeProgress) => void; clear: () => void } {
  let shown = false;
  return {
    show: (p) => {
      if (!enabled) return;
      shown = true;
      process.stderr.write(
        `\r\x1b[KSearching folder ${p.folder}/${p.folders} … ${p.done}/${p.total} mails`,
      );
    },
    clear: () => {
      if (shown) process.stderr.write('\r\x1b[K');
      shown = false;
    },
  };
}

/** `--order`: newest (default), oldest or largest in any case; null for another word. */
function orderOf(text: string): SearchOrder | null {
  const order = text.toLowerCase();
  if (order === 'newest' || order === 'oldest' || order === 'largest') return order;
  return null;
}

/** `--limit`: a whole number 0–200 (the default when absent); null when it isn't one. */
function limitOf(text: string | undefined): number | null {
  if (text === undefined) return SEARCH_SAMPLES_DEFAULT;
  return /^\d{1,3}$/.test(text) && Number(text) <= SEARCH_SAMPLES_MAX ? Number(text) : null;
}

/** Every check that needs no network, in the order the user can fix them. */
function checkRequest(words: readonly string[], opts: Options): Checked {
  const unknown = words.find((w) => w.startsWith('--'));
  if (unknown !== undefined) return { text: unknownOptionText(unknown) };
  const order = orderOf(opts.order ?? 'newest');
  if (order === null) return { text: SEARCH_ORDER_TEXT };
  const limit = limitOf(opts.limit);
  if (limit === null) return { text: SEARCH_LIMIT_TEXT };
  const savedName = opts.filter === undefined ? null : savedFilterName(opts.filter);
  if (opts.filter !== undefined && savedName === null) return { text: FILTER_NAME_TEXT };
  const read = readFilterTerms(words, opts.body, savedName === null ? SEARCH_EMPTY_TEXT : null);
  if ('text' in read) return { text: read.text };
  const { line, body, terms } = read;
  const dates = opts.sent === true ? 'sent' : 'received';
  let part: FilterPart;
  if (savedName === null) {
    const checked = compileTerms(terms, dates);
    if (checked === null) return { text: UNSUPPORTED_TEXT };
    part = { kind: 'typed', compiled: checked.compiled };
  } else {
    // The typed terms are checked alone as well, so a refusal is named before any login.
    if (terms.length > 0 && compileTerms(terms, dates) === null) return { text: UNSUPPORTED_TEXT };
    part = { kind: 'saved', name: savedName };
  }
  let ref: string | undefined;
  if (opts.account !== undefined && opts.account.trim() !== '') {
    const parsed = parseAccountRef(opts.account);
    if (parsed === null) return { text: REF_INVALID_TEXT };
    ref = parsed;
  }
  return { request: { line, body, terms, part, order, limit, ref } };
}

/**
 * What the run searches with, read after the login. Typed terms were compiled before it; with
 * `--filter` the saved terms come first, then the typed ones (AND). An unknown or unreadable name,
 * or no terms at all, is a text instead: an empty saved filter never means "every mail".
 */
async function runFilter(
  session: Session,
  request: SearchRequest,
  sent: boolean,
): Promise<{ compiled: CompiledFilter; saved: SavedUse | null } | { text: string }> {
  const { part } = request;
  if (part.kind === 'typed') return { compiled: part.compiled, saved: null };
  const saved = await getSavedFilter(session.services.filters, part.name);
  if (saved === null) return { text: notFoundText(part.name) };
  if (saved.filter === null) return { text: unreadableText(part.name) };
  const savedTerms = filterTerms(saved.filter);
  if (savedTerms.length === 0) return { text: emptySavedText(part.name) };
  // A group with no terms inside (at any depth) compiles without a check: refused as unreadable.
  if (hasEmptyGroup(saved.filter.where)) return { text: unreadableText(part.name) };
  const terms = [...savedTerms, ...request.terms];
  const checked = compileTerms(terms, sent ? 'sent' : 'received');
  if (checked === null) return { text: UNSUPPORTED_TEXT };
  // Backstop for the checks above: no check and the match-all query would list every mail.
  const { compiled } = checked;
  if (compiled.checks.length === 0 && isDeepStrictEqual(compiled.query, { all: true })) {
    return { text: emptySavedText(part.name) };
  }
  return {
    compiled,
    saved: {
      name: part.name,
      text: savedFilterText(saved.filter),
      body: compiled.criteria.includes('body'),
    },
  };
}

export function registerSearch(program: Command, ctx: CliContext): void {
  program
    .command('search')
    .description(
      'Find mails with a filter: how many, how big, in which folders, from whom (read-only)',
    )
    .argument(
      '[filter...]',
      'the filter, as in the app\'s filter line, e.g. "from:@shop.sk older:1y larger:1mb"',
    )
    .option('--account <id>', 'mailbox id from `mm account list` (optional with one saved mailbox)')
    .option('--folder <path>', 'only this folder, by its full path (see `mm folders --json`)')
    .option('--sent', 'the date words check the Date: header, not the arrival date')
    .option('--body <text>', 'only mails whose body contains this text (the server searches it)')
    .option('--order <order>', 'newest (default), oldest or largest — the sample list')
    .option('--limit <n>', 'rows of the sample list, 0-200 (default 20)')
    .option(
      '--filter <name>',
      'a saved filter (mm filter list); the words and --body are added to it',
    )
    .option('--json', 'one JSON object (versioned) instead of the report')
    .allowUnknownOption()
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  mm search "from:@shop.sk older:1y larger:1mb"',
        '  mm search "att larger:5mb" --order largest',
        '  mm search "date:2023 unread" --folder INBOX --json',
        '  mm search "older:2y" --sent',
        '  mm search --filter big-old --folder INBOX',
        '',
        'Keys: from: to: cc: subject: older: newer: since: before: date: larger: smaller:',
        'Words: unread read flagged att; a - in front turns a term around (-att, -from:@shop.sk).',
        'A phrase with spaces goes in double quotes inside the filter: mm search \'subject:"faktura 2023"\'',
      ].join('\n'),
    )
    .action((rawWords: unknown, rawOpts: unknown) =>
      guarded(ctx, async (state) => {
        loadEnvFiles();
        const parsedOpts = optionsSchema.safeParse(rawOpts);
        const parsedWords = wordsSchema.safeParse(rawWords);
        if (!parsedOpts.success || !parsedWords.success) {
          fail('Unexpected options — see `mm search --help`.');
          return;
        }
        const opts = parsedOpts.data;
        const checked = checkRequest(parsedWords.data, opts);
        if ('text' in checked) {
          fail(checked.text);
          return;
        }
        const { request } = checked;
        const { line, body, order, limit, ref } = request;
        const json = opts.json === true;
        const sent = opts.sent === true;
        const folder = opts.folder;
        createLocalCredentialProvider(process.env); // a missing key fails before the network
        const session = await loggedIn();
        if (session === null) return;
        const run = await runFilter(session, request, sent);
        if ('text' in run) {
          fail(run.text);
          return;
        }
        const { compiled, saved } = run;
        const account = await pickAccount(session, ref, 'search', SEARCH_USAGE);
        if (account === null) return;
        state.account = account;
        // stdout stays pure JSON with --json.
        (json ? console.error : console.log)(`Mailbox: ${accountLabel(account)}`);

        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const started = Date.now();
        const progress = progressLine(process.stderr.isTTY === true && !json);
        const counts = { messages: 0, bytes: 0 };
        let failure: unknown;
        try {
          const { tree, result, gmail } = await withAccountSession(
            loginDeps(session, ctx),
            account,
            async (s) => {
              const listed = await listFolders(s, { sizes: false, only: () => false });
              const found = await searchMailbox(s, listed, compiled, {
                ...(folder !== undefined && { folder }),
                displayPath: sanitize,
                order,
                limit,
                onProgress: progress.show,
              });
              return { tree: listed, result: found, gmail: s.features.gmail };
            },
          );
          progress.clear();
          counts.messages = result.totals.messages;
          counts.bytes = result.totals.bytes;
          if (json) {
            const scope = folder === undefined ? null : (result.folders[0]?.path ?? folder);
            const object = searchJson(result, tree, account.id, {
              filter: line,
              body,
              sent,
              order,
              folder: scope,
              gmail,
              saved: saved?.name ?? null,
            });
            console.log(JSON.stringify(object, null, 2));
            return;
          }
          const lines = searchLines(result, tree, {
            filter: line,
            body,
            sent,
            order,
            timeZone,
            saved,
          });
          for (const text of lines) console.log(text);
        } catch (err) {
          failure = err;
          throw err;
        } finally {
          progress.clear();
          const failed = failure !== undefined;
          safeEmit(ctx.log, () =>
            searchFinish({
              acct: account.id,
              count: failed ? 0 : counts.messages,
              bytes: failed ? 0 : counts.bytes,
              ms: Date.now() - started,
              criteria: compiled.criteria,
              outcome: failed ? 'failed' : 'ok',
              ...(failed && { reason: accountFailureReason(failure) }),
            }),
          );
        }
      }),
    );
}
