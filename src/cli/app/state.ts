import type { AuthUser } from '../../core/auth.js';
import type { Filter } from '../../core/filters/schema.js';
import { emptyBasket, type Basket } from '../../core/mailbox/basket.js';
import type { FolderInfo, FolderTree, SizeProgress } from '../../core/mailbox/folders.js';
import type { FolderSnapshot } from '../../core/mailbox/messages.js';
import type { MailboxStats } from '../../core/mailbox/stats.js';
import type {
  DiscoveryResult,
  DiscoverySource,
  ProviderInfo,
} from '../../core/providers/discover.js';
import type { ImapSettings } from '../../core/providers/settings.js';
import { normalizeEmail } from '../../core/remembered-users.js';
import {
  MIN_COLS,
  MIN_ROWS,
  bodyHeight,
  screenOf,
  type BrowserAction,
  type BrowserKey,
  type BrowserState,
  type BrowserStats,
  type Keypress,
  type Screen,
} from '../browser/state.js';

// State of the app (M2d): what plain `mm` opens. Types and small pure helpers shared by the
// reducers (sign-in.ts, home.ts, mailbox.ts, logs.ts, add.ts), reduce.ts and the renderer. As in
// the folder browser, every input gives a new state plus effects that the controller runs and
// answers with further actions; nothing here talks to Mail Manager or a mail server, prints or
// logs.
//
// The password lives in the form only while it is typed: submitting moves it into the one
// `sign-in` effect and empties the field, so no state after that holds it. The password of a
// mailbox that is being added (M2d-4, `AddView.password`) is held the same way: it leaves the
// state in the one `add-mailbox` effect, and Esc drops it.
//
// The mailbox screen (M2d-2) holds the folder tree and, while a folder is open, the state of the
// M2b browser (`MailboxView.browser`): folder names, senders and subjects are held for display
// only. So are the stats of the mailbox (M2d-3, `MailboxView.stats`): they are read once on a
// connection of their own and stay in the view until the mailbox is left. The filter line of the
// open folder and its matches (M3a) are held in the browser state the same way, for display only;
// the search itself runs in the controller on the mailbox's session (`search-folder`).

export type AppKey =
  | {
      type:
        | 'up'
        | 'down'
        | 'pageup'
        | 'pagedown'
        | 'enter'
        | 'escape'
        | 'left'
        | 'backspace'
        | 'tab'
        | 'clear'
        | 'other';
    }
  | { type: 'char'; text: string };

export const MAX_EMAIL_CHARS = 254;
export const MAX_PASSWORD_CHARS = 1024;

/** A message on the status line; the renderer has the words. */
export type AppMessage =
  | 'wrong-credentials'
  | 'unreachable'
  | 'sign-in-failed'
  | 'email-required'
  | 'password-required'
  | 'forget-signed-in'
  | 'session-ended'
  | 'load-failed'
  | 'folder-unavailable'
  | 'truncated'
  | 'challenge';

export interface SignInForm {
  email: string;
  /** A remembered address was chosen: only the password is typed. */
  fixedEmail: boolean;
  /** Never drawn; '' again from the moment the form is submitted. */
  password: string;
  field: 'email' | 'password';
}

export type SignInMode =
  | 'checking'
  | 'check-failed'
  | 'pick'
  | 'form'
  | 'submitting'
  | 'confirm-switch'
  | 'signing-out'
  | 'confirm-forget';

export interface SignInView {
  kind: 'sign-in';
  mode: SignInMode;
  /** Row of the list: a known user, or the last row (index = number of known users). */
  cursor: number;
  /** The open form, or the one waiting for a sign-out (`confirm-switch`, `signing-out`). */
  form: SignInForm | null;
  message: AppMessage | null;
}

/** A saved mailbox as Home shows it - never its secret. */
export interface MailboxRow {
  id: string;
  email: string;
  provider: string;
  lastCheckedAt: Date | null;
}

/** The rows below the mailboxes on Home. */
export const HOME_ACTIONS = ['add', 'logs', 'log-out'] as const;

