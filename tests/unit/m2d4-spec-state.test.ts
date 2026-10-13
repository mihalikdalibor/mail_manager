import { describe, it, expect } from 'vitest';
import { addView, providerRows } from '../../src/cli/app/add.js';
import { initialApp } from '../../src/cli/app/state.js';
import type {
  AddView,
  AppAction,
  AppEffect,
  AppKey,
  AppReduced,
  AppState,
  HomeView,
  MailboxRow,
} from '../../src/cli/app/state.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import type { Screen } from '../../src/cli/browser/state.js';
import type { AuthUser } from '../../src/core/auth.js';
import { providerInfo } from '../../src/core/providers/discover.js';
import type { DiscoveryResult, Tried } from '../../src/core/providers/discover.js';
import { parseEmail } from '../../src/core/providers/email.js';
import { PRESETS, pickableProviders } from '../../src/core/providers/presets.js';
import type { Preset } from '../../src/core/providers/presets.js';
import { manualSettings, validateManualHost } from '../../src/core/providers/settings.js';

// M2d-4 add-a-mailbox state (spec A1-A11, H1 and the add edge cases): the pure reducer reached
// the way a user does - Enter on Home's "+ Add a mailbox" row - then keys and the result actions
// the controller would send. The reducer validates with the core's pure validators; discovery,
// the duplicate check and the add itself are effects. No network, no mail server.

const SCREEN: Screen = { rows: 24, cols: 100 };
const SMALL: Screen = { rows: 5, cols: 30 };
const ALICE: AuthUser = { email: 'alice@example.com', userId: 'user-alice' };
const ADDRESS = 'anna@example-test-domain.eu';
const HOST = 'imap.example-test-domain.eu';
const PASSWORD = 'Zq7#Wx9!Lp3^Nv5';
const PARSED = parseEmail(ADDRESS);

const ch = (text: string): AppKey => ({ type: 'char', text });
const key = (type: Exclude<AppKey['type'], 'char'>): AppKey => ({ type });
const ENTER = key('enter');
const ESC = key('escape');
const LEFT = key('left');
const BACKSPACE = key('backspace');
const CLEAR = key('clear');
const TAB = key('tab');
const UP = key('up');
const DOWN = key('down');
const PGUP = key('pageup');
const PGDN = key('pagedown');

const ROW1: MailboxRow = {
  id: 'm1',
  email: 'one@example.com',
  provider: 'websupport',
  lastCheckedAt: null,
};

function press(state: AppState, ...keys: AppKey[]): AppReduced {
  let current = state;
  const effects: AppEffect[] = [];
  for (const k of keys) {
    const r = reduceApp(current, { type: 'key', key: k });
    current = r.state;
    effects.push(...r.effects);
  }
  return { state: current, effects };
}

function act(state: AppState, action: AppAction): AppReduced {
  return reduceApp(state, action);
}

function typeText(state: AppState, text: string): AppState {
  return press(state, ...[...text].map(ch)).state;
}

function types(r: AppReduced): string[] {
  return r.effects.map((e) => e.type);
}

function add(s: AppState): AddView {
  if (s.view.kind !== 'add') throw new Error(`expected the add view, got ${s.view.kind}`);
  return s.view;
}

function homeView(s: AppState): HomeView {
  if (s.view.kind !== 'home') throw new Error(`expected Home, got ${s.view.kind}`);
  return s.view;
}

function effectOf<T extends AppEffect['type']>(
  r: AppReduced,
  type: T,
): Extract<AppEffect, { type: T }> {
  const e = r.effects.find((x): x is Extract<AppEffect, { type: T }> => x.type === type);
  if (e === undefined) throw new Error(`no ${type} effect in [${types(r).join(', ')}]`);
  return e;
}

/** The message of the DiscoveryInputError a core validator throws, for the expected text. */
function inputError(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err.message;
  }
  throw new Error('expected a DiscoveryInputError');
}

// --- Home -> add ----------------------------------------------------------------------------

function homeState(
  options: { addProblem?: string | null } = {},
  screen: Screen = SCREEN,
): AppState {
  const s0 = startApp(
    initialApp('1.0.0', screen, { addProblem: options.addProblem ?? null }),
  ).state;
  const s1 = act(s0, {
    type: 'session',
    generation: s0.generation,
    user: ALICE,
    remembered: [ALICE.email],
  }).state;
  const s2 = press(s1, ENTER).state;
  return act(s2, { type: 'mailboxes', generation: s2.generation, rows: [ROW1] }).state;
}

/** Rows are the mailbox, then Add, Logs, Log out. */
function addScreen(screen: Screen = SCREEN): AppState {
  const r = press(homeState({}, screen), DOWN, ENTER);
  expect(add(r.state).step).toBe('address');
  return r.state;
}

/** Enter on the typed address: the lookup is under way. */
function looking(address = ADDRESS): AppReduced {
  return press(typeText(addScreen(), address), ENTER);
}

function discovered(result: DiscoveryResult, from: AppReduced = looking()): AppState {
  return act(from.state, { type: 'discovered', generation: from.state.generation, result }).state;
}

// --- discovery results ----------------------------------------------------------------------

function preset(id: string): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (p === undefined) throw new Error(`no preset ${id}`);
  return p;
}

const BASE = { email: PARSED, notices: [] as string[], tried: [] as Tried[] };

type Found = Extract<DiscoveryResult, { status: 'found' }>;

/** A found result for the preset websupport (verified, with a hint). */
function foundResult(over: Partial<Found> = {}): Found {
  return {
    ...BASE,
    status: 'found',
    source: 'preset-domain',
    imap: { host: HOST, port: 993, username: ADDRESS },
    altHosts: [],
    provider: providerInfo(preset('websupport')),
    ...over,
  };
}

