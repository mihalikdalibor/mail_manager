import { describe, it, expect } from 'vitest';
import {
  ADDRESS_REQUIRED,
  OFF_DOMAIN_CONFIRM,
  PASSWORD_REQUIRED,
  addLines,
  addView,
  providerRows,
  reduceAdd,
} from '../../src/cli/app/add.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import {
  MAX_EMAIL_CHARS,
  MAX_PASSWORD_CHARS,
  backToHome,
  initialApp,
} from '../../src/cli/app/state.js';
import type {
  AddStep,
  AddView,
  AppAction,
  AppEffect,
  AppKey,
  AppReduced,
  AppState,
  HomeView,
  MailboxRow,
} from '../../src/cli/app/state.js';
import { bodyHeight } from '../../src/cli/browser/state.js';
import type { Screen } from '../../src/cli/browser/state.js';
import type { AuthUser } from '../../src/core/auth.js';
import { providerInfo } from '../../src/core/providers/discover.js';
import type { DiscoveryResult } from '../../src/core/providers/discover.js';
import { parseEmail } from '../../src/core/providers/email.js';
import { PRESETS, pickableProviders } from '../../src/core/providers/presets.js';
import type { Preset } from '../../src/core/providers/presets.js';

// M2d-4 add a mailbox, state: Enter on Home's "+ Add a mailbox", every step and its keys, what
// the validators of the core say, the four outcomes of the lookup, where Esc goes from each
// step, the password leaving the state, results nobody waits for, and Home when the mailbox is
// saved - through reduceApp. Every step proves that the state it was given is untouched.
// Addresses and hosts are placeholders.

// --- fixtures -------------------------------------------------------------------------------

const ANNA: AuthUser = { email: 'anna@example-test-domain.eu', userId: 'user-anna' };
const SCREEN: Screen = { rows: 24, cols: 80 }; // 21 body lines
const SMALLEST: Screen = { rows: 8, cols: 40 }; // 5 body lines
const TOO_SMALL: Screen = { rows: 7, cols: 80 };
const MAILBOXES: MailboxRow[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'box@example-test-domain.eu',
    provider: 'websupport',
    lastCheckedAt: null,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'second@example-test-domain.eu',
    provider: 'custom',
    lastCheckedAt: null,
  },
];
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const ADDRESS = 'new@example-test-domain.eu';
const EMAIL = parseEmail(ADDRESS);
/** Typed into the password field: in no state once it is submitted. */
const PASSWORD = 'Zx9#Qw7$Lk2!vJ5^';
const PROBLEM = 'MM_MASTER_KEY is not set';
const zeroWidth = String.fromCodePoint(0x200b);
const override = String.fromCodePoint(0x202e);

function preset(id: string): Preset {
  const found = PRESETS.find((p) => p.id === id);
  if (found === undefined) throw new Error(`no preset ${id}`);
  return found;
}

const WEBSUPPORT = preset('websupport');
const OUTLOOK = preset('outlook');
const WEDOS = preset('wedos');
const GMAIL = preset('gmail');

const base = { email: EMAIL, notices: [], tried: [] };
/** A built-in preset matched the address. */
const FOUND: DiscoveryResult = {
  ...base,
  status: 'found',
  source: 'preset-domain',
  provider: providerInfo(WEBSUPPORT),
  imap: { host: 'imap.m1.websupport.sk', port: 993, username: ADDRESS },
  altHosts: [],
};
/** A DNS record named a server outside the address's domain: no provider, and it takes `y`. */
const OFF_DOMAIN: DiscoveryResult = {
  ...base,
  status: 'found',
  source: 'srv',
  via: '_imaps._tcp.example-test-domain.eu',
  imap: { host: 'imap.elsewhere-test-domain.eu', port: 993, username: ADDRESS },
  altHosts: [],
  offDomain: true,
  notices: ['The username is a guess (full email address); SRV records do not specify it.'],
};
const BLOCKED: DiscoveryResult = {
  ...base,
  status: 'blocked',
  source: 'preset-mx',
  via: 'mx.example-test-domain.eu',
  provider: providerInfo(OUTLOOK),
  reason: OUTLOOK.blocked ?? '',
};
const NEEDS_HOST: DiscoveryResult = {
  ...base,
  status: 'needs-host',
  source: 'preset-mx',
  via: 'mx.example-test-domain.eu',
  provider: providerInfo(WEDOS),
};
const MANUAL: DiscoveryResult = {
  ...base,
  status: 'manual',
  tried: [
    { source: 'preset-domain', outcome: 'no-match' },
    { source: 'preset-mx', outcome: 'no-match', detail: 'mx.example-test-domain.eu' },
    { source: 'ispdb', outcome: 'not-found' },
  ],
};
/** A page far longer than any window: 60 notices. */
const LONG: DiscoveryResult = {
  ...FOUND,
  notices: Array.from({ length: 60 }, (_, i) => `Notice number ${String(i + 1)}.`),
};

// --- the driver -----------------------------------------------------------------------------

function key(type: Exclude<AppKey['type'], 'char'>): AppAction {
  return { type: 'key', key: { type } };
}

function ch(text: string): AppAction {
  return { type: 'key', key: { type: 'char', text } };
}

function chars(text: string): AppAction[] {
  return [...text].map(ch);
}

function repeat(action: AppAction, n: number): AppAction[] {
  return Array.from({ length: n }, () => action);
}

const BACK_KEYS: [string, AppAction][] = [
  ['Esc', key('escape')],
  ['Left', key('left')],
  ['Backspace', key('backspace')],
];

/** One step, proving the state it was given wasn't changed. */
function step(state: AppState, action: AppAction): AppReduced {
  const before = structuredClone(state);
  const out = reduceApp(state, action);
  expect(state).toEqual(before);
  return out;
}

/** The actions in order: the last state and every effect on the way. */
function run(state: AppState, ...actions: AppAction[]): AppReduced {
  let s = state;
  const effects: AppEffect[] = [];
  for (const a of actions) {
    const out = step(s, a);
    s = out.state;
    effects.push(...out.effects);
  }
  return { state: s, effects };
}

function act(state: AppState, ...actions: AppAction[]): AppState {
  return run(state, ...actions).state;
}

function view(state: AppState): AddView {
  if (state.view.kind !== 'add') throw new Error(`not adding: ${state.view.kind}`);
  return state.view;
}

function home(state: AppState): HomeView {
  if (state.view.kind !== 'home') throw new Error(`not on Home: ${state.view.kind}`);
  return state.view;
}

interface Options {
  screen?: Screen;
  mailboxes?: MailboxRow[];
  addProblem?: string;
}

/** Home of ANNA, its list still loading. */
function loadingHome(o: Options = {}): AppState {
  const options = o.addProblem === undefined ? {} : { addProblem: o.addProblem };
  const s0 = startApp(initialApp('1.2.3', o.screen ?? SCREEN, options)).state;
  return act(
    s0,
    { type: 'session', generation: s0.generation, user: ANNA, remembered: [ANNA.email] },
    key('enter'),
  );
}

/** Home of ANNA with her mailboxes, the cursor on "+ Add a mailbox". */
function atHome(o: Options = {}): AppState {
  const rows = o.mailboxes ?? MAILBOXES;
  const s = loadingHome(o);
  return act(
    s,
    { type: 'mailboxes', generation: s.generation, rows },
    ...repeat(key('down'), rows.length),
  );
}

/** The add screen as Enter opens it. */
function opened(o: Options = {}): AppState {
  return act(atHome(o), key('enter'));
}

/** The address typed and sent: the lookup is under way. */
function looking(o: Options = {}): AppState {
  return act(opened(o), ...chars(ADDRESS), key('enter'));
}

/** The lookup answered with `result`. */
function discovered(result: DiscoveryResult, o: Options = {}): AppState {
  const s = looking(o);
  return act(s, { type: 'discovered', generation: s.generation, result });
}

/** The provider list, opened from what was found. */
function providers(o: Options = {}): AppState {
  return act(discovered(FOUND, o), ch('c'));
}

/** The row of a preset in the provider list. */
function rowOf(id: string): number {
  const at = providerRows().findIndex((row) => row.kind === 'preset' && row.preset.id === id);
  if (at === -1) throw new Error(`no row for ${id}`);
  return at;
}