export interface HomeView {
  kind: 'home';
  mode: 'list' | 'signing-out';
  /** null until the list arrived. */
  mailboxes: readonly MailboxRow[] | null;
  loadFailed: boolean;
  /** Row: a mailbox, then HOME_ACTIONS. */
  cursor: number;
  message: AppMessage | null;
  /** The mailbox to put the cursor on when the list arrives (the one just added). */
  focusId: string | null;
  /** The address of the mailbox just added: said on the status line until the next key. */
  added: string | null;
}

export type MailboxMode =
  | 'connecting'
  | 'reading'
  | 'ready'
  | 'failed'
  | 'confirm-leave'
  | 'confirm-quit'
  | 'browsing'
  | 'stats';

export type FolderOrder = 'tree' | 'size' | 'name';

export type StatsSection = 'years' | 'senders' | 'domains' | 'largest';
export type StatsBy = 'size' | 'messages';

/** The stats of the open mailbox: not asked for yet, being read, there, or why not. */
export type StatsRead =
  | { status: 'idle' }
  /** `progress`: null until the first folder reports. */
  | { status: 'reading'; progress: SizeProgress | null }
  | { status: 'ready'; stats: MailboxStats }
  /** `text`: what happened and what to do, already in plain words. */
  | { status: 'failed'; text: string };

/** One mailbox, open: its folders as usage bars and, in a folder, the M2b browser. */
export interface MailboxView {
  kind: 'mailbox';
  mode: MailboxMode;
  /** What Home showed - never a secret. */
  mailbox: MailboxRow;
  /** Home as it was, restored by Left. */
  home: HomeView;
  /** The size fallback's "n/m" while reading. */
  progress: SizeProgress | null;
  /** null until the folders were read. */
  tree: FolderTree | null;
  /** The text of the failed login or read, as the controller gave it. */
  failure: string | null;
  order: FolderOrder;
  /** Row in the folders as `order` lists them. */
  cursor: number;
  /** The marks of this visit: seeds every browser and is written back when it is left. */
  basket: Basket;
  /** What the browsers of this visit did so far (for `browse.finish`). */
  visit: BrowserStats;
  /** A folder was opened in this visit. */
  opened: boolean;
  /** Bumped on every browser open and leave: browser results of another token are dropped. */
  browserToken: number;
  /** The browser inside the open folder; null on the bars. */
  browser: BrowserState | null;
  /** Where the space goes: kept while the mailbox is open, whatever is on screen. */
  stats: StatsRead;
  /** Bumped by every stats read that starts: a result of an earlier one is dropped. */
  statsToken: number;
  /** What the stats screen shows, remembered while the mailbox is open. */
  statsSection: StatsSection;
  statsBy: StatsBy;
  /** Rows of the section scrolled off the top. */
  statsTop: number;
  message: AppMessage | null;
}

/** How far back the logs screen looks. */
export type LogsWindow = '24h' | '7d' | '30d';

/** The local logs as a page (M2d-5): what `mm logs` prints, read again whenever a filter changes. */
export interface LogsView {
  kind: 'logs';
  /** Home as it was, restored by Esc. */
  home: HomeView;
  mode: 'reading' | 'shown' | 'failed';
  window: LogsWindow;
  securityOnly: boolean;
  warnOnly: boolean;
  /** The report, oldest first: sanitised, ASCII. */
  lines: readonly string[];
  /** Why the log folder can't be read. */
  failure: string | null;
  /** Rows scrolled up from the bottom; 0 = the newest line is the last row. */
  scroll: number;
}

export type AddStep =
  | 'address'
  | 'looking'
  | 'found'
  | 'blocked'
  | 'nothing'
  | 'providers'
  | 'host'
  | 'server'
  | 'checking-saved'
  | 'password'
  | 'checking'
  | 'failed';

/** The server a mailbox is added with, once it is chosen. */
export interface ChosenServer {
  settings: ImapSettings;
  /** Preset id, or `custom`. */
  provider: string;
  /** Shown name and hint of the provider, when one is known. */
  name: string | null;
  hint: string | null;
}