/** A found result with no provider (a custom server). */
function foundBare(over: Partial<Found> = {}): Found {
  return {
    ...BASE,
    status: 'found',
    source: 'ispdb',
    imap: { host: HOST, port: 993, username: ADDRESS },
    altHosts: [],
    ...over,
  };
}

const BLOCKED: DiscoveryResult = {
  ...BASE,
  status: 'blocked',
  source: 'preset-mx',
  provider: providerInfo(preset('outlook')),
  reason: 'Microsoft only allows sign-in through its own login page (OAuth).',
};

const NEEDS_HOST: DiscoveryResult = {
  ...BASE,
  status: 'needs-host',
  source: 'preset-mx',
  provider: providerInfo(preset('wedos')),
};

const MANUAL: DiscoveryResult = { ...BASE, status: 'manual' };
const MANUAL_OFFLINE: DiscoveryResult = {
  ...BASE,
  status: 'manual',
  domainProblem: 'dns-unreachable',
};

/** The found step, reached through the lookup. */
const atFound = (result: DiscoveryResult = foundResult()): AppState => discovered(result);

/** The password step after choosing the found settings. */
function atPassword(result: DiscoveryResult = foundResult()): AppState {
  const checking = press(atFound(result), ENTER);
  return act(checking.state, {
    type: 'saved-checked',
    generation: checking.state.generation,
  }).state;
}

// --- A1: Enter on the Add row ---------------------------------------------------------------

describe('A1 Enter on "+ Add a mailbox"', () => {
  it('opens the address step: an empty field, no effect, no "coming" hint', () => {
    const before = homeState();
    const r = press(before, DOWN, ENTER);
    const v = add(r.state);
    expect(v.step).toBe('address');
    expect(v.address).toBe('');
    expect(v.note).toBeNull();
    expect(r.effects).toEqual([]);
    expect(JSON.stringify(r.state.view)).not.toContain('coming-add');
  });

  it('keeps Home as it was for Esc to restore', () => {
    const before = homeState();
    const atAddRow = press(before, DOWN).state;
    const v = add(press(atAddRow, ENTER).state);
    expect(v.home).toEqual(homeView(atAddRow));
    expect(v.home.cursor).toBe(1);
  });

  it('addView(home, problem): the failed step with the text, or the address step', () => {
    const h = homeView(homeState());
    const ok = addView(h, null);
    expect(ok.kind).toBe('add');
    expect(ok.step).toBe('address');
    expect(ok.home).toBe(h);
    const bad = addView(h, 'MM_MASTER_KEY is not set.');
    expect(bad.step).toBe('failed');
    expect(bad.failure).toBe('MM_MASTER_KEY is not set.');
    expect(bad.home).toBe(h);
  });

  describe('with an addProblem (MM_MASTER_KEY missing or broken)', () => {
    const PROBLEM = 'MM_MASTER_KEY is missing - see `mm doctor`.';
    const problem = (): AppState => press(homeState({ addProblem: PROBLEM }), DOWN, ENTER).state;

    it('shows its text and asks nothing', () => {
      const v = add(problem());
      expect(v.step).toBe('failed');
      expect(v.failure).toBe(PROBLEM);
    });

    it('only Esc / Left / Backspace (to Home) and q act', () => {
      const s = problem();
      const idle = press(
        s,
        ch('a'),
        ch('x'),
        ENTER,
        UP,
        DOWN,
        PGUP,
        PGDN,
        TAB,
        CLEAR,
        ch('c'),
        ch('m'),
        ch('y'),
      );
      expect(idle.state).toEqual(s);
      expect(idle.effects).toEqual([]);
      for (const k of [ESC, LEFT, BACKSPACE]) {
        expect(press(s, k).state.view).toEqual(add(s).home);
      }
      expect(press(s, ch('q')).effects).toEqual([{ type: 'quit' }]);
    });
  });
});

describe('A1 the address field', () => {
  it('typed characters, Backspace and Ctrl+U as in the sign-in form', () => {
    let s = typeText(addScreen(), 'anna');
    expect(add(s).address).toBe('anna');
    s = press(s, BACKSPACE).state;
    expect(add(s).address).toBe('ann');
    s = press(typeText(s, 'x'), CLEAR).state;
    expect(add(s).address).toBe('');
  });

  it('at most 254 code points', () => {
    const s = typeText(addScreen(), 'a'.repeat(300));
    expect([...add(s).address]).toHaveLength(254);
    const emoji = typeText(addScreen(), '\u{1F600}'.repeat(300));
    expect([...add(emoji).address]).toHaveLength(254);
  });

  it('q is a letter in the field', () => {
    const r = press(addScreen(), ch('q'));
    expect(add(r.state).address).toBe('q');
    expect(r.effects).toEqual([]);
  });

  it('characters that sanitize() would change are not taken', () => {
    const s = typeText(addScreen(), 'a\u202Eb\u200Bc');
    expect(add(s).address).toBe('abc');
  });

  it('Left does not leave a field; Backspace erases', () => {
    const s = typeText(addScreen(), 'ab');
    expect(add(press(s, LEFT).state).step).toBe('address');
    expect(add(press(s, LEFT).state).address).toBe('ab');
    expect(add(press(s, BACKSPACE).state).address).toBe('a');
  });

  it('Enter with an empty field: "Type the e-mail address of the mailbox."', () => {
    const r = press(addScreen(), ENTER);
    expect(add(r.state).step).toBe('address');
    expect(add(r.state).note).toBe('Type the e-mail address of the mailbox.');
    expect(r.effects).toEqual([]);
  });

  it('Enter with text that is not an address: the message of parseEmail, the field stays', () => {
    for (const bad of [
      'no-at-sign',
      'anna@',
      '@example-test-domain.eu',
      'anna@localhost',
      'a@bad_domain',
    ]) {
      const r = press(typeText(addScreen(), bad), ENTER);
      expect(add(r.state).step, bad).toBe('address');
      expect(add(r.state).address, bad).toBe(bad);
      expect(add(r.state).note, bad).toBe(inputError(() => parseEmail(bad)));
      expect(r.effects, bad).toEqual([]);
    }
    const r = press(typeText(addScreen(), 'no-at-sign'), ENTER);
    expect(add(r.state).note).toBe('Email address must contain "@"');
  });

  it('Esc goes back to Home as it was, with nothing started', () => {
    const before = homeState();
    const atAddRow = press(before, DOWN).state;
    const r = press(typeText(press(atAddRow, ENTER).state, 'half-typed'), ESC);
    expect(r.state.view).toEqual(homeView(atAddRow));
    expect(r.effects).toEqual([]);
  });

  it('window too small: nothing can be typed, nothing acts - not even Esc or q', () => {
    const s = act(addScreen(), { type: 'resize', screen: SMALL }).state;
    const r = press(s, ch('a'), ch('q'), ESC, ENTER, BACKSPACE, CLEAR, LEFT, TAB);
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
    const back = act(s, { type: 'resize', screen: SCREEN }).state;
    expect(add(typeText(back, 'ok')).address).toBe('ok');
  });
});