/** The provider list with the cursor on `id`. */
function onPreset(id: string, o: Options = {}): AppState {
  const before = providerRows()
    .slice(0, rowOf(id))
    .filter((row) => row.kind === 'preset').length;
  const s = act(providers(o), ...repeat(key('down'), before));
  expect(view(s).cursor).toBe(rowOf(id));
  return s;
}

/** The server fields, opened from what was found. */
function server(o: Options = {}): AppState {
  return act(discovered(FOUND, o), ch('m'));
}

/** What was found is used: is it saved already? */
function checkingSaved(result: DiscoveryResult = FOUND, o: Options = {}): AppState {
  return act(discovered(result, o), result === OFF_DOMAIN ? ch('y') : key('enter'));
}

function savedChecked(state: AppState): AppAction {
  return { type: 'saved-checked', generation: state.generation };
}

/** The password field. */
function atPassword(result: DiscoveryResult = FOUND, o: Options = {}): AppState {
  const s = checkingSaved(result, o);
  return act(s, savedChecked(s));
}

/** The password sent: the login is being checked. */
function checking(o: Options = {}): AppState {
  return act(atPassword(FOUND, o), ...chars(PASSWORD), key('enter'));
}

type Effect<T extends AppEffect['type']> = Extract<AppEffect, { type: T }>;

const WEBSUPPORT_CHOSEN = {
  settings: { host: 'imap.m1.websupport.sk', port: 993, username: ADDRESS },
  provider: 'websupport',
  name: 'Websupport',
  hint: WEBSUPPORT.hint ?? null,
};

// --- A1: opening, and the address -----------------------------------------------------------

describe('Enter on "+ Add a mailbox" (A1)', () => {
  it('addView: the address field, nothing typed, nothing found, nothing chosen', () => {
    const kept = home(atHome());
    expect(addView(kept, null)).toEqual({
      kind: 'add',
      home: kept,
      step: 'address',
      address: '',
      checking: null,
      result: null,
      cursor: 1,
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
      failure: null,
    });
    expect(addView(kept, null).home).toBe(kept);
  });

  it('addView with a problem: only its text, on the failed step', () => {
    const kept = home(atHome());
    expect(addView(kept, PROBLEM)).toEqual({
      ...addView(kept, null),
      step: 'failed',
      failure: PROBLEM,
    });
  });

  it('opens the address field: no request, the same generation', () => {
    const s = atHome();
    expect(home(s).cursor).toBe(2);
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: addView(home(s), null) });
  });

  it('with no mailboxes it is the first row', () => {
    const s = atHome({ mailboxes: [] });
    expect(home(s).cursor).toBe(0);
    expect(view(act(s, key('enter'))).step).toBe('address');
  });

  it('"Added ..." on Home is not kept for the way back', () => {
    const s = atHome();
    const said: AppState = { ...s, view: { ...home(s), added: ADDRESS } };
    expect(view(act(said, key('enter'))).home).toEqual(home(s));
  });

  it('too small: Enter on Home does nothing', () => {
    const s = act(atHome(), { type: 'resize', screen: TOO_SMALL });
    expect(step(s, key('enter'))).toEqual({ state: s, effects: [] });
  });
});

describe('no key, no mailbox: the reason and the way back (A1)', () => {
  const failedOpen = (): AppState => opened({ addProblem: PROBLEM });

  it('Enter shows the problem instead of the field', () => {
    const s = atHome({ addProblem: PROBLEM });
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: addView(home(s), PROBLEM) });
    expect(view(out.state)).toMatchObject({ step: 'failed', failure: PROBLEM });
  });

  it.each(BACK_KEYS)('%s: Home as it was', (_name, back) => {
    const s = failedOpen();
    const out = step(s, back);
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, generation: s.generation + 1, view: view(s).home });
  });

  it.each(['q', 'Q'])('%s quits', (text) => {
    const s = failedOpen();
    expect(step(s, ch(text))).toEqual({ state: s, effects: [{ type: 'quit' }] });
  });

  it('nothing else acts: nothing can be typed, looked up or chosen', () => {
    const s = failedOpen();
    const keys = [key('enter'), key('tab'), key('clear'), ch('a'), ch('y'), ch('c'), ch('m')];
    for (const k of keys) expect(step(s, k)).toEqual({ state: s, effects: [] });
  });
});

describe('the address field (A1)', () => {
  it('takes what is typed, case kept', () => {
    const s = act(opened(), ...chars('New@Example-Test-Domain.EU'));
    expect(view(s)).toEqual({ ...view(opened()), address: 'New@Example-Test-Domain.EU' });
  });

  it('q, y, c and m are letters here', () => {
    const s = opened();
    const out = run(s, ...chars('qycmQ'));
    expect(out.effects).toEqual([]);
    expect(view(out.state).address).toBe('qycmQ');
  });

  it('Backspace takes the last character, Ctrl+U everything', () => {
    const s = act(opened(), ...chars('abc'));
    expect(view(act(s, key('backspace'))).address).toBe('ab');
    expect(view(act(s, ...repeat(key('backspace'), 9))).address).toBe('');
    expect(view(act(s, key('clear'))).address).toBe('');
  });

  it('holds 254 code points and no more', () => {
    const full = act(opened(), ...repeat(ch('a'), MAX_EMAIL_CHARS));
    expect(view(full).address).toHaveLength(254);
    expect(step(full, ch('b')).state).toBe(full);
    // A character of two code units is one code point.
    const emoji = String.fromCodePoint(0x1f4e7);
    const wide = act(opened(), ...repeat(ch(emoji), 300));
    expect([...view(wide).address]).toHaveLength(254);
  });

  it('text that could not be shown is not taken', () => {
    const s = act(opened(), ch('a'));
    for (const hidden of [zeroWidth, override, `b${zeroWidth}`]) {
      expect(step(s, ch(hidden)).state).toBe(s);
    }
  });

  it('keys that are not for a field do nothing', () => {
    const s = act(opened(), ch('a'));
    for (const k of [
      key('left'),
      key('tab'),
      key('up'),
      key('down'),
      key('pageup'),
      key('other'),
    ]) {
      expect(step(s, k)).toEqual({ state: s, effects: [] });
    }
  });

  it.each(['', '   '])('Enter on an empty field (%j): the hint, nothing asked', (typed) => {
    const s = act(opened(), ...chars(typed));
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), note: ADDRESS_REQUIRED } });
    expect(ADDRESS_REQUIRED).toBe('Type the e-mail address of the mailbox.');
  });

  it.each<[string, string]>([
    ['no-at.example-test-domain.eu', 'Email address must contain "@"'],
    ['@example-test-domain.eu', 'Email address has no name before "@"'],
    ['new@', 'Email address has no domain after "@"'],
    ['new@nodot', 'Email domain is not a valid domain name'],
    ['ne w@example-test-domain.eu', 'Email address contains invalid characters'],
    ['new@exa mple-test-domain.eu', 'Email domain contains invalid characters'],
    ['new@127.0.0.1', 'Email domain is not a valid domain name'],
  ])('Enter on %j: "%s", the field stays', (typed, message) => {
    const s = act(opened(), ...chars(typed));
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), note: message } });
    expect(view(out.state)).toMatchObject({ step: 'address', address: typed });
  });

  it('the next key clears the message', () => {
    const noted = act(opened(), ...chars('nope'), key('enter'));
    expect(view(noted).note).toBe('Email address must contain "@"');
    for (const k of [ch('@'), key('backspace'), key('clear'), key('tab'), key('other')]) {
      expect(view(act(noted, k)).note).toBeNull();
    }
    // Enter again says it again.
    expect(view(act(noted, key('enter'))).note).toBe('Email address must contain "@"');
  });

  it('Esc: Home as it was, also with something typed', () => {
    for (const s of [opened(), act(opened(), ...chars('half@')), act(opened(), key('enter'))]) {
      const out = step(s, key('escape'));
      expect(out.effects).toEqual([]);
      expect(out.state).toEqual({ ...s, generation: s.generation + 1, view: view(s).home });
      expect(out.state.view).toBe(view(s).home);
      expect(home(out.state)).toMatchObject({ mailboxes: MAILBOXES, cursor: 2, message: null });
    }
  });

  it('too small: nothing is typed, and no key acts', () => {
    const s = act(act(opened(), ch('a')), { type: 'resize', screen: TOO_SMALL });
    const keys = [ch('b'), ch('q'), key('backspace'), key('clear'), key('enter'), key('escape')];
    for (const k of keys) expect(step(s, k)).toEqual({ state: s, effects: [] });
  });
});

// --- A2: the lookup -------------------------------------------------------------------------

