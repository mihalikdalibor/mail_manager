import { MAX_FOLDERS } from '../../core/mailbox/folders.js';
import { lastChecked, providerName } from '../account-text.js';
import { CHALLENGE_NOTICE } from '../browser/controller.js';
import { columns, fitTail, helpLine, tooSmallFrame, type HelpItem } from '../browser/layout.js';
import { render, type Rendered } from '../browser/render.js';
import { bodyHeight, screenOf } from '../browser/state.js';
import { displayWidth, fit } from '../browser/width.js';
import { sanitize } from '../log-text.js';
import { addBody, addBusy, addHeader, addHelp, addNote } from './add-render.js';
import { logsBody, logsBusy, logsHeader, logsHelp } from './logs-render.js';
import {
  mailboxBody,
  mailboxBusy,
  mailboxHeader,
  mailboxHelp,
  mailboxQuestion,
} from './mailbox-render.js';
import { statsNote } from './stats-render.js';
import {
  HOME_ACTIONS,
  NO_EMAIL,
  knownUsers,
  tooSmall,
  unknownView,
  windowTop,
  type AppMessage,
  type AppState,
  type HomeView,
  type MailboxRow,
  type SignInView,
} from './state.js';

// The app's screens (M2d) as plain-text lines: header, body, status line, key help - the
// sign-in page and Home here, the mailbox screen's pieces in mailbox-render.ts, those of its
// stats screen in stats-render.ts, the logs screen's in logs-render.ts and the add screen's in
// add-render.ts; inside a folder the M2b browser draws the whole frame. Pure: no escape codes
// (the terminal shell highlights `cursorLine`). Everything the app draws itself is plain ASCII;
// every string from outside - addresses from Mail Manager or users.json, provider ids, the
// typed e-mail, folder names, senders, subjects, log lines, the text of a failure - goes
// through sanitize() and is fitted to the width. A password is never read here: its line is
// the same whatever was typed.

export interface AppRenderOptions {
  /** The "checked ..." cell of a mailbox; default local `YYYY-MM-DD HH:MM`, or `never`. */
  formatChecked?: (d: Date | null) => string;
  /** The IANA zone a mail's date on the stats screen is a day in; default: this computer's. */
  timeZone?: string;
}

interface Body {
  /** Exactly the body height. */
  lines: string[];
  cursorLine: number | null;
}

const INDENT = '    ';
const ANOTHER_USER = 'Sign in as another user';
/** The last row when there is nobody else to choose. */
const ONLY_SIGN_IN = 'Sign in';
const SIGNED_IN = 'signed in  ';
const EMAIL_LABEL = `${INDENT}E-mail:    `;
const PASSWORD_LINE = `${INDENT}Password:  (nothing is shown while you type)`;
/** Mark at the end of the field being typed into. */
const TYPING = '_';
const LOADING = 'Loading your mailboxes...';
const NO_MAILBOXES = 'No mailboxes yet - add your first one.';
/** The e-mail of a mailbox row keeps this many columns before the right cell gives way. */
const EMAIL_MIN = 24;
/** The least a question shows of its address: one character and "...". */
const QUESTION_EMAIL_MIN = 4;

const ACTION_TEXT: Record<(typeof HOME_ACTIONS)[number], string> = {
  add: '+ Add a mailbox',
  logs: 'Logs',
  'log-out': 'Log out',
};

const HELP_WAITING: readonly HelpItem[] = [{ text: 'Ctrl+C quit', rank: 0 }];
const HELP_QUESTION: readonly HelpItem[] = [
  { text: 'y yes', rank: 0 },
  { text: 'any other key no', rank: 1 },
];
const HELP_PICK: readonly HelpItem[] = [
  { text: 'Up/Down move', rank: 0 },
  { text: 'Enter choose', rank: 2 },
  { text: 'f forget', rank: 3 },
  { text: 'q quit', rank: 1 },
];
const HELP_CHECK_FAILED: readonly HelpItem[] = [
  { text: 'r try again', rank: 0 },
  { text: 'q quit', rank: 1 },
];
const HELP_HOME: readonly HelpItem[] = [
  { text: 'Up/Down move', rank: 0 },
  { text: 'Enter open', rank: 2 },
  { text: 'Esc back', rank: 3 },
  { text: 'q quit', rank: 1 },
];
const HELP_HOME_FAILED: readonly HelpItem[] = [
  { text: 'Up/Down move', rank: 0 },
  { text: 'r try again', rank: 1 },
  { text: 'Enter open', rank: 3 },
  { text: 'Esc back', rank: 4 },
  { text: 'q quit', rank: 2 },
];