/** Adding a mailbox (M2d-4): the address, its server, the password, the login check. */
export interface AddView {
  kind: 'add';
  /** Home as it was, restored by Esc from the first step. */
  home: HomeView;
  step: AddStep;
  /** The address as typed. */
  address: string;
  /** What discovery is checking now. */
  checking: DiscoverySource | null;
  result: DiscoveryResult | null;
  /** Row of the provider list (a preset, never a heading). */
  cursor: number;
  /** Lines scrolled in the read-only steps (found, blocked, nothing, failed). */
  scroll: number;
  host: string;
  username: string;
  field: 'host' | 'username';
  /** The provider whose host is being typed (step `host`). */
  hostProvider: ProviderInfo | null;
  /**
   * The steps Esc goes back through, nearest last. Only steps the user acts in are pushed
   * (address, found, nothing, providers, host, server) - never looking, checking-saved,
   * checking.
   */
  back: readonly AddStep[];
  chosen: ChosenServer | null;
  /** Never drawn; '' again from the moment it is submitted. */
  password: string;
  /** A validation message or the text of a rejected login. */
  note: string | null;
  /** The login guard is making this login wait. */
  waiting: boolean;
  failure: string | null;
}

export interface AppState {
  version: string;
  screen: Screen;
  /** Bumped with every request: a result for an older one is ignored. */
  generation: number;
  /** The signed-in user. */
  current: AuthUser | null;
  /** The addresses of earlier sign-ins, newest first. */
  remembered: readonly string[];
  /** A mailbox's stats are read as soon as its folders are there; otherwise only on `s`. */
  autoStats: boolean;
  /** Why no mailbox can be added (in plain words), or null when one can. */
  addProblem: string | null;
  view: SignInView | HomeView | MailboxView | LogsView | AddView;
}

export interface KnownUser {
  email: string;
  signedIn: boolean;
}

export type AppAction =
  | { type: 'key'; key: AppKey }
  | { type: 'resize'; screen: Screen }
  | { type: 'session'; generation: number; user: AuthUser | null; remembered: readonly string[] }
  | { type: 'session-failed'; generation: number; remembered: readonly string[] }
  | { type: 'signed-in'; generation: number; user: AuthUser; remembered: readonly string[] }
  | {
      type: 'sign-in-failed';
      generation: number;
      reason: 'invalid-credentials' | 'unreachable' | 'unknown';
    }
  | { type: 'signed-out'; generation: number; remembered: readonly string[] }
  | { type: 'remembered'; emails: readonly string[] }
  | { type: 'mailboxes'; generation: number; rows: readonly MailboxRow[] }
  | { type: 'mailboxes-failed'; generation: number }
  | { type: 'session-ended'; generation: number; remembered: readonly string[] }
  /** The login worked: the folders are being read. */
  | { type: 'mailbox-reading'; generation: number }
  | { type: 'mailbox-progress'; generation: number; progress: SizeProgress }
  | { type: 'mailbox-opened'; generation: number; tree: FolderTree }
  /** `text`: what happened and what to do, already in plain words. */
  | { type: 'mailbox-failed'; generation: number; text: string }
  /** The login guard waits before this login. */
  | { type: 'challenge'; generation: number }
  /** That wait is over: the login starts. */
  | { type: 'challenge-done'; generation: number }
  /** A result for the embedded browser that was opened under `browserToken`. */
  | { type: 'browser'; browserToken: number; action: BrowserAction }
  /** The stats read `statsToken` of the open mailbox: how far it is, its result, or why not. */
  | { type: 'stats-progress'; statsToken: number; progress: SizeProgress }
  | { type: 'stats-ready'; statsToken: number; stats: MailboxStats }
  | { type: 'stats-failed'; statsToken: number; text: string }
  /** The logs as lines to show, or why the log folder can't be read (in plain words). */
  | { type: 'logs-read'; generation: number; lines: readonly string[] }
  | { type: 'logs-failed'; generation: number; text: string }
  /** Adding a mailbox: what the lookup of its settings is checking, and what it found. */
  | { type: 'discover-progress'; generation: number; source: DiscoverySource }
  | { type: 'discovered'; generation: number; result: DiscoveryResult }
  /** The address and server are not saved yet: the password can be asked. */
  | { type: 'saved-checked'; generation: number }
  /** The login was rejected in a way another password may fix; `text` says so in plain words. */
  | { type: 'add-rejected'; generation: number; text: string }
  /** Adding can't go on; `text`: what happened and what to do, already in plain words. */
  | { type: 'add-failed'; generation: number; text: string }
  | { type: 'mailbox-added'; generation: number; id: string; email: string };