describe('a valid address is looked up (A2)', () => {
  it('Enter: "looking", one discover request for what was typed', () => {
    const s = act(opened(), ...chars(ADDRESS));
    const out = step(s, key('enter'));
    expect(out.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: { ...view(s), step: 'looking' },
    });
    expect(out.effects).toEqual([
      { type: 'discover', generation: s.generation + 1, address: ADDRESS },
    ]);
  });

  it('spaces around the address are not sent; the field keeps what was typed', () => {
    const out = run(opened(), ...chars(`  ${ADDRESS} `), key('enter'));
    expect(out.effects).toEqual([
      { type: 'discover', generation: out.state.generation, address: ADDRESS },
    ]);
    expect(view(out.state).address).toBe(`  ${ADDRESS} `);
  });

  it('a Unicode domain goes out as typed', () => {
    const typed = `new@b${String.fromCodePoint(0xfc)}cher.example-test-domain.eu`;
    const out = run(opened(), ...chars(typed), key('enter'));
    expect(out.effects).toEqual([
      { type: 'discover', generation: out.state.generation, address: typed },
    ]);
    expect(view(out.state)).toMatchObject({ step: 'looking', address: typed });
  });

  it('a new lookup forgets what an earlier one found', () => {
    const again = act(discovered(FOUND), key('escape'), key('enter'));
    expect(view(again)).toMatchObject({ step: 'looking', result: null, checking: null, back: [] });
  });

  it('progress names the source being asked', () => {
    const s = looking();
    const one = step(s, { type: 'discover-progress', generation: s.generation, source: 'ispdb' });
    expect(one).toEqual({ state: { ...s, view: { ...view(s), checking: 'ispdb' } }, effects: [] });
    const two = act(one.state, {
      type: 'discover-progress',
      generation: s.generation,
      source: 'srv',
    });
    expect(view(two).checking).toBe('srv');
  });

  it('Esc: the address field with what was typed; what the lookup still says is dropped', () => {
    const s = act(looking(), {
      type: 'discover-progress',
      generation: looking().generation,
      source: 'ispdb',
    });
    const out = step(s, key('escape'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: { ...view(s), step: 'address', checking: null },
    });
    expect(view(out.state).address).toBe(ADDRESS);
    const late: AppAction[] = [
      { type: 'discovered', generation: s.generation, result: FOUND },
      { type: 'discover-progress', generation: s.generation, source: 'srv' },
      { type: 'add-failed', generation: s.generation, text: 'late' },
    ];
    for (const action of late) expect(step(out.state, action).state).toBe(out.state);
  });

  it('no other key acts while looking; q quits', () => {
    const s = looking();
    const keys = [key('left'), key('backspace'), key('enter'), key('up'), ch('a'), ch('y')];
    for (const k of keys) expect(step(s, k)).toEqual({ state: s, effects: [] });
    expect(step(s, ch('q'))).toEqual({ state: s, effects: [{ type: 'quit' }] });
  });

  it('the address that the lookup refuses after all: its text on the failed step', () => {
    const s = looking();
    const out = step(s, { type: 'add-failed', generation: s.generation, text: 'Not an address.' });
    expect(out.effects).toEqual([]);
    expect(view(out.state)).toMatchObject({ step: 'failed', failure: 'Not an address.' });
  });

  it('a result for a step that is not looking changes nothing', () => {
    const s = act(opened(), ...chars(ADDRESS));
    const forged: AppAction[] = [
      { type: 'discovered', generation: s.generation, result: FOUND },
      { type: 'discover-progress', generation: s.generation, source: 'srv' },
    ];
    for (const action of forged) expect(step(s, action).state).toBe(s);
  });
});

// --- A3 / A4: the four outcomes -------------------------------------------------------------

describe('what the lookup found (A3)', () => {
  it('found: the page of the settings, Esc goes back to the address', () => {
    const s = looking();
    const out = step(s, { type: 'discovered', generation: s.generation, result: FOUND });
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: { ...view(s), step: 'found', result: FOUND, back: ['address'] },
    });
  });

  it('Enter uses the settings: first whether the mailbox is saved already', () => {
    const s = discovered(FOUND);
    const out = step(s, key('enter'));
    expect(out.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: {
        ...view(s),
        step: 'checking-saved',
        back: ['address', 'found'],
        chosen: WEBSUPPORT_CHOSEN,
      },
    });
    expect(out.effects).toEqual([
      {
        type: 'check-saved',
        generation: s.generation + 1,
        email: EMAIL.address,
        host: 'imap.m1.websupport.sk',
        provider: 'websupport',
      },
    ]);
  });

  it('the check and the add are for the address the lookup parsed, not the text of the field', () => {
    // Typed with spaces and in upper case; the lookup answers with the address it will use.
    const typed = '  NEW@Example-Test-Domain.EU ';
    const s = act(opened(), ...chars(typed), key('enter'));
    const out = run(
      s,
      { type: 'discovered', generation: s.generation, result: FOUND },
      key('enter'),
    );
    expect(view(out.state).address).toBe(typed);
    expect(out.effects).toEqual([
      {
        type: 'check-saved',
        generation: out.state.generation,
        email: ADDRESS,
        host: 'imap.m1.websupport.sk',
        provider: 'websupport',
      },
    ]);
    const sent = run(out.state, savedChecked(out.state), ...chars(PASSWORD), key('enter'));
    expect((sent.effects[0] as Effect<'add-mailbox'>).email).toBe(ADDRESS);
    // The server fields get it as their username too.
    const fields = act(s, { type: 'discovered', generation: s.generation, result: FOUND }, ch('m'));
    expect(view(fields).username).toBe(ADDRESS);
  });

  it.each(['y', 'Y'])('%s uses them too, warning or not', (text) => {
    for (const result of [FOUND, OFF_DOMAIN]) {
      const s = discovered(result);
      const out = step(s, ch(text));
      expect(view(out.state).step).toBe('checking-saved');
      expect(out.effects).toHaveLength(1);
    }
  });

  it('settings without a known provider are saved as "custom", with no name or hint', () => {
    const out = run(discovered(OFF_DOMAIN), ch('y'));
    expect(view(out.state).chosen).toEqual({
      settings: { host: 'imap.elsewhere-test-domain.eu', port: 993, username: ADDRESS },
      provider: 'custom',
      name: null,
      hint: null,
    });
    expect(out.effects[0]).toMatchObject({
      type: 'check-saved',
      host: 'imap.elsewhere-test-domain.eu',
      provider: 'custom',
    });
  });

  it('a server from an unsigned DNS record: Enter only says to press y', () => {
    const s = discovered(OFF_DOMAIN);
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), note: OFF_DOMAIN_CONFIRM } });
    expect(OFF_DOMAIN_CONFIRM).toBe('Press y to use this server, or m to enter another.');
    // Enter again changes nothing; y goes on, and the note is gone.
    expect(step(out.state, key('enter')).state).toBe(out.state);
    expect(view(act(out.state, ch('y')))).toMatchObject({ step: 'checking-saved', note: null });
  });

  it('c opens the provider list on its first provider', () => {
    const s = discovered(FOUND);
    const out = step(s, ch('c'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: { ...view(s), step: 'providers', back: ['address', 'found'], cursor: 1 },
    });
  });

  it('m opens the server fields: no host yet, the address as the username', () => {
    const s = discovered(FOUND);
    const out = step(s, ch('m'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: {
        ...view(s),
        step: 'server',
        back: ['address', 'found'],
        host: '',
        username: EMAIL.address,
        field: 'host',
      },
    });
  });

  it.each(BACK_KEYS)('%s: the address field, as typed', (_name, back) => {
    const s = discovered(FOUND);
    const out = step(s, back);
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), step: 'address', back: [] } });
    expect(view(out.state).address).toBe(ADDRESS);
  });

  it('q quits; keys that mean nothing here do nothing', () => {
    const s = discovered(FOUND);
    expect(step(s, ch('q'))).toEqual({ state: s, effects: [{ type: 'quit' }] });
    for (const k of [key('tab'), key('clear'), key('other'), ch('x'), ch('r')]) {
      expect(step(s, k)).toEqual({ state: s, effects: [] });
    }
  });

  it('a page longer than the window scrolls, and stops at both ends', () => {
    const s = discovered(LONG);
    const lines = addLines(view(s), SCREEN.cols).length;
    expect(lines).toBeGreaterThan(60);
    const last = lines - bodyHeight(SCREEN);
    expect(step(s, key('up')).state).toBe(s);
    expect(view(act(s, key('down'))).scroll).toBe(1);
    expect(view(act(s, key('pagedown'))).scroll).toBe(21);
    expect(view(act(s, ...repeat(key('pagedown'), 9))).scroll).toBe(last);
    const end = act(s, ...repeat(key('pagedown'), 9));
    expect(step(end, key('down')).state).toBe(end);
    expect(view(act(end, key('up'))).scroll).toBe(last - 1);
    expect(view(act(end, key('pageup'))).scroll).toBe(last - 21);
    expect(view(act(end, ...repeat(key('pageup'), 9))).scroll).toBe(0);
  });

  it('a page that fits does not scroll', () => {
    const s = discovered(FOUND);
    for (const k of [key('up'), key('down'), key('pageup'), key('pagedown')]) {
      expect(step(s, k).state).toBe(s);
    }
  });

  it('going on starts from the top of the next page', () => {
    const scrolledDown = act(discovered(LONG), key('pagedown'));
    expect(view(act(scrolledDown, key('enter'))).scroll).toBe(0);
    expect(view(act(scrolledDown, ch('c'))).scroll).toBe(0);
    expect(view(act(scrolledDown, key('escape'))).scroll).toBe(0);
  });
});