// --- A2: looking up -------------------------------------------------------------------------

describe('A2 looking up the settings', () => {
  it('a valid address: the looking step and one discover effect with the trimmed address', () => {
    const r = press(typeText(addScreen(), `  ${ADDRESS}  `), ENTER);
    const v = add(r.state);
    expect(v.step).toBe('looking');
    expect(v.checking).toBeNull();
    expect(r.effects).toEqual([
      { type: 'discover', generation: r.state.generation, address: ADDRESS },
    ]);
  });

  it('discover-progress names the source being checked', () => {
    const r = looking();
    const s = act(r.state, {
      type: 'discover-progress',
      generation: r.state.generation,
      source: 'ispdb',
    });
    expect(add(s.state).checking).toBe('ispdb');
    expect(add(s.state).step).toBe('looking');
    expect(s.effects).toEqual([]);
    const next = act(s.state, {
      type: 'discover-progress',
      generation: r.state.generation,
      source: 'srv',
    });
    expect(add(next.state).checking).toBe('srv');
  });

  it('Esc returns to the address field with the typed address; the late result changes nothing', () => {
    const r = looking();
    const back = press(r.state, ESC);
    expect(add(back.state).step).toBe('address');
    expect(add(back.state).address).toBe(ADDRESS);
    expect(back.effects).toEqual([]);
    const late = act(back.state, {
      type: 'discovered',
      generation: r.state.generation,
      result: foundResult(),
    });
    expect(late.state).toEqual(back.state);
    const lateProgress = act(back.state, {
      type: 'discover-progress',
      generation: r.state.generation,
      source: 'srv',
    });
    expect(lateProgress.state).toEqual(back.state);
  });

  it('keys other than Esc and q do nothing while looking up', () => {
    const r = looking();
    const idle = press(r.state, ch('a'), ENTER, UP, DOWN, ch('c'), ch('m'), ch('y'), BACKSPACE);
    expect(idle.state).toEqual(r.state);
    expect(idle.effects).toEqual([]);
  });

  it('q quits', () => {
    expect(press(looking().state, ch('q')).effects).toEqual([{ type: 'quit' }]);
  });

  it('a result of an older generation changes nothing', () => {
    const r = looking();
    const s = act(r.state, {
      type: 'discovered',
      generation: r.state.generation - 1,
      result: foundResult(),
    });
    expect(s.state).toEqual(r.state);
  });
});

// --- A3, A4: what was found -----------------------------------------------------------------

describe('A3 found', () => {
  it('discovered "found" shows the found step', () => {
    const result = foundResult();
    const v = add(discovered(result));
    expect(v.step).toBe('found');
    expect(v.result).toBe(result);
  });

  it('Enter uses the settings: check-saved with the address, host and provider id', () => {
    const r = press(atFound(), ENTER);
    expect(add(r.state).step).toBe('checking-saved');
    expect(r.effects).toEqual([
      {
        type: 'check-saved',
        generation: r.state.generation,
        email: ADDRESS,
        host: HOST,
        provider: 'websupport',
      },
    ]);
    const chosen = add(r.state).chosen;
    expect(chosen?.settings).toEqual({ host: HOST, port: 993, username: ADDRESS });
    expect(chosen?.provider).toBe('websupport');
    expect(chosen?.name).toBe(preset('websupport').name);
    expect(chosen?.hint).toBe(preset('websupport').hint ?? null);
  });

  it('without a provider the provider is "custom"', () => {
    const r = press(atFound(foundBare()), ENTER);
    expect(effectOf(r, 'check-saved').provider).toBe('custom');
    expect(add(r.state).chosen?.name).toBeNull();
  });

  it('an off-domain SRV result: Enter only says so; y uses the settings', () => {
    const s = atFound(foundBare({ offDomain: true, source: 'srv' }));
    const enter = press(s, ENTER);
    expect(add(enter.state).step).toBe('found');
    expect(add(enter.state).note).toBe('Press y to use this server, or m to enter another.');
    expect(enter.effects).toEqual([]);
    const y = press(enter.state, ch('y'));
    expect(add(y.state).step).toBe('checking-saved');
    expect(effectOf(y, 'check-saved')).toMatchObject({ email: ADDRESS, host: HOST });
  });

  it('y also works without the warning', () => {
    const r = press(atFound(), ch('y'));
    expect(add(r.state).step).toBe('checking-saved');
    expect(types(r)).toEqual(['check-saved']);
  });

  it('c opens the provider list, m the server fields, Esc the address field', () => {
    expect(add(press(atFound(), ch('c')).state).step).toBe('providers');
    expect(add(press(atFound(), ch('m')).state).step).toBe('server');
    const back = press(atFound(), ESC);
    expect(add(back.state).step).toBe('address');
    expect(add(back.state).address).toBe(ADDRESS);
    expect(back.effects).toEqual([]);
  });

  it('Left and Backspace act like Esc in this step; q quits', () => {
    for (const k of [LEFT, BACKSPACE]) expect(add(press(atFound(), k).state).step).toBe('address');
    expect(press(atFound(), ch('q')).effects).toEqual([{ type: 'quit' }]);
  });

  it('scroll keys do not leave the step or crash', () => {
    const s = atFound(
      foundResult({ notices: Array.from({ length: 30 }, (_, i) => `Notice number ${String(i)}`) }),
    );
    const r = press(s, DOWN, DOWN, PGDN, PGDN, UP, PGUP, UP, UP, UP);
    expect(add(r.state).step).toBe('found');
    expect(r.effects).toEqual([]);
  });
});