/** What `browse.finish` reports of a mailbox visit: counts and bytes, never names. */
export interface BrowseFinishData {
  /** A folder was opened (there is no data for a visit that opened none). */
  opened: boolean;
  folders: number;
  mails: number;
  reconnects: number;
  marked: number;
  bytes: number;
}

export type AppEffect =
  | { type: 'check-session'; generation: number }
  | { type: 'sign-in'; generation: number; email: string; password: string }
  | { type: 'sign-out'; generation: number }
  | { type: 'forget'; email: string }
  | { type: 'load-mailboxes'; generation: number }
  /** One login to the saved mailbox, then its folders. */
  | { type: 'open-mailbox'; generation: number; accountId: string }
  /** Log out the mailbox's session; `finish` is null when no folder was opened. */
  | { type: 'close-mailbox'; finish: BrowseFinishData | null }
  /** A page for the embedded browser (`browserGeneration` is the browser's own generation). */
  | {
      type: 'load-page';
      browserToken: number;
      browserGeneration: number;
      path: string;
      page: number;
      expected: FolderSnapshot | null;
    }
  /** Search the open folder with this filter (embedded browser). */
  | {
      type: 'search-folder';
      browserToken: number;
      browserGeneration: number;
      path: string;
      filter: Filter;
    }
  /** A page of a filtered list, by UID. */
  | {
      type: 'load-matches';
      browserToken: number;
      browserGeneration: number;
      path: string;
      page: number;
      expected: FolderSnapshot;
      uids: number[];
    }
  /** The search under way is no longer wanted. */
  | { type: 'stop-search' }
  | { type: 'reconnect-mailbox'; browserToken: number }
  /** One more login to the open mailbox, then its stats; `statsToken` names the read. */
  | { type: 'read-stats'; statsToken: number; tree: FolderTree }
  /** Read the local logs of this window, with these filters. */
  | {
      type: 'read-logs';
      generation: number;
      window: LogsWindow;
      securityOnly: boolean;
      warnOnly: boolean;
    }
  /** Look up the IMAP settings of this address (public data, no login). */
  | { type: 'discover'; generation: number; address: string }
  /** Is this address + server saved already? */
  | { type: 'check-saved'; generation: number; email: string; host: string; provider: string }
  /** One login with the typed password and, when it works, the saved mailbox. */
  | {
      type: 'add-mailbox';
      generation: number;
      email: string;
      settings: ImapSettings;
      provider: string;
      password: string;
    }
  | { type: 'quit' };

export interface AppReduced {
  state: AppState;
  effects: AppEffect[];
}

/** The effects that carry a generation, before it is stamped. */
export type PendingEffect =
  | { type: 'check-session' }
  | { type: 'sign-in'; email: string; password: string }
  | { type: 'sign-out' }
  | { type: 'load-mailboxes' }
  | { type: 'open-mailbox'; accountId: string }
  | { type: 'read-logs'; window: LogsWindow; securityOnly: boolean; warnOnly: boolean }
  | { type: 'discover'; address: string }
  | { type: 'check-saved'; email: string; host: string; provider: string }
  | {
      type: 'add-mailbox';
      email: string;
      settings: ImapSettings;
      provider: string;
      password: string;
    };

/** Shown for a signed-in user whose account has no e-mail address. */
export const NO_EMAIL = '(no e-mail)';

/** Why Gmail's stats can't be read while All Mail is hidden: no login is made for them. */
export const STATS_GMAIL_HIDDEN =
  "Stats can't be read - Gmail hides All Mail from IMAP (Labels > Show in IMAP).";

/** readline key names that are keys of their own; every other name may be typed text. */
const KEYS = new Map<string, Exclude<AppKey, { type: 'char' }>['type']>([
  ['up', 'up'],
  ['down', 'down'],
  ['pageup', 'pageup'],
  ['pagedown', 'pagedown'],
  ['return', 'enter'],
  ['enter', 'enter'],
  ['left', 'left'],
  ['backspace', 'backspace'],
  ['tab', 'tab'],
]);

/** Longest key sequence taken as typed text (UTF-16 units): one character, however composed. */
const MAX_SEQUENCE = 16;
/** C0 and C1 control characters and DEL - covers ESC, so no escape sequence is typed text. */
const CONTROL = /\p{Cc}/u;

