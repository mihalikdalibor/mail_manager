import {
  providerInfo,
  type DiscoveryResult,
  type ProviderInfo,
} from '../../core/providers/discover.js';
import { DiscoveryInputError, parseEmail, type ParsedEmail } from '../../core/providers/email.js';
import { PRESETS, pickableProviders, type Preset } from '../../core/providers/presets.js';
import {
  manualSettings,
  settingsFromPreset,
  validateManualHost,
  validateManualUsername,
  type ImapSettings,
} from '../../core/providers/settings.js';
import { wrap } from '../browser/layout.js';
import { bodyHeight, type Screen } from '../browser/state.js';
import { domainProblemText, foundVia, offDomainWarning, triedText } from '../discovery-text.js';
import { sanitize } from '../log-text.js';
import {
  MAX_EMAIL_CHARS,
  MAX_PASSWORD_CHARS,
  asciiText,
  backToHome,
  emit,
  erased,
  isLetter,
  tooSmall,
  typed,
  type AddView,
  type AppAction,
  type AppKey,
  type AppReduced,
  type AppState,
  type ChosenServer,
  type HomeView,
} from './state.js';

// Adding a mailbox (M2d-4) as a pure reducer: the address, what the lookup found, the provider
// list or a server typed by hand, the check that it isn't saved yet, the password and the login
// check - the steps of `mm account add`, one screen each. The lookup, the duplicate check and
// the add itself are effects the controller runs; everything typed is checked here with the
// core's own validators, so their messages are the ones the commands print.
//
// Esc goes one step back: `back` holds the steps the user acted in, nearest last. A request
// that is still under way when a step is left is dropped by its generation (reduce.ts).
//
// The password is held only while it is typed: Enter moves it into the one `add-mailbox`
// effect and empties the field, Esc drops it. Nothing drawn depends on it.

export const ADDRESS_REQUIRED = 'Type the e-mail address of the mailbox.';
export const PASSWORD_REQUIRED = 'Type the password.';
/** After Enter on a server that an unsigned DNS record named: it takes `y`. */
export const OFF_DOMAIN_CONFIRM = 'Press y to use this server, or m to enter another.';

/** Longest host or username taken into a field (code points). */
const MAX_FIELD_CHARS = 254;

export const ADD_INDENT = '    ';
/** What a warning's first line starts with: no indent. */
const WARNING_MARK = '! ';
/** Columns of a label and the gap after it: every value starts in the same column. */
export const ADD_LABEL_WIDTH = 11;

/** A row of the provider list: a group's heading, or a provider to choose. */
export type ProviderRow =
  | { kind: 'heading'; text: string }
  | {
      kind: 'preset';
      preset: Preset;
      verified: boolean;
      /** Why it can't be used yet, or null. */
      blocked: string | null;
    };

const GROUPS: readonly (readonly [Preset['group'], string])[] = [
  ['sk-cz', 'Slovakia / Czechia'],
  ['global', 'Global'],
];

/** The provider list: each group's heading, then its providers in the picker's order. */
export function providerRows(presets: readonly Preset[] = PRESETS): ProviderRow[] {
  const sorted = pickableProviders(presets);
  return GROUPS.flatMap(([group, text]): ProviderRow[] => [
    { kind: 'heading', text },
    ...sorted
      .filter((preset) => preset.group === group)
      .map((preset): ProviderRow => ({
        kind: 'preset',
        preset,
        verified: preset.verified,
        blocked: preset.blocked ?? null,
      })),
  ]);
}

/** The built-in list; it never changes while the app runs. */
const ROWS = providerRows();
/** The rows a cursor can be on, as indexes into ROWS. */
const PRESET_ROWS = ROWS.flatMap((row, i) => (row.kind === 'preset' ? [i] : []));

function same(state: AppState): AppReduced {
  return { state, effects: [] };
}

function quit(state: AppState): AppReduced {
  return { state, effects: [{ type: 'quit' }] };
}

function shown(state: AppState, view: AddView): AppState {
  return state.view === view ? state : { ...state, view };
}

/**
 * The screen as Enter on Home's "+ Add a mailbox" opens it: the address field - or, when no
 * mailbox can be added (`addProblem`: the key is missing or broken), only the reason.
 */