describe('A4 blocked, needs-host and manual', () => {
  it('blocked: only Esc (to the address) and q act', () => {
    const s = discovered(BLOCKED);
    expect(add(s).step).toBe('blocked');
    const idle = press(s, ENTER, ch('y'), ch('c'), ch('m'), ch('a'), TAB);
    expect(idle.state).toEqual(s);
    expect(idle.effects).toEqual([]);
    expect(add(press(s, ESC).state).step).toBe('address');
    expect(add(press(s, ESC).state).address).toBe(ADDRESS);
    expect(press(s, ch('q')).effects).toEqual([{ type: 'quit' }]);
  });

  it('needs-host: the host step for that provider', () => {
    const s = discovered(NEEDS_HOST);
    const v = add(s);
    expect(v.step).toBe('host');
    expect(v.hostProvider?.id).toBe('wedos');
    expect(v.host).toBe('');
  });

  it('manual: the nothing-found step; c, m and Esc', () => {
    const s = discovered(MANUAL);
    expect(add(s).step).toBe('nothing');
    expect(add(press(s, ch('c')).state).step).toBe('providers');
    expect(add(press(s, ch('m')).state).step).toBe('server');
    expect(add(press(s, ESC).state).step).toBe('address');
    expect(press(s, ch('q')).effects).toEqual([{ type: 'quit' }]);
  });

  it('manual after a DNS problem still lets the user go on (a hint, never a dead end)', () => {
    const s = discovered(MANUAL_OFFLINE);
    expect(add(s).step).toBe('nothing');
    expect(add(press(s, ch('c')).state).step).toBe('providers');
    expect(add(press(s, ch('m')).state).step).toBe('server');
  });
});

// --- A5: the provider list ------------------------------------------------------------------

describe('A5 the provider list', () => {
  const ORDER = pickableProviders();
  const open = (from: AppState = discovered(MANUAL)): AppState => press(from, ch('c')).state;

  it('providerRows: a heading for each group plus one row per preset, in pickable order', () => {
    const rows = providerRows();
    expect(rows).toHaveLength(PRESETS.length + 2);
    const json = JSON.stringify(rows);
    expect(json).toContain('Slovakia / Czechia');
    expect(json).toContain('Global');
    expect(json.indexOf('Slovakia / Czechia')).toBeLessThan(json.indexOf('Global'));
  });

  it('Enter on each preset, in pickableProviders order, does what its kind says', () => {
    ORDER.forEach((p, i) => {
      const at = press(open(), ...Array.from({ length: i }, () => DOWN)).state;
      const r = press(at, ENTER);
      if (p.blocked !== undefined) {
        expect(add(r.state).step, p.id).toBe('providers');
        expect(add(r.state).note, p.id).toBe(`Not supported yet: ${p.blocked}`);
        expect(r.effects, p.id).toEqual([]);
      } else if (p.imap === null) {
        expect(add(r.state).step, p.id).toBe('host');
        expect(add(r.state).hostProvider?.id, p.id).toBe(p.id);
        expect(r.effects, p.id).toEqual([]);
      } else {
        expect(add(r.state).step, p.id).toBe('checking-saved');
        expect(effectOf(r, 'check-saved'), p.id).toEqual({
          type: 'check-saved',
          generation: r.state.generation,
          email: ADDRESS,
          host: p.imap.host,
          provider: p.id,
        });
        expect(add(r.state).chosen?.settings, p.id).toEqual({
          host: p.imap.host,
          port: 993,
          username: ADDRESS,
        });
        expect(add(r.state).chosen?.name, p.id).toBe(p.name);
      }
    });
  });

  /** What Enter does on the list after `keys`, without the generation. */
  function outcome(keys: AppKey[]): unknown {
    const r = press(press(open(), ...keys).state, ENTER);
    return {
      step: add(r.state).step,
      note: add(r.state).note,
      host: add(r.state).hostProvider?.id ?? null,
      effects: r.effects.map((e) => ({ ...e, generation: 0 })),
    };
  }
  const times = (n: number, k: AppKey): AppKey[] => Array.from({ length: n }, () => k);

  it('Up at the first preset stays on it', () => {
    expect(outcome([UP, UP, UP])).toEqual(outcome([]));
  });

  it('Down at the last preset stays on it', () => {
    expect(outcome(times(ORDER.length + 20, DOWN))).toEqual(outcome(times(ORDER.length - 1, DOWN)));
    expect(outcome(times(ORDER.length - 1, DOWN))).not.toEqual(outcome([]));
  });

  it('PgDn and PgUp move over presets and are clamped at both ends', () => {
    expect(outcome(times(40, PGDN))).toEqual(outcome(times(ORDER.length - 1, DOWN)));
    expect(outcome([...times(40, PGDN), ...times(40, PGUP)])).toEqual(outcome([]));
  });

  it('Up moves back one preset', () => {
    expect(outcome([DOWN, DOWN, UP])).toEqual(outcome([DOWN]));
  });

  it('a blocked preset is listed but cannot be chosen: nothing is checked, no password asked', () => {
    const blockedIndex = ORDER.findIndex((p) => p.blocked !== undefined);
    expect(blockedIndex).toBeGreaterThanOrEqual(0);
    const at = press(open(), ...Array.from({ length: blockedIndex }, () => DOWN)).state;
    const r = press(at, ENTER, ENTER, ch('y'));
    expect(add(r.state).step).toBe('providers');
    expect(r.effects).toEqual([]);
    expect(add(r.state).chosen).toBeNull();
  });

  it('m opens the server fields', () => {
    expect(add(press(open(), ch('m')).state).step).toBe('server');
  });

  it('Esc, Left and Backspace go back to where the list was opened from', () => {
    for (const [from, step] of [
      [discovered(MANUAL), 'nothing'],
      [atFound(), 'found'],
    ] as const) {
      for (const k of [ESC, LEFT, BACKSPACE]) {
        const r = press(open(from), k);
        expect(add(r.state).step).toBe(step);
        expect(add(r.state).note).toBeNull();
        expect(r.effects).toEqual([]);
      }
    }
  });

  it('the found result is still there after a visit to the list', () => {
    const back = press(open(atFound()), ESC);
    expect(effectOf(press(back.state, ENTER), 'check-saved')).toMatchObject({ host: HOST });
  });

  it('q quits from the list', () => {
    expect(press(open(), ch('q')).effects).toEqual([{ type: 'quit' }]);
  });
});

