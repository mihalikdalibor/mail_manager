import { describe, it, expect } from 'vitest';
import { renderApp } from '../../src/cli/app/render.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { asciiText, initialApp } from '../../src/cli/app/state.js';
import type { AddView, AppAction, AppKey, AppState, MailboxRow } from '../../src/cli/app/state.js';
import { CHALLENGE_NOTICE } from '../../src/cli/browser/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Screen } from '../../src/cli/browser/state.js';
import { displayWidth } from '../../src/cli/browser/width.js';
import { domainProblemText, foundVia, triedText } from '../../src/cli/discovery-text.js';
import type { AuthUser } from '../../src/core/auth.js';
import { SOURCE_LABEL, providerInfo } from '../../src/core/providers/discover.js';
import type { DiscoveryResult, Tried } from '../../src/core/providers/discover.js';
import { parseEmail } from '../../src/core/providers/email.js';
import { PRESETS, pickableProviders } from '../../src/core/providers/presets.js';
import type { Preset } from '../../src/core/providers/presets.js';

// M2d-4 add-a-mailbox renderer (spec A1-A8, H1 and the Frame rule): every step exact at 40x8,
// 80x24 and 200x50, ASCII app text, hostile strings from outside sanitised, and the password -
// or anything that depends on its length - in no frame of any step. States are built through
// the reducer.

const SCREEN: Screen = { rows: 24, cols: 100 };
const S40: Screen = { rows: 8, cols: 40 };
const S80: Screen = { rows: 24, cols: 80 };
const S200: Screen = { rows: 50, cols: 200 };
const ALICE: AuthUser = { email: 'alice@example.com', userId: 'user-alice' };
const ADDRESS = 'anna@example-test-domain.eu';
const HOST = 'imap.example-test-domain.eu';
const PARSED = parseEmail(ADDRESS);
// Upper-case letters, digits and symbols that no fixed UI text has.
const PW = 'QWZ7#JX!9~^QZ';

const ch = (text: string): AppKey => ({ type: 'char', text });
const key = (type: Exclude<AppKey['type'], 'char'>): AppKey => ({ type });
const ENTER = key('enter');
const DOWN = key('down');
const UP = key('up');

const ROW1: MailboxRow = {
  id: 'm1',
  email: 'one@example.com',
  provider: 'websupport',
  lastCheckedAt: null,
};

// --- building states ------------------------------------------------------------------------

function press(state: AppState, ...keys: AppKey[]): AppState {
  let s = state;
  for (const k of keys) s = reduceApp(s, { type: 'key', key: k }).state;
  return s;
}

function act(state: AppState, action: AppAction): AppState {
  return reduceApp(state, action).state;
}

function typeText(state: AppState, text: string): AppState {
  return press(state, ...[...text].map(ch));
}

function add(s: AppState): AddView {
  if (s.view.kind !== 'add') throw new Error(`expected the add view, got ${s.view.kind}`);
  return s.view;
}

function home(screen: Screen = SCREEN, addProblem: string | null = null): AppState {
  const s0 = startApp(initialApp('1.0.0', screen, { addProblem })).state;
  const s1 = act(s0, {
    type: 'session',
    generation: s0.generation,
    user: ALICE,
    remembered: [ALICE.email],
  });
  const s2 = press(s1, ENTER);
  return act(s2, { type: 'mailboxes', generation: s2.generation, rows: [ROW1] });
}

/** Enter on the Add row (rows: the mailbox, Add, Logs, Log out). */
function addScreen(screen: Screen = SCREEN, addProblem: string | null = null): AppState {
  const s = press(home(screen, addProblem), DOWN, ENTER);
  add(s);
  return s;
}

function looking(screen: Screen = SCREEN): AppState {
  return press(typeText(addScreen(screen), ADDRESS), ENTER);
}

function discovered(result: DiscoveryResult, screen: Screen = SCREEN): AppState {
  const s = looking(screen);
  return act(s, { type: 'discovered', generation: s.generation, result });
}

function preset(id: string): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (p === undefined) throw new Error(`no preset ${id}`);
  return p;
}

const BASE = { email: PARSED, notices: [] as string[], tried: [] as Tried[] };
type Found = Extract<DiscoveryResult, { status: 'found' }>;

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

