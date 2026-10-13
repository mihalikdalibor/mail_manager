import { SOURCE_LABEL } from '../../core/providers/discover.js';
import { CHALLENGE_NOTICE } from '../browser/controller.js';
import { columns, fitTail, type HelpItem } from '../browser/layout.js';
import { fit } from '../browser/width.js';
import { sanitize } from '../log-text.js';
import {
  ADD_INDENT,
  ADD_LABEL_WIDTH,
  addLabelled,
  addLines,
  addNoteLines,
  addNoteText,
  addPlain,
  addServerLines,
  providerRows,
  type ProviderRow,
} from './add.js';
import type { MailboxBody } from './mailbox-render.js';
import { asciiText, windowTop, type AddView, type ChosenServer } from './state.js';

// The add-a-mailbox screen (M2d-4) as plain-text pieces for render.ts: header, body, what the
// status line says, key help. Pure. A field shows what was typed (through sanitize(), its end
// kept); everything else from outside - provider names and hints, hosts, what the lookup says,
// the text of a failure - goes through sanitize() and asciiText() and is fitted to the width.
// The password is never read here: its line is the same whatever was typed. A note that fits
// the status line is shown there; a longer one (a rejected login's text) is wrapped in the
// body.

const TITLE = 'Mail Manager - Add a mailbox';
const LOOKING = 'Looking up settings...';
const CHECKING_SAVED = 'Checking your saved mailboxes...';
const CHECKING_LOGIN = 'Checking the login...';
/** Mark at the end of the field being typed into. */
const TYPING = '_';
const ADDRESS_LABEL = `${ADD_INDENT}E-mail of the mailbox: `;
const HOST_LABEL = `${ADD_INDENT}${'IMAP host:'.padEnd(ADD_LABEL_WIDTH)}`;
const USERNAME_LABEL = `${ADD_INDENT}${'Username:'.padEnd(ADD_LABEL_WIDTH)}`;
const PASSWORD_LINE = `${ADD_INDENT}Password:  (nothing is shown while you type)`;
const NOT_SUPPORTED = 'not supported yet  ';

const HELP_WAITING: readonly HelpItem[] = [{ text: 'Ctrl+C quit', rank: 0 }];
const HELP_BACK: readonly HelpItem[] = [
  { text: 'Esc back', rank: 0 },
  { text: 'q quit', rank: 1 },
];
/** A page that only shows something: it scrolls when it is longer than the window. */
const HELP_PAGE: readonly HelpItem[] = [{ text: 'Up/Down scroll', rank: 2 }, ...HELP_BACK];
const HELP_FIELD: readonly HelpItem[] = [
  { text: 'Enter next', rank: 0 },
  { text: 'Esc back', rank: 1 },
  { text: 'Ctrl+C quit', rank: 2 },
];
const HELP_SERVER: readonly HelpItem[] = [
  { text: 'Enter next', rank: 0 },
  { text: 'Tab switch field', rank: 3 },
  { text: 'Esc back', rank: 1 },
  { text: 'Ctrl+C quit', rank: 2 },
];
const HELP_PASSWORD: readonly HelpItem[] = [
  { text: 'Enter add mailbox', rank: 0 },
  { text: 'Esc back', rank: 1 },
  { text: 'Ctrl+C quit', rank: 2 },
];
const HELP_CHOOSE: readonly HelpItem[] = [
  { text: 'c provider list', rank: 3 },
  { text: 'm enter server', rank: 4 },
  { text: 'Up/Down scroll', rank: 5 },
  { text: 'Esc back', rank: 0 },
  { text: 'q quit', rank: 1 },
];
const HELP_PROVIDERS: readonly HelpItem[] = [
  { text: 'Up/Down move', rank: 2 },
  { text: 'Enter choose', rank: 3 },
  { text: 'm enter server', rank: 4 },
  { text: 'Esc back', rank: 0 },
  { text: 'q quit', rank: 1 },
];

function padded(lines: string[], height: number, cols: number): string[] {
  const out = lines.slice(0, height).map((line) => fit(line, cols));
  while (out.length < height) out.push(fit('', cols));
  return out;
}

/** A field: its label, then what was typed with its end kept (and the mark while typing). */
function field(label: string, value: string, typing: boolean, cols: number): string {
  const text = fitTail(sanitize(value) + (typing ? TYPING : ''), cols - label.length);
  return fit(`${label}${text}`, cols);
}

/** The first `room` lines, the last one ending in "..." - there was more. */
function cut(lines: string[], room: number, cols: number): string[] {
  if (room <= 0) return [];
  const kept = lines.slice(0, room);
  kept[room - 1] = fit(`${kept[room - 1] ?? ''} ...`, cols).trimEnd();
  return kept;
}

/**
 * Lines above the fields, the fields, lines below them, in `height` lines. When the body is too
 * short the lines above go first, top first; then what is below is cut and ends in "...". The
 * fields are always there.
 */
function fieldBody(
  above: string[],
  fields: string[],
  below: string[],
  active: number | null,
  height: number,
  cols: number,
): MailboxBody {
  const room = Math.max(0, height - fields.length);
  const under = below.length <= room ? below : cut(below, room, cols);
  const over = above.slice(Math.max(0, above.length - (room - under.length)));
  return {
    lines: padded([...over, ...fields, ...under], height, cols),
    cursorLine: active === null ? null : 1 + over.length + active,
  };
}