export function addView(home: HomeView, addProblem: string | null): AddView {
  return {
    kind: 'add',
    home,
    step: addProblem === null ? 'address' : 'failed',
    address: '',
    checking: null,
    result: null,
    cursor: PRESET_ROWS[0] ?? 0,
    scroll: 0,
    host: '',
    username: '',
    field: 'host',
    hostProvider: null,
    back: [],
    chosen: null,
    password: '',
    note: null,
    waiting: false,
    failure: addProblem,
  };
}

// --- what the read-only steps show ----------------------------------------------------------

/** Text from outside as the screen takes it: nothing a terminal would act on, plain ASCII. */
function clean(text: string): string {
  return asciiText(sanitize(text));
}

/** `    Label:     value`, a long value wrapped under itself. */
export function addLabelled(label: string, value: string, cols: number): string[] {
  const head = `${ADD_INDENT}${label.padEnd(ADD_LABEL_WIDTH)}`;
  const parts = wrap(clean(value), Math.max(1, cols - head.length));
  if (parts.length === 0) return [head];
  return parts.map((part, i) => `${i === 0 ? head : ' '.repeat(head.length)}${part}`);
}

/** A warning, at the margin so that it stands out: `! text`, wrapped under the text. */
function warning(text: string, cols: number): string[] {
  const parts = wrap(clean(text), Math.max(1, cols - WARNING_MARK.length));
  return parts.map(
    (part, i) => `${i === 0 ? WARNING_MARK : ' '.repeat(WARNING_MARK.length)}${part}`,
  );
}

/** Text wrapped to the body; its line breaks are kept (sanitize() would join the sentences). */
export function addPlain(text: string, cols: number): string[] {
  const width = Math.max(1, cols - ADD_INDENT.length);
  return text
    .split('\n')
    .flatMap((part) => wrap(clean(part), width))
    .map((line) => `${ADD_INDENT}${line}`);
}

function providerLines(provider: ProviderInfo | undefined, cols: number): string[] {
  if (provider === undefined) return [];
  const name = provider.verified ? provider.name : `${provider.name} (unverified preset)`;
  return addLabelled('Provider:', name, cols);
}

function helpLines(provider: ProviderInfo | undefined, cols: number): string[] {
  return [
    ...(provider?.hint === undefined ? [] : addLabelled('Hint:', provider.hint, cols)),
    ...(provider?.helpUrl === undefined ? [] : addLabelled('Help:', provider.helpUrl, cols)),
  ];
}

/** The server a login would go to: `Server:    host:993 (TLS)` and the username. */
export function addServerLines(settings: ImapSettings, cols: number): string[] {
  return [
    ...addLabelled('Server:', `${settings.host}:${String(settings.port)} (TLS)`, cols),
    ...addLabelled('Username:', settings.username, cols),
  ];
}

function resultLines(result: DiscoveryResult, cols: number): string[] {
  const warnings = (texts: readonly string[]): string[] =>
    texts.flatMap((text) => warning(text, cols));
  const domain = result.email.displayDomain;
  switch (result.status) {
    case 'found': {
      const offDomain = offDomainWarning(result);
      return [
        ...providerLines(result.provider, cols),
        ...addServerLines(result.imap, cols),
        ...addLabelled('Found via:', foundVia(result.source, result.via), cols),
        ...helpLines(result.provider, cols),
        ...warnings(result.notices),
        ...(result.domainProblem === undefined
          ? []
          : warnings([domainProblemText(result.domainProblem, domain)])),
        ...(offDomain === undefined ? [] : warnings([offDomain])),
      ];
    }
    case 'blocked':
      return [
        ...providerLines(result.provider, cols),
        ...addLabelled('Found via:', foundVia(result.source, result.via), cols),
        ...helpLines(result.provider, cols),
        ...warnings(result.notices),
        ...addPlain(`Not supported yet: ${result.reason}`, cols),
      ];
    case 'manual':
      return [
        ...(result.domainProblem === undefined
          ? []
          : addPlain(domainProblemText(result.domainProblem, domain), cols)),
        ...addPlain(`No IMAP settings found for ${domain}.`, cols),
        ...result.tried.flatMap((tried) => addLabelled('Tried:', triedText(tried), cols)),
        ...warnings(result.notices),
      ];
    case 'needs-host':
      // Never shown as a page: the host field opens at once.
      return [];
  }
}

/**
 * The lines of a step that only shows something (found, blocked, nothing, failed), wrapped to
 * `cols`: the page those steps scroll. Every other step has none.
 */