// --- A6: the host and server steps ----------------------------------------------------------

describe('A6 the host step (a provider whose host is per mailbox)', () => {
  const atHost = (): AppState => discovered(NEEDS_HOST);

  it('typed characters, Backspace and Ctrl+U; at most 254 code points; q is a letter', () => {
    let s = typeText(atHost(), 'imap.q');
    expect(add(s).host).toBe('imap.q');
    s = press(s, BACKSPACE).state;
    expect(add(s).host).toBe('imap.');
    expect(add(press(s, CLEAR).state).host).toBe('');
    expect([...add(typeText(atHost(), 'h'.repeat(400))).host]).toHaveLength(254);
    expect(add(typeText(atHost(), 'a\u202Eb')).host).toBe('ab');
  });

  it('Enter with a good host: check-saved for that provider with the manual settings', () => {
    const r = press(typeText(atHost(), HOST), ENTER);
    expect(add(r.state).step).toBe('checking-saved');
    expect(r.effects).toEqual([
      {
        type: 'check-saved',
        generation: r.state.generation,
        email: ADDRESS,
        host: HOST,
        provider: 'wedos',
      },
    ]);
    expect(add(r.state).chosen?.settings).toEqual({ host: HOST, port: 993, username: ADDRESS });
    expect(add(r.state).chosen?.name).toBe(preset('wedos').name);
  });

  it('a host with a different case or spaces is normalised like manualSettings does', () => {
    const r = press(typeText(atHost(), '  IMAP.Example-Test-Domain.EU '), ENTER);
    expect(add(r.state).chosen?.settings.host).toBe(HOST);
  });

  it("a bad host: validateManualHost's message, the field stays, nothing started", () => {
    for (const bad of [
      '',
      'imap.example-test-domain.eu:993',
      'localhost',
      'a/b.example.com',
      '127.0.0.1',
    ]) {
      const r = press(typeText(atHost(), bad), ENTER);
      expect(add(r.state).step, bad).toBe('host');
      expect(add(r.state).host, bad).toBe(bad);
      expect(add(r.state).note, bad).toBe(inputError(() => validateManualHost(bad)));
      expect(r.effects, bad).toEqual([]);
    }
    expect(add(press(atHost(), ENTER).state).note).toBe('IMAP host is empty');
  });

  it('Esc goes back to the address field', () => {
    const r = press(typeText(atHost(), 'half'), ESC);
    expect(add(r.state).step).toBe('address');
    expect(add(r.state).address).toBe(ADDRESS);
  });

  it('Left does not leave a field', () => {
    expect(add(press(typeText(atHost(), 'ab'), LEFT).state).step).toBe('host');
  });

  it('opened from the provider list, Esc goes back to the list', () => {
    const wedosIndex = pickableProviders().findIndex((p) => p.id === 'wedos');
    const list = press(discovered(MANUAL), ch('c')).state;
    const host = press(list, ...Array.from({ length: wedosIndex }, () => DOWN), ENTER).state;
    expect(add(host).step).toBe('host');
    expect(add(host).hostProvider?.id).toBe('wedos');
    expect(add(press(host, ESC).state).step).toBe('providers');
  });
});

