import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { lineErrorText } from '../../src/cli/filter-text.js';
import { dateFormatter, dayText } from '../../src/cli/stats-text.js';
import type { AuditEntry, AuditRepo, FiltersRepo, SavedFilter } from '../../src/core/db/repos.js';
import { RepoError } from '../../src/core/db/repos.js';
import { parseFilterLine } from '../../src/core/filters/line.js';
import type { LineError } from '../../src/core/filters/line.js';
import type { Filter } from '../../src/core/filters/schema.js';

// M3c `mm filter save | list | show | delete` (spec). Supabase, the confirm prompt, env files and
// the paths are mocked; the saved-filter core, the filter line, the audit and log and the CLI texts
// are real. The saved filters live in a fake `filters` repo that follows the repo contract: a name
// taken → RepoError('conflict'), `list` by name, `replace` and `remove` by id. The audit repo
// records every row written.

const USER_ID = '22222222-2222-4222-8222-222222222222';
const RUN = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const NOT_LOGGED_IN = 'Not logged in — run `mm login`';
const FILTER_NAME_TEXT =
  'A filter name is 1–40 letters, digits, - or _, not starting with - (e.g. big-old).';
const SAVE_EMPTY_TEXT =
  'Type the filter to save, e.g. mm filter save big-old "older:1y larger:1mb".';
const LIMIT_TEXT =
  'You have 200 saved filters, the most Mail Manager keeps — delete one first (mm filter delete <name>).';
const NO_FILTERS_TEXT = 'No saved filters yet — save one with mm filter save <name> "<filter>".';
const DELETE_NEEDS_TTY_TEXT = 'mm filter delete needs a terminal to confirm, or --yes';
const SEARCH_BODY_TEXT =
  'The --body text can\'t be used — up to 200 characters, without quotes (") or control characters.';
const UNKNOWN_SAVE_OPTION = 'Unknown option "--jsno" — see `mm filter save --help`.';
const UNREADABLE = "(can't be read)";
const NOT_A_LINE = "(can't be shown as a line)";

const duplicateText = (name: string): string =>
  `A filter named "${name}" is already saved — add --replace to overwrite it, or pick another name.`;
const notFoundText = (name: string): string =>
  `No saved filter named "${name}" — see \`mm filter list\`.`;
const deleteConfirm = (name: string): string =>
  `Delete the saved filter "${name}"? Your mails are not touched.`;

const { currentUser, createSupabaseServices, loadEnvFiles, confirm } = vi.hoisted(() => ({
  currentUser: vi.fn<() => Promise<{ email: string; userId: string } | null>>(),
  createSupabaseServices: vi.fn<(...args: unknown[]) => unknown>(),
  loadEnvFiles: vi.fn(),
  confirm: vi.fn<(config: { message: string; default?: boolean }) => Promise<boolean>>(),
}));

vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return { ...actual, loadEnvFiles };
});
vi.mock('../../src/core/db/supabase/index.js', () => ({
  createSupabaseServices,
  FileSessionStorage: class {
    getItem(): string | null {
      return null;
    }
    setItem(): void {}
    removeItem(): void {}
    clear(): void {}
    isEmpty(): boolean {
      return false;
    }
  },
}));
vi.mock('../../src/core/paths.js', () => ({
  configDir: vi.fn(() => '/nonexistent/mm-test-config'),
  logDir: vi.fn(() => '/nonexistent/mm-test-config/logs'),
}));
vi.mock('@inquirer/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inquirer/prompts')>();
  return { ...actual, confirm };
});

const { buildProgram } = await import('../../src/cli/index.js');
const { MemoryEventLog } = await import('../../src/core/log/index.js');
type Log = InstanceType<typeof MemoryEventLog>;

// ---- fakes ----

let seq = 0;