/**
 * Maps a readline keypress to an app key. readline reports a lone Esc as
 * `{ name: 'escape', meta: true }`, so Esc is matched before the Ctrl/Meta rule. Everything
 * that isn't a named key and carries no control character is typed text, case kept. Format
 * characters (a zero-width joiner, say) pass: a password may contain them.
 */
export function appKeyOf(k: Keypress): AppKey {
  if (k.ctrl !== true && k.name === 'escape') return { type: 'escape' };
  if (k.ctrl === true && k.name === 'u') return { type: 'clear' };
  if (k.ctrl === true || k.meta === true) return { type: 'other' };
  const named = typeof k.name === 'string' ? KEYS.get(k.name) : undefined;
  if (named !== undefined) return { type: named };
  const text = k.sequence;
  if (typeof text !== 'string' || text === '' || text.length > MAX_SEQUENCE || CONTROL.test(text)) {
    return { type: 'other' };
  }
  return { type: 'char', text };
}

export { erased, typed } from '../browser/field.js';

/**
 * Whether two addresses are one user: their stored forms are equal (letter case and the
 * Unicode or `xn--` form of an international domain don't matter). Text that isn't an address
 * is compared without letter case.
 */
function sameUser(a: string, b: string): boolean {
  const left = normalizeEmail(a);
  const right = normalizeEmail(b);
  return left !== null && right !== null ? left === right : a.toLowerCase() === b.toLowerCase();
}

/**
 * The users of the sign-in list: the signed-in one first (shown as Mail Manager gave it), then
 * every remembered address that isn't that user.
 */
export function knownUsers(state: Pick<AppState, 'current' | 'remembered'>): KnownUser[] {
  const { current, remembered } = state;
  if (current === null) return remembered.map((email) => ({ email, signedIn: false }));
  return [
    { email: current.email === '' ? NO_EMAIL : current.email, signedIn: true },
    ...remembered
      .filter((email) => !sameUser(email, current.email))
      .map((email) => ({ email, signedIn: false })),
  ];
}

/** generation + 1 on the state, and that generation on the effect. */
export function emit(state: AppState, effect: PendingEffect): AppReduced {
  const generation = state.generation + 1;
  return { state: { ...state, generation }, effects: [{ ...effect, generation }] };
}

/**
 * Home again, from a screen that kept it (the logs, adding a mailbox): as it was, under a new
 * generation, so whatever that screen still waits for is dropped. A list that had not arrived
 * when the screen was opened is asked for again - its answer was dropped the same way, and
 * without a new request Home would wait for it for good.
 */
export function backToHome(state: AppState, home: HomeView): AppReduced {
  if (home.mailboxes === null && !home.loadFailed) {
    return emit({ ...state, view: home }, { type: 'load-mailboxes' });
  }
  return { state: { ...state, generation: state.generation + 1, view: home }, effects: [] };
}

/** True for the letter key `letter` (lower-case), typed in either case. */
export function isLetter(key: AppKey, letter: string): boolean {
  return key.type === 'char' && key.text.toLowerCase() === letter;
}

/** Below 40x8 only "window too small" is shown. */
export function tooSmall(screen: Screen): boolean {
  return screen.rows < MIN_ROWS || screen.cols < MIN_COLS;
}

/** First visible row so the cursor stays on screen. */
export function windowTop(cursor: number, height: number): number {
  return cursor < height ? 0 : cursor - height + 1;
}

/** Body lines of the mailbox screen above its folder rows: the totals and the quota. */
export const MAILBOX_FIXED_LINES = 2;

/** Folder rows of the mailbox screen that fit below those lines. */
export function folderRoom(screen: Screen): number {
  return Math.max(1, bodyHeight(screen) - MAILBOX_FIXED_LINES);
}

/** Exhaustiveness: a view without its case fails to compile (and ends the app if it ever ran). */
export function unknownView(view: never): never {
  throw new Error(`Unknown app view: ${String(view)}`);
}

/** The sign-in list from its first row. */
export function pickView(message: AppMessage | null = null): SignInView {
  return { kind: 'sign-in', mode: 'pick', cursor: 0, form: null, message };
}