describe('A6 the server step (m): host and username', () => {
  const atServer = (from: AppState = atFound()): AppState => press(from, ch('m')).state;

  it('starts on the host field with the username prefilled with the address', () => {
    const v = add(atServer());
    expect(v.step).toBe('server');
    expect(v.field).toBe('host');
    expect(v.host).toBe('');
    expect(v.username).toBe(ADDRESS);
  });

  it('Tab, Up and Down switch the field; typing goes to the active one', () => {
    let s = atServer();
    s = press(s, TAB).state;
    expect(add(s).field).toBe('username');
    s = press(s, TAB).state;
    expect(add(s).field).toBe('host');
    s = press(s, DOWN).state;
    expect(add(s).field).toBe('username');
    s = press(s, UP).state;
    expect(add(s).field).toBe('host');
    s = typeText(s, 'h');
    s = typeText(press(s, TAB).state, 'u');
    expect(add(s).host).toBe('h');
    expect(add(s).username).toBe(`${ADDRESS}u`);
  });

  it('Enter on the host moves on to the username', () => {
    const r = press(typeText(atServer(), HOST), ENTER);
    expect(add(r.state).step).toBe('server');
    expect(add(r.state).field).toBe('username');
    expect(r.effects).toEqual([]);
  });

  it('Enter on the username with a good host: manual settings, provider custom', () => {
    const r = press(typeText(atServer(), HOST), ENTER, ENTER);
    expect(add(r.state).step).toBe('checking-saved');
    expect(r.effects).toEqual([
      {
        type: 'check-saved',
        generation: r.state.generation,
        email: ADDRESS,
        host: HOST,
        provider: 'custom',
      },
    ]);
    expect(add(r.state).chosen?.settings).toEqual(manualSettings({ host: HOST }, PARSED));
    expect(add(r.state).chosen?.provider).toBe('custom');
    expect(add(r.state).chosen?.name).toBeNull();
  });

  it('a typed username replaces the default; an empty one means the address', () => {
    const custom = press(typeText(atServer(), HOST), ENTER, CLEAR, ...[...'box1'].map(ch), ENTER);
    expect(add(custom.state).chosen?.settings).toEqual({ host: HOST, port: 993, username: 'box1' });
    const empty = press(typeText(atServer(), HOST), ENTER, CLEAR, ENTER);
    expect(add(empty.state).chosen?.settings.username).toBe(ADDRESS);
  });

  it('a bad host is found when the username is confirmed: the message and the host field', () => {
    for (const bad of ['', 'imap.example-test-domain.eu:993', 'localhost']) {
      const r = press(typeText(atServer(), bad), ENTER, ENTER);
      expect(add(r.state).step, bad).toBe('server');
      expect(add(r.state).field, bad).toBe('host');
      expect(add(r.state).note, bad).toBe(inputError(() => validateManualHost(bad)));
      expect(r.effects, bad).toEqual([]);
    }
  });

  it('Esc goes back to where the fields were opened from', () => {
    expect(add(press(atServer(), ESC).state).step).toBe('found');
    expect(add(press(atServer(discovered(MANUAL)), ESC).state).step).toBe('nothing');
    const fromList = press(press(discovered(MANUAL), ch('c')).state, ch('m')).state;
    expect(add(press(fromList, ESC).state).step).toBe('providers');
  });

  it('Left does not leave a field; q is a letter', () => {
    const s = atServer();
    expect(add(press(s, LEFT).state).step).toBe('server');
    const q = press(s, ch('q'));
    expect(add(q.state).host).toBe('q');
    expect(q.effects).toEqual([]);
  });
});

// --- A7: the duplicate check ----------------------------------------------------------------

describe('A7 the check of the saved mailboxes', () => {
  const checking = (): AppReduced => press(atFound(), ENTER);

  it('saved-checked leads to the password step', () => {
    const r = checking();
    const s = act(r.state, { type: 'saved-checked', generation: r.state.generation });
    expect(add(s.state).step).toBe('password');
    expect(add(s.state).password).toBe('');
    expect(s.effects).toEqual([]);
  });

  it('add-failed (the mailbox is saved) leads to the failed step with its text; no password step', () => {
    const r = checking();
    const s = act(r.state, {
      type: 'add-failed',
      generation: r.state.generation,
      text: 'This mailbox is already saved.',
    });
    expect(add(s.state).step).toBe('failed');
    expect(add(s.state).failure).toBe('This mailbox is already saved.');
    expect(press(s.state, ESC).state.view).toEqual(add(s.state).home);
    expect(press(s.state, LEFT).state.view).toEqual(add(s.state).home);
    expect(press(s.state, BACKSPACE).state.view).toEqual(add(s.state).home);
    expect(press(s.state, ch('q')).effects).toEqual([{ type: 'quit' }]);
  });

  it('keys other than Esc and q do nothing while checking', () => {
    const r = checking();
    const idle = press(r.state, ch('a'), ENTER, ch('y'), UP, DOWN, BACKSPACE);
    expect(idle.state).toEqual(r.state);
    expect(idle.effects).toEqual([]);
  });

  it('Esc goes one step back (the step the settings were chosen in); the late answer changes nothing', () => {
    const r = checking();
    const back = press(r.state, ESC);
    expect(add(back.state).step).toBe('found');
    expect(back.effects).toEqual([]);
    const late = act(back.state, { type: 'saved-checked', generation: r.state.generation });
    expect(late.state).toEqual(back.state);
    const lateFail = act(back.state, {
      type: 'add-failed',
      generation: r.state.generation,
      text: 'late',
    });
    expect(lateFail.state).toEqual(back.state);
  });

  it('q quits', () => {
    expect(press(checking().state, ch('q')).effects).toEqual([{ type: 'quit' }]);
  });
});

// --- A8: the password -----------------------------------------------------------------------