export function addLines(view: AddView, cols: number): string[] {
  switch (view.step) {
    case 'found':
    case 'blocked':
    case 'nothing':
      return view.result === null ? [] : resultLines(view.result, cols);
    case 'failed':
      return addPlain(view.failure ?? '', cols);
    default:
      return [];
  }
}

/** The note in the words drawn, or null. */
export function addNoteText(view: AddView): string | null {
  return view.note === null ? null : clean(view.note);
}

/**
 * The note wrapped for the body: only one that is too long for the status line goes there
 * (a rejected login's text, say). None when it fits, or when there is no note.
 */
export function addNoteLines(view: AddView, cols: number): string[] {
  const note = addNoteText(view);
  if (note === null || note.length <= cols) return [];
  return addPlain(view.note ?? '', cols);
}

/** Body lines the page of a read-only step has: a note in the body takes its lines below it. */
export function addPageRoom(view: AddView, screen: Screen): number {
  return Math.max(1, bodyHeight(screen) - addNoteLines(view, screen.cols).length);
}

// --- the steps ------------------------------------------------------------------------------

function emailOf(view: AddView): ParsedEmail | null {
  return view.result?.email ?? null;
}

/** The message of a core validator, or null when the value passes. */
function problemOf(check: () => unknown): string | null {
  try {
    check();
    return null;
  } catch (err) {
    if (err instanceof DiscoveryInputError) return err.message;
    throw err;
  }
}

/**
 * The server is chosen in this step: first whether the mailbox is saved already - the password
 * is asked after that. Esc comes back here.
 */
function choose(state: AppState, view: AddView, chosen: ChosenServer): AppReduced {
  const email = emailOf(view);
  if (email === null) return same(state);
  return emit(
    shown(state, {
      ...view,
      step: 'checking-saved',
      back: [...view.back, view.step],
      chosen,
      password: '',
      note: null,
      scroll: 0,
    }),
    {
      type: 'check-saved',
      email: email.address,
      host: chosen.settings.host,
      provider: chosen.provider,
    },
  );
}

function openProviders(state: AppState, view: AddView): AppReduced {
  return same(
    shown(state, {
      ...view,
      step: 'providers',
      back: [...view.back, view.step],
      cursor: PRESET_ROWS[0] ?? 0,
      note: null,
      scroll: 0,
    }),
  );
}

/** The server typed by hand: the host, and the username - the address unless changed. */
function openServer(state: AppState, view: AddView): AppReduced {
  const email = emailOf(view);
  if (email === null) return same(state);
  return same(
    shown(state, {
      ...view,
      step: 'server',
      back: [...view.back, view.step],
      host: '',
      username: email.address,
      field: 'host',
      note: null,
      scroll: 0,
    }),
  );
}

/**
 * Esc: the step before this one, as it was left - nothing chosen, no password. From the first
 * step: Home. `pending`: a request of this step is under way and is dropped.
 */
function back(state: AppState, view: AddView, pending = false): AppReduced {
  const step = view.back.at(-1);
  if (step === undefined) return backToHome(state, view.home);
  const generation = pending ? state.generation + 1 : state.generation;
  return same({
    ...state,
    generation,
    view: {
      ...view,
      step,
      back: view.back.slice(0, -1),
      checking: null,
      chosen: null,
      password: '',
      note: null,
      waiting: false,
      scroll: 0,
    },
  });
}

function isBack(key: AppKey): boolean {
  return key.type === 'escape' || key.type === 'left' || key.type === 'backspace';
}

/** The page `by` lines further down (or up), kept inside what there is. */
function scrolled(state: AppState, view: AddView, by: number): AppReduced {
  const lines = addLines(view, state.screen.cols).length;
  const last = Math.max(0, lines - addPageRoom(view, state.screen));
  const scroll = Math.min(Math.max(0, view.scroll + by), last);
  return scroll === view.scroll ? same(state) : same(shown(state, { ...view, scroll }));
}

/** Up / Down / PgUp / PgDn on a page; null for any other key. */
function scrollKey(state: AppState, view: AddView, key: AppKey): AppReduced | null {
  const page = addPageRoom(view, state.screen);
  switch (key.type) {
    case 'up':
      return scrolled(state, view, -1);
    case 'down':
      return scrolled(state, view, 1);
    case 'pageup':
      return scrolled(state, view, -page);
    case 'pagedown':
      return scrolled(state, view, page);
    default:
      return null;
  }
}