describe('not supported, a host of its own, nothing found (A4)', () => {
  it('blocked: only the way back and q', () => {
    const s = discovered(BLOCKED);
    expect(view(s)).toMatchObject({ step: 'blocked', result: BLOCKED, back: ['address'] });
    for (const k of [key('enter'), ch('y'), ch('c'), ch('m'), key('tab'), ch('x')]) {
      expect(step(s, k)).toEqual({ state: s, effects: [] });
    }
    expect(step(s, ch('q'))).toEqual({ state: s, effects: [{ type: 'quit' }] });
    for (const [, back] of BACK_KEYS) {
      expect(view(act(s, back))).toMatchObject({ step: 'address', back: [], address: ADDRESS });
    }
  });

  it('needs-host: straight to the host field of that provider', () => {
    const s = looking();
    const out = step(s, { type: 'discovered', generation: s.generation, result: NEEDS_HOST });
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: {
        ...view(s),
        step: 'host',
        result: NEEDS_HOST,
        back: ['address'],
        hostProvider: providerInfo(WEDOS),
        host: '',
      },
    });
    // Esc from there: the address field.
    expect(view(act(out.state, key('escape')))).toMatchObject({ step: 'address', back: [] });
  });

  it('manual: nothing found - c, m, or back', () => {
    const s = discovered(MANUAL);
    expect(view(s)).toMatchObject({ step: 'nothing', result: MANUAL, back: ['address'] });
    expect(view(act(s, ch('c')))).toMatchObject({
      step: 'providers',
      back: ['address', 'nothing'],
      cursor: 1,
    });
    expect(view(act(s, ch('m')))).toMatchObject({
      step: 'server',
      back: ['address', 'nothing'],
      username: EMAIL.address,
    });
    for (const [, back] of BACK_KEYS) {
      expect(view(act(s, back))).toMatchObject({ step: 'address', back: [] });
    }
    // There are no settings to use.
    for (const k of [key('enter'), ch('y'), ch('x')]) {
      expect(step(s, k)).toEqual({ state: s, effects: [] });
    }
    expect(step(s, ch('q'))).toEqual({ state: s, effects: [{ type: 'quit' }] });
  });
});

// --- A5: the provider list ------------------------------------------------------------------

describe('the provider list (A5)', () => {
  it('providerRows: a heading, its providers in the order of the picker, the next heading', () => {
    const rows = providerRows();
    const sorted = pickableProviders();
    const local = sorted.filter((p) => p.group === 'sk-cz');
    const global = sorted.filter((p) => p.group === 'global');
    expect(rows).toHaveLength(PRESETS.length + 2);
    expect(rows[0]).toEqual({ kind: 'heading', text: 'Slovakia / Czechia' });
    expect(rows[local.length + 1]).toEqual({ kind: 'heading', text: 'Global' });
    expect(rows.filter((row) => row.kind === 'heading')).toHaveLength(2);
    const ids = rows.flatMap((row) => (row.kind === 'preset' ? [row.preset.id] : []));
    expect(ids).toEqual([...local, ...global].map((p) => p.id));
  });

  it('providerRows: each provider with whether it is verified and why it is blocked', () => {
    for (const row of providerRows()) {
      if (row.kind !== 'preset') continue;
      expect(row.verified).toBe(row.preset.verified);
      expect(row.blocked).toBe(row.preset.blocked ?? null);
    }
    const outlook = providerRows()[rowOf('outlook')];
    expect(outlook).toMatchObject({ kind: 'preset', verified: true, blocked: OUTLOOK.blocked });
    const zoznam = providerRows()[rowOf('zoznam')];
    expect(zoznam).toMatchObject({ kind: 'preset', verified: false, blocked: null });
  });

  it('providerRows of another list: both headings, its providers', () => {
    const rows = providerRows([GMAIL, WEDOS]);
    expect(rows).toEqual([
      { kind: 'heading', text: 'Slovakia / Czechia' },
      { kind: 'preset', preset: WEDOS, verified: true, blocked: null },
      { kind: 'heading', text: 'Global' },
      { kind: 'preset', preset: GMAIL, verified: true, blocked: null },
    ]);
    expect(providerRows([])).toEqual([
      { kind: 'heading', text: 'Slovakia / Czechia' },
      { kind: 'heading', text: 'Global' },
    ]);
  });

  it('the cursor moves over providers only: a heading is stepped over', () => {
    const rows = providerRows();
    const heading = rows.findIndex((row, i) => i > 0 && row.kind === 'heading');
    let s = providers();
    const seen = [view(s).cursor];
    for (let i = 0; i < PRESETS.length + 3; i++) {
      s = act(s, key('down'));
      seen.push(view(s).cursor);
    }
    expect(seen.slice(0, PRESETS.length)).toEqual(
      rows.flatMap((row, i) => (row.kind === 'preset' ? [i] : [])),
    );
    expect(seen).not.toContain(heading);
    expect(seen).not.toContain(0);
    // The last provider holds; so does the first.
    expect(seen.at(-1)).toBe(rows.length - 1);
    expect(step(s, key('down')).state).toBe(s);
    const first = providers();
    expect(step(first, key('up')).state).toBe(first);
  });

  it('Up goes back over the heading; PgDn and PgUp go a window of providers at a time', () => {
    const rows = providerRows();
    const heading = rows.findIndex((row, i) => i > 0 && row.kind === 'heading');
    const first = act(providers(), ...repeat(key('down'), heading - 1));
    expect(view(first).cursor).toBe(heading + 1);
    expect(view(act(first, key('up'))).cursor).toBe(heading - 1);
    // 21 body lines: 21 providers further, which is past the heading.
    expect(view(act(providers(), key('pagedown'))).cursor).toBe(1 + 21 + 1);
    expect(view(act(providers(), key('pagedown'), key('pagedown'))).cursor).toBe(rows.length - 1);
    const end = act(providers(), ...repeat(key('pagedown'), 3));
    expect(view(act(end, key('pageup'))).cursor).toBe(rows.length - 1 - 21 - 1);
    expect(view(act(end, key('pageup'), key('pageup'))).cursor).toBe(1);
  });

  it('Enter on a provider with a server of its own: its settings, the address as username', () => {
    const s = onPreset('gmail');
    const out = step(s, key('enter'));
    expect(out.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: {
        ...view(s),
        step: 'checking-saved',
        back: ['address', 'found', 'providers'],
        chosen: {
          settings: { host: 'imap.gmail.com', port: 993, username: EMAIL.address },
          provider: 'gmail',
          name: GMAIL.name,
          hint: GMAIL.hint ?? null,
        },
      },
    });
    expect(out.effects).toEqual([
      {
        type: 'check-saved',
        generation: s.generation + 1,
        email: EMAIL.address,
        host: 'imap.gmail.com',
        provider: 'gmail',
      },
    ]);
  });

  it('Enter on one that is not supported yet: only the reason', () => {
    const s = onPreset('outlook');
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: { ...view(s), note: `Not supported yet: ${OUTLOOK.blocked ?? ''}` },
    });
    // The next key clears it - and moves, when it is a move.
    expect(view(act(out.state, key('up')))).toMatchObject({
      note: null,
      cursor: rowOf('outlook') - 1,
    });
    expect(view(act(out.state, ch('x')))).toMatchObject({ note: null, cursor: rowOf('outlook') });
  });

  it("Enter on one whose server is the mailbox's own: the host field", () => {
    const s = onPreset('wedos');
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: {
        ...view(s),
        step: 'host',
        back: ['address', 'found', 'providers'],
        hostProvider: providerInfo(WEDOS),
        host: '',
      },
    });
  });

  it('m: the server fields, opened from the list', () => {
    const s = onPreset('gmail');
    expect(view(act(s, ch('m')))).toMatchObject({
      step: 'server',
      back: ['address', 'found', 'providers'],
      host: '',
      username: EMAIL.address,
      field: 'host',
    });
  });

  it.each(BACK_KEYS)('%s: where the list was opened from', (_name, back) => {
    expect(view(act(providers(), back))).toMatchObject({ step: 'found', back: ['address'] });
    const fromNothing = act(discovered(MANUAL), ch('c'));
    expect(view(act(fromNothing, back))).toMatchObject({ step: 'nothing', back: ['address'] });
  });

  it('q quits; y and c are nothing here', () => {
    const s = providers();
    expect(step(s, ch('q'))).toEqual({ state: s, effects: [{ type: 'quit' }] });
    for (const k of [ch('y'), ch('c'), key('tab'), key('other')]) {
      expect(step(s, k)).toEqual({ state: s, effects: [] });
    }
  });

  it('opened again, the list starts on its first provider', () => {
    const s = act(onPreset('gmail'), key('escape'), ch('c'));
    expect(view(s).cursor).toBe(1);
  });
});