describe('A8 the password step', () => {
  it('typed characters, Backspace and Ctrl+U; anything is taken; at most 1024 code points', () => {
    let s = typeText(atPassword(), PASSWORD);
    expect(add(s).password).toBe(PASSWORD);
    s = press(s, BACKSPACE).state;
    expect(add(s).password).toBe(PASSWORD.slice(0, -1));
    expect(add(press(s, CLEAR).state).password).toBe('');
    expect([...add(typeText(atPassword(), 'p'.repeat(2000))).password]).toHaveLength(1024);
    expect(add(typeText(atPassword(), 'a\u202Eb')).password).toBe('a\u202Eb');
    expect(add(press(atPassword(), ch('q')).state).password).toBe('q');
  });

  it('Enter with an empty password: "Type the password."', () => {
    const r = press(atPassword(), ENTER);
    expect(add(r.state).step).toBe('password');
    expect(add(r.state).note).toBe('Type the password.');
    expect(r.effects).toEqual([]);
  });

  it('Enter submits: one add-mailbox effect with everything, and the password leaves the state', () => {
    const typedState = typeText(atPassword(), PASSWORD);
    const r = press(typedState, ENTER);
    expect(add(r.state).step).toBe('checking');
    expect(r.effects).toEqual([
      {
        type: 'add-mailbox',
        generation: r.state.generation,
        email: ADDRESS,
        settings: { host: HOST, port: 993, username: ADDRESS },
        provider: 'websupport',
        password: PASSWORD,
      },
    ]);
    expect(add(r.state).password).toBe('');
    expect(JSON.stringify(r.state)).not.toContain(PASSWORD);
  });

  it('no state after the submit holds the password, whatever happens next', () => {
    const submitted = press(typeText(atPassword(), PASSWORD), ENTER);
    const g = submitted.state.generation;
    const states: AppState[] = [
      submitted.state,
      act(submitted.state, { type: 'challenge', generation: g }).state,
      act(submitted.state, { type: 'add-rejected', generation: g, text: 'Wrong.' }).state,
      act(submitted.state, { type: 'add-failed', generation: g, text: 'Broke.' }).state,
      act(submitted.state, { type: 'mailbox-added', generation: g, id: 'new-id', email: ADDRESS })
        .state,
    ];
    for (const s of states) {
      expect(JSON.stringify(s)).not.toContain(PASSWORD);
      expect(JSON.stringify(s)).not.toContain('Zq7#');
    }
  });

  it('while the login runs only Ctrl+C acts: every other key changes nothing', () => {
    const submitted = press(typeText(atPassword(), PASSWORD), ENTER);
    const idle = press(
      submitted.state,
      ESC,
      LEFT,
      BACKSPACE,
      ENTER,
      ch('q'),
      ch('y'),
      ch('a'),
      UP,
      DOWN,
      CLEAR,
      TAB,
    );
    expect(idle.state).toEqual(submitted.state);
    expect(idle.effects).toEqual([]);
  });
});

// --- A9, A10: results of the add ------------------------------------------------------------

describe('A9 the result of the add', () => {
  const submitted = (): AppReduced => press(typeText(atPassword(), PASSWORD), ENTER);

  it('a rejected password: the password step again, the field empty, the text as a note', () => {
    const r = submitted();
    const s = act(r.state, {
      type: 'add-rejected',
      generation: r.state.generation,
      text: 'Check the password and try again.',
    });
    const v = add(s.state);
    expect(v.step).toBe('password');
    expect(v.password).toBe('');
    expect(v.note).toBe('Check the password and try again.');
    expect(s.effects).toEqual([]);
  });

  it('the second try uses the same server and provider with the new password', () => {
    const r = submitted();
    const rejected = act(r.state, {
      type: 'add-rejected',
      generation: r.state.generation,
      text: 'Wrong.',
    }).state;
    const again = press(typeText(rejected, 'second-try-pw'), ENTER);
    expect(effectOf(again, 'add-mailbox')).toMatchObject({
      email: ADDRESS,
      settings: { host: HOST, port: 993, username: ADDRESS },
      provider: 'websupport',
      password: 'second-try-pw',
    });
    expect(again.state.generation).toBeGreaterThan(rejected.generation);
  });

  it("the guard's wait: challenge shows it, challenge-done ends it, only while checking", () => {
    const r = submitted();
    const g = r.state.generation;
    const waiting = act(r.state, { type: 'challenge', generation: g });
    expect(add(waiting.state).step).toBe('checking');
    expect(add(waiting.state).waiting).toBe(true);
    const done = act(waiting.state, { type: 'challenge-done', generation: g });
    expect(add(done.state).waiting).toBe(false);
    expect(add(done.state).step).toBe('checking');
    const idle = atPassword();
    expect(act(idle, { type: 'challenge', generation: idle.generation }).state).toEqual(idle);
  });

  it('add-failed (blocked login, any other user-facing failure): the failed step; Esc goes Home', () => {
    const r = submitted();
    const s = act(r.state, {
      type: 'add-failed',
      generation: r.state.generation,
      text: 'Too many attempts.',
    });
    expect(add(s.state).step).toBe('failed');
    expect(add(s.state).failure).toBe('Too many attempts.');
    expect(add(s.state).password).toBe('');
    expect(press(s.state, ESC).state.view).toEqual(add(s.state).home);
  });

  it('results of an older generation change nothing', () => {
    const r = submitted();
    const g = r.state.generation - 1;
    for (const action of [
      { type: 'add-rejected', generation: g, text: 'late' },
      { type: 'add-failed', generation: g, text: 'late' },
      { type: 'mailbox-added', generation: g, id: 'x', email: ADDRESS },
      { type: 'challenge', generation: g },
    ] satisfies AppAction[]) {
      expect(act(r.state, action).state).toEqual(r.state);
    }
  });
});