/** The text of a field after `key`: what was typed, erased or cleared - as it was otherwise. */
function edited(value: string, key: AppKey, max: number, shownField = true): string {
  switch (key.type) {
    case 'char':
      // Text that couldn't be shown is not taken into a field that is.
      return shownField && sanitize(key.text) !== key.text ? value : typed(value, key.text, max);
    case 'backspace':
      return erased(value);
    case 'clear':
      return '';
    default:
      return value;
  }
}

function addressKey(state: AppState, view: AddView, key: AppKey): AppReduced {
  // A key clears the note, as on the sign-in form.
  const v: AddView = view.note === null ? view : { ...view, note: null };
  if (key.type === 'escape') return back(state, v);
  if (key.type === 'enter') {
    const address = v.address.trim();
    if (address === '') return same(shown(state, { ...v, note: ADDRESS_REQUIRED }));
    const problem = problemOf(() => parseEmail(address));
    if (problem !== null) return same(shown(state, { ...v, note: problem }));
    return emit(
      shown(state, { ...v, step: 'looking', checking: null, result: null, chosen: null }),
      { type: 'discover', address },
    );
  }
  const address = edited(v.address, key, MAX_EMAIL_CHARS);
  return same(shown(state, address === v.address ? v : { ...v, address }));
}

function lookingKey(state: AppState, view: AddView, key: AppKey): AppReduced {
  if (key.type !== 'escape') return same(state);
  // The address field again, as typed. The new generation drops what the lookup still reports.
  return same({
    ...state,
    generation: state.generation + 1,
    view: { ...view, step: 'address', checking: null, note: null },
  });
}

function discovered(state: AppState, view: AddView, result: DiscoveryResult): AppReduced {
  const next: AddView = {
    ...view,
    result,
    checking: null,
    back: ['address'],
    chosen: null,
    note: null,
    scroll: 0,
  };
  switch (result.status) {
    case 'found':
      return same(shown(state, { ...next, step: 'found' }));
    case 'blocked':
      return same(shown(state, { ...next, step: 'blocked' }));
    case 'needs-host':
      // The provider is known, its server is the mailbox's own: asked for at once.
      return same(shown(state, { ...next, step: 'host', hostProvider: result.provider, host: '' }));
    case 'manual':
      return same(shown(state, { ...next, step: 'nothing' }));
  }
}

function foundKey(state: AppState, view: AddView, key: AppKey): AppReduced {
  const result = view.result;
  if (result?.status !== 'found') return isBack(key) ? back(state, view) : same(state);
  const use = (): AppReduced =>
    choose(state, view, {
      settings: result.imap,
      provider: result.provider?.id ?? 'custom',
      name: result.provider?.name ?? null,
      hint: result.provider?.hint ?? null,
    });
  if (isBack(key)) return back(state, view);
  if (isLetter(key, 'y')) return use();
  if (isLetter(key, 'c')) return openProviders(state, view);
  if (isLetter(key, 'm')) return openServer(state, view);
  if (key.type === 'enter') {
    // A faked DNS record is the one way these settings could be hostile: Enter is not enough.
    if (result.offDomain !== true) return use();
    if (view.note === OFF_DOMAIN_CONFIRM) return same(state);
    // With the end of the page in view: the warning that says why is its last line.
    const noted: AddView = { ...view, note: OFF_DOMAIN_CONFIRM };
    const lines = addLines(noted, state.screen.cols).length;
    const scroll = Math.max(0, lines - addPageRoom(noted, state.screen));
    return same(shown(state, { ...noted, scroll }));
  }
  return scrollKey(state, view, key) ?? same(state);
}

function nothingKey(state: AppState, view: AddView, key: AppKey): AppReduced {
  if (isBack(key)) return back(state, view);
  if (isLetter(key, 'c')) return openProviders(state, view);
  if (isLetter(key, 'm')) return openServer(state, view);
  return scrollKey(state, view, key) ?? same(state);
}

/** The preset row `by` providers from the cursor (headings don't count), inside the list. */
function presetRow(cursor: number, by: number): number {
  const at = PRESET_ROWS.findIndex((row) => row >= cursor);
  const from = at === -1 ? PRESET_ROWS.length - 1 : at;
  const to = Math.min(Math.max(0, from + by), PRESET_ROWS.length - 1);
  return PRESET_ROWS[to] ?? cursor;
}