/** A saved row; the ids are unique per test file run. */
function savedRow(name: string, filter: Filter | null, updatedAt = T0): SavedFilter {
  seq += 1;
  return {
    id: `5d0e7c1a-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    name,
    filter,
    createdAt: new Date(T0),
    updatedAt: new Date(updatedAt),
  };
}

/** The filter of a line that must be read; fails the test when the line is refused. */
function filterOf(text: string): Filter {
  const result = parseFilterLine(text);
  if (!result.ok) throw new Error(`"${text}" was refused as ${result.error.code}`);
  return result.filter;
}

/** The error of a line that must be refused; fails the test when the line is read. */
function refusalOf(text: string): LineError {
  const result = parseFilterLine(text);
  if (result.ok) throw new Error(`"${text}" was read`);
  return result.error;
}

interface FakeFilters extends FiltersRepo {
  rows: Map<string, SavedFilter>;
  skipped: number;
}

function fakeFilters(seeded: SavedFilter[], skipped: number): FakeFilters {
  const rows = new Map<string, SavedFilter>(seeded.map((f) => [f.id, f]));
  const byName = (name: string): SavedFilter | undefined =>
    [...rows.values()].find((f) => f.name === name);
  return {
    rows,
    skipped,
    create(name: string, filter: Filter): Promise<SavedFilter> {
      if (byName(name) !== undefined) return Promise.reject(new RepoError('conflict', 'taken'));
      const row = savedRow(name, filter);
      rows.set(row.id, row);
      return Promise.resolve(row);
    },
    replace(id: string, filter: Filter): Promise<SavedFilter | null> {
      const row = rows.get(id);
      if (row === undefined) return Promise.resolve(null);
      const next = { ...row, filter, updatedAt: new Date(T0 + 3 * DAY) };
      rows.set(id, next);
      return Promise.resolve(next);
    },
    list(): Promise<{ filters: SavedFilter[]; skipped: number }> {
      const sorted = [...rows.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      return Promise.resolve({ filters: sorted, skipped });
    },
    getByName(name: string): Promise<SavedFilter | null> {
      return Promise.resolve(byName(name) ?? null);
    },
    remove(id: string): Promise<boolean> {
      return Promise.resolve(rows.delete(id));
    },
  };
}

function recordingAudit(): AuditRepo & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    write: (entry: AuditEntry) => {
      entries.push(entry);
      return Promise.resolve();
    },
    listRecent: () => Promise.resolve({ records: [], skipped: 0 }),
  };
}

// ---- harness ----

let out = { stdout: '', stderr: '' };
let log: Log;
let filters: FakeFilters;
let audit: ReturnType<typeof recordingAudit>;
let confirmAnswer: boolean | Error;
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalOutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true, writable: true });
}

/** Replaces the saved filters with `rows`; `skipped` is the count of malformed rows. */
function seed(rows: SavedFilter[], skipped = 0): void {
  filters = fakeFilters(rows, skipped);
}

beforeEach(() => {
  out = { stdout: '', stderr: '' };
  process.exitCode = undefined;
  seed([]);
  audit = recordingAudit();
  log = new MemoryEventLog({ run: RUN, ver: '0.10.0', now: () => T0, level: 'debug' });
  confirmAnswer = false;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.stdout += chunkToString(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    out.stderr += chunkToString(chunk);
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.stdout += `${args.map(chunkToString).join(' ')}\n`;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    out.stderr += `${args.map(chunkToString).join(' ')}\n`;
  });
  currentUser.mockResolvedValue({ email: 'user@example-test-domain.eu', userId: USER_ID });
  createSupabaseServices.mockImplementation(() => ({
    auth: { currentUser },
    filters,
    audit,
  }));
  confirm.mockImplementation(() =>
    confirmAnswer instanceof Error ? Promise.reject(confirmAnswer) : Promise.resolve(confirmAnswer),
  );
  // Pinned explicitly: nothing may depend on the terminal the tests run in.
  setTTY(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of [currentUser, createSupabaseServices, loadEnvFiles, confirm]) {
    fn.mockReset();
  }
  process.exitCode = undefined;
  if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (originalOutIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalOutIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

async function mm(...args: string[]): Promise<void> {
  await buildProgram({ exitOverride: true, log, run: RUN }).parseAsync(['node', 'mm', ...args]);
}

function exitCode(): number {
  return Number(process.exitCode ?? 0);
}

function events(name: string): Record<string, unknown>[] {
  return log.records.filter((r) => r.event === name);
}

/** Nothing past the cheap checks ran: no services, no user lookup. */
function expectNoServices(): void {
  expect(createSupabaseServices).not.toHaveBeenCalled();
  expect(currentUser).not.toHaveBeenCalled();
}

function stored(name: string): SavedFilter | undefined {
  return [...filters.rows.values()].find((f) => f.name === name);
}

/** The day text of a date, as the list and the show screens print it. */
function dayOf(date: Date): string {
  return dayText(date, dateFormatter(Intl.DateTimeFormat().resolvedOptions().timeZone));
}

/** Control characters (but not the line break) and the bidi controls: never on a terminal. */
function unsafeChars(text: string): string[] {
  return [...text].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return (
      (code < 0x20 && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
}

function jsonOut(): Record<string, unknown> {
  return JSON.parse(out.stdout) as Record<string, unknown>;
}

// ---- tests ----

describe('mm --help', () => {
  it('lists step 8, mm filter save', async () => {
    await expect(mm('--help')).rejects.toBeInstanceOf(CommanderError);
    expect(out.stdout).toContain('8. mm filter save');
  });
});

describe('mm filter save', () => {
  it('a typed filter is saved under its name, echoed as typed, with the Use it line; exit 0', async () => {
    await mm('filter', 'save', 'big-old', 'older:1y', 'larger:1mb');
    expect(out.stdout).toContain('Saved "big-old": older:1y larger:1mb');
    expect(out.stdout).toContain('Use it: mm search --filter big-old');
    expect(stored('big-old')?.filter).toEqual(filterOf('older:1y larger:1mb'));
    expect(exitCode()).toBe(0);
  });

  it('the name is stored in lower case: Big-Old → big-old', async () => {
    await mm('filter', 'save', 'Big-Old', 'older:1y');
    expect(out.stdout).toContain('Saved "big-old": older:1y');
    expect([...filters.rows.values()].map((f) => f.name)).toEqual(['big-old']);
    expect(exitCode()).toBe(0);
  });

  it('--body alone is a valid saved filter: body:"x"', async () => {
    await mm('filter', 'save', 'big-old', '--body', 'x');
    expect(out.stdout).toContain('Saved "big-old": body:"x"');
    expect(stored('big-old')?.filter).toEqual({
      version: 1,
      where: { kind: 'all', of: [{ kind: 'body', value: 'x' }] },
    });
    expect(exitCode()).toBe(0);
  });

  it.each<[string, string[], string]>([
    ['a name with a space', ['a b', 'older:1y'], FILTER_NAME_TEXT],
    ['a name with a non-ASCII letter', ['ä', 'older:1y'], FILTER_NAME_TEXT],
    ['a 41-character name', ['x'.repeat(41), 'older:1y'], FILTER_NAME_TEXT],
    ['an empty name', ['""', 'older:1y'], FILTER_NAME_TEXT],
    ['no filter', ['big-old'], SAVE_EMPTY_TEXT],
    ['only quotes as the filter', ['big-old', '""'], SAVE_EMPTY_TEXT],
    ['an unknown key in the filter', ['big-old', 'form:x'], lineErrorText(refusalOf('form:x'))],
    ['a body with quotes', ['big-old', 'older:1y', '--body', 'a"b'], SEARCH_BODY_TEXT],
    ['an unknown option before the name', ['--jsno', 'big-old', 'x'], UNKNOWN_SAVE_OPTION],
  ])('%s → its text, exit 1, no Supabase call', async (_name, args, text) => {
    await mm('filter', 'save', ...args);
    expect(out.stderr).toContain(text);
    expect(exitCode()).toBe(1);
    expectNoServices();
    expect(filters.rows.size).toBe(0);
  });

  it('a name that starts with a dash (after --) → the name text before any Supabase call, exit 1', async () => {
    await mm('filter', 'save', '--', '-old', 'older:1y');
    expect(out.stderr).toContain(FILTER_NAME_TEXT);
    expect(exitCode()).toBe(1);
    expectNoServices();
  });

  it('a filter that is not a valid filter after the line is read: the unsupported text, exit 1', async () => {
    await mm('filter', 'save', 'big-old', 'hostile\x1b');
    expect(out.stderr).toContain(lineErrorText({ code: 'unsupported', token: '' }));
    expectNoServices();
    expect(exitCode()).toBe(1);
  });

  it('a name already saved without --replace: the duplicate text, exit 1, the old filter kept', async () => {
    seed([savedRow('big-old', filterOf('older:1y'))]);
    await mm('filter', 'save', 'big-old', 'older:2y');
    expect(out.stderr).toContain(duplicateText('big-old'));
    expect(exitCode()).toBe(1);
    expect(stored('big-old')?.filter).toEqual(filterOf('older:1y'));
    expect(events('filter.save')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'duplicate' }),
    ]);
    expect(audit.entries).toHaveLength(0);
  });

  it('two saves racing on one new name: the second gets a conflict → the duplicate text, exit 1', async () => {
    filters.create = () => Promise.reject(new RepoError('conflict', 'taken by a race'));
    await mm('filter', 'save', 'big-old', 'older:1y');
    expect(out.stderr).toContain(duplicateText('big-old'));
    expect(exitCode()).toBe(1);
    expect(events('filter.save')).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'duplicate' }),
    ]);
    expect(audit.entries).toHaveLength(0);
  });

  it('--replace of an existing name: Replaced, the new filter stored, one row, one audit row', async () => {
    seed([savedRow('big-old', filterOf('older:1y'))]);
    await mm('filter', 'save', 'big-old', '--replace', 'older:2y');
    expect(out.stdout).toContain('Replaced "big-old": older:2y');
    expect(stored('big-old')?.filter).toEqual(filterOf('older:2y'));
    expect(filters.rows.size).toBe(1);
    expect(audit.entries).toHaveLength(1);
    expect(exitCode()).toBe(0);
  });

  it('an unreadable row: save --replace fixes it, the Replaced text, exit 0', async () => {
    seed([savedRow('broken', null)]);
    await mm('filter', 'save', 'broken', '--replace', 'older:1y');
    expect(out.stdout).toContain('Replaced "broken": older:1y');
    expect(stored('broken')?.filter).toEqual(filterOf('older:1y'));
    expect(exitCode()).toBe(0);
  });

  it('--replace of a name that does not exist: a plain save, the Saved text', async () => {
    await mm('filter', 'save', 'new-one', '--replace', 'older:1y');
    expect(out.stdout).toContain('Saved "new-one": older:1y');
    expect(out.stdout).not.toContain('Replaced');
    expect(stored('new-one')?.filter).toEqual(filterOf('older:1y'));
    expect(exitCode()).toBe(0);
  });

  it('200 saved filters (unreadable ones included): the limit text, exit 1, nothing saved', async () => {
    seed(
      Array.from({ length: 200 }, (_v, i) =>
        savedRow(`f-${String(i).padStart(3, '0')}`, i % 2 === 0 ? filterOf('older:1y') : null),
      ),
    );
    await mm('filter', 'save', 'new-one', 'older:1y');
    expect(out.stderr).toContain(LIMIT_TEXT);
    expect(exitCode()).toBe(1);
    expect(filters.rows.size).toBe(200);
    expect(stored('new-one')).toBeUndefined();
  });

  it('--replace of an existing name still works at 200 saved filters', async () => {
    seed(
      Array.from({ length: 200 }, (_v, i) =>
        savedRow(`f-${String(i).padStart(3, '0')}`, i % 2 === 0 ? filterOf('older:1y') : null),
      ),
    );
    await mm('filter', 'save', 'f-000', '--replace', 'older:3y');
    expect(out.stdout).toContain('Replaced "f-000": older:3y');
    expect(exitCode()).toBe(0);
    expect(filters.rows.size).toBe(200);
  });

  it('a successful save writes one filter.save event and one audit row; no name or filter value in any line or row', async () => {
    await mm('filter', 'save', 'big-old', 'older:1y', 'larger:1mb');
    expect(events('filter.save')).toEqual([expect.objectContaining({ outcome: 'ok' })]);
    expect(audit.entries).toHaveLength(1);
    const text = [log.lines.join('\n'), JSON.stringify(audit.entries)].join('\n');
    for (const needle of ['big-old', 'older', 'larger']) {
      expect(text).not.toContain(needle);
    }
  });
});

describe('mm filter list', () => {
  it('one aligned line per filter, the unreadable one says so, the skipped line; exit 0', async () => {
    seed([savedRow('big-old', filterOf('older:1y larger:1mb')), savedRow('broken', null)], 1);
    await mm('filter', 'list');
    const lines = out.stdout.split('\n');
    expect(lines).toContain(`big-old  ${dayOf(new Date(T0))}  older:1y larger:1mb`);
    expect(lines).toContain(`broken   ${dayOf(new Date(T0))}  ${UNREADABLE}`);
    expect(lines).toContain("1 saved filter couldn't be read and is not shown.");
    expect(exitCode()).toBe(0);
  });

  it('none saved → the no-filters text on stdout, exit 0', async () => {
    await mm('filter', 'list');
    expect(out.stdout).toContain(NO_FILTERS_TEXT);
    expect(exitCode()).toBe(0);
  });

  it('none readable but two skipped rows → the skipped line, not the no-filters text', async () => {
    seed([], 2);
    await mm('filter', 'list');
    expect(out.stdout).toContain("2 saved filters couldn't be read and are not shown.");
    expect(out.stdout).not.toContain(NO_FILTERS_TEXT);
    expect(exitCode()).toBe(0);
  });

  it('--json: v 1, one entry per filter with name, line, body, readable, updated; the skipped count', async () => {
    seed([savedRow('big-old', filterOf('older:1y larger:1mb')), savedRow('broken', null)], 1);
    await mm('filter', 'list', '--json');
    expect(jsonOut()).toEqual({
      v: 1,
      filters: [
        {
          name: 'big-old',
          line: 'older:1y larger:1mb',
          body: null,
          readable: true,
          updated: new Date(T0).toISOString(),
        },
        {
          name: 'broken',
          line: null,
          body: null,
          readable: false,
          updated: new Date(T0).toISOString(),
        },
      ],
      skipped: 1,
    });
    expect(exitCode()).toBe(0);
  });

  it("a filter the line cannot print: (can't be shown as a line), exit 0", async () => {
    seed([
      savedRow('either', {
        version: 1,
        where: {
          kind: 'all',
          of: [
            {
              kind: 'any',
              of: [
                { kind: 'word', value: 'a' },
                { kind: 'word', value: 'b' },
              ],
            },
          ],
        },
      }),
    ]);
    await mm('filter', 'list');
    expect(out.stdout).toContain(`either  ${dayOf(new Date(T0))}  ${NOT_A_LINE}`);
    expect(exitCode()).toBe(0);
  });

  it("hostile stored values: U+202E is not printed; a row with an ESC word (refused) is (can't be read)", async () => {
    seed([
      savedRow('bidi', {
        version: 1,
        where: { kind: 'all', of: [{ kind: 'word', value: 'shop\u202eevil' }] },
      }),
      savedRow('esc', null),
    ]);
    await mm('filter', 'list');
    expect(out.stdout).not.toContain('\u202e');
    for (const line of [...out.stdout.split('\n'), ...out.stderr.split('\n')]) {
      expect(unsafeChars(line)).toEqual([]);
    }
    expect(out.stdout).toContain(`esc   ${dayOf(new Date(T0))}  ${UNREADABLE}`);
    expect(exitCode()).toBe(0);
  });

  it('not logged in → the login hint, exit 1', async () => {
    currentUser.mockResolvedValue(null);
    await mm('filter', 'list');
    expect(out.stderr).toContain(NOT_LOGGED_IN);
    expect(exitCode()).toBe(1);
  });
});

describe('mm filter show', () => {
  it('the name, the filter, the day saved and the Use it line; no (changed …) when the day is the same', async () => {
    seed([savedRow('big-old', filterOf('older:1y larger:1mb'))]);
    await mm('filter', 'show', 'big-old');
    expect(out.stdout).toContain('Name: big-old');
    expect(out.stdout).toContain('Filter: older:1y larger:1mb');
    expect(out.stdout).toContain(`Saved: ${dayOf(new Date(T0))}`);
    expect(out.stdout).not.toContain('(changed');
    expect(out.stdout).toContain('Use it: mm search --filter big-old');
    expect(exitCode()).toBe(0);
  });

  it('a change on another day: Saved: <day> (changed <day>)', async () => {
    seed([savedRow('big-old', filterOf('older:1y'), T0 + 3 * DAY)]);
    await mm('filter', 'show', 'big-old');
    expect(out.stdout).toContain(
      `Saved: ${dayOf(new Date(T0))} (changed ${dayOf(new Date(T0 + 3 * DAY))})`,
    );
    expect(exitCode()).toBe(0);
  });

  it('a missing name → the not-found text, exit 1', async () => {
    await mm('filter', 'show', 'nope');
    expect(out.stderr).toContain(notFoundText('nope'));
    expect(exitCode()).toBe(1);
  });

  it("an unreadable row → Filter: (can't be read)", async () => {
    seed([savedRow('broken', null)]);
    await mm('filter', 'show', 'broken');
    expect(out.stdout).toContain(`Filter: ${UNREADABLE}`);
    expect(exitCode()).toBe(0);
  });

  it('a name that breaks the name rule → the name text before any Supabase call', async () => {
    await mm('filter', 'show', 'a b');
    expect(out.stderr).toContain(FILTER_NAME_TEXT);
    expect(exitCode()).toBe(1);
    expectNoServices();
  });

  it('--json: v 1, name, line, body, readable, created, updated', async () => {
    seed([savedRow('big-old', filterOf('older:1y larger:1mb'), T0 + 3 * DAY)]);
    await mm('filter', 'show', 'big-old', '--json');
    expect(jsonOut()).toEqual({
      v: 1,
      name: 'big-old',
      line: 'older:1y larger:1mb',
      body: null,
      readable: true,
      created: new Date(T0).toISOString(),
      updated: new Date(T0 + 3 * DAY).toISOString(),
    });
    expect(exitCode()).toBe(0);
  });

  it('a hostile stored value: no U+202E in the output', async () => {
    seed([
      savedRow('bidi', {
        version: 1,
        where: { kind: 'all', of: [{ kind: 'word', value: 'shop\u202eevil' }] },
      }),
    ]);
    await mm('filter', 'show', 'bidi');
    expect(out.stdout).not.toContain('\u202e');
    expect(exitCode()).toBe(0);
  });
});

describe('mm filter delete', () => {
  it('an unreadable row can be deleted with --yes', async () => {
    seed([savedRow('broken', null)]);
    await mm('filter', 'delete', 'broken', '--yes');
    expect(out.stdout).toContain('Deleted "broken".');
    expect(stored('broken')).toBeUndefined();
    expect(exitCode()).toBe(0);
  });

  it('--yes deletes without a prompt: Deleted "big-old"., the row gone, one filter.delete event and audit row', async () => {
    seed([savedRow('big-old', filterOf('older:1y'))]);
    await mm('filter', 'delete', 'big-old', '--yes');
    expect(out.stdout).toContain('Deleted "big-old".');
    expect(confirm).not.toHaveBeenCalled();
    expect(stored('big-old')).toBeUndefined();
    expect(events('filter.delete')).toEqual([expect.objectContaining({ outcome: 'ok' })]);
    expect(audit.entries).toHaveLength(1);
    expect(exitCode()).toBe(0);
  });

  it('--yes without a terminal: deleted, no prompt', async () => {
    seed([savedRow('big-old', filterOf('older:1y'))]);
    setTTY(false);
    await mm('filter', 'delete', 'big-old', '--yes');
    expect(confirm).not.toHaveBeenCalled();
    expect(out.stdout).toContain('Deleted "big-old".');
    expect(stored('big-old')).toBeUndefined();
    expect(exitCode()).toBe(0);
  });

  it('a terminal and confirm answered yes: the question with default no, then Deleted', async () => {
    seed([savedRow('big-old', filterOf('older:1y'))]);
    confirmAnswer = true;
    await mm('filter', 'delete', 'big-old');
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      message: deleteConfirm('big-old'),
      default: false,
    });
    expect(out.stdout).toContain('Deleted "big-old".');
    expect(stored('big-old')).toBeUndefined();
    expect(exitCode()).toBe(0);
  });

  it('a terminal and confirm answered no: Nothing deleted., the row kept, no event, exit 0', async () => {
    seed([savedRow('big-old', filterOf('older:1y'))]);
    confirmAnswer = false;
    await mm('filter', 'delete', 'big-old');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(out.stdout).toContain('Nothing deleted.');
    expect(stored('big-old')).toBeDefined();
    expect(events('filter.delete')).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
    expect(exitCode()).toBe(0);
  });

  it('Ctrl+C at the confirm → exit 130, the row kept', async () => {
    seed([savedRow('big-old', filterOf('older:1y'))]);
    const cancel = new Error('User force closed the prompt with SIGINT');
    cancel.name = 'ExitPromptError';
    confirmAnswer = cancel;
    await mm('filter', 'delete', 'big-old');
    expect(exitCode()).toBe(130);
    expect(stored('big-old')).toBeDefined();
  });

  it('no terminal and no --yes → the needs-a-terminal text before any Supabase call, exit 1', async () => {
    seed([savedRow('big-old', filterOf('older:1y'))]);
    setTTY(false);
    await mm('filter', 'delete', 'big-old');
    expect(out.stderr).toContain(DELETE_NEEDS_TTY_TEXT);
    expect(exitCode()).toBe(1);
    expectNoServices();
    expect(stored('big-old')).toBeDefined();
  });

  it('a missing name → the not-found text before the confirm, exit 1', async () => {
    await mm('filter', 'delete', 'nope');
    expect(out.stderr).toContain(notFoundText('nope'));
    expect(confirm).not.toHaveBeenCalled();
    expect(exitCode()).toBe(1);
  });

  it('a name that breaks the name rule → the name text before any Supabase call', async () => {
    await mm('filter', 'delete', 'a b', '--yes');
    expect(out.stderr).toContain(FILTER_NAME_TEXT);
    expect(exitCode()).toBe(1);
    expectNoServices();
  });
});