/** What the mailbox will be added with: provider, server, username, the provider's hint. */
function chosenLines(chosen: ChosenServer | null, cols: number): string[] {
  if (chosen === null) return [];
  return [
    ...(chosen.name === null ? [] : addLabelled('Provider:', chosen.name, cols)),
    ...addServerLines(chosen.settings, cols),
    ...(chosen.hint === null ? [] : addLabelled('Hint:', chosen.hint, cols)),
  ];
}

/** A page (found, blocked, nothing, failed) from `scroll`; a long note keeps the last lines. */
function pageBody(view: AddView, height: number, cols: number): MailboxBody {
  const note = addNoteLines(view, cols);
  const room = Math.max(1, height - note.length);
  const lines = addLines(view, cols);
  const scroll = Math.min(Math.max(0, view.scroll), Math.max(0, lines.length - room));
  const page = padded(lines.slice(scroll, scroll + room), room, cols);
  return { lines: padded([...page, ...note], height, cols), cursorLine: null };
}

function rowLine(row: ProviderRow, cols: number): string {
  if (row.kind === 'heading') return fit(`${ADD_INDENT}${row.text}`, cols);
  const name = asciiText(sanitize(row.preset.name));
  return columns(
    `${ADD_INDENT}  ${name}${row.verified ? '' : ' (unverified)'}`,
    row.blocked === null ? '' : NOT_SUPPORTED,
    cols,
  );
}

function providersBody(view: AddView, height: number, cols: number): MailboxBody {
  const rows = providerRows();
  const note = addNoteLines(view, cols);
  const room = Math.max(1, height - note.length);
  const cursor = Math.min(Math.max(0, view.cursor), Math.max(0, rows.length - 1));
  const top = windowTop(cursor, room);
  const list = rows.slice(top, top + room).map((row) => rowLine(row, cols));
  return {
    lines: padded([...padded(list, room, cols), ...note], height, cols),
    cursorLine: 1 + cursor - top,
  };
}

export function addHeader(cols: number): string {
  return fit(TITLE, cols);
}

export function addBody(view: AddView, height: number, cols: number): MailboxBody {
  const note = addNoteLines(view, cols);
  switch (view.step) {
    case 'address':
      return fieldBody([], [field(ADDRESS_LABEL, view.address, true, cols)], note, 0, height, cols);
    case 'looking':
      return fieldBody(
        [],
        [field(ADDRESS_LABEL, view.address, false, cols)],
        [],
        null,
        height,
        cols,
      );
    case 'found':
    case 'blocked':
    case 'nothing':
    case 'failed':
      return pageBody(view, height, cols);
    case 'providers':
      return providersBody(view, height, cols);
    case 'host': {
      const provider = view.hostProvider;
      return fieldBody(
        provider === null ? [] : addLabelled('Provider:', provider.name, cols),
        [field(HOST_LABEL, view.host, true, cols)],
        [...(provider?.hostHint === undefined ? [] : addPlain(provider.hostHint, cols)), ...note],
        0,
        height,
        cols,
      );
    }
    case 'server':
      return fieldBody(
        [],
        [
          field(HOST_LABEL, view.host, view.field === 'host', cols),
          field(USERNAME_LABEL, view.username, view.field === 'username', cols),
        ],
        note,
        view.field === 'host' ? 0 : 1,
        height,
        cols,
      );
    case 'checking-saved':
      return fieldBody(chosenLines(view.chosen, cols), [], [], null, height, cols);
    case 'password':
      return fieldBody(
        [...chosenLines(view.chosen, cols), ''],
        [PASSWORD_LINE],
        note,
        0,
        height,
        cols,
      );
    case 'checking':
      return fieldBody(
        [...chosenLines(view.chosen, cols), ''],
        [PASSWORD_LINE],
        [],
        null,
        height,
        cols,
      );
  }
}

/** What the screen is waiting for, or null. */
export function addBusy(view: AddView): string | null {
  switch (view.step) {
    case 'looking':
      return view.checking === null
        ? LOOKING
        : `${LOOKING} checking ${SOURCE_LABEL[view.checking]}`;
    case 'checking-saved':
      return CHECKING_SAVED;
    case 'checking':
      // The login guard's wait is said instead: nothing is being checked yet.
      return view.waiting ? CHALLENGE_NOTICE : CHECKING_LOGIN;
    default:
      return null;
  }
}

/** The note for the status line: only one that fits it (a longer one is in the body). */
export function addNote(view: AddView, cols: number): string | null {
  const note = addNoteText(view);
  return note !== null && note.length <= cols ? note : null;
}

export function addHelp(view: AddView): readonly HelpItem[] {
  switch (view.step) {
    case 'address':
    case 'host':
      return HELP_FIELD;
    case 'server':
      return HELP_SERVER;
    case 'password':
      return HELP_PASSWORD;
    case 'checking':
      return HELP_WAITING;
    case 'looking':
    case 'checking-saved':
      return HELP_BACK;
    case 'blocked':
    case 'failed':
      return HELP_PAGE;
    case 'nothing':
      return HELP_CHOOSE;
    case 'providers':
      return HELP_PROVIDERS;
    case 'found':
      return [
        // A server named by an unsigned DNS record takes `y`, not Enter.
        view.result?.status === 'found' && view.result.offDomain === true
          ? { text: 'y use this server', rank: 2 }
          : { text: 'Enter use these', rank: 2 },
        ...HELP_CHOOSE,
      ];
  }
}