// --- A6: the host, the server ---------------------------------------------------------------

describe('the host of a known provider (A6)', () => {
  const hostStep = (): AppState => discovered(NEEDS_HOST);

  it('takes a host name; q is a letter', () => {
    const s = act(hostStep(), ...chars('wes1-imap.wedos.net'), ch('q'));
    expect(view(s)).toEqual({ ...view(hostStep()), host: 'wes1-imap.wedos.netq' });
    expect(view(act(s, key('backspace'))).host).toBe('wes1-imap.wedos.net');
    expect(view(act(s, key('clear'))).host).toBe('');
  });

  it('holds 254 code points; text that could not be shown is not taken', () => {
    const full = act(hostStep(), ...repeat(ch('a'), 254));
    expect(view(full).host).toHaveLength(254);
    expect(step(full, ch('b')).state).toBe(full);
    const s = act(hostStep(), ch('a'));
    expect(step(s, ch(zeroWidth)).state).toBe(s);
  });

  it.each<[string, string]>([
    ['', 'IMAP host is empty'],
    ['   ', 'IMAP host is empty'],
    [
      'imap.example-test-domain.eu:993',
      'Enter the host name only (e.g. imap.example.com); port 993 is used',
    ],
    [
      'https://imap.example-test-domain.eu',
      'Enter the host name only (e.g. imap.example.com); port 993 is used',
    ],
    [
      '127.0.0.1',
      'IMAP host is not a valid host name (IP addresses and localhost are not accepted)',
    ],
    [
      'localhost',
      'IMAP host is not a valid host name (IP addresses and localhost are not accepted)',
    ],
  ])('Enter on %j: "%s", the field stays', (typed, message) => {
    const s = act(hostStep(), ...chars(typed));
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), note: message } });
    expect(view(act(out.state, ch('a'))).note).toBeNull();
  });

  it('Enter on a host name: that server for that provider, the address as username', () => {
    const s = act(hostStep(), ...chars(' Wes1-IMAP.wedos.net. '));
    const out = step(s, key('enter'));
    expect(view(out.state)).toMatchObject({
      step: 'checking-saved',
      back: ['address', 'host'],
      chosen: {
        settings: { host: 'wes1-imap.wedos.net', port: 993, username: EMAIL.address },
        provider: 'wedos',
        name: WEDOS.name,
        hint: WEDOS.hint ?? null,
      },
    });
    expect(out.effects).toEqual([
      {
        type: 'check-saved',
        generation: s.generation + 1,
        email: EMAIL.address,
        host: 'wes1-imap.wedos.net',
        provider: 'wedos',
      },
    ]);
  });

  it('Esc: where the field was opened from; Left is not a way back in a field', () => {
    expect(view(act(hostStep(), key('escape')))).toMatchObject({ step: 'address', back: [] });
    const fromList = act(onPreset('wedos'), key('enter'));
    expect(view(act(fromList, key('escape')))).toMatchObject({
      step: 'providers',
      back: ['address', 'found'],
      cursor: rowOf('wedos'),
    });
    expect(step(hostStep(), key('left'))).toEqual({ state: hostStep(), effects: [] });
  });

  it('opened for another provider, the field is empty again', () => {
    const typed = act(onPreset('wedos'), key('enter'), ...chars('one.example-test-domain.eu'));
    const again = act(typed, key('escape'), key('enter'));
    expect(view(again)).toMatchObject({ step: 'host', host: '' });
  });
});

describe('the server typed by hand (A6)', () => {
  it('Tab, Up and Down switch between host and username', () => {
    const s = server();
    expect(view(s).field).toBe('host');
    for (const k of [key('tab'), key('up'), key('down')]) {
      const other = act(s, k);
      expect(view(other)).toEqual({ ...view(s), field: 'username' });
      expect(view(act(other, k)).field).toBe('host');
    }
  });

  it('typing goes into the field with the cursor', () => {
    const s = act(server(), ...chars('imap.example-test-domain.eu'));
    expect(view(s)).toMatchObject({ host: 'imap.example-test-domain.eu', username: EMAIL.address });
    const user = act(s, key('tab'), key('clear'), ...chars('login-name'));
    expect(view(user)).toMatchObject({
      host: 'imap.example-test-domain.eu',
      username: 'login-name',
    });
    expect(view(act(user, key('backspace'))).username).toBe('login-nam');
  });

  it('Enter on the host moves on, whatever it holds', () => {
    const out = step(server(), key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...server(), view: { ...view(server()), field: 'username' } });
  });

  it('Enter on the username with a bad host: its message, and the cursor on the host', () => {
    const s = act(server(), ...chars('not a host'), key('enter'));
    expect(view(s).field).toBe('username');
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: {
        ...view(s),
        field: 'host',
        note: 'IMAP host is not a valid host name (IP addresses and localhost are not accepted)',
      },
    });
  });

  it('a username that cannot be sent: its message, the cursor stays on it', () => {
    const typed = act(server(), ...chars('imap.example-test-domain.eu'), key('enter'));
    // No key can type this; a state that holds it anyway is still refused.
    const s: AppState = { ...typed, view: { ...view(typed), username: `user${override}name` } };
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(view(out.state)).toMatchObject({
      step: 'server',
      field: 'username',
      note: 'Username contains invalid characters',
    });
  });

  it('both fine: that server, saved as "custom"', () => {
    const s = act(
      server(),
      ...chars('IMAP.Example-Test-Domain.eu'),
      key('enter'),
      key('clear'),
      ...chars(' login-name '),
    );
    const out = step(s, key('enter'));
    expect(view(out.state)).toMatchObject({
      step: 'checking-saved',
      back: ['address', 'found', 'server'],
      chosen: {
        settings: { host: 'imap.example-test-domain.eu', port: 993, username: 'login-name' },
        provider: 'custom',
        name: null,
        hint: null,
      },
    });
    expect(out.effects).toEqual([
      {
        type: 'check-saved',
        generation: s.generation + 1,
        email: EMAIL.address,
        host: 'imap.example-test-domain.eu',
        provider: 'custom',
      },
    ]);
  });

  it('an empty username is the address', () => {
    const s = act(server(), ...chars('imap.example-test-domain.eu'), key('enter'), key('clear'));
    expect(view(act(s, key('enter'))).chosen?.settings.username).toBe(EMAIL.address);
  });

  it('Esc: where the fields were opened from; opened again they start afresh', () => {
    const typed = act(server(), ...chars('half'), key('tab'), ch('x'));
    expect(view(act(typed, key('escape')))).toMatchObject({ step: 'found', back: ['address'] });
    expect(view(act(typed, key('escape'), ch('m')))).toMatchObject({
      host: '',
      username: EMAIL.address,
      field: 'host',
    });
    const fromList = act(providers(), ch('m'));
    expect(view(act(fromList, key('escape')))).toMatchObject({
      step: 'providers',
      back: ['address', 'found'],
    });
  });
});