function providersKey(state: AppState, view: AddView, key: AppKey): AppReduced {
  // A key clears the note, as on Home.
  const v: AddView = view.note === null ? view : { ...view, note: null };
  const moved = (by: number): AppReduced => {
    const cursor = presetRow(v.cursor, by);
    return same(shown(state, cursor === v.cursor ? v : { ...v, cursor }));
  };
  const page = bodyHeight(state.screen);
  if (isBack(key)) return back(state, v);
  if (isLetter(key, 'm')) return openServer(state, v);
  switch (key.type) {
    case 'up':
      return moved(-1);
    case 'down':
      return moved(1);
    case 'pageup':
      return moved(-page);
    case 'pagedown':
      return moved(page);
    case 'enter': {
      const row = ROWS[v.cursor];
      const email = emailOf(v);
      if (row?.kind !== 'preset' || email === null) return same(shown(state, v));
      const { preset } = row;
      if (preset.blocked !== undefined) {
        return same(shown(state, { ...v, note: `Not supported yet: ${preset.blocked}` }));
      }
      const settings = settingsFromPreset(preset, email);
      if (settings === null) {
        // Its server is the mailbox's own: typed next.
        return same(
          shown(state, {
            ...v,
            step: 'host',
            back: [...v.back, 'providers'],
            hostProvider: providerInfo(preset),
            host: '',
            scroll: 0,
          }),
        );
      }
      return choose(state, v, {
        settings,
        provider: preset.id,
        name: preset.name,
        hint: preset.hint ?? null,
      });
    }
    default:
      return same(shown(state, v));
  }
}

function hostKey(state: AppState, view: AddView, key: AppKey): AppReduced {
  const v: AddView = view.note === null ? view : { ...view, note: null };
  if (key.type === 'escape') return back(state, v);
  if (key.type === 'enter') {
    const email = emailOf(v);
    const provider = v.hostProvider;
    if (email === null || provider === null) return same(shown(state, v));
    const problem = problemOf(() => validateManualHost(v.host));
    if (problem !== null) return same(shown(state, { ...v, note: problem }));
    return choose(state, v, {
      settings: manualSettings({ host: v.host }, email),
      provider: provider.id,
      name: provider.name,
      hint: provider.hint ?? null,
    });
  }
  const host = edited(v.host, key, MAX_FIELD_CHARS);
  return same(shown(state, host === v.host ? v : { ...v, host }));
}

function serverKey(state: AppState, view: AddView, key: AppKey): AppReduced {
  const v: AddView = view.note === null ? view : { ...view, note: null };
  switch (key.type) {
    case 'escape':
      return back(state, v);
    case 'tab':
    case 'up':
    case 'down':
      return same(shown(state, { ...v, field: v.field === 'host' ? 'username' : 'host' }));
    case 'enter': {
      if (v.field === 'host') return same(shown(state, { ...v, field: 'username' }));
      const email = emailOf(v);
      if (email === null) return same(shown(state, v));
      // Both are checked here: the message, and the field it is about.
      const host = problemOf(() => validateManualHost(v.host));
      if (host !== null) return same(shown(state, { ...v, field: 'host', note: host }));
      const username = problemOf(() => validateManualUsername(v.username, email));
      if (username !== null) return same(shown(state, { ...v, note: username }));
      return choose(state, v, {
        settings: manualSettings({ host: v.host, username: v.username }, email),
        provider: 'custom',
        name: null,
        hint: null,
      });
    }
    default: {
      if (v.field === 'host') {
        const host = edited(v.host, key, MAX_FIELD_CHARS);
        return same(shown(state, host === v.host ? v : { ...v, host }));
      }
      const username = edited(v.username, key, MAX_FIELD_CHARS);
      return same(shown(state, username === v.username ? v : { ...v, username }));
    }
  }
}

function passwordKey(state: AppState, view: AddView, key: AppKey): AppReduced {
  switch (key.type) {
    case 'char':
    case 'backspace':
    case 'clear': {
      // Anything typed is taken: the field is never shown. Nothing on screen follows the
      // typing - a note stays until Enter or Esc.
      const password = edited(view.password, key, MAX_PASSWORD_CHARS, false);
      return same(shown(state, password === view.password ? view : { ...view, password }));
    }
    case 'escape':
      return back(state, view);
    case 'enter': {
      const email = emailOf(view);
      const chosen = view.chosen;
      if (email === null || chosen === null) return same(state);
      if (view.password === '') return same(shown(state, { ...view, note: PASSWORD_REQUIRED }));
      // The password leaves the state here: it travels in the effect only.
      return emit(
        shown(state, { ...view, step: 'checking', password: '', note: null, waiting: false }),
        {
          type: 'add-mailbox',
          email: email.address,
          settings: chosen.settings,
          provider: chosen.provider,
          password: view.password,
        },
      );
    }
    default:
      return same(state);
  }
}

