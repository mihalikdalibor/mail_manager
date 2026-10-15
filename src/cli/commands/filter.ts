import { confirm } from '@inquirer/prompts';
import type { Command } from 'commander';
import { z } from 'zod';
import { loadEnvFiles } from '../../core/config.js';
import {
  deleteFilter,
  getSavedFilter,
  listFilters,
  saveFilter,
  savedFilterName,
  SavedFilterError,
  type FilterStoreDeps,
} from '../../core/saved-filters.js';
import { fail, guarded, interactive, loggedIn, type Session } from '../account-session.js';
import { compileTerms, readFilterTerms, UNSUPPORTED_TEXT } from '../filter-args.js';
import type { CliContext } from '../index.js';
import {
  DELETE_NEEDS_TTY_TEXT,
  FILTER_NAME_TEXT,
  jsonLine,
  NO_FILTERS_TEXT,
  notFoundText,
  SAVE_EMPTY_TEXT,
  savedErrorText,
  savedFilterText,
  skippedText,
  typedText,
} from '../saved-filter-text.js';
import { unknownOptionText } from '../search-text.js';
import { dateFormatter, dayText } from '../stats-text.js';

// `mm filter save | list | show | delete` (M3c): filters kept under a name in the cloud, for
// `mm search --filter <name>`. A thin shell over src/core/saved-filters.ts: every check that needs
// no network runs first (name, terms, the compiler), then the session is read. Filter values go to
// stdout, never to a log — the events and audit rows carry the filter's id only.

const UNEXPECTED_OPTIONS_TEXT = 'Unexpected options — see `mm filter --help`.';
const wordsSchema = z.array(z.string().max(1000)).max(100);
const saveOptions = z.strictObject({
  body: z.string().max(10_000).optional(),
  replace: z.boolean().optional(),
});
const jsonOptions = z.strictObject({ json: z.boolean().optional() });
const deleteOptions = z.strictObject({ yes: z.boolean().optional() });

function filterDeps(session: Session, ctx: CliContext): FilterStoreDeps {
  return {
    repo: session.services.filters,
    audit: session.services.audit,
    log: ctx.log,
    runId: ctx.run,
  };
}

/** Dates as the local day on this machine (`2024-05-02`). */
function dayFormat(): Intl.DateTimeFormat {
  return dateFormatter(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function registerSave(filter: Command, ctx: CliContext): void {
  filter
    .command('save')
    .description('Save a filter under a name, for mm search --filter <name>')
    .argument(
      '[name]',
      'the name: 1–40 letters, digits, - or _, not starting with - (e.g. big-old)',
    )
    .argument('[filter...]', 'the filter, as in mm search, e.g. "older:1y larger:1mb"')
    .option('--body <text>', 'only mails whose body contains this text (the last term)')
    .option('--replace', 'overwrite the saved filter that has this name')
    .allowUnknownOption()
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  mm filter save big-old "older:1y larger:1mb"',
        '  mm filter save shop-mail "from:@shop.sk" --body invoice',
        '  mm filter save big-old "larger:5mb" --replace',
        '',
        'The name is kept in lower case. Up to 200 saved filters.',
      ].join('\n'),
    )
    .action((nameArg: string | undefined, rawWords: unknown, rawOpts: unknown) =>
      guarded(ctx, async () => {
        loadEnvFiles();
        const parsedOpts = saveOptions.safeParse(rawOpts);
        const parsedWords = wordsSchema.safeParse(rawWords);
        if (!parsedOpts.success || !parsedWords.success) {
          fail(UNEXPECTED_OPTIONS_TEXT);
          return;
        }
        const opts = parsedOpts.data;
        const words = parsedWords.data;
        const unknown = [nameArg ?? '', ...words].find((w) => w.startsWith('--'));
        if (unknown !== undefined) {
          fail(unknownOptionText(unknown, 'filter save'));
          return;
        }
        const name = savedFilterName(nameArg ?? '');
        if (name === null) {
          fail(FILTER_NAME_TEXT);
          return;
        }
        const read = readFilterTerms(words, opts.body, SAVE_EMPTY_TEXT);
        if ('text' in read) {
          fail(read.text);
          return;
        }
        const checked = compileTerms(read.terms, 'received');
        if (checked === null) {
          fail(UNSUPPORTED_TEXT);
          return;
        }
        const session = await loggedIn();
        if (session === null) return;
        try {
          const { replaced } = await saveFilter(filterDeps(session, ctx), name, checked.filter, {
            replace: opts.replace === true,
          });
          console.log(
            `${replaced ? 'Replaced' : 'Saved'} "${name}": ${typedText(read.line, read.body)}`,
          );
          console.log(`Use it: mm search --filter ${name}`);
        } catch (err) {
          if (!(err instanceof SavedFilterError)) throw err;
          fail(savedErrorText(err, name));
        }
      }),
    );
}