// --- A7: saved already? ---------------------------------------------------------------------

describe('is the mailbox saved already? (A7)', () => {
  it('not saved: the password field, empty', () => {
    const s = checkingSaved();
    const out = step(s, savedChecked(s));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), step: 'password' } });
    expect(view(out.state)).toMatchObject({ password: '', note: null, chosen: WEBSUPPORT_CHOSEN });
  });

  it('saved already (or the check failed): its text, and no password is asked', () => {
    const s = checkingSaved();
    const out = step(s, { type: 'add-failed', generation: s.generation, text: 'Already saved.' });
    expect(out.effects).toEqual([]);
    expect(view(out.state)).toMatchObject({ step: 'failed', failure: 'Already saved.' });
  });

  it('Esc: the step the server was chosen in, nothing chosen; the answer is dropped', () => {
    const s = checkingSaved();
    const out = step(s, key('escape'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: { ...view(s), step: 'found', back: ['address'], chosen: null },
    });
    expect(step(out.state, savedChecked(s)).state).toBe(out.state);
    expect(
      step(out.state, { type: 'add-failed', generation: s.generation, text: 'late' }).state,
    ).toBe(out.state);
  });

  it('no other key acts; q quits', () => {
    const s = checkingSaved();
    const keys = [key('left'), key('backspace'), key('enter'), ch('y'), ch('a'), key('up')];
    for (const k of keys) expect(step(s, k)).toEqual({ state: s, effects: [] });
    expect(step(s, ch('q'))).toEqual({ state: s, effects: [{ type: 'quit' }] });
  });

  it('an answer for a step that is not waiting for it changes nothing', () => {
    for (const s of [discovered(FOUND), atPassword(), checking()]) {
      expect(step(s, savedChecked(s)).state).toBe(s);
    }
  });
});

// --- A8: the password -----------------------------------------------------------------------

describe('the password (A8)', () => {
  it('takes anything that is typed - also what could not be shown, and q', () => {
    const typed = `p ss${zeroWidth}q${override}`;
    const s = act(atPassword(), ...chars(typed));
    expect(view(s)).toEqual({ ...view(atPassword()), password: typed });
  });

  it('Backspace takes the last character, Ctrl+U everything', () => {
    const s = act(atPassword(), ...chars('abc'));
    expect(view(act(s, key('backspace'))).password).toBe('ab');
    expect(view(act(s, key('clear'))).password).toBe('');
  });

  it('holds 1024 code points and no more', () => {
    const full = act(atPassword(), ...repeat(ch('a'), MAX_PASSWORD_CHARS));
    expect(view(full).password).toHaveLength(1024);
    expect(step(full, ch('b')).state).toBe(full);
  });

  it('Enter on an empty field: the hint, nothing sent', () => {
    const s = atPassword();
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({ ...s, view: { ...view(s), note: PASSWORD_REQUIRED } });
    expect(PASSWORD_REQUIRED).toBe('Type the password.');
  });

  it('typing changes nothing but the password: a note stays until Enter or Esc', () => {
    const noted = act(atPassword(), key('enter'));
    const typed = act(noted, ...chars('abc'), key('backspace'), key('clear'), ch('x'));
    expect(view(typed)).toEqual({ ...view(noted), password: 'x' });
    expect(view(typed).note).toBe(PASSWORD_REQUIRED);
  });

  it('Enter: one add-mailbox request with the password - and the state without it', () => {
    const s = act(atPassword(), ...chars(PASSWORD));
    expect(view(s).password).toBe(PASSWORD);
    const out = step(s, key('enter'));
    expect(out.effects).toEqual([
      {
        type: 'add-mailbox',
        generation: s.generation + 1,
        email: EMAIL.address,
        settings: { host: 'imap.m1.websupport.sk', port: 993, username: ADDRESS },
        provider: 'websupport',
        password: PASSWORD,
      },
    ]);
    expect(out.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: { ...view(s), step: 'checking', password: '' },
    });
    expect(JSON.stringify(out.state)).not.toContain(PASSWORD);
  });

  it('spaces belong to the password: nothing is trimmed', () => {
    const out = run(atPassword(), ...chars('  two  spaces  '), key('enter'));
    const sent = out.effects[0] as Effect<'add-mailbox'>;
    expect(sent.password).toBe('  two  spaces  ');
  });

  it('Enter after a note: the note goes with the request', () => {
    const s = act(atPassword(), key('enter'), ...chars(PASSWORD), key('enter'));
    expect(view(s)).toMatchObject({ step: 'checking', note: null, password: '' });
  });

  it('Esc: the step the server was chosen in - nothing chosen, the password dropped', () => {
    const s = act(atPassword(), ...chars(PASSWORD));
    const out = step(s, key('escape'));
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: { ...view(s), step: 'found', back: ['address'], chosen: null, password: '' },
    });
    expect(JSON.stringify(out.state)).not.toContain(PASSWORD);
  });

  it('keys that are not for the field do nothing', () => {
    const s = act(atPassword(), ch('a'));
    for (const k of [key('left'), key('tab'), key('up'), key('down'), key('other')]) {
      expect(step(s, k)).toEqual({ state: s, effects: [] });
    }
  });

  it('too small: nothing is typed and nothing is sent', () => {
    const s = act(act(atPassword(), ch('a')), { type: 'resize', screen: TOO_SMALL });
    for (const k of [ch('b'), ch('q'), key('backspace'), key('enter'), key('escape')]) {
      expect(step(s, k)).toEqual({ state: s, effects: [] });
    }
  });
});

// --- A8 / A9: the login check ---------------------------------------------------------------

describe('while the login is checked (A8, A9)', () => {
  it('no key acts - not q, not Esc', () => {
    const s = checking();
    const keys = [
      ch('q'),
      ch('a'),
      key('escape'),
      key('left'),
      key('backspace'),
      key('enter'),
      key('clear'),
      key('up'),
    ];
    for (const k of keys) expect(step(s, k)).toEqual({ state: s, effects: [] });
  });

  it('the login guard makes it wait, and says when the wait is over', () => {
    const s = checking();
    const waiting = step(s, { type: 'challenge', generation: s.generation });
    expect(waiting).toEqual({ state: { ...s, view: { ...view(s), waiting: true } }, effects: [] });
    const over = step(waiting.state, { type: 'challenge-done', generation: s.generation });
    expect(over).toEqual({ state: s, effects: [] });
  });

  it('a wait of another step, or of an earlier request, changes nothing', () => {
    const s = atPassword();
    expect(step(s, { type: 'challenge', generation: s.generation }).state).toBe(s);
    expect(step(s, { type: 'challenge-done', generation: s.generation }).state).toBe(s);
    const now = checking();
    expect(step(now, { type: 'challenge', generation: now.generation - 1 }).state).toBe(now);
  });

  it('rejected: the password field again, empty, with what the mail server said no to', () => {
    const s = act(checking(), { type: 'challenge', generation: checking().generation });
    const out = step(s, { type: 'add-rejected', generation: s.generation, text: 'Not accepted.' });
    expect(out.effects).toEqual([]);
    expect(out.state).toEqual({
      ...s,
      view: { ...view(s), step: 'password', note: 'Not accepted.', waiting: false },
    });
    expect(view(out.state)).toMatchObject({ password: '', chosen: WEBSUPPORT_CHOSEN });
  });

  it('nothing is tried again by itself: the next request takes a password and Enter', () => {
    const s = checking();
    const rejected = step(s, { type: 'add-rejected', generation: s.generation, text: 'No.' });
    expect(rejected.effects).toEqual([]);
    expect(step(rejected.state, key('enter')).effects).toEqual([]);
    const again = run(rejected.state, ...chars('second try'), key('enter'));
    expect(again.effects).toEqual([
      {
        type: 'add-mailbox',
        generation: s.generation + 1,
        email: EMAIL.address,
        settings: { host: 'imap.m1.websupport.sk', port: 993, username: ADDRESS },
        provider: 'websupport',
        password: 'second try',
      },
    ]);
    expect(view(again.state)).toMatchObject({ step: 'checking', note: null });
  });

  it('after a rejection Esc still goes one step back', () => {
    const s = checking();
    const rejected = act(s, { type: 'add-rejected', generation: s.generation, text: 'No.' });
    expect(view(act(rejected, key('escape')))).toMatchObject({
      step: 'found',
      back: ['address'],
      chosen: null,
      note: null,
    });
  });

  it('failed for good: its text, and only the way back to Home', () => {
    const s = act(checking(), { type: 'challenge', generation: checking().generation });
    const out = step(s, { type: 'add-failed', generation: s.generation, text: 'Blocked.' });
    expect(out.effects).toEqual([]);
    expect(view(out.state)).toMatchObject({
      step: 'failed',
      failure: 'Blocked.',
      waiting: false,
      password: '',
      note: null,
    });
    for (const [, back] of BACK_KEYS) {
      const left = step(out.state, back);
      expect(left.effects).toEqual([]);
      expect(left.state).toEqual({
        ...out.state,
        generation: out.state.generation + 1,
        view: view(s).home,
      });
    }
    expect(step(out.state, ch('q')).effects).toEqual([{ type: 'quit' }]);
    for (const k of [key('enter'), ch('y'), ch('c'), ch('m'), ch('r')]) {
      expect(step(out.state, k)).toEqual({ state: out.state, effects: [] });
    }
  });

  it('a long failure text scrolls', () => {
    const s = checking();
    const text = Array.from({ length: 60 }, (_, i) => `Line ${String(i)}.`).join('\n');
    const failedState = act(s, { type: 'add-failed', generation: s.generation, text });
    expect(addLines(view(failedState), SCREEN.cols)).toHaveLength(60);
    expect(view(act(failedState, key('pagedown'))).scroll).toBe(21);
    expect(view(act(failedState, ...repeat(key('pagedown'), 5))).scroll).toBe(39);
  });

  it('a result of an earlier request, or for another step, changes nothing', () => {
    const s = checking();
    const earlier = s.generation - 1;
    const stale: AppAction[] = [
      { type: 'add-rejected', generation: earlier, text: 'old' },
      { type: 'add-failed', generation: earlier, text: 'old' },
      { type: 'mailbox-added', generation: earlier, id: NEW_ID, email: ADDRESS },
    ];
    for (const action of stale) expect(step(s, action).state).toBe(s);
    const other = atPassword();
    const forged: AppAction[] = [
      { type: 'add-rejected', generation: other.generation, text: 'forged' },
      { type: 'add-failed', generation: other.generation, text: 'forged' },
      { type: 'mailbox-added', generation: other.generation, id: NEW_ID, email: ADDRESS },
    ];
    for (const action of forged) expect(step(other, action).state).toBe(other);
  });
});