/** Plain words for a status message. */
export function messageText(message: AppMessage): string {
  switch (message) {
    case 'wrong-credentials':
      return 'Wrong e-mail or password - try again.';
    case 'unreachable':
      return "Can't reach Mail Manager - check your internet connection and try again.";
    case 'sign-in-failed':
      return "Signing in didn't work - try again later.";
    case 'email-required':
      return 'Type your e-mail address first.';
    case 'password-required':
      return 'Type your password.';
    case 'forget-signed-in':
      return 'Log out first to forget this address.';
    case 'session-ended':
      return 'Your sign-in has ended - sign in again.';
    case 'load-failed':
      return "Couldn't load your mailboxes - check your internet connection (r = try again).";
    case 'folder-unavailable':
      return "Couldn't open that folder.";
    case 'truncated':
      return `Only the first ${MAX_FOLDERS.toLocaleString('en-US')} folders are shown.`;
    case 'challenge':
      return CHALLENGE_NOTICE;
  }
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The signed-in user's address for a header or a question. */
function currentEmail(state: AppState): string {
  return sanitize(state.current?.email ?? '') || NO_EMAIL;
}

function headerLine(state: AppState, cols: number): string {
  const view = state.view;
  switch (view.kind) {
    case 'sign-in':
      return columns(`Mail Manager ${sanitize(state.version)}`, 'Sign in', cols);
    case 'home': {
      const right =
        view.mailboxes === null ? '' : plural(view.mailboxes.length, 'mailbox', 'mailboxes');
      return columns(`Mail Manager - ${currentEmail(state)}`, right, cols);
    }
    case 'mailbox':
      return mailboxHeader(view, cols);
    case 'logs':
      return logsHeader(view, cols);
    case 'add':
      return addHeader(cols);
    default:
      return unknownView(view);
  }
}

function filled(lines: string[], height: number, cols: number): string[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push(fit('', cols));
  return out;
}

/** The cursor inside `0..last`, whatever the state holds. */
function within(cursor: number, last: number): number {
  return Math.min(Math.max(0, cursor), Math.max(0, last));
}

function userListBody(state: AppState, view: SignInView, height: number, cols: number): Body {
  const users = knownUsers(state);
  const cursor = within(view.cursor, users.length);
  const top = windowTop(cursor, height);
  const lines: string[] = [];
  for (let i = top; i < top + height && i <= users.length; i++) {
    const user = users[i];
    lines.push(
      user === undefined
        ? fit(`${INDENT}${users.length === 0 ? ONLY_SIGN_IN : ANOTHER_USER}`, cols)
        : columns(`${INDENT}${sanitize(user.email)}`, user.signedIn ? SIGNED_IN : '', cols),
    );
  }
  const highlighted =
    view.mode === 'pick' || view.mode === 'confirm-switch' || view.mode === 'confirm-forget';
  return { lines: filled(lines, height, cols), cursorLine: highlighted ? 1 + cursor - top : null };
}

function formBody(view: SignInView, height: number, cols: number): Body {
  const form = view.form;
  if (form === null) return { lines: filled([], height, cols), cursorLine: null };
  const typing = view.mode === 'form' && form.field === 'email' && !form.fixedEmail;
  const email = fitTail(sanitize(form.email) + (typing ? TYPING : ''), cols - 16);
  const lines = [fit(`${EMAIL_LABEL}${email}`, cols), fit(PASSWORD_LINE, cols)];
  const cursorLine = view.mode === 'form' ? (form.field === 'email' ? 1 : 2) : null;
  return { lines: filled(lines, height, cols), cursorLine };
}

function signInBody(state: AppState, view: SignInView, height: number, cols: number): Body {
  switch (view.mode) {
    case 'checking':
      return { lines: filled([], height, cols), cursorLine: null };
    case 'form':
    case 'submitting':
      return formBody(view, height, cols);
    case 'pick':
    case 'confirm-switch':
    case 'confirm-forget':
    case 'signing-out':
    case 'check-failed':
      return userListBody(state, view, height, cols);
  }
}

/**
 * The right cell of every mailbox row, the same kind for the whole frame: provider and last
 * check, else the provider alone, else nothing - the e-mail is never squeezed out by it.
 */
function mailboxCells(
  mailboxes: readonly MailboxRow[],
  cols: number,
  formatChecked: (d: Date | null) => string,
): string[] {
  if (mailboxes.length === 0) return [];
  const providers = mailboxes.map((m) => providerName(m.provider));
  const checked = mailboxes.map((m) => `checked ${sanitize(formatChecked(m.lastCheckedAt))}`);
  const widest = Math.max(...providers.map(displayWidth));
  const widestChecked = Math.max(...checked.map(displayWidth));
  const short = providers.map((p) => `${fit(p, widest)}  `);
  // Padded to one width so the provider column lines up when one row says "checked never".
  const full = short.map((cell, i) => `${cell}${fit(checked[i] ?? '', widestChecked)}  `);
  const widestEmail = Math.max(...mailboxes.map((m) => displayWidth(sanitize(m.email))));
  const need = INDENT.length + Math.min(EMAIL_MIN, widestEmail);
  if (cols - displayWidth(full[0] ?? '') - 1 >= need) return full;
  if (cols - displayWidth(short[0] ?? '') - 1 >= need) return short;
  return mailboxes.map(() => '');
}

function homeBody(
  view: HomeView,
  height: number,
  cols: number,
  formatChecked: (d: Date | null) => string,
): Body {
  const mailboxes = view.mailboxes ?? [];
  // An info line is not a row: the row window gets one line less.
  const info =
    view.mailboxes === null
      ? view.loadFailed
        ? null
        : LOADING
      : mailboxes.length === 0
        ? NO_MAILBOXES
        : null;
  const lines = info === null ? [] : [fit(`${INDENT}${info}`, cols)];
  const room = Math.max(1, height - lines.length);
  const total = mailboxes.length + HOME_ACTIONS.length;
  const cursor = within(view.cursor, total - 1);
  const top = windowTop(cursor, room);
  const cursorLine = view.mode === 'list' ? 1 + lines.length + cursor - top : null;
  const cells = mailboxCells(mailboxes, cols, formatChecked);
  for (let i = top; i < top + room && i < total; i++) {
    const mailbox = mailboxes[i];
    const action = HOME_ACTIONS[i - mailboxes.length];
    if (mailbox !== undefined) {
      lines.push(columns(`${INDENT}${sanitize(mailbox.email)}`, cells[i] ?? '', cols));
    } else if (action !== undefined) {
      lines.push(fit(`${INDENT}${ACTION_TEXT[action]}`, cols));
    }
  }
  return { lines: filled(lines, height, cols), cursorLine };
}

/**
 * A question about an address in at most `cols` columns: a long address is shortened, so the
 * end of the question - what is being asked - stays on screen. When not even one character of
 * the address fits, the whole text is returned and the line's own cut applies.
 */
function asked(before: string, email: string, after: string, cols: number): string {
  const whole = `${before}${email}${after}`;
  if (displayWidth(whole) <= cols) return whole;
  const room = cols - displayWidth(before) - displayWidth(after);
  return room < QUESTION_EMAIL_MIN ? whole : `${before}${fit(email, room)}${after}`;
}

/** The question a `y` answers, or null: it is also shown while the window is too small. */
function question(state: AppState, cols: number): string | null {
  const view = state.view;
  switch (view.kind) {
    case 'sign-in':
      if (view.mode === 'confirm-switch') {
        return asked('Sign out ', currentEmail(state), ' first? (y/N)', cols);
      }
      if (view.mode === 'confirm-forget') {
        const email = sanitize(knownUsers(state)[view.cursor]?.email ?? '');
        return asked('Forget ', email, '? (y/N)', cols);
      }
      return null;
    case 'home':
    case 'logs':
    case 'add':
      return null;
    case 'mailbox':
      return mailboxQuestion(view);
    default:
      return unknownView(view);
  }
}

/** What the view is waiting for, or null. */
function busyText(view: AppState['view']): string | null {
  switch (view.kind) {
    case 'sign-in':
      if (view.mode === 'checking') return 'Checking your sign-in...';
      if (view.mode === 'submitting') return 'Signing in...';
      return view.mode === 'signing-out' ? 'Signing out...' : null;
    case 'home':
      return view.mode === 'signing-out' ? 'Signing out...' : null;
    case 'mailbox':
      return mailboxBusy(view);
    case 'logs':
      return logsBusy(view);
    case 'add':
      return addBusy(view);
    default:
      return unknownView(view);
  }
}

/** The message of the view on screen, in words; null when it has none. */
function messageOf(view: AppState['view'], cols: number): string | null {
  // The logs screen has no messages: what it has to say is in its body.
  if (view.kind === 'logs') return null;
  if (view.kind === 'add') return addNote(view, cols);
  if (view.message !== null) return messageText(view.message);
  // Home, back from adding a mailbox: said until the next key.
  return view.kind === 'home' && view.added !== null ? `Added ${sanitize(view.added)}.` : null;
}

function statusText(state: AppState, cols: number): string {
  const view = state.view;
  // The stats screen has the line to itself: a note of the bars is not shown on it.
  if (view.kind === 'mailbox' && view.mode === 'stats') return statsNote(view) ?? '';
  const said = busyText(view) ?? question(state, cols) ?? messageOf(view, cols);
  if (said !== null) return said;
  // On the bars, when nothing else is to be said: where the stats read stands.
  return view.kind === 'mailbox' ? (statsNote(view) ?? '') : '';
}

function helpItems(state: AppState): readonly HelpItem[] {
  const view = state.view;
  switch (view.kind) {
    case 'home':
      if (view.mode === 'signing-out') return HELP_WAITING;
      return view.loadFailed ? HELP_HOME_FAILED : HELP_HOME;
    case 'mailbox':
      return mailboxHelp(view);
    case 'logs':
      return logsHelp(view);
    case 'add':
      return addHelp(view);
    case 'sign-in':
      return signInHelp(view);
    default:
      return unknownView(view);
  }
}

function signInHelp(view: SignInView): readonly HelpItem[] {
  switch (view.mode) {
    case 'checking':
    case 'submitting':
    case 'signing-out':
      return HELP_WAITING;
    case 'confirm-switch':
    case 'confirm-forget':
      return HELP_QUESTION;
    case 'check-failed':
      return HELP_CHECK_FAILED;
    case 'pick':
      return HELP_PICK;
    case 'form':
      return [
        { text: view.form?.field === 'email' ? 'Enter next' : 'Enter sign in', rank: 0 },
        // A fixed e-mail leaves one field: no key to switch.
        ...(view.form?.fixedEmail === true ? [] : [{ text: 'Tab switch field', rank: 3 }]),
        { text: 'Esc back', rank: 1 },
        { text: 'Ctrl+C quit', rank: 2 },
      ];
  }
}

function bodyOf(state: AppState, height: number, cols: number, opts: AppRenderOptions): Body {
  const view = state.view;
  switch (view.kind) {
    case 'sign-in':
      return signInBody(state, view, height, cols);
    case 'home':
      return homeBody(view, height, cols, opts.formatChecked ?? ((d) => lastChecked(d)));
    case 'mailbox':
      return mailboxBody(view, height, cols, opts.timeZone);
    case 'logs':
      return logsBody(view, height, cols);
    case 'add':
      return addBody(view, height, cols);
    default:
      return unknownView(view);
  }
}

export function renderApp(state: AppState, opts: AppRenderOptions = {}): Rendered {
  const view = state.view;
  // Inside a folder the M2b browser draws the whole frame, its "too small" one included.
  if (view.kind === 'mailbox' && view.mode === 'browsing' && view.browser !== null) {
    return render(view.browser, { sizes: true });
  }
  const { rows, cols } = screenOf(state.screen);
  if (tooSmall({ rows, cols })) return tooSmallFrame(rows, cols, question(state, cols));
  const height = bodyHeight(state.screen);
  const body = bodyOf(state, height, cols, opts);
  const lines = [
    headerLine(state, cols),
    ...body.lines,
    statusText(state, cols),
    helpLine(helpItems(state), cols),
  ];
  return { lines: lines.map((line) => fit(line, cols)), cursorLine: body.cursorLine };
}