function foundBare(over: Partial<Found> = {}): Found {
  return {
    ...BASE,
    status: 'found',
    source: 'ispdb',
    via: 'autoconfig.example-test-domain.eu',
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
  reason: 'Microsoft allows IMAP only with OAuth2.',
  notices: ['This is a notice of the blocked result.'],
};

const NEEDS_HOST: DiscoveryResult = {
  ...BASE,
  status: 'needs-host',
  source: 'preset-mx',
  provider: providerInfo(preset('wedos')),
};

const TRIED: Tried[] = [
  { source: 'ispdb', outcome: 'not-found' },
  { source: 'srv', outcome: 'timeout', detail: '5000' },
];

const MANUAL: DiscoveryResult = { ...BASE, status: 'manual', tried: TRIED };
const MANUAL_OFFLINE: DiscoveryResult = {
  ...BASE,
  status: 'manual',
  tried: TRIED,
  domainProblem: 'dns-unreachable',
};

function atPassword(result: DiscoveryResult = foundResult(), screen: Screen = SCREEN): AppState {
  const checking = press(discovered(result, screen), ENTER);
  return act(checking, { type: 'saved-checked', generation: checking.generation });
}

function submitted(typedPassword = PW, screen: Screen = SCREEN): AppState {
  return press(typeText(atPassword(foundResult(), screen), typedPassword), ENTER);
}

function resized(s: AppState, screen: Screen): AppState {
  return act(s, { type: 'resize', screen });
}

// --- reading a frame ------------------------------------------------------------------------

const text = (r: Rendered): string => r.lines.join('\n');
const collapsed = (r: Rendered): string => text(r).replace(/\s+/g, ' ');
const statusLine = (r: Rendered): string => r.lines[r.lines.length - 2] ?? '';
const helpLine = (r: Rendered): string => r.lines[r.lines.length - 1] ?? '';

function checkFrame(r: Rendered, screen: Screen): void {
  expect(r.lines).toHaveLength(screen.rows);
  for (const line of r.lines) expect(displayWidth(line)).toBe(screen.cols);
}

// --- the frame is always exact --------------------------------------------------------------

describe('Frame rule: every frame of every step has exactly rows lines of exactly cols columns', () => {
  const SCREENS: [string, Screen][] = [
    ['40x8', S40],
    ['80x24', S80],
    ['200x50', S200],
  ];
  const HOSTILE_PROVIDER = {
    ...providerInfo(preset('websupport')),
    name: 'Ev\u202Eil \u4E2D\u6587 \u{1F600} Provider\u0007',
    hint: `Hint\u0007 with \u202E bidi and \u4E2D\u6587 ${'long '.repeat(40)}`,
    helpUrl: 'https://example-test-domain.eu/help\u202E',
  };
  const HOSTILE_FOUND = foundBare({
    via: 'evil\u202E\u0007.example-test-domain.eu',
    notices: [
      'Notice \u202E one\u0007',
      `Long notice ${'word '.repeat(80)}`,
      '\u4E2D\u6587'.repeat(50),
    ],
    provider: HOSTILE_PROVIDER,
  });
  const HOSTILE_TRIED: Tried[] = [
    { source: 'ispdb', outcome: 'error', detail: 'x\u202Ey\u0007' },
    { source: 'autoconfig', outcome: 'invalid', detail: '\u4E2D\u6587'.repeat(40) },
  ];
  const LONG_NOTE = `${'The server said no. Check the password and try again. '.repeat(8)}`;

  const STEPS: [string, (s: Screen) => AppState][] = [
    ['address, empty', (s) => addScreen(s)],
    ['address, typed', (s) => typeText(addScreen(s), ADDRESS)],
    ['address, longest', (s) => typeText(addScreen(s), 'a'.repeat(300))],
    ['address, with a note', (s) => press(addScreen(s), ENTER)],
    ['address, bad input note', (s) => press(typeText(addScreen(s), 'nope'), ENTER)],
    ['looking', (s) => looking(s)],
    [
      'looking, checking a source',
      (s) => {
        const l = looking(s);
        return act(l, { type: 'discover-progress', generation: l.generation, source: 'srv' });
      },
    ],
    ['found', (s) => discovered(foundResult(), s)],
    ['found, bare', (s) => discovered(foundBare(), s)],
    ['found, hostile', (s) => discovered(HOSTILE_FOUND, s)],
    [
      'found, every warning',
      (s) =>
        discovered(
          foundBare({
            source: 'srv',
            offDomain: true,
            domainProblem: 'not-exist',
            notices: Array.from({ length: 12 }, (_, i) => `Notice number ${String(i)}`),
          }),
          s,
        ),
    ],
    [
      'found, off-domain after Enter',
      (s) => press(discovered(foundBare({ offDomain: true }), s), ENTER),
    ],
    ['blocked', (s) => discovered(BLOCKED, s)],
    ['nothing', (s) => discovered(MANUAL, s)],
    ['nothing, hostile tried', (s) => discovered({ ...MANUAL, tried: HOSTILE_TRIED }, s)],
    ['providers', (s) => press(discovered(MANUAL, s), ch('c'))],
    [
      'providers, cursor down',
      (s) => press(discovered(MANUAL, s), ch('c'), DOWN, DOWN, DOWN, DOWN, DOWN),
    ],
    [
      'providers, cursor at the end',
      (s) => press(discovered(MANUAL, s), ch('c'), ...Array.from({ length: 40 }, () => DOWN)),
    ],
    ['host', (s) => discovered(NEEDS_HOST, s)],
    [
      'host, typed with a note',
      (s) => press(typeText(discovered(NEEDS_HOST, s), 'bad:host'), ENTER),
    ],
    ['server', (s) => press(discovered(MANUAL, s), ch('m'))],
    [
      'server, bad host',
      (s) => press(typeText(press(discovered(MANUAL, s), ch('m')), 'bad:host'), ENTER, ENTER),
    ],
    ['checking saved', (s) => press(discovered(foundResult(), s), ENTER)],
    ['password', (s) => atPassword(foundResult(), s)],
    ['password, hostile provider', (s) => atPassword(HOSTILE_FOUND, s)],
    ['password, typed', (s) => typeText(atPassword(foundResult(), s), PW)],
    ['password, empty Enter', (s) => press(atPassword(foundResult(), s), ENTER)],
    ['checking the login', (s) => submitted(PW, s)],
    [
      'checking the login, guard waiting',
      (s) => {
        const c = submitted(PW, s);
        return act(c, { type: 'challenge', generation: c.generation });
      },
    ],
    [
      'password again with a long rejection',
      (s) => {
        const c = submitted(PW, s);
        return act(c, { type: 'add-rejected', generation: c.generation, text: LONG_NOTE });
      },
    ],
    [
      'failed, long text',
      (s) => {
        const c = submitted(PW, s);
        return act(c, { type: 'add-failed', generation: c.generation, text: LONG_NOTE });
      },
    ],
    ['failed, add problem', (s) => addScreen(s, 'MM_MASTER_KEY is missing. '.repeat(10))],
  ];
  for (const [screenName, screen] of SCREENS) {
    for (const [name, make] of STEPS) {
      it(`${name} at ${screenName}`, () => {
        const r = renderApp(make(screen));
        checkFrame(r, screen);
        expect(r.lines[0]).toContain('Mail Manager - Add a mailbox');
      });
    }
  }

  it('hostile strings leave no control, bidi or invisible character in any frame', () => {
    const hostile: AppState[] = [
      discovered(HOSTILE_FOUND),
      atPassword(HOSTILE_FOUND),
      discovered({ ...MANUAL, tried: HOSTILE_TRIED }),
      press(discovered({ ...MANUAL, tried: HOSTILE_TRIED }), ch('c')),
    ];
    for (const screen of [S40, S80, S200]) {
      for (const s of hostile) {
        const out = text(renderApp(resized(s, screen)));
        expect(out).not.toContain('\u202E');
        expect(out.replace(/\n/g, '')).not.toMatch(/\p{Cc}/u);
      }
    }
  });

  it('the app text of every step is plain ASCII (ASCII data) at every size', () => {
    const ascii: AppState[] = [
      addScreen(),
      press(addScreen(), ENTER),
      looking(),
      discovered(foundResult()),
      discovered(
        foundBare({ offDomain: true, notices: ['A notice.'], domainProblem: 'dns-error' }),
      ),
      discovered(BLOCKED),
      discovered(MANUAL),
      press(discovered(MANUAL), ch('c')),
      discovered(NEEDS_HOST),
      press(discovered(MANUAL), ch('m')),
      press(discovered(foundResult()), ENTER),
      atPassword(),
      submitted(),
      addScreen(SCREEN, 'MM_MASTER_KEY is broken.'),
    ];
    for (const screen of [S40, S80, SCREEN, S200]) {
      for (const s of ascii) {
        for (const line of renderApp(resized(s, screen)).lines) {
          expect(line).toMatch(/^[\x20-\x7E]*$/);
        }
      }
    }
  });

  it('non-ASCII punctuation of a text from outside is written in ASCII', () => {
    const c = submitted();
    const s = act(c, {
      type: 'add-failed',
      generation: c.generation,
      text: 'Not working \u2014 try again\u2026 \u201Csoon\u201D',
    });
    expect(collapsed(renderApp(s))).toContain('Not working - try again... "soon"');
  });
});

describe('Frame rule: a window below 40x8 shows only "Window too small"', () => {
  const TOO_SMALL: [string, Screen][] = [
    ['39x8', { rows: 8, cols: 39 }],
    ['40x7', { rows: 7, cols: 40 }],
    ['30x5', { rows: 5, cols: 30 }],
  ];
  for (const [name, screen] of TOO_SMALL) {
    it(`${name}: every step is replaced and the frame is exact`, () => {
      for (const s of [
        addScreen(),
        typeText(addScreen(), ADDRESS),
        looking(),
        discovered(foundResult()),
        discovered(MANUAL),
        atPassword(),
        submitted(),
      ]) {
        const r = renderApp(resized(s, screen));
        checkFrame(r, screen);
        expect(text(r)).toMatch(/too small/i);
        expect(text(r)).not.toContain('Password');
        expect(text(r)).not.toContain('Provider');
        expect(text(r)).not.toContain(ADDRESS);
      }
    });
  }

  it('exactly 40x8 is big enough', () => {
    expect(text(renderApp(addScreen(S40)))).not.toMatch(/too small/i);
  });
});

// --- A1: the address step -------------------------------------------------------------------

describe('A1 the address step', () => {
  it('header, the field label and the typed address', () => {
    const r = renderApp(typeText(addScreen(), ADDRESS));
    expect(r.lines[0]).toContain('Mail Manager - Add a mailbox');
    expect(collapsed(r)).toContain('E-mail of the mailbox:');
    expect(text(r)).toContain(ADDRESS);
  });

  it('the notices of an empty and a bad address are shown', () => {
    expect(collapsed(renderApp(press(addScreen(), ENTER)))).toContain(
      'Type the e-mail address of the mailbox.',
    );
    expect(collapsed(renderApp(press(typeText(addScreen(), 'nope'), ENTER)))).toContain(
      'Email address must contain "@"',
    );
  });

  it('with an add problem: its text, nothing to type, Esc and q in the help', () => {
    const r = renderApp(addScreen(SCREEN, 'MM_MASTER_KEY is missing - run `mm doctor`.'));
    expect(collapsed(r)).toContain('MM_MASTER_KEY is missing - run `mm doctor`.');
    expect(text(r)).not.toContain('E-mail of the mailbox:');
    expect(helpLine(r)).toContain('Esc');
    expect(helpLine(r)).toContain('q');
  });

  it('the key help names Esc at 40 columns', () => {
    const r = renderApp(addScreen(S40));
    expect(helpLine(r)).toContain('Esc');
  });
});

// --- A2: looking up -------------------------------------------------------------------------

describe('A2 looking up the settings', () => {
  it('"Looking up settings..." on the status line', () => {
    expect(statusLine(renderApp(looking()))).toContain('Looking up settings...');
  });

  it('with the source being checked: "Looking up settings... checking <source>"', () => {
    for (const source of ['ispdb', 'autoconfig', 'srv', 'preset-mx'] as const) {
      const l = looking();
      const s = act(l, { type: 'discover-progress', generation: l.generation, source });
      expect(statusLine(renderApp(s))).toContain(
        `Looking up settings... checking ${SOURCE_LABEL[source]}`,
      );
    }
  });

  it('the typed address stays visible; the help says Esc cancels', () => {
    const r = renderApp(looking());
    expect(text(r)).toContain(ADDRESS);
    expect(helpLine(r)).toContain('Esc');
  });
});

// --- A3, A4: what was found -----------------------------------------------------------------

describe('A3 found', () => {
  it('lists the provider, server, username and how it was found', () => {
    const r = renderApp(discovered(foundResult()));
    const c = collapsed(r);
    expect(c).toContain(`Provider: ${preset('websupport').name}`);
    expect(c).not.toContain('(unverified preset)');
    expect(text(r)).toContain(`Server:    ${HOST}:993 (TLS)`);
    expect(c).toContain(`Username: ${ADDRESS}`);
    expect(c).toContain(`Found via: ${asciiText(foundVia('preset-domain', undefined))}`);
  });

  it("the provider's hint and help link", () => {
    const p = preset('websupport');
    const c = collapsed(renderApp(discovered(foundResult())));
    expect(c).toContain(`Hint: ${p.hint}`);
    expect(c).toContain(`Help: ${p.helpUrl}`);
  });

  it('an unverified provider is tagged', () => {
    const zoznam = preset('zoznam');
    expect(zoznam.verified).toBe(false);
    const r = renderApp(discovered(foundResult({ provider: providerInfo(zoznam) })));
    expect(collapsed(r)).toContain(`Provider: ${zoznam.name} (unverified preset)`);
  });

  it('no provider: no Provider, Hint or Help line; the how-found names the source and the host', () => {
    const r = renderApp(discovered(foundBare()));
    const c = collapsed(r);
    expect(c).not.toContain('Provider:');
    expect(c).not.toContain('Hint:');
    expect(c).not.toContain('Help:');
    expect(c).toContain(
      `Found via: ${asciiText(foundVia('ispdb', 'autoconfig.example-test-domain.eu'))}`,
    );
    expect(text(r)).toContain(`Server:    ${HOST}:993 (TLS)`);
  });

  it('every warning is a line starting with "! ": notices, the domain problem, the off-domain warning', () => {
    const result = foundBare({
      source: 'srv',
      offDomain: true,
      domainProblem: 'not-exist',
      notices: ['First notice here.', 'Second notice here.'],
    });
    const r = renderApp(discovered(result));
    const lines = r.lines.map((l) => l.trimEnd());
    expect(lines.some((l) => l.startsWith('! First notice here.'))).toBe(true);
    expect(lines.some((l) => l.startsWith('! Second notice here.'))).toBe(true);
    const c = collapsed(r);
    expect(c).toContain(
      `! ${asciiText(domainProblemText('not-exist', PARSED.displayDomain)).slice(0, 60)}`,
    );
    expect(c).toContain(`! Warning: this server is not under ${PARSED.displayDomain}`);
  });

  it('a long warning is wrapped, not cut (at 80 columns)', () => {
    const notice = Array.from({ length: 30 }, (_, i) => `word${String(i)}x`).join(' ');
    const r = renderApp(discovered(foundResult({ notices: [notice] }), S80));
    expect(collapsed(r)).toContain(`! ${notice}`);
  });

  it('after Enter on an off-domain result the note names y and m', () => {
    const r = renderApp(press(discovered(foundBare({ offDomain: true })), ENTER));
    expect(collapsed(r)).toContain('Press y to use this server, or m to enter another.');
  });

  it('the key help names Esc and q at 40 columns', () => {
    const help = helpLine(renderApp(discovered(foundResult(), S40)));
    expect(help).toContain('Esc');
    expect(help).toContain('q');
  });
});

describe('A4 blocked and nothing found', () => {
  it('blocked: the provider, how it was found, hint and help, notices and the reason', () => {
    const p = preset('outlook');
    const c = collapsed(renderApp(discovered(BLOCKED, S200)));
    expect(c).toContain(`Provider: ${p.name}`);
    expect(c).toContain('Found via:');
    expect(c).toContain(`Hint: ${p.hint}`);
    expect(c).toContain(`Help: ${p.helpUrl}`);
    expect(c).toContain('! This is a notice of the blocked result.');
    expect(c).toContain('Not supported yet: Microsoft allows IMAP only with OAuth2.');
    expect(c).not.toContain('Server:');
  });

  it('manual: what was not found, one line per source tried, the notices', () => {
    const c = collapsed(
      renderApp(discovered({ ...MANUAL, notices: ['A notice for nothing found.'], tried: TRIED })),
    );
    expect(c).toContain(`No IMAP settings found for ${PARSED.displayDomain}.`);
    for (const t of TRIED) expect(c).toContain(asciiText(triedText(t)));
    expect(c).toContain('A notice for nothing found.');
  });

  it('manual after a DNS problem: its text comes first, then the rest', () => {
    const r = renderApp(discovered(MANUAL_OFFLINE));
    const c = collapsed(r);
    const problem = asciiText(domainProblemText('dns-unreachable', PARSED.displayDomain));
    expect(c).toContain(problem.slice(0, 60));
    expect(c.indexOf(problem.slice(0, 60))).toBeLessThan(
      c.indexOf(`No IMAP settings found for ${PARSED.displayDomain}.`),
    );
  });
});

// --- A5: the provider list ------------------------------------------------------------------

describe('A5 the provider list', () => {
  const open = (screen: Screen = S200): AppState => press(discovered(MANUAL, screen), ch('c'));
  const ORDER = pickableProviders();

  it('both group headings and every preset, headings in order, presets in pickable order', () => {
    const r = renderApp(open());
    const lines = r.lines.map((l) => l.trimEnd());
    const sk = lines.findIndex((l) => l.includes('Slovakia / Czechia'));
    const global = lines.findIndex((l) => l.includes('Global'));
    expect(sk).toBeGreaterThan(0);
    expect(global).toBeGreaterThan(sk);
    const rows = ORDER.map((p) => lines.findIndex((l, i) => i > 0 && l.includes(p.name)));
    for (const row of rows) expect(row).toBeGreaterThan(0);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    const firstGlobal = ORDER.findIndex((p) => p.group === 'global');
    expect(rows[firstGlobal - 1]).toBeLessThan(global);
    expect(rows[firstGlobal]).toBeGreaterThan(global);
  });

  it('an unverified preset is tagged (unverified); a blocked one says "not supported yet"', () => {
    const lines = renderApp(open()).lines;
    const row = (name: string): string => lines.find((l) => l.includes(name)) ?? '';
    expect(row('Zoznam')).toContain('(unverified)');
    expect(row('Azet')).toContain('(unverified)');
    expect(row('Websupport')).not.toContain('(unverified)');
    expect(row('Outlook.com / Microsoft 365')).toContain('not supported yet');
    expect(row('Websupport')).not.toContain('not supported yet');
  });

  it('the cursor is always on a preset row, never on a heading, from the first to the last', () => {
    for (let i = 0; i < ORDER.length + 3; i++) {
      const s = press(open(), ...Array.from({ length: i }, () => DOWN));
      const r = renderApp(s);
      expect(r.cursorLine, `after ${String(i)} Down presses`).not.toBeNull();
      const line = r.lines[r.cursorLine ?? -1] ?? '';
      const expected = ORDER[Math.min(i, ORDER.length - 1)] as Preset;
      expect(line, `after ${String(i)} Down presses`).toContain(expected.name);
    }
  });

  it('the cursor starts on the first preset', () => {
    const r = renderApp(open());
    expect(r.lines[r.cursorLine ?? -1]).toContain((ORDER[0] as Preset).name);
    const up = renderApp(press(open(), UP, UP));
    expect(up.lines[up.cursorLine ?? -1]).toContain((ORDER[0] as Preset).name);
  });

  it('at 40x8 the cursor row stays on screen while moving through the list', () => {
    let s = open(S40);
    for (let i = 0; i < ORDER.length + 3; i++) {
      const r = renderApp(s);
      checkFrame(r, S40);
      expect(r.cursorLine).not.toBeNull();
      expect(r.cursorLine).toBeGreaterThanOrEqual(1);
      expect(r.cursorLine).toBeLessThanOrEqual(S40.rows - 3);
      const expected = ORDER[Math.min(i, ORDER.length - 1)] as Preset;
      expect(r.lines[r.cursorLine ?? -1]).toContain(expected.name.slice(0, 6));
      s = press(s, DOWN);
    }
  });

  it('Enter on a blocked preset shows "Not supported yet: <reason>"', () => {
    const idx = ORDER.findIndex((p) => p.blocked !== undefined);
    const p = ORDER[idx] as Preset;
    const s = press(open(), ...Array.from({ length: idx }, () => DOWN), ENTER);
    expect(collapsed(renderApp(s))).toContain(`Not supported yet: ${p.blocked ?? ''}`);
  });
});

// --- A6: the host and server steps ----------------------------------------------------------

describe('A6 the host and server steps', () => {
  it("host: the label, the typed host and the provider's hint below", () => {
    const p = preset('wedos');
    const r = renderApp(typeText(discovered(NEEDS_HOST), 'wes1-imap'));
    const c = collapsed(r);
    expect(c).toContain('IMAP host:');
    expect(c).toContain('wes1-imap');
    expect(c).toContain(asciiText(p.hostHint ?? ''));
  });

  it('host: the message of a bad host', () => {
    const s = press(typeText(discovered(NEEDS_HOST), 'bad:host'), ENTER);
    expect(collapsed(renderApp(s))).toContain(
      'Enter the host name only (e.g. imap.example.com); port 993 is used',
    );
  });

  it('server: both fields, the username prefilled with the address', () => {
    const r = renderApp(press(discovered(MANUAL), ch('m')));
    const c = collapsed(r);
    expect(c).toContain('IMAP host:');
    expect(c).toContain('Username:');
    expect(c).toContain(ADDRESS);
  });

  it('server: the typed host shows, and a bad one shows its message', () => {
    const s = press(typeText(press(discovered(MANUAL), ch('m')), 'bad:host'), ENTER, ENTER);
    const c = collapsed(renderApp(s));
    expect(c).toContain('bad:host');
    expect(c).toContain('Enter the host name only (e.g. imap.example.com); port 993 is used');
  });
});

// --- A7, A8: the saved check and the password -----------------------------------------------

describe('A7 checking the saved mailboxes', () => {
  it('"Checking your saved mailboxes..." on the status line', () => {
    const s = press(discovered(foundResult()), ENTER);
    expect(statusLine(renderApp(s))).toContain('Checking your saved mailboxes...');
  });
});

describe('A8 the password step', () => {
  it('shows the provider, server, username, hint and the hidden-password line', () => {
    const p = preset('websupport');
    const r = renderApp(atPassword());
    const c = collapsed(r);
    expect(c).toContain(p.name);
    expect(c).toContain(`${HOST}:993`);
    expect(c).toContain(ADDRESS);
    expect(c).toContain(`${p.hint ?? ''}`);
    expect(c).toContain('Password:');
    expect(text(r)).toContain('Password:  (nothing is shown while you type)');
  });

  it('a manual server has no provider name but still its server and username', () => {
    const r = renderApp(atPassword(foundBare()));
    const c = collapsed(r);
    expect(c).toContain(`${HOST}:993`);
    expect(c).toContain(ADDRESS);
    expect(text(r)).toContain('(nothing is shown while you type)');
  });

  it('the notice of an empty password', () => {
    expect(collapsed(renderApp(press(atPassword(), ENTER)))).toContain('Type the password.');
  });

  it('no frame, typing it character by character, contains it or any 3-character part of it', () => {
    let s = atPassword();
    const before = text(renderApp(s));
    for (let i = 0; i + 3 <= PW.length; i++) expect(before).not.toContain(PW.slice(i, i + 3));
    for (const c of PW) {
      s = press(s, ch(c));
      const all = text(renderApp(s));
      expect(all).not.toContain(PW);
      for (let i = 0; i + 3 <= PW.length; i++) expect(all).not.toContain(PW.slice(i, i + 3));
    }
  });

  it('nothing in the frame depends on the length of the password (0, 1, 5, 40, 300 characters)', () => {
    const frames = [0, 1, 5, 40, 300].map((n) => renderApp(typeText(atPassword(), 'p'.repeat(n))));
    for (const f of frames) expect(f).toEqual(frames[0]);
  });

  it('nor on its content', () => {
    expect(renderApp(typeText(atPassword(), 'aaaaaaaa'))).toEqual(
      renderApp(typeText(atPassword(), 'QWZ7#JX!')),
    );
  });

  it('at every size too', () => {
    for (const screen of [S40, S80, S200]) {
      const a = renderApp(typeText(atPassword(foundResult(), screen), 'x'));
      const b = renderApp(typeText(atPassword(foundResult(), screen), 'y'.repeat(60)));
      expect(a).toEqual(b);
    }
  });

  it('after the submit, in the rejection and in the failure: no part of the password', () => {
    const c = submitted();
    for (const s of [
      c,
      act(c, { type: 'challenge', generation: c.generation }),
      act(c, { type: 'add-rejected', generation: c.generation, text: 'Wrong.' }),
      act(c, { type: 'add-failed', generation: c.generation, text: 'Broke.' }),
    ]) {
      const all = text(renderApp(s));
      expect(all).not.toContain(PW);
      expect(all).not.toContain('QWZ');
      expect(all).not.toContain('~^Q');
    }
  });

  it('a rejected password: the password step again with the text below it, wrapped', () => {
    const words = Array.from({ length: 25 }, (_, i) => `word${String(i)}x`).join(' ');
    const c = submitted();
    const r = renderApp(act(c, { type: 'add-rejected', generation: c.generation, text: words }));
    expect(collapsed(r)).toContain(words);
    expect(text(r)).toContain('(nothing is shown while you type)');
    expect(text(r)).not.toContain('Checking the login...');
  });

  it('in a short window the password line survives a long rejection; the note is cut with ...', () => {
    const c = submitted(PW, S40);
    const note = 'Check the address and the password, then try again. '.repeat(10);
    const r = renderApp(act(c, { type: 'add-rejected', generation: c.generation, text: note }));
    checkFrame(r, S40);
    expect(text(r)).toContain('Password:');
    expect(text(r)).toContain('...');
  });
});

describe("A8 checking the login, A9 the guard's wait", () => {
  it('"Checking the login..." on the status line', () => {
    expect(statusLine(renderApp(submitted()))).toContain('Checking the login...');
  });

  it("the guard's wait notice replaces it until the wait ends", () => {
    const c = submitted();
    const waiting = renderApp(act(c, { type: 'challenge', generation: c.generation }));
    expect(statusLine(waiting)).toContain(CHALLENGE_NOTICE);
    expect(statusLine(waiting)).not.toContain('Checking the login...');
    const w = act(c, { type: 'challenge', generation: c.generation });
    const done = renderApp(act(w, { type: 'challenge-done', generation: c.generation }));
    expect(statusLine(done)).toContain('Checking the login...');
    expect(statusLine(done)).not.toContain(CHALLENGE_NOTICE);
  });

  it('the failed screen shows the text in the body and the key help names Esc and q', () => {
    const c = submitted();
    const r = renderApp(
      act(c, { type: 'add-failed', generation: c.generation, text: 'Too many attempts. Wait.' }),
    );
    expect(collapsed(r)).toContain('Too many attempts. Wait.');
    expect(statusLine(r)).not.toContain('Too many attempts');
    expect(helpLine(r)).toContain('Esc');
    expect(helpLine(r)).toContain('q');
  });
});

// --- H1, A10: Home --------------------------------------------------------------------------

describe('H1 Home after the change', () => {
  it('Enter on Add or Logs no longer says "Coming in a next step"', () => {
    const addFrame = text(renderApp(press(home(), DOWN, ENTER)));
    const logsFrame = text(renderApp(press(home(), DOWN, DOWN, ENTER)));
    expect(addFrame).not.toContain('Coming in a next step');
    expect(logsFrame).not.toContain('Coming in a next step');
    expect(addFrame).toContain('Mail Manager - Add a mailbox');
    expect(logsFrame).toContain('Mail Manager - Logs');
  });

  it("Home's rows, keys and header are otherwise as before", () => {
    const r = renderApp(home());
    expect(r.lines[0]).toContain('Mail Manager - alice@example.com');
    expect(text(r)).toContain('one@example.com');
    expect(text(r)).toContain('+ Add a mailbox');
    expect(text(r)).toContain('Logs');
    expect(text(r)).toContain('Log out');
    expect(helpLine(r)).toContain('Enter');
  });
});

describe('A10 "Added <address>." on Home', () => {
  const ID = '44444444-4444-4444-8444-444444444444';

  function homeAfterAdd(): AppState {
    const c = submitted();
    const added = act(c, {
      type: 'mailbox-added',
      generation: c.generation,
      id: ID,
      email: ADDRESS,
    });
    return act(added, {
      type: 'mailboxes',
      generation: added.generation,
      rows: [ROW1, { id: ID, email: ADDRESS, provider: 'websupport', lastCheckedAt: null }],
    });
  }

  it('the status line says "Added <address>." and the cursor is on the new mailbox', () => {
    const r = renderApp(homeAfterAdd());
    expect(statusLine(r)).toContain(`Added ${ADDRESS}.`);
    expect(r.lines[r.cursorLine ?? -1]).toContain(ADDRESS);
  });

  it('the next key clears it', () => {
    const r = renderApp(press(homeAfterAdd(), UP));
    expect(text(r)).not.toContain('Added ');
  });

  it('while the list loads again, Home shows the loading text', () => {
    const c = submitted();
    const added = act(c, {
      type: 'mailbox-added',
      generation: c.generation,
      id: ID,
      email: ADDRESS,
    });
    expect(text(renderApp(added))).toContain('Loading your mailboxes...');
  });

  it('a hostile address in the message is sanitised and the frame is exact', () => {
    const c = submitted();
    const added = act(c, {
      type: 'mailbox-added',
      generation: c.generation,
      id: ID,
      email: 'evil\u202E\u0007@example-test-domain.eu',
    });
    const loaded = act(added, {
      type: 'mailboxes',
      generation: added.generation,
      rows: [ROW1],
    });
    for (const screen of [S40, S80, S200]) {
      const r = renderApp(resized(loaded, screen));
      checkFrame(r, screen);
      expect(text(r)).not.toContain('\u202E');
      expect(text(r).replace(/\n/g, '')).not.toMatch(/\p{Cc}/u);
    }
  });
});