// --- A10: saved -----------------------------------------------------------------------------

describe('saved: Home with the new mailbox (A10)', () => {
  function added(o: Options = {}): AppReduced {
    const s = checking(o);
    return step(s, { type: 'mailbox-added', generation: s.generation, id: NEW_ID, email: ADDRESS });
  }

  it('Home again, its list asked for anew, the mailbox to look for, and what to say', () => {
    const s = checking();
    const out = added();
    expect(out.state).toEqual({
      ...s,
      generation: s.generation + 1,
      view: {
        ...view(s).home,
        mailboxes: null,
        cursor: 0,
        loadFailed: false,
        message: null,
        focusId: NEW_ID,
        added: ADDRESS,
      },
    });
    expect(out.effects).toEqual([{ type: 'load-mailboxes', generation: s.generation + 1 }]);
    expect(JSON.stringify(out.state)).not.toContain(PASSWORD);
  });

  it('while the list loads the cursor is on the first row: an early Enter is not Logs or Log out', () => {
    // The cursor Home had ("+ Add a mailbox", after its mailboxes) is another row without them.
    expect(view(checking()).home.cursor).toBeGreaterThan(0);
    const out = reduceApp(added().state, { type: 'key', key: { type: 'enter' } });
    expect(out.state.view.kind).toBe('add');
    expect(out.effects.map((e) => e.type)).not.toContain('sign-out');
    expect(out.effects.map((e) => e.type)).not.toContain('read-logs');
  });

  it('the list arrives: the cursor is on the new mailbox', () => {
    const s = added().state;
    const rows: MailboxRow[] = [
      ...MAILBOXES,
      { id: NEW_ID, email: ADDRESS, provider: 'websupport', lastCheckedAt: null },
    ];
    const listed = step(s, { type: 'mailboxes', generation: s.generation, rows });
    expect(listed.effects).toEqual([]);
    expect(home(listed.state)).toEqual({
      kind: 'home',
      mode: 'list',
      mailboxes: rows,
      loadFailed: false,
      cursor: 2,
      message: null,
      focusId: null,
      added: ADDRESS,
    });
  });

  it('wherever it is in the list', () => {
    const s = added().state;
    const mine: MailboxRow = {
      id: NEW_ID,
      email: ADDRESS,
      provider: 'websupport',
      lastCheckedAt: null,
    };
    const first = act(s, {
      type: 'mailboxes',
      generation: s.generation,
      rows: [mine, ...MAILBOXES],
    });
    expect(home(first).cursor).toBe(0);
    const [one, two] = MAILBOXES;
    if (one === undefined || two === undefined) throw new Error('two mailboxes expected');
    const middle = act(s, { type: 'mailboxes', generation: s.generation, rows: [one, mine, two] });
    expect(home(middle).cursor).toBe(1);
  });

  it('not in the list after all: the first row', () => {
    const s = added().state;
    const listed = act(s, { type: 'mailboxes', generation: s.generation, rows: MAILBOXES });
    expect(home(listed)).toMatchObject({ cursor: 0, focusId: null, added: ADDRESS });
  });

  it('a later list has no mailbox to look for: the first row, as always', () => {
    const s = added().state;
    const rows: MailboxRow[] = [
      ...MAILBOXES,
      { id: NEW_ID, email: ADDRESS, provider: 'websupport', lastCheckedAt: null },
    ];
    const listed = act(s, { type: 'mailboxes', generation: s.generation, rows });
    const again = act(listed, { type: 'mailboxes', generation: listed.generation, rows });
    expect(home(again).cursor).toBe(0);
  });

  it('"Added ..." is said until the next key', () => {
    const s = added().state;
    const listed = act(s, { type: 'mailboxes', generation: s.generation, rows: MAILBOXES });
    expect(home(listed).added).toBe(ADDRESS);
    for (const k of [key('down'), key('up'), ch('x'), key('other')]) {
      expect(home(act(listed, k)).added).toBeNull();
    }
    // Also while the list is still loading.
    expect(home(act(s, key('down'))).added).toBeNull();
  });

  it('the list fails to load: its message, "Added ..." kept behind it', () => {
    const s = added().state;
    const failedList = act(s, { type: 'mailboxes-failed', generation: s.generation });
    expect(home(failedList)).toMatchObject({
      loadFailed: true,
      message: 'load-failed',
      added: ADDRESS,
      focusId: NEW_ID,
    });
  });
});

// --- A11: the way back ----------------------------------------------------------------------