function registerList(filter: Command, ctx: CliContext): void {
  filter
    .command('list')
    .description('List your saved filters: name, when changed, the filter')
    .option('--json', 'one JSON object (versioned) instead of the list')
    .action((rawOpts: unknown) =>
      guarded(ctx, async () => {
        loadEnvFiles();
        const parsed = jsonOptions.safeParse(rawOpts);
        if (!parsed.success) {
          fail(UNEXPECTED_OPTIONS_TEXT);
          return;
        }
        const session = await loggedIn();
        if (session === null) return;
        const { filters, skipped } = await listFilters(session.services.filters);
        if (parsed.data.json === true) {
          const object = {
            v: 1,
            filters: filters.map((f) => ({
              name: f.name,
              ...jsonLine(f.filter),
              readable: f.filter !== null,
              updated: f.updatedAt.toISOString(),
            })),
            skipped,
          };
          console.log(JSON.stringify(object, null, 2));
          return;
        }
        if (filters.length === 0 && skipped === 0) {
          console.log(NO_FILTERS_TEXT);
          return;
        }
        const day = dayFormat();
        const width = filters.reduce((w, f) => Math.max(w, f.name.length), 0);
        for (const f of filters) {
          const when = dayText(f.updatedAt, day);
          console.log(`${f.name.padEnd(width)}  ${when}  ${savedFilterText(f.filter)}`);
        }
        if (skipped > 0) console.log(skippedText(skipped));
      }),
    );
}

function registerShow(filter: Command, ctx: CliContext): void {
  filter
    .command('show')
    .description('Show one saved filter: the filter as a line, when it was saved and changed')
    .argument('[name]', 'the saved filter name (see mm filter list)')
    .option('--json', 'one JSON object (versioned) instead of the lines')
    .action((nameArg: string | undefined, rawOpts: unknown) =>
      guarded(ctx, async () => {
        loadEnvFiles();
        const parsed = jsonOptions.safeParse(rawOpts);
        if (!parsed.success) {
          fail(UNEXPECTED_OPTIONS_TEXT);
          return;
        }
        const name = savedFilterName(nameArg ?? '');
        if (name === null) {
          fail(FILTER_NAME_TEXT);
          return;
        }
        const session = await loggedIn();
        if (session === null) return;
        const found = await getSavedFilter(session.services.filters, name);
        if (found === null) {
          fail(notFoundText(name));
          return;
        }
        if (parsed.data.json === true) {
          const object = {
            v: 1,
            name,
            ...jsonLine(found.filter),
            readable: found.filter !== null,
            created: found.createdAt.toISOString(),
            updated: found.updatedAt.toISOString(),
          };
          console.log(JSON.stringify(object, null, 2));
          return;
        }
        const day = dayFormat();
        const created = dayText(found.createdAt, day);
        const updated = dayText(found.updatedAt, day);
        console.log(`Name: ${name}`);
        console.log(`Filter: ${savedFilterText(found.filter)}`);
        console.log(`Saved: ${created}${created === updated ? '' : ` (changed ${updated})`}`);
        console.log(`Use it: mm search --filter ${name}`);
      }),
    );
}

function registerDelete(filter: Command, ctx: CliContext): void {
  filter
    .command('delete')
    .description('Delete a saved filter (no mail is touched)')
    .argument('[name]', 'the saved filter name (see mm filter list)')
    .option('--yes', 'delete without asking')
    .action((nameArg: string | undefined, rawOpts: unknown) =>
      guarded(ctx, async () => {
        loadEnvFiles();
        const parsed = deleteOptions.safeParse(rawOpts);
        if (!parsed.success) {
          fail(UNEXPECTED_OPTIONS_TEXT);
          return;
        }
        const name = savedFilterName(nameArg ?? '');
        if (name === null) {
          fail(FILTER_NAME_TEXT);
          return;
        }
        const yes = parsed.data.yes === true;
        if (!yes && !interactive()) {
          fail(DELETE_NEEDS_TTY_TEXT);
          return;
        }
        const session = await loggedIn();
        if (session === null) return;
        const found = await getSavedFilter(session.services.filters, name);
        if (found === null) {
          fail(notFoundText(name));
          return;
        }
        console.log(`Filter: ${savedFilterText(found.filter)}`);
        if (
          !yes &&
          !(await confirm({
            message: `Delete the saved filter "${name}"? Your mails are not touched.`,
            default: false,
          }))
        ) {
          console.log('Nothing deleted.');
          return;
        }
        try {
          await deleteFilter(filterDeps(session, ctx), name);
        } catch (err) {
          if (!(err instanceof SavedFilterError)) throw err;
          fail(savedErrorText(err, name));
          return;
        }
        console.log(`Deleted "${name}".`);
      }),
    );
}

export function registerFilter(program: Command, ctx: CliContext): void {
  const filter = program
    .command('filter')
    .description(
      'Save filters under a name and use them with mm search --filter (save, list, show, delete)',
    );
  registerSave(filter, ctx);
  registerList(filter, ctx);
  registerShow(filter, ctx);
  registerDelete(filter, ctx);
}