describe('A10 saved: back to Home with the list loaded again', () => {
  const ID = '44444444-4444-4444-8444-444444444444';

  function saved(): AppReduced {
    const r = press(typeText(atPassword(), PASSWORD), ENTER);
    return act(r.state, {
      type: 'mailbox-added',
      generation: r.state.generation,
      id: ID,
      email: ADDRESS,
    });
  }

  it('Home with the list still to load: one load-mailboxes effect, the new mailbox to focus', () => {
    const r = saved();
    const v = homeView(r.state);
    expect(v.mailboxes).toBeNull();
    expect(v.loadFailed).toBe(false);
    expect(v.message).toBeNull();
    expect(v.focusId).toBe(ID);
    expect(v.added).toBe(ADDRESS);
    expect(r.effects).toEqual([{ type: 'load-mailboxes', generation: r.state.generation }]);
  });

  it('the cursor goes to the new mailbox when the list arrives', () => {
    const r = saved();
    const other: MailboxRow = {
      id: 'zzz',
      email: 'two@example.com',
      provider: 'gmail',
      lastCheckedAt: null,
    };
    const added: MailboxRow = {
      id: ID,
      email: ADDRESS,
      provider: 'websupport',
      lastCheckedAt: null,
    };
    const s = act(r.state, {
      type: 'mailboxes',
      generation: r.state.generation,
      rows: [ROW1, other, added],
    }).state;
    expect(homeView(s).cursor).toBe(2);
    expect(homeView(s).focusId).toBeNull();
    expect(homeView(s).added).toBe(ADDRESS);
  });

  it('row 0 when the new mailbox is not in the list', () => {
    const r = saved();
    const s = act(r.state, {
      type: 'mailboxes',
      generation: r.state.generation,
      rows: [ROW1],
    }).state;
    expect(homeView(s).cursor).toBe(0);
  });

  it('a key clears "Added <address>."', () => {
    const r = saved();
    const s = act(r.state, {
      type: 'mailboxes',
      generation: r.state.generation,
      rows: [ROW1, { id: ID, email: ADDRESS, provider: 'websupport', lastCheckedAt: null }],
    }).state;
    expect(homeView(press(s, DOWN).state).added).toBeNull();
  });

  it('a failed reload of the list is Home\'s usual "could not load" state, not a crash', () => {
    const r = saved();
    const s = act(r.state, { type: 'mailboxes-failed', generation: r.state.generation }).state;
    expect(homeView(s).loadFailed).toBe(true);
  });
});

// --- A11: Esc, one step back ----------------------------------------------------------------

describe('A11 Esc goes one step back', () => {
  it('address -> found -> password and back, step by step, then Home', () => {
    let s = atPassword();
    expect(add(s).step).toBe('password');
    s = press(typeText(s, 'half-typed'), ESC).state;
    expect(add(s).step).toBe('found');
    expect(add(s).password).toBe('');
    expect(add(s).chosen).toBeNull();
    s = press(s, ESC).state;
    expect(add(s).step).toBe('address');
    expect(add(s).address).toBe(ADDRESS);
    const home = press(s, ESC).state;
    expect(home.view).toEqual(add(s).home);
  });

  it('password reached through the provider list goes back to the list, then where it was opened', () => {
    const list = press(discovered(MANUAL), ch('c')).state;
    const active24 = pickableProviders().findIndex((p) => p.id === 'active24');
    const checking = press(list, ...Array.from({ length: active24 }, () => DOWN), ENTER);
    expect(add(checking.state).step).toBe('checking-saved');
    const password = act(checking.state, {
      type: 'saved-checked',
      generation: checking.state.generation,
    }).state;
    expect(add(password).step).toBe('password');
    const s1 = press(password, ESC).state;
    expect(add(s1).step).toBe('providers');
    const s2 = press(s1, ESC).state;
    expect(add(s2).step).toBe('nothing');
    const s3 = press(s2, ESC).state;
    expect(add(s3).step).toBe('address');
    expect(press(s3, ESC).state.view.kind).toBe('home');
  });

  it('password reached through the server fields goes back to them', () => {
    const server = press(atFound(), ch('m')).state;
    const checking = press(typeText(server, HOST), ENTER, ENTER);
    const password = act(checking.state, {
      type: 'saved-checked',
      generation: checking.state.generation,
    }).state;
    const back = press(password, ESC).state;
    expect(add(back).step).toBe('server');
    expect(add(press(back, ESC).state).step).toBe('found');
  });

  it('password reached through the host step goes back to the host step', () => {
    const checking = press(typeText(discovered(NEEDS_HOST), HOST), ENTER);
    const password = act(checking.state, {
      type: 'saved-checked',
      generation: checking.state.generation,
    }).state;
    expect(add(press(password, ESC).state).step).toBe('host');
  });

  it('nothing is started by going back', () => {
    for (const s of [atPassword(), atFound(), discovered(MANUAL)]) {
      expect(press(s, ESC).effects).toEqual([]);
    }
  });

  it('in the steps without a field Left and Backspace do the same; in a field they do not', () => {
    for (const k of [LEFT, BACKSPACE]) {
      expect(add(press(atFound(), k).state).step).toBe('address');
      expect(add(press(discovered(MANUAL), k).state).step).toBe('address');
      expect(add(press(discovered(BLOCKED), k).state).step).toBe('address');
    }
    expect(add(press(atPassword(), LEFT).state).step).toBe('password');
    expect(add(press(discovered(NEEDS_HOST), LEFT).state).step).toBe('host');
    expect(add(press(addScreen(), LEFT).state).step).toBe('address');
  });

  it('q quits in the steps without a field and is a letter in a field', () => {
    for (const s of [atFound(), discovered(MANUAL), discovered(BLOCKED), looking().state]) {
      expect(press(s, ch('q')).effects).toEqual([{ type: 'quit' }]);
    }
    for (const s of [atPassword(), discovered(NEEDS_HOST), addScreen()]) {
      expect(press(s, ch('q')).effects).toEqual([]);
    }
  });

  it('window too small: only q acts in the steps where q does not type', () => {
    const small = (s: AppState): AppState => act(s, { type: 'resize', screen: SMALL }).state;
    const found = small(atFound());
    const idle = press(found, ENTER, ch('y'), ch('c'), ch('m'), ESC, LEFT, BACKSPACE, DOWN);
    expect(idle.state).toEqual(found);
    expect(idle.effects).toEqual([]);
    expect(press(found, ch('q')).effects).toEqual([{ type: 'quit' }]);

    const password = small(atPassword());
    const typedTry = press(password, ch('a'), ch('q'), ENTER, ESC);
    expect(typedTry.state).toEqual(password);
    expect(typedTry.effects).toEqual([]);
  });

  it('a resize keeps the step and what was typed', () => {
    const s = typeText(addScreen(), 'half');
    const r = act(s, { type: 'resize', screen: { rows: 12, cols: 60 } }).state;
    expect(add(r).step).toBe('address');
    expect(add(r).address).toBe('half');
  });
});