describe('Esc goes one step back, all the way to Home (A11)', () => {
  /** The steps Esc shows from `state` until Home. */
  function wayBack(state: AppState): (AddStep | 'home')[] {
    const steps: (AddStep | 'home')[] = [];
    let s = state;
    for (let i = 0; i < 12 && s.view.kind === 'add'; i++) {
      s = act(s, key('escape'));
      steps.push(s.view.kind === 'add' ? s.view.step : 'home');
    }
    return steps;
  }

  it.each<[string, () => AppState, (AddStep | 'home')[]]>([
    ['the address', () => opened(), ['home']],
    ['looking', () => looking(), ['address', 'home']],
    ['found', () => discovered(FOUND), ['address', 'home']],
    ['blocked', () => discovered(BLOCKED), ['address', 'home']],
    ['nothing', () => discovered(MANUAL), ['address', 'home']],
    ['the host of a known provider', () => discovered(NEEDS_HOST), ['address', 'home']],
    ['the list, from found', () => providers(), ['found', 'address', 'home']],
    [
      'the list, from nothing',
      () => act(discovered(MANUAL), ch('c')),
      ['nothing', 'address', 'home'],
    ],
    ['the server fields, from found', () => server(), ['found', 'address', 'home']],
    [
      'the server fields, from the list',
      () => act(providers(), ch('m')),
      ['providers', 'found', 'address', 'home'],
    ],
    [
      'the host field, from the list',
      () => act(onPreset('wedos'), key('enter')),
      ['providers', 'found', 'address', 'home'],
    ],
    ['the check, from found', () => checkingSaved(), ['found', 'address', 'home']],
    ['the password, from found', () => atPassword(), ['found', 'address', 'home']],
    [
      'the password, from the list',
      () => {
        const s = act(onPreset('gmail'), key('enter'));
        return act(s, savedChecked(s));
      },
      ['providers', 'found', 'address', 'home'],
    ],
    [
      'the password, from a host typed for a provider of the list',
      () => {
        const s = act(
          onPreset('wedos'),
          key('enter'),
          ...chars('wes1-imap.wedos.net'),
          key('enter'),
        );
        return act(s, savedChecked(s));
      },
      ['host', 'providers', 'found', 'address', 'home'],
    ],
    [
      'the password, from the server fields',
      () => {
        const s = act(
          server(),
          ...chars('imap.example-test-domain.eu'),
          key('enter'),
          key('enter'),
        );
        return act(s, savedChecked(s));
      },
      ['server', 'found', 'address', 'home'],
    ],
    ['a failure', () => act(checkingSaved(), failedAction(checkingSaved())), ['home']],
  ])('from %s', (_name, make, steps) => {
    expect(wayBack(make())).toEqual(steps);
  });

  function failedAction(state: AppState): AppAction {
    return { type: 'add-failed', generation: state.generation, text: 'No.' };
  }

  it('Home comes back as it was: the same list and cursor, nothing asked for', () => {
    const before = atHome();
    const out = run(atPassword(), ...repeat(key('escape'), 3));
    expect(out.state.view).toEqual(before.view);
    // No request on the way back: only the lookup and the check on the way in.
    expect(out.effects).toEqual([]);
  });

  it('no step on the way back holds the password or a chosen server', () => {
    let s = act(atPassword(), ...chars(PASSWORD));
    while (s.view.kind === 'add') {
      s = act(s, key('escape'));
      expect(JSON.stringify(s)).not.toContain(PASSWORD);
      if (s.view.kind === 'add') expect(s.view.chosen).toBeNull();
    }
  });

  it('opened while the mailbox list was still loading: back on Home it is asked for again', () => {
    const loading = loadingHome();
    expect(home(loading).mailboxes).toBeNull();
    const adding = act(loading, key('enter'));
    expect(view(adding).step).toBe('address');
    // The list that arrives meanwhile is not Home's any more.
    const listed: AppAction = { type: 'mailboxes', generation: adding.generation, rows: MAILBOXES };
    expect(step(adding, listed).state).toBe(adding);
    const out = step(adding, key('escape'));
    expect(out.state).toEqual({
      ...adding,
      generation: adding.generation + 1,
      view: home(loading),
    });
    expect(out.effects).toEqual([{ type: 'load-mailboxes', generation: adding.generation + 1 }]);
    // From the failed screen too.
    const failedState: AppState = {
      ...adding,
      view: { ...view(adding), step: 'failed', failure: 'No.' },
    };
    for (const [, back] of BACK_KEYS) {
      expect(step(failedState, back).effects).toEqual([
        { type: 'load-mailboxes', generation: adding.generation + 1 },
      ]);
    }
  });

  it('backToHome: a list that arrived, or failed, comes back untouched', () => {
    const s = opened();
    expect(backToHome(s, view(s).home)).toEqual({
      state: { ...s, generation: s.generation + 1, view: view(s).home },
      effects: [],
    });
    const failedHome: HomeView = { ...view(s).home, mailboxes: null, loadFailed: true };
    expect(backToHome(s, failedHome).effects).toEqual([]);
    const loading: HomeView = { ...view(s).home, mailboxes: null };
    expect(backToHome(s, loading)).toEqual({
      state: { ...s, generation: s.generation + 1, view: loading },
      effects: [{ type: 'load-mailboxes', generation: s.generation + 1 }],
    });
  });
});

describe('q quits where it is not a letter; too small, only q acts (A11)', () => {
  const STEPS: [AddStep, () => AppState, boolean][] = [
    ['address', () => opened(), false],
    ['looking', () => looking(), true],
    ['found', () => discovered(FOUND), true],
    ['blocked', () => discovered(BLOCKED), true],
    ['nothing', () => discovered(MANUAL), true],
    ['providers', () => providers(), true],
    ['host', () => discovered(NEEDS_HOST), false],
    ['server', () => server(), false],
    ['checking-saved', () => checkingSaved(), true],
    ['password', () => atPassword(), false],
    ['checking', () => checking(), false],
    ['failed', () => opened({ addProblem: PROBLEM }), true],
  ];

  it('every step is in the table', () => {
    for (const [name, make] of STEPS) expect(view(make()).step).toBe(name);
    expect(STEPS).toHaveLength(12);
  });

  it.each(STEPS)('%s', (_name, make, quits) => {
    const s = make();
    for (const text of ['q', 'Q']) {
      expect(step(s, ch(text)).effects).toEqual(quits ? [{ type: 'quit' }] : []);
    }
  });

  it.each(STEPS)('%s, too small', (_name, make, quits) => {
    const s = act(make(), { type: 'resize', screen: TOO_SMALL });
    const keys = [
      key('escape'),
      key('left'),
      key('backspace'),
      key('enter'),
      key('up'),
      key('down'),
      key('pagedown'),
      key('tab'),
      key('clear'),
      ch('y'),
      ch('c'),
      ch('m'),
      ch('a'),
    ];
    for (const k of keys) expect(step(s, k)).toEqual({ state: s, effects: [] });
    expect(step(s, ch('q'))).toEqual({ state: s, effects: quits ? [{ type: 'quit' }] : [] });
  });

  it.each(STEPS)('%s: a result still arrives while the window is too small', (name, make) => {
    const s = act(make(), { type: 'resize', screen: TOO_SMALL });
    const answers: Partial<Record<AddStep, [AppAction, AddStep]>> = {
      looking: [{ type: 'discovered', generation: s.generation, result: FOUND }, 'found'],
      'checking-saved': [savedChecked(s), 'password'],
      checking: [{ type: 'add-rejected', generation: s.generation, text: 'No.' }, 'password'],
    };
    const answer = answers[name];
    if (answer === undefined) return;
    expect(view(act(s, answer[0])).step).toBe(answer[1]);
  });
});

// --- small windows, other views -------------------------------------------------------------

describe('the rest', () => {
  it('a resize keeps the view; the scroll position is brought back at the next key', () => {
    const small = act(discovered(LONG, { screen: SMALLEST }), ...repeat(key('pagedown'), 40));
    const lines = addLines(view(small), SMALLEST.cols).length;
    expect(view(small).scroll).toBe(lines - bodyHeight(SMALLEST));
    const large = act(small, { type: 'resize', screen: SCREEN });
    expect(large).toEqual({ ...small, screen: SCREEN });
    const wide = addLines(view(large), SCREEN.cols).length - bodyHeight(SCREEN);
    expect(view(act(large, key('down'))).scroll).toBe(wide);
  });

  it('reduceAdd leaves a state that shows another view alone', () => {
    const s = atHome();
    const actions: AppAction[] = [
      key('enter'),
      ch('q'),
      { type: 'discovered', generation: s.generation, result: FOUND },
      { type: 'mailbox-added', generation: s.generation, id: NEW_ID, email: ADDRESS },
    ];
    for (const action of actions) expect(reduceAdd(s, action)).toEqual({ state: s, effects: [] });
  });

  it('an action of another screen changes nothing while a mailbox is added', () => {
    for (const s of [opened(), discovered(FOUND), atPassword()]) {
      const others: AppAction[] = [
        { type: 'mailboxes', generation: s.generation, rows: [] },
        { type: 'mailboxes-failed', generation: s.generation },
        { type: 'logs-read', generation: s.generation, lines: ['x'] },
        { type: 'mailbox-reading', generation: s.generation },
      ];
      for (const action of others) expect(step(s, action).state).toBe(s);
    }
  });

  it('addLines: only the steps that show a page have lines', () => {
    expect(addLines(view(discovered(FOUND)), 80).length).toBeGreaterThan(3);
    expect(addLines(view(discovered(BLOCKED)), 80).length).toBeGreaterThan(2);
    expect(addLines(view(discovered(MANUAL)), 80).length).toBeGreaterThan(3);
    expect(addLines(view(opened({ addProblem: PROBLEM })), 80)).toEqual([`    ${PROBLEM}`]);
    for (const s of [opened(), looking(), providers(), server(), checkingSaved(), atPassword()]) {
      expect(addLines(view(s), 80)).toEqual([]);
    }
  });
});