function onKey(state: AppState, view: AddView, key: AppKey): AppReduced {
  const small = tooSmall(state.screen);
  switch (view.step) {
    case 'checking':
      // The login can't be called back: only Ctrl+C acts, and that is the controller's.
      return same(state);
    // In a field `q` is a letter, and nothing is typed into a field that isn't on screen.
    case 'address':
      return small ? same(state) : addressKey(state, view, key);
    case 'host':
      return small ? same(state) : hostKey(state, view, key);
    case 'server':
      return small ? same(state) : serverKey(state, view, key);
    case 'password':
      return small ? same(state) : passwordKey(state, view, key);
    default:
      break;
  }
  if (isLetter(key, 'q')) return quit(state);
  // Only "window too small" is shown: quit is the one key that acts.
  if (small) return same(state);
  switch (view.step) {
    case 'looking':
      return lookingKey(state, view, key);
    case 'checking-saved':
      // The step the server was chosen in; the check still under way is dropped.
      return key.type === 'escape' ? back(state, view, true) : same(state);
    case 'found':
      return foundKey(state, view, key);
    case 'nothing':
      return nothingKey(state, view, key);
    case 'providers':
      return providersKey(state, view, key);
    case 'blocked':
      return isBack(key) ? back(state, view) : (scrollKey(state, view, key) ?? same(state));
    case 'failed':
      // Nothing to go back to: Home, whatever step it failed in.
      if (isBack(key)) return backToHome(state, view.home);
      return scrollKey(state, view, key) ?? same(state);
  }
}

/** Adding ended in a step that can't go on: its text, and only the way back to Home. */
function failed(view: AddView, text: string): AddView {
  return {
    ...view,
    step: 'failed',
    failure: text,
    checking: null,
    password: '',
    note: null,
    waiting: false,
    scroll: 0,
  };
}

/** One step of the add screen; a state showing another view comes back unchanged. */
export function reduceAdd(state: AppState, action: AppAction): AppReduced {
  const view = state.view;
  if (view.kind !== 'add') return same(state);
  switch (action.type) {
    case 'key':
      return onKey(state, view, action.key);
    case 'discover-progress':
      if (view.step !== 'looking') return same(state);
      return same(shown(state, { ...view, checking: action.source }));
    case 'discovered':
      return view.step === 'looking' ? discovered(state, view, action.result) : same(state);
    case 'saved-checked':
      if (view.step !== 'checking-saved') return same(state);
      return same(shown(state, { ...view, step: 'password', password: '', note: null }));
    case 'challenge':
      return view.step === 'checking'
        ? same(shown(state, { ...view, waiting: true }))
        : same(state);
    case 'challenge-done':
      return view.step === 'checking'
        ? same(shown(state, { ...view, waiting: false }))
        : same(state);
    case 'add-rejected':
      // Another password may do: the field again, empty, with what the mail server said no to.
      if (view.step !== 'checking') return same(state);
      return same(
        shown(state, {
          ...view,
          step: 'password',
          password: '',
          note: action.text,
          waiting: false,
        }),
      );
    case 'add-failed':
      if (view.step !== 'looking' && view.step !== 'checking-saved' && view.step !== 'checking') {
        return same(state);
      }
      return same(shown(state, failed(view, action.text)));
    case 'mailbox-added':
      if (view.step !== 'checking') return same(state);
      // Home with its list read again: the new mailbox is in it, and gets the cursor.
      return emit(
        {
          ...state,
          view: {
            ...view.home,
            mailboxes: null,
            // The old cursor was "+ Add a mailbox", after the mailboxes: without them it would be
            // on "Logs" or "Log out", one impatient Enter away.
            cursor: 0,
            loadFailed: false,
            message: null,
            focusId: action.id,
            added: action.email,
          },
        },
        { type: 'load-mailboxes' },
      );
    default:
      return same(state);
  }
}