/** A fresh Home: its mailbox list is still to be loaded. */
export function homeView(): HomeView {
  return {
    kind: 'home',
    mode: 'list',
    mailboxes: null,
    loadFailed: false,
    cursor: 0,
    message: null,
    focusId: null,
    added: null,
  };
}

/** A mailbox being opened from Home: connecting, nothing read or marked yet. */
export function mailboxView(
  mailbox: MailboxRow,
  home: HomeView,
  browserToken: number,
): MailboxView {
  return {
    kind: 'mailbox',
    mode: 'connecting',
    mailbox,
    home,
    progress: null,
    tree: null,
    failure: null,
    order: 'tree',
    cursor: 0,
    basket: emptyBasket,
    visit: { foldersOpened: 0, mailsLoaded: 0, reconnects: 0 },
    opened: false,
    browserToken,
    browser: null,
    stats: { status: 'idle' },
    statsToken: 0,
    statsSection: 'years',
    statsBy: 'size',
    statsTop: 0,
    message: null,
  };
}

/** Letter keys of the M2b browser, lower-case. */
const BROWSER_LETTERS = new Map<string, BrowserKey>([
  [' ', 'space'],
  ['a', 'mark-screen'],
  ['q', 'quit'],
  ['y', 'yes'],
  ['n', 'no'],
  ['r', 'reconnect'],
]);

/** Letter keys of the mail list inside the app only (M3a); on its own they are `other`. */
const EMBEDDED_LETTERS = new Map<string, BrowserKey>([
  ['/', 'filter'],
  ['o', 'order'],
  ['m', 'mark-all'],
]);

/**
 * An app key as the M2b browser's reducer takes it. Embedded in the app, Esc goes back like
 * Left; on its own (`mm folders`) Esc quits.
 */
export function browserKeyOf(key: AppKey, embedded: boolean): BrowserKey {
  switch (key.type) {
    case 'up':
    case 'down':
    case 'pageup':
    case 'pagedown':
    case 'enter':
      return key.type;
    case 'left':
    case 'backspace':
      return 'back';
    case 'escape':
      return embedded ? 'back' : 'quit';
    case 'char': {
      if (embedded) {
        const own = EMBEDDED_LETTERS.get(key.text.toLowerCase());
        if (own !== undefined) return own;
      }
      return BROWSER_LETTERS.get(key.text.toLowerCase()) ?? 'other';
    }
    default:
      return 'other';
  }
}

/** The folders in the order the bars list them; ties keep the tree order. */
export function orderedFolders(tree: FolderTree, order: FolderOrder): readonly FolderInfo[] {
  switch (order) {
    case 'tree':
      return tree.folders;
    case 'size':
      // Largest first, unknown sizes last.
      return [...tree.folders].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
    case 'name': {
      // By the full path without letter case, in code unit order (no locale).
      const keyed = tree.folders.map((folder) => ({ folder, key: folder.path.toLowerCase() }));
      keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return keyed.map((k) => k.folder);
    }
  }
}

/** Punctuation of the CLI's texts that the app writes in ASCII. */
const ASCII_OF = new Map<string, string>([
  ['\u2014', '-'],
  ['\u2013', '-'],
  ['\u2026', '...'],
  ['\u2018', "'"],
  ['\u2019', "'"],
  ['\u201c', '"'],
  ['\u201d', '"'],
  ['\u2192', '->'],
]);

/**
 * `text` in ASCII: dashes, the ellipsis, curly quotes and the arrow become their ASCII form,
 * every other non-ASCII character a "?".
 */
export function asciiText(text: string): string {
  let out = '';
  for (const ch of text) out += ch.charCodeAt(0) < 0x80 ? ch : (ASCII_OF.get(ch) ?? '?');
  return out;
}

export function initialApp(
  version: string,
  screen: Screen,
  options: { autoStats?: boolean; addProblem?: string | null } = {},
): AppState {
  return {
    version,
    screen: screenOf(screen),
    generation: 0,
    current: null,
    remembered: [],
    autoStats: options.autoStats ?? false,
    addProblem: options.addProblem ?? null,
    view: { kind: 'sign-in', mode: 'checking', cursor: 0, form: null, message: null },
  };
}
