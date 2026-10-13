import { describe, it, expect } from 'vitest';
import { addBody, addBusy, addHeader, addHelp, addNote } from '../../src/cli/app/add-render.js';
import { addLines, addView, providerRows } from '../../src/cli/app/add.js';
import { reduceApp, startApp } from '../../src/cli/app/reduce.js';
import { renderApp } from '../../src/cli/app/render.js';
import { initialApp } from '../../src/cli/app/state.js';
import type {
  AddStep,
  AddView,
  AppAction,
  AppKey,
  AppState,
  HomeView,
  MailboxRow,
} from '../../src/cli/app/state.js';
import { helpLine } from '../../src/cli/browser/layout.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Screen } from '../../src/cli/browser/state.js';
import { displayWidth } from '../../src/cli/browser/width.js';
import { domainProblemText, offDomainWarning, triedText } from '../../src/cli/discovery-text.js';
import type { AuthUser } from '../../src/core/auth.js';
import { providerInfo } from '../../src/core/providers/discover.js';
import type { DiscoveryResult, ProviderInfo } from '../../src/core/providers/discover.js';
import { parseEmail } from '../../src/core/providers/email.js';
import { PRESETS } from '../../src/core/providers/presets.js';
import type { Preset } from '../../src/core/providers/presets.js';

// M2d-4 add a mailbox, drawn: renderApp over states built with the reducers - every step at
// 40x8, 80x24 and 200x50, what the lookup found, the provider list, the fields, the notes and
// where they go, the key help - and the pieces of add-render.ts on their own. Every frame is
// proven exact in size; whatever is not a typed field is plain ASCII. The password is in no
// frame, and no frame depends on it. Addresses and hosts are placeholders; hostile characters
// are made from their code points.

// --- fixtures -------------------------------------------------------------------------------

const ANNA: AuthUser = { email: 'anna@example-test-domain.eu', userId: 'user-anna' };
const SMALLEST: Screen = { rows: 8, cols: 40 }; // 5 body lines
const SCREEN: Screen = { rows: 24, cols: 80 }; // 21 body lines
const WIDE: Screen = { rows: 50, cols: 200 }; // 47 body lines
const SCREENS: Screen[] = [SMALLEST, SCREEN, WIDE];
const ASCII = /^[\x20-\x7e]*$/;
const TITLE = 'Mail Manager - Add a mailbox';
const PASSWORD_LINE = '    Password:  (nothing is shown while you type)';
const CHALLENGE = 'Several wrong passwords - waiting 5 seconds before trying again.';
const ADDRESS = 'new@example-test-domain.eu';
const EMAIL = parseEmail(ADDRESS);
/** Shares no three characters in a row with anything on screen. */
const CANARY = 'Zx9#Qw7$Lk2!vJ5^';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const MAILBOX: MailboxRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'box@example-test-domain.eu',
  provider: 'websupport',
  lastCheckedAt: null,
};
/** What a mail server's "no" is answered with: longer than any status line here but 200x50's. */
const REJECTED =
  "Couldn't sign in. Check the e-mail address, the password and the IMAP server, then try again with care.";

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

function preset(id: string): Preset {
  const found = PRESETS.find((p) => p.id === id);
  if (found === undefined) throw new Error(`no preset ${id}`);
  return found;
}

const OUTLOOK = preset('outlook');
const WEDOS = preset('wedos');

/** A provider with short texts: its page fits 80 columns without wrapping. */
const PROVIDER: ProviderInfo = {
  id: 'websupport',
  name: 'Websupport',
  verified: true,
  auth: ['password'],
  hint: 'Log in with your full address.',
  helpUrl: 'https://help.example-test-domain.eu/imap',
};
const base = { email: EMAIL, notices: [], tried: [] };
const FOUND: DiscoveryResult = {
  ...base,
  status: 'found',
  source: 'preset-domain',
  provider: PROVIDER,
  imap: { host: 'imap.example-test-domain.eu', port: 993, username: ADDRESS },
  altHosts: [],
};
const SRV_NOTICE = 'The username is a guess (full email address); SRV records do not specify it.';
/** No provider; a notice, a domain problem and the warning about the unsigned record. */
const OFF_DOMAIN: DiscoveryResult = {
  ...base,
  status: 'found',
  source: 'srv',
  via: '_imaps._tcp.example-test-domain.eu',
  imap: { host: 'imap.elsewhere-test-domain.eu', port: 993, username: ADDRESS },
  altHosts: [],
  offDomain: true,
  notices: [SRV_NOTICE],
  domainProblem: 'dns-error',
};
const BLOCKED: DiscoveryResult = {
  ...base,
  status: 'blocked',
  source: 'preset-mx',
  via: 'mx.example-test-domain.eu',
  provider: { ...PROVIDER, id: 'outlook', name: 'Outlook.com', verified: false },
  reason: 'Only its own sign-in page is allowed.',
  notices: ['The Outlook.com preset is not yet verified.'],
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
  domainProblem: 'not-exist',
  tried: [
    { source: 'preset-domain', outcome: 'no-match' },
    { source: 'preset-mx', outcome: 'not-found' },
    { source: 'ispdb', outcome: 'error', detail: 'HTTP 500' },
  ],
  notices: ['Mozilla ISPDB lists only STARTTLS / non-993 IMAP, which is not supported.'],
};
const FOUND_40 = [
  '    Provider:  Websupport',
  '    Server:    imap.example-test-domain.',
  '               eu:993 (TLS)',
  '    Username:  new@example-test-domain.e',
  '               u',
  '    Found via: built-in preset (email',
  '               domain)',
  '    Hint:      Log in with your full',
  '               address.',
  '    Help:      https://help.example-test',
  '               -domain.eu/imap',
];
const FOUND_80 = [
  '    Provider:  Websupport',
  '    Server:    imap.example-test-domain.eu:993 (TLS)',
  '    Username:  new@example-test-domain.eu',
  '    Found via: built-in preset (email domain)',
  '    Hint:      Log in with your full address.',
  '    Help:      https://help.example-test-domain.eu/imap',
];
const CHOSEN_80 = [
  '    Provider:  Websupport',
  '    Server:    imap.example-test-domain.eu:993 (TLS)',
  '    Username:  new@example-test-domain.eu',
  '    Hint:      Log in with your full address.',
];

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

function act(state: AppState, ...actions: AppAction[]): AppState {
  let s = state;
  for (const a of actions) s = reduceApp(s, a).state;
  return s;
}

function view(state: AppState): AddView {
  if (state.view.kind !== 'add') throw new Error(`not adding: ${state.view.kind}`);
  return state.view;
}

/** Home of ANNA with one mailbox, the cursor on "+ Add a mailbox". */
function atHome(screen: Screen = SCREEN, addProblem?: string): AppState {
  const options = addProblem === undefined ? {} : { addProblem };
  const s0 = startApp(initialApp('1.2.3', screen, options)).state;
  const s1 = act(
    s0,
    { type: 'session', generation: s0.generation, user: ANNA, remembered: [ANNA.email] },
    key('enter'),
  );
  return act(s1, { type: 'mailboxes', generation: s1.generation, rows: [MAILBOX] }, key('down'));
}

function opened(screen: Screen = SCREEN): AppState {
  return act(atHome(screen), key('enter'));
}

function looking(screen: Screen = SCREEN): AppState {
  return act(opened(screen), ...chars(ADDRESS), key('enter'));
}

function discovered(result: DiscoveryResult, screen: Screen = SCREEN): AppState {
  const s = looking(screen);
  return act(s, { type: 'discovered', generation: s.generation, result });
}

function providers(screen: Screen = SCREEN): AppState {
  return act(discovered(FOUND, screen), ch('c'));
}

function rowOf(id: string): number {
  return providerRows().findIndex((row) => row.kind === 'preset' && row.preset.id === id);
}

/** The provider list with the cursor on `id`. */
function onPreset(id: string, screen: Screen = SCREEN): AppState {
  const before = providerRows()
    .slice(0, rowOf(id))
    .filter((row) => row.kind === 'preset').length;
  return act(providers(screen), ...repeat(key('down'), before));
}

function server(screen: Screen = SCREEN): AppState {
  return act(discovered(FOUND, screen), ch('m'));
}

function checkingSaved(screen: Screen = SCREEN, result: DiscoveryResult = FOUND): AppState {
  return act(discovered(result, screen), ch('y'));
}

function atPassword(screen: Screen = SCREEN, result: DiscoveryResult = FOUND): AppState {
  const s = checkingSaved(screen, result);
  return act(s, { type: 'saved-checked', generation: s.generation });
}

function checking(screen: Screen = SCREEN): AppState {
  return act(atPassword(screen), ...chars(CANARY), key('enter'));
}

function rejected(screen: Screen = SCREEN, text: string = REJECTED): AppState {
  const s = checking(screen);
  return act(s, { type: 'add-rejected', generation: s.generation, text });
}

function failed(text: string, screen: Screen = SCREEN): AppState {
  const s = checking(screen);
  return act(s, { type: 'add-failed', generation: s.generation, text });
}

/** Home right after the mailbox was saved; `rows`: the list has arrived. */
function added(screen: Screen = SCREEN, rows?: readonly MailboxRow[], email = ADDRESS): AppState {
  const s = checking(screen);
  const home = act(s, { type: 'mailbox-added', generation: s.generation, id: NEW_ID, email });
  if (rows === undefined) return home;
  return act(home, { type: 'mailboxes', generation: home.generation, rows });
}

const HOME: HomeView = {
  kind: 'home',
  mode: 'list',
  mailboxes: [MAILBOX],
  loadFailed: false,
  cursor: 1,
  message: null,
  focusId: null,
  added: null,
};

/** An add view made by hand: for what no reducer would put there. */
function stateOf(over: Partial<AddView>, screen: Screen = SCREEN): AppState {
  return {
    ...initialApp('1.2.3', screen),
    current: ANNA,
    view: { ...addView(HOME, null), ...over },
  };
}

/** Every step, built with the reducers. */
function everyStep(screen: Screen): [AddStep, AppState][] {
  return [
    ['address', act(opened(screen), ...chars(ADDRESS))],
    ['looking', looking(screen)],
    ['found', discovered(OFF_DOMAIN, screen)],
    ['blocked', discovered(BLOCKED, screen)],
    ['nothing', discovered(MANUAL, screen)],
    ['providers', onPreset('outlook', screen)],
    ['host', act(discovered(NEEDS_HOST, screen), ...chars('wes1-imap.wedos.net'))],
    ['server', act(server(screen), ...chars('imap.example-test-domain.eu'), key('tab'))],
    ['checking-saved', checkingSaved(screen)],
    ['password', rejected(screen)],
    ['checking', checking(screen)],
    ['failed', failed('The mailbox is already saved.', screen)],
  ];
}

// --- reading a frame ------------------------------------------------------------------------

/** The frame of `state`, proven exact: `rows` lines of `cols` columns, in plain ASCII. */
function frame(state: AppState): Rendered {
  const out = renderApp(state);
  expect(out.lines).toHaveLength(state.screen.rows);
  for (const line of out.lines) {
    expect(line).toHaveLength(state.screen.cols);
    expect(line).toMatch(ASCII);
  }
  return out;
}

function trimmed(out: Rendered): string[] {
  return out.lines.map((l) => l.trimEnd());
}

function lineAt(out: Rendered, i: number): string {
  return (out.lines[i] ?? '').trimEnd();
}

function status(out: Rendered): string {
  return lineAt(out, out.lines.length - 2);
}

function help(out: Rendered): string {
  return lineAt(out, out.lines.length - 1);
}

/** The body: every line between the header and the status line. */
function body(out: Rendered): string[] {
  return trimmed(out).slice(1, -2);
}

/** The body without the blank lines at its end. */
function page(out: Rendered): string[] {
  const lines = body(out);
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

function blank(n: number): string[] {
  return Array.from({ length: n }, () => '');
}

// --- every step, every size -----------------------------------------------------------------

describe('every step is a whole frame at every size', () => {
  describe.each(SCREENS)('$rows x $cols', (screen) => {
    it.each(everyStep(screen))('%s', (name, state) => {
      expect(view(state).step).toBe(name);
      const out = frame(state);
      expect(lineAt(out, 0)).toBe(TITLE);
    });
  });

  it('the twelve steps are all there', () => {
    expect(everyStep(SCREEN).map(([name]) => name)).toHaveLength(12);
  });

  it.each<Screen>([
    { rows: 7, cols: 80 },
    { rows: 24, cols: 39 },
    { rows: 3, cols: 20 },
  ])('$rows x $cols is too small: only that is said, in every step', (screen) => {
    for (const [, state] of everyStep(SCREEN)) {
      const out = renderApp(act(state, { type: 'resize', screen }));
      expect(out.lines).toHaveLength(screen.rows);
      for (const line of out.lines) expect(line).toHaveLength(screen.cols);
      const text = out.lines.join('\n');
      expect(text).toMatch(/[Tt]oo small - need/);
      for (const shown of [
        'Add a mailbox',
        'E-mail',
        'Password',
        'Server',
        'imap.',
        'websupport',
      ]) {
        expect(text).not.toContain(shown);
      }
      expect(out.cursorLine).toBeNull();
    }
  });
});

// --- A1: the address ------------------------------------------------------------------------

describe('the address field (A1)', () => {
  it('80x24, nothing typed', () => {
    const out = frame(opened());
    expect(trimmed(out)).toEqual([
      TITLE,
      '    E-mail of the mailbox: _',
      ...blank(20),
      '',
      'Enter next  Esc back  Ctrl+C quit',
    ]);
    expect(out.cursorLine).toBe(1);
  });

  it('what is typed is shown, the mark after it', () => {
    const out = frame(act(opened(), ...chars(ADDRESS)));
    expect(lineAt(out, 1)).toBe(`    E-mail of the mailbox: ${ADDRESS}_`);
  });

  it('40 columns: the end of a long address stays in view', () => {
    const out = frame(act(opened(SMALLEST), ...chars(ADDRESS)));
    expect(trimmed(out)).toEqual([
      TITLE,
      '    E-mail of the mailbox: ...domain.eu_',
      ...blank(4),
      '',
      'Enter next  Esc back  Ctrl+C quit',
    ]);
    // Short enough: all of it.
    expect(lineAt(frame(act(opened(SMALLEST), ...chars('a@b.eu'))), 1)).toBe(
      '    E-mail of the mailbox: a@b.eu_',
    );
  });

  it('a message that fits the status line is shown there', () => {
    const empty = frame(act(opened(SMALLEST), key('enter')));
    expect(status(empty)).toBe('Type the e-mail address of the mailbox.');
    expect(page(empty)).toEqual(['    E-mail of the mailbox: _']);
    const noAt = frame(act(opened(), ...chars('nope'), key('enter')));
    expect(status(noAt)).toBe('Email address must contain "@"');
    expect(page(noAt)).toEqual(['    E-mail of the mailbox: nope_']);
  });

  it('one that does not fit is wrapped below the field instead', () => {
    const out = frame(act(opened(SMALLEST), ...chars('a b@c.eu'), key('enter')));
    expect(status(out)).toBe('');
    expect(page(out)).toEqual([
      '    E-mail of the mailbox: a b@c.eu_',
      '    Email address contains invalid',
      '    characters',
    ]);
    // The same message at 80 columns: on the status line.
    const wide = frame(act(opened(), ...chars('a b@c.eu'), key('enter')));
    expect(status(wide)).toBe('Email address contains invalid characters');
    expect(page(wide)).toEqual(['    E-mail of the mailbox: a b@c.eu_']);
  });

  it('a typed address with wide characters is shown as typed, and the frame is exact', () => {
    const typed = `${cp(0x4e2d, 0x6587)}@b${cp(0xfc)}cher.example-test-domain.eu`;
    for (const screen of SCREENS) {
      const out = renderApp(act(opened(screen), ...chars(typed)));
      expect(out.lines).toHaveLength(screen.rows);
      for (const line of out.lines) expect(displayWidth(line)).toBe(screen.cols);
      if (screen.cols >= 80) expect(lineAt(out, 1)).toBe(`    E-mail of the mailbox: ${typed}_`);
    }
  });
});

// --- A2: looking ----------------------------------------------------------------------------

describe('looking up the settings (A2)', () => {
  it('the address without the mark, the status says what is going on', () => {
    const out = frame(looking());
    expect(trimmed(out)).toEqual([
      TITLE,
      `    E-mail of the mailbox: ${ADDRESS}`,
      ...blank(20),
      'Looking up settings...',
      'Esc back  q quit',
    ]);
    expect(out.cursorLine).toBeNull();
  });

  it.each([
    ['preset-mx', 'Looking up settings... checking built-in preset (MX record)'],
    ['ispdb', 'Looking up settings... checking Mozilla ISPDB'],
    ['autoconfig', "Looking up settings... checking the domain's autoconfig file"],
    ['srv', 'Looking up settings... checking DNS SRV record'],
  ] as const)('checking %s', (source, text) => {
    const s = looking();
    const out = frame(act(s, { type: 'discover-progress', generation: s.generation, source }));
    expect(status(out)).toBe(text);
  });

  it('40 columns: the status is cut at the end', () => {
    const s = looking(SMALLEST);
    const out = frame(
      act(s, { type: 'discover-progress', generation: s.generation, source: 'autoconfig' }),
    );
    expect(status(out)).toBe('Looking up settings... checking the d...');
  });
});

// --- A3: found ------------------------------------------------------------------------------

describe('what was found (A3)', () => {
  it('80x24: provider, server, username, how it was found, hint and help', () => {
    const out = frame(discovered(FOUND));
    expect(trimmed(out)).toEqual([
      TITLE,
      ...FOUND_80,
      ...blank(15),
      '',
      'Enter use these  c provider list  m enter server  Esc back  q quit',
    ]);
    expect(out.cursorLine).toBeNull();
  });

  it('200x50: the same lines, every key in the help', () => {
    const out = frame(discovered(FOUND, WIDE));
    expect(page(out)).toEqual(FOUND_80);
    expect(help(out)).toBe(
      'Enter use these  c provider list  m enter server  Up/Down scroll  Esc back  q quit',
    );
  });

  it('40x8: every value wrapped under itself; the page starts at its top', () => {
    const s = discovered(FOUND, SMALLEST);
    expect(addLines(view(s), 40)).toEqual(FOUND_40);
    const out = frame(s);
    expect(body(out)).toEqual(FOUND_40.slice(0, 5));
    expect(help(out)).toBe('Enter use these  Esc back  q quit');
  });

  it('40x8: Down and PgDn show the rest', () => {
    const s = discovered(FOUND, SMALLEST);
    expect(body(frame(act(s, key('down'))))).toEqual(FOUND_40.slice(1, 6));
    expect(body(frame(act(s, key('pagedown'))))).toEqual(FOUND_40.slice(5, 10));
    expect(body(frame(act(s, ...repeat(key('pagedown'), 5))))).toEqual(FOUND_40.slice(6));
  });

  it('an unverified provider is tagged', () => {
    const result: DiscoveryResult = { ...FOUND, provider: { ...PROVIDER, verified: false } };
    expect(page(frame(discovered(result)))[0]).toBe(
      '    Provider:  Websupport (unverified preset)',
    );
  });

  it('no provider: no provider line, no hint, no help', () => {
    const result: DiscoveryResult = { ...FOUND, source: 'ispdb', via: 'example-test-domain.eu' };
    delete (result as { provider?: ProviderInfo }).provider;
    expect(page(frame(discovered(result)))).toEqual([
      '    Server:    imap.example-test-domain.eu:993 (TLS)',
      '    Username:  new@example-test-domain.eu',
      '    Found via: Mozilla ISPDB - example-test-domain.eu',
    ]);
  });

  it('a provider without a hint or a help link has neither line', () => {
    const bare: ProviderInfo = { id: 'x', name: 'Bare', verified: true, auth: ['password'] };
    const text = page(frame(discovered({ ...FOUND, provider: bare }))).join('\n');
    expect(text).toContain('    Provider:  Bare');
    expect(text).not.toContain('Hint:');
    expect(text).not.toContain('Help:');
  });

  it('every warning starts "! " at the margin: the notices, the domain problem, the DNS warning', () => {
    const out = frame(discovered(OFF_DOMAIN, WIDE));
    const warning = offDomainWarning(OFF_DOMAIN) ?? '';
    expect(warning).toContain('imap.elsewhere-test-domain.eu');
    expect(page(out)).toEqual([
      '    Server:    imap.elsewhere-test-domain.eu:993 (TLS)',
      '    Username:  new@example-test-domain.eu',
      '    Found via: DNS SRV record - _imaps._tcp.example-test-domain.eu',
      `! ${SRV_NOTICE}`,
      `! ${domainProblemText('dns-error', 'example-test-domain.eu')}`,
      // 207 characters: even 200 columns wrap it.
      `! ${warning.slice(0, warning.lastIndexOf(' '))}`,
      '  imap.elsewhere-test-domain.eu.',
    ]);
    expect(help(out)).toBe(
      'y use this server  c provider list  m enter server  Up/Down scroll  Esc back  q quit',
    );
  });

  it('a long warning is wrapped under its text, not cut', () => {
    const out = frame(discovered(OFF_DOMAIN));
    const warnings = page(out).slice(3);
    expect(warnings).toEqual([
      `! ${SRV_NOTICE}`,
      '! The DNS servers of "example-test-domain.eu" answered with an error, so its',
      "  mail settings can't be looked up right now. Try again later, or ask whoever",
      '  manages the domain.',
      '! Warning: this server is not under example-test-domain.eu and comes from an',
      '  unsigned DNS record, which someone on your network could fake. Only continue',
      '  if you know your provider uses imap.elsewhere-test-domain.eu.',
    ]);
  });

  it('Enter on a server from an unsigned record: the note on the status line', () => {
    const out = frame(act(discovered(OFF_DOMAIN), key('enter')));
    expect(status(out)).toBe('Press y to use this server, or m to enter another.');
    expect(help(out)).toBe('y use this server  c provider list  m enter server  Esc back  q quit');
  });

  it('40 columns: that note is wrapped at the end of the body, the warning above it', () => {
    const s = act(discovered(OFF_DOMAIN, SMALLEST), key('enter'));
    const out = frame(s);
    expect(status(out)).toBe('');
    expect(body(out)).toEqual([
      '  on your network could fake. Only',
      '  continue if you know your provider',
      '  uses imap.elsewhere-test-domain.eu.',
      '    Press y to use this server, or m to',
      '    enter another.',
    ]);
    // Scrolled as far as it goes: the page has three lines here.
    const lines = addLines(view(s), 40);
    expect(view(s).scroll).toBe(lines.length - 3);
    expect(help(out)).toBe('y use this server  Esc back  q quit');
  });

  it('a scroll outside the page (a window that grew, a stray value) is drawn clamped', () => {
    const s = discovered(OFF_DOMAIN, SMALLEST);
    const lines = addLines(view(s), 40).map((l) => l.trimEnd());
    expect(lines.length).toBeGreaterThan(5);
    const at = (scroll: number): string[] => body(frame({ ...s, view: { ...view(s), scroll } }));
    // Past the end: the last five lines, the page's last line on the last body line.
    expect(at(lines.length + 50)).toEqual(lines.slice(-5));
    expect(at(lines.length - 5)).toEqual(lines.slice(-5));
    // Before the start: the first five.
    expect(at(-3)).toEqual(lines.slice(0, 5));
    expect(at(0)).toEqual(lines.slice(0, 5));
  });
});

// --- A4: blocked, nothing found -------------------------------------------------------------

describe('not supported yet, and nothing found (A4)', () => {
  it('blocked: the provider, how it was found, hint and help, notices, the reason', () => {
    const out = frame(discovered(BLOCKED));
    expect(trimmed(out)).toEqual([
      TITLE,
      '    Provider:  Outlook.com (unverified preset)',
      '    Found via: built-in preset (MX record) - mx.example-test-domain.eu',
      '    Hint:      Log in with your full address.',
      '    Help:      https://help.example-test-domain.eu/imap',
      '! The Outlook.com preset is not yet verified.',
      '    Not supported yet: Only its own sign-in page is allowed.',
      ...blank(15),
      '',
      'Up/Down scroll  Esc back  q quit',
    ]);
    expect(out.cursorLine).toBeNull();
  });

  it('blocked at 40x8: Esc and q stay in the help', () => {
    expect(help(frame(discovered(BLOCKED, SMALLEST)))).toBe('Up/Down scroll  Esc back  q quit');
    expect(helpLine(addHelp(view(discovered(BLOCKED))), 20).trimEnd()).toBe('Esc back  q quit');
  });

  it('nothing found: the domain problem, the sentence, what was tried, the notices', () => {
    const out = frame(discovered(MANUAL, WIDE));
    const problem = domainProblemText('not-exist', 'example-test-domain.eu');
    expect(page(out)).toEqual([
      // 216 characters: wrapped at the last word that fits 196 columns.
      `    ${problem.slice(0, problem.indexOf(' enter its IMAP host.'))}`,
      '    enter its IMAP host.',
      '    No IMAP settings found for example-test-domain.eu.',
      '    Tried:     built-in preset (email domain): no known provider',
      '    Tried:     built-in preset (MX record): nothing found',
      '    Tried:     Mozilla ISPDB: failed (HTTP 500)',
      '! Mozilla ISPDB lists only STARTTLS / non-993 IMAP, which is not supported.',
    ]);
    expect(help(out)).toBe('c provider list  m enter server  Up/Down scroll  Esc back  q quit');
    for (const tried of MANUAL.tried) {
      expect(out.lines.join('\n')).toContain(triedText(tried));
    }
  });

  it('nothing found, no problem with the domain: the sentence first', () => {
    const result: DiscoveryResult = { ...base, status: 'manual' };
    expect(page(frame(discovered(result)))).toEqual([
      '    No IMAP settings found for example-test-domain.eu.',
    ]);
    expect(help(frame(discovered(result)))).toBe(
      'c provider list  m enter server  Up/Down scroll  Esc back  q quit',
    );
    expect(help(frame(discovered(result, SMALLEST)))).toBe('c provider list  Esc back  q quit');
  });
});

// --- A5: the provider list ------------------------------------------------------------------

describe('the provider list (A5)', () => {
  it('headings and providers; the cursor on the first provider', () => {
    const out = frame(providers(WIDE));
    const rows = providerRows();
    const lines = page(out);
    expect(lines).toHaveLength(rows.length);
    expect(lines[0]).toBe('    Slovakia / Czechia');
    expect(out.cursorLine).toBe(2);
    rows.forEach((row, i) => {
      const line = lines[i] ?? '';
      if (row.kind === 'heading') {
        expect(line).toBe(`    ${row.text}`);
        return;
      }
      const name = `      ${row.preset.name}${row.verified ? '' : ' (unverified)'}`;
      if (row.blocked === null) expect(line).toBe(name);
      else expect(line).toBe(`${name.padEnd(200 - 19)}not supported yet`);
    });
    expect(lines).toContain('    Global');
    expect(lines).toContain('      Zoznam (unverified)');
    expect(help(out)).toBe('Up/Down move  Enter choose  m enter server  Esc back  q quit');
  });

  it('80 columns: a provider that is not supported says so on the right', () => {
    const out = frame(onPreset('outlook'));
    const line = lineAt(out, out.cursorLine ?? 0);
    expect(line).toBe(`${`      ${OUTLOOK.name}`.padEnd(80 - 19)}not supported yet`);
  });

  it('the cursor line follows the cursor, and the window follows it too', () => {
    const rows = providerRows();
    // 21 body lines for 26 rows: from the 21st row on the list scrolls.
    const down19 = frame(act(providers(), ...repeat(key('down'), 19)));
    expect(view(act(providers(), ...repeat(key('down'), 19))).cursor).toBe(21);
    expect(down19.cursorLine).toBe(21);
    expect(body(down19)[0]).toBe('      Active24');
    const end = frame(act(providers(), ...repeat(key('down'), rows.length)));
    const lastRow = rows.at(-1);
    expect(end.cursorLine).toBe(21);
    expect(body(end)[20]).toBe(`      ${lastRow?.kind === 'preset' ? lastRow.preset.name : ''}`);
  });

  it('40x8: five rows, the heading first while the cursor is near the top', () => {
    const out = frame(providers(SMALLEST));
    expect(body(out)[0]).toBe('    Slovakia / Czechia');
    expect(out.cursorLine).toBe(2);
    expect(help(out)).toBe('Up/Down move  Esc back  q quit');
    const moved = frame(act(providers(SMALLEST), ...repeat(key('down'), 6)));
    expect(moved.cursorLine).toBe(5);
    expect(body(moved)).toHaveLength(5);
  });

  it('Enter on one that is not supported: the reason on the status line when it fits', () => {
    const out = frame(act(onPreset('outlook', WIDE), key('enter')));
    expect(status(out)).toBe(`Not supported yet: ${OUTLOOK.blocked ?? ''}`);
  });

  it('80 columns: the reason is wrapped at the end of the body, the list above it', () => {
    const s = act(onPreset('outlook'), key('enter'));
    const out = frame(s);
    expect(status(out)).toBe('');
    expect(body(out).slice(19)).toEqual([
      '    Not supported yet: Microsoft allows IMAP only with OAuth2 (LOGINDISABLED).',
      '    Supported from M6.',
    ]);
    // 19 rows of the list are left, and the cursor is still on screen.
    expect(out.cursorLine).toBe(19);
    expect(lineAt(out, 19)).toContain(OUTLOOK.name);
    // The next key takes the note away.
    expect(body(frame(act(s, key('up')))).slice(19)).not.toContain('    Supported from M6.');
  });
});

// --- A6: host and server --------------------------------------------------------------------

describe('the host of a known provider (A6)', () => {
  it('80x24: the provider, the field, its hint below', () => {
    const out = frame(discovered(NEEDS_HOST));
    expect(trimmed(out)).toEqual([
      TITLE,
      '    Provider:  WEDOS',
      '    IMAP host: _',
      '    Each WEDOS webhosting has its own IMAP server, e.g. wes1-imap.wedos.net.',
      '    Find it in the WEDOS customer administration under your hosting service,',
      "    table 'Service addresses'.",
      ...blank(16),
      '',
      'Enter next  Esc back  Ctrl+C quit',
    ]);
    expect(out.cursorLine).toBe(2);
  });

  it('what is typed is shown after the label', () => {
    const out = frame(act(discovered(NEEDS_HOST), ...chars('wes1-imap.wedos.net')));
    expect(lineAt(out, 2)).toBe('    IMAP host: wes1-imap.wedos.net_');
  });

  it('a message goes on the status line, or below the hint when it does not fit', () => {
    const empty = frame(act(discovered(NEEDS_HOST), key('enter')));
    expect(status(empty)).toBe('IMAP host is empty');
    const port = act(discovered(NEEDS_HOST, SMALLEST), ...chars('a.eu:993'), key('enter'));
    const out = frame(port);
    expect(status(out)).toBe('');
    // Five lines: the field is there, and what is below it ends in "...".
    expect(body(out)).toEqual([
      '    IMAP host: a.eu:993_',
      '    Each WEDOS webhosting has its own',
      '    IMAP server, e.g.',
      '    wes1-imap.wedos.net. Find it in the',
      '    WEDOS customer administration und...',
    ]);
    expect(out.cursorLine).toBe(1);
  });

  it('40x8 without a message: the provider line gives way to the field and its hint', () => {
    const out = frame(discovered(NEEDS_HOST, SMALLEST));
    expect(body(out)[0]).toBe('    IMAP host: _');
    expect(out.cursorLine).toBe(1);
    expect(body(out)[4]?.endsWith('...')).toBe(true);
  });
});

describe('the server typed by hand (A6)', () => {
  it('80x24: both fields, the mark and the cursor on the host', () => {
    const out = frame(server());
    expect(trimmed(out)).toEqual([
      TITLE,
      '    IMAP host: _',
      `    Username:  ${ADDRESS}`,
      ...blank(19),
      '',
      'Enter next  Tab switch field  Esc back  Ctrl+C quit',
    ]);
    expect(out.cursorLine).toBe(1);
  });

  it('on the username: the mark and the cursor are there', () => {
    const out = frame(act(server(), ...chars('imap.example-test-domain.eu'), key('tab')));
    expect(page(out)).toEqual([
      '    IMAP host: imap.example-test-domain.eu',
      `    Username:  ${ADDRESS}_`,
    ]);
    expect(out.cursorLine).toBe(2);
  });

  it('a bad host: its message, the cursor back on the host', () => {
    const message =
      'IMAP host is not a valid host name (IP addresses and localhost are not accepted)';
    // 80 characters: at 80 columns it still fits the status line.
    const out = frame(act(server(), ...chars('not a host'), key('enter'), key('enter')));
    expect(status(out)).toBe(message);
    expect(page(out)).toEqual(['    IMAP host: not a host_', `    Username:  ${ADDRESS}`]);
    expect(out.cursorLine).toBe(1);
    // One column less: wrapped below the fields.
    const narrow = frame(
      act(server({ rows: 24, cols: 79 }), ...chars('not a host'), key('enter'), key('enter')),
    );
    expect(status(narrow)).toBe('');
    expect(page(narrow)).toEqual([
      '    IMAP host: not a host_',
      `    Username:  ${ADDRESS}`,
      '    IMAP host is not a valid host name (IP addresses and localhost are not',
      '    accepted)',
    ]);
    expect(narrow.cursorLine).toBe(1);
  });

  it('40 columns: the help keeps Enter, Esc and Ctrl+C', () => {
    expect(help(frame(server(SMALLEST)))).toBe('Enter next  Esc back  Ctrl+C quit');
  });
});

// --- A7 / A8 / A9: the check, the password, the login ---------------------------------------

describe('checking the saved mailboxes (A7)', () => {
  it('what was chosen, and the status', () => {
    const out = frame(checkingSaved());
    expect(trimmed(out)).toEqual([
      TITLE,
      ...CHOSEN_80,
      ...blank(17),
      'Checking your saved mailboxes...',
      'Esc back  q quit',
    ]);
    expect(out.cursorLine).toBeNull();
  });
});

describe('the password step (A8)', () => {
  it('80x24: provider, server, username, hint, a blank line, the password line', () => {
    const out = frame(atPassword());
    expect(trimmed(out)).toEqual([
      TITLE,
      ...CHOSEN_80,
      '',
      PASSWORD_LINE,
      ...blank(15),
      '',
      'Enter add mailbox  Esc back  Ctrl+C quit',
    ]);
    expect(out.cursorLine).toBe(6);
  });

  it('a server typed by hand: no provider, no hint', () => {
    const s = act(server(), ...chars('imap.example-test-domain.eu'), key('enter'), key('enter'));
    const out = frame(act(s, { type: 'saved-checked', generation: s.generation }));
    expect(page(out)).toEqual([
      '    Server:    imap.example-test-domain.eu:993 (TLS)',
      `    Username:  ${ADDRESS}`,
      '',
      PASSWORD_LINE,
    ]);
    expect(out.cursorLine).toBe(4);
  });

  it('Enter on an empty field: "Type the password." on the status line', () => {
    const out = frame(act(atPassword(), key('enter')));
    expect(status(out)).toBe('Type the password.');
    expect(page(out)).toEqual([...CHOSEN_80, '', PASSWORD_LINE]);
  });

  it('40x8: the lines above the password give way, top first; the password line stays', () => {
    const out = frame(atPassword(SMALLEST));
    expect(body(out)).toEqual([
      '               u',
      '    Hint:      Log in with your full',
      '               address.',
      '',
      '    Password:  (nothing is shown whil...',
    ]);
    expect(out.cursorLine).toBe(5);
    expect(help(out)).toBe('Enter add mailbox  Esc back  Ctrl+C quit');
  });
});

describe('the login check (A8, A9)', () => {
  it('"Checking the login...", no cursor, only Ctrl+C in the help', () => {
    const out = frame(checking());
    expect(trimmed(out)).toEqual([
      TITLE,
      ...CHOSEN_80,
      '',
      PASSWORD_LINE,
      ...blank(15),
      'Checking the login...',
      'Ctrl+C quit',
    ]);
    expect(out.cursorLine).toBeNull();
  });

  it('while the login guard makes it wait: its notice instead, until the wait is over', () => {
    const s = checking();
    const waiting = act(s, { type: 'challenge', generation: s.generation });
    expect(status(frame(waiting))).toBe(CHALLENGE);
    const over = act(waiting, { type: 'challenge-done', generation: s.generation });
    expect(status(frame(over))).toBe('Checking the login...');
    expect(
      status(frame(act(checking(SMALLEST), { type: 'challenge', generation: s.generation }))),
    ).toBe('Several wrong passwords - waiting 5 s...');
  });

  it('rejected: the field again and the text below it, wrapped', () => {
    const out = frame(rejected());
    expect(status(out)).toBe('');
    expect(page(out)).toEqual([
      ...CHOSEN_80,
      '',
      PASSWORD_LINE,
      "    Couldn't sign in. Check the e-mail address, the password and the IMAP",
      '    server, then try again with care.',
    ]);
    expect(out.cursorLine).toBe(6);
    expect(help(out)).toBe('Enter add mailbox  Esc back  Ctrl+C quit');
  });

  it('200 columns: that text fits the status line and is shown there', () => {
    const out = frame(rejected(WIDE));
    expect(status(out)).toBe(REJECTED);
    expect(page(out)).toEqual([...CHOSEN_80, '', PASSWORD_LINE]);
  });

  it('40x8: the password line first, then as much of the text as fits, ending in "..."', () => {
    const out = frame(rejected(SMALLEST));
    // The text has three lines here: one line above the field is left, the blank one.
    expect(body(out)).toEqual([
      '',
      '    Password:  (nothing is shown whil...',
      "    Couldn't sign in. Check the e-mail",
      '    address, the password and the IMAP',
      '    server, then try again with care.',
    ]);
    expect(out.cursorLine).toBe(2);
    const long = frame(rejected(SMALLEST, `${REJECTED} ${REJECTED}`));
    expect(body(long)[0]).toBe('    Password:  (nothing is shown whil...');
    expect(body(long)[4]?.endsWith('...')).toBe(true);
  });

  it('a text from the CLI is drawn in ASCII', () => {
    const out = frame(rejected(SCREEN, `No ${cp(0x2014)} it ${cp(0x2019)}can${cp(0x2019)}t.`));
    expect(status(out)).toBe("No - it 'can't.");
  });

  it('failed for good: its text, wrapped; Esc, q and the scroll keys in the help', () => {
    const text =
      'This mailbox is already saved (id 3f2a91c0). To change its password run `mm account update-password 3f2a91c0`.';
    const out = frame(failed(text));
    expect(trimmed(out)).toEqual([
      TITLE,
      '    This mailbox is already saved (id 3f2a91c0). To change its password run `mm',
      '    account update-password 3f2a91c0`.',
      ...blank(19),
      '',
      'Up/Down scroll  Esc back  q quit',
    ]);
    expect(out.cursorLine).toBeNull();
  });

  it('a failure text with line breaks keeps them', () => {
    expect(page(frame(failed('One.\nTwo.')))).toEqual(['    One.', '    Two.']);
  });

  it('no key: only the reason, where the address field would be', () => {
    const problem = 'MM_MASTER_KEY is not set - add it to .env.local (see `mm doctor`).';
    const out = frame(act(atHome(SCREEN, problem), key('enter')));
    expect(trimmed(out)).toEqual([
      TITLE,
      `    ${problem}`,
      ...blank(20),
      '',
      'Up/Down scroll  Esc back  q quit',
    ]);
  });
});

// --- A8: the password is never drawn --------------------------------------------------------

describe('the password is never drawn (A8)', () => {
  function expectNoCanary(out: Rendered): void {
    const text = out.lines.join('\n');
    for (let i = 0; i + 3 <= CANARY.length; i++) expect(text).not.toContain(CANARY.slice(i, i + 3));
  }

  it.each(SCREENS)('$rows x $cols: no frame changes while it is typed', (screen) => {
    const empty = atPassword(screen);
    const before = renderApp(empty);
    expectNoCanary(before);
    let state = empty;
    for (const c of CANARY) {
      state = act(state, ch(c));
      const out = renderApp(state);
      expect(out).toEqual(before);
      expectNoCanary(out);
    }
    expect(renderApp(act(empty, ...repeat(ch('x'), 1024)))).toEqual(before);
    expect(renderApp(act(empty, ...chars(`${cp(0x65e5, 0x672c)}${cp(0x1f600)}`)))).toEqual(before);
    expect(renderApp(act(state, key('backspace')))).toEqual(before);
    expect(renderApp(act(state, key('clear')))).toEqual(before);
  });

  it.each(SCREENS)('$rows x $cols: nor with a note on screen', (screen) => {
    for (const noted of [act(atPassword(screen), key('enter')), rejected(screen)]) {
      const before = renderApp(noted);
      let state = noted;
      for (const c of CANARY) {
        state = act(state, ch(c));
        expect(renderApp(state)).toEqual(before);
      }
      expect(renderApp(act(state, ...repeat(key('backspace'), 3)))).toEqual(before);
      expect(renderApp(act(state, key('clear')))).toEqual(before);
    }
  });

  it('nor is it in any frame after it was sent: checking, waiting, rejected, failed, Home', () => {
    for (const screen of SCREENS) {
      const sent = checking(screen);
      const states = [
        sent,
        act(sent, { type: 'challenge', generation: sent.generation }),
        act(sent, { type: 'add-rejected', generation: sent.generation, text: REJECTED }),
        act(sent, { type: 'add-failed', generation: sent.generation, text: 'No.' }),
        added(screen),
        added(screen, [MAILBOX]),
        act(sent, { type: 'resize', screen: { rows: 4, cols: 30 } }),
      ];
      for (const state of states) expectNoCanary(renderApp(state));
    }
  });

  it('nor after Esc from the field', () => {
    const typed = act(atPassword(), ...chars(CANARY));
    let s = typed;
    while (s.view.kind === 'add') {
      s = act(s, key('escape'));
      expectNoCanary(renderApp(s));
    }
  });

  it('the password line is the same in every state that shows it', () => {
    const states = [
      atPassword(),
      act(atPassword(), ...chars(CANARY)),
      checking(),
      rejected(WIDE),
      act(atPassword(), key('enter')),
    ];
    for (const state of states) {
      expect(trimmed(renderApp(state))).toContain(PASSWORD_LINE);
    }
  });
});

// --- A10: Home afterwards -------------------------------------------------------------------

describe('Home after a mailbox was added (A10)', () => {
  const NEW: MailboxRow = {
    id: NEW_ID,
    email: ADDRESS,
    provider: 'websupport',
    lastCheckedAt: null,
  };

  it('while the list loads again: the loading line, and "Added <address>."', () => {
    const out = frame(added());
    expect(lineAt(out, 0)).toBe('Mail Manager - anna@example-test-domain.eu');
    expect(lineAt(out, 1)).toBe('    Loading your mailboxes...');
    expect(status(out)).toBe(`Added ${ADDRESS}.`);
  });

  it('the list is there: the cursor on the new mailbox, the status still says it', () => {
    const out = frame(added(SCREEN, [MAILBOX, NEW]));
    expect(lineAt(out, 0)).toContain('2 mailboxes');
    expect(out.cursorLine).toBe(2);
    expect(lineAt(out, 2)).toContain(ADDRESS);
    expect(status(out)).toBe(`Added ${ADDRESS}.`);
  });

  it('the next key takes it away', () => {
    const listed = added(SCREEN, [MAILBOX, NEW]);
    expect(status(frame(act(listed, key('up'))))).toBe('');
    expect(status(frame(act(listed, ch('x'))))).toBe('');
  });

  it('a list that fails to load says so first', () => {
    const s = added();
    const out = frame(act(s, { type: 'mailboxes-failed', generation: s.generation }));
    expect(status(out)).toBe(
      "Couldn't load your mailboxes - check your internet connection (r = try again).",
    );
  });

  it('a long address is cut at the end; a hostile one is cleaned', () => {
    const long = added(SMALLEST, undefined, `${'a'.repeat(40)}@example-test-domain.eu`);
    expect(status(frame(long))).toBe(`Added ${'a'.repeat(31)}...`);
    const hostile = added(
      SCREEN,
      undefined,
      `e${cp(0x1b)}[31mvil${cp(0x202e)}@example-test-domain.eu`,
    );
    expect(status(frame(hostile))).toBe('Added e[31mvil@example-test-domain.eu.');
  });
});

// --- hostile text ---------------------------------------------------------------------------

describe('whatever the lookup, a preset or an error says, the frame is exact and plain ASCII', () => {
  const NASTY = `e${cp(0x1b)}[31mvil ${cp(0x202e)}txt ${cp(0x4e2d, 0x6587)} ${cp(0x1f4e7)} z${cp(0x200b)}w ${cp(0x2014)} t${cp(9)}b n${cp(0)}l`;
  const CLEAN = 'e[31mvil txt ?? ? zw - tb nl';
  const provider: ProviderInfo = {
    id: 'x',
    name: `Name ${NASTY}`,
    verified: false,
    auth: ['password'],
    hint: `Hint ${NASTY}`,
    hostHint: `Host hint ${NASTY}`,
    helpUrl: `https://help.example-test-domain.eu/${NASTY}`,
  };
  const results: DiscoveryResult[] = [
    {
      ...base,
      status: 'found',
      source: 'srv',
      via: `via ${NASTY}`,
      provider,
      imap: { host: `host-${NASTY}`, port: 993, username: `user ${NASTY}` },
      altHosts: [],
      offDomain: true,
      notices: [`Notice ${NASTY}`],
      domainProblem: 'dns-unreachable',
    },
    {
      ...base,
      status: 'blocked',
      source: 'preset-mx',
      via: `via ${NASTY}`,
      provider,
      reason: `Reason ${NASTY}`,
      notices: [`Notice ${NASTY}`],
    },
    {
      ...base,
      email: { ...EMAIL, displayDomain: `dom ${NASTY}` },
      status: 'manual',
      domainProblem: 'not-exist',
      tried: [{ source: 'srv', outcome: 'error', detail: `detail ${NASTY}` }],
      notices: [`Notice ${NASTY}`],
    },
    { ...base, status: 'needs-host', source: 'preset-mx', provider },
  ];

  it.each(SCREENS)('$rows x $cols: every result of the lookup', (screen) => {
    for (const result of results) {
      const s = discovered(result, screen);
      frame(s);
      const text = addLines(view(s), screen.cols).join(' ');
      if (screen.cols === 200 && result.status !== 'needs-host') expect(text).toContain(CLEAN);
      for (const line of addLines(view(s), screen.cols)) {
        expect(line).toMatch(ASCII);
        expect(line.length).toBeLessThanOrEqual(screen.cols);
      }
    }
  });

  it.each(SCREENS)('$rows x $cols: the chosen server, the note and the failure', (screen) => {
    const [found] = results;
    if (found === undefined) throw new Error('no result');
    const password = atPassword(screen, found);
    frame(password);
    const sent = act(password, ch('x'), key('enter'));
    frame(sent);
    frame(act(sent, { type: 'add-rejected', generation: sent.generation, text: `No ${NASTY}` }));
    frame(act(sent, { type: 'add-failed', generation: sent.generation, text: `Failed ${NASTY}` }));
    if (screen.cols === 200) {
      const lines = trimmed(frame(password));
      expect(lines).toContain(`    Provider:  Name ${CLEAN}`);
      expect(lines).toContain(`    Server:    host-${CLEAN}:993 (TLS)`);
      expect(lines).toContain(`    Username:  user ${CLEAN}`);
      expect(lines).toContain(`    Hint:      Hint ${CLEAN}`);
      expect(
        status(
          frame(
            act(sent, { type: 'add-rejected', generation: sent.generation, text: `No ${NASTY}` }),
          ),
        ),
      ).toBe(`No ${CLEAN}`);
    }
  });

  it('the host field of a hostile provider: its name and hint are cleaned', () => {
    const out = frame(discovered(results[3] ?? FOUND, WIDE));
    expect(page(out)).toEqual([
      `    Provider:  Name ${CLEAN}`,
      '    IMAP host: _',
      `    Host hint ${CLEAN}`,
    ]);
  });

  it('seeded views at seeded sizes: always a whole frame, never a control character', () => {
    let seed = 20261008;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pieces = [
      'a',
      'Zq',
      '7',
      '-',
      '.',
      ' ',
      '@',
      cp(0x1b),
      cp(0x202e),
      cp(0x4e2d),
      cp(0x1f4e7),
      cp(0),
    ];
    const text = (max: number): string =>
      Array.from({ length: next(max) }, () => pieces[next(pieces.length)] ?? '').join('');
    const steps: AddStep[] = [
      'address',
      'looking',
      'found',
      'blocked',
      'nothing',
      'providers',
      'host',
      'server',
      'checking-saved',
      'password',
      'checking',
      'failed',
    ];
    const sources = ['preset-domain', 'preset-mx', 'ispdb', 'autoconfig', 'srv'] as const;
    for (let i = 0; i < 400; i++) {
      const stepName = steps[next(steps.length)] ?? 'address';
      const result = results[next(results.length)] ?? null;
      const over: Partial<AddView> = {
        step: stepName,
        address: text(60),
        checking: next(2) === 0 ? null : (sources[next(5)] ?? null),
        result: next(4) === 0 ? null : result,
        cursor: next(40) - 5,
        scroll: next(60) - 5,
        host: text(80),
        username: text(80),
        field: next(2) === 0 ? 'host' : 'username',
        hostProvider: next(3) === 0 ? null : provider,
        chosen:
          next(3) === 0
            ? null
            : {
                settings: { host: text(90), port: 993, username: text(90) },
                provider: 'custom',
                name: next(2) === 0 ? null : text(70),
                hint: next(2) === 0 ? null : text(300),
              },
        password: text(40),
        note: next(2) === 0 ? null : text(400),
        waiting: next(2) === 0,
        failure: next(2) === 0 ? null : text(900),
      };
      const screen: Screen = { rows: 8 + next(40), cols: 40 + next(170) };
      const out = renderApp(stateOf(over, screen));
      expect(out.lines).toHaveLength(screen.rows);
      for (const line of out.lines) {
        expect(displayWidth(line), `${stepName} ${String(screen.cols)}`).toBe(screen.cols);
        expect(line).not.toMatch(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u);
      }
      const cursor = out.cursorLine;
      if (cursor !== null) {
        expect(cursor).toBeGreaterThanOrEqual(1);
        expect(cursor).toBeLessThanOrEqual(screen.rows - 3);
      }
    }
  }, 30_000);
});

// --- the pieces -----------------------------------------------------------------------------

describe('the pieces of add-render.ts', () => {
  it('addHeader: the title in exactly the width', () => {
    expect(addHeader(80)).toBe(TITLE.padEnd(80));
    expect(addHeader(40)).toBe(TITLE.padEnd(40));
    expect(addHeader(20)).toBe('Mail Manager - Ad...');
  });

  it('addBody: `height` lines of `cols` columns in every step', () => {
    for (const [, state] of everyStep(SCREEN)) {
      for (const [height, cols] of [
        [0, 40],
        [1, 40],
        [2, 40],
        [5, 40],
        [21, 80],
        [47, 200],
      ] as const) {
        const out = addBody(view(state), height, cols);
        expect(out.lines).toHaveLength(height);
        for (const line of out.lines) expect(line).toHaveLength(cols);
      }
    }
  });

  it('addBody: a cursor line only where something is chosen or typed', () => {
    const cursors = Object.fromEntries(
      everyStep(SCREEN).map(([name, state]) => [name, addBody(view(state), 21, 80).cursorLine]),
    );
    expect(cursors).toEqual({
      address: 1,
      looking: null,
      found: null,
      blocked: null,
      nothing: null,
      providers: 1 + rowOf('outlook') - (rowOf('outlook') - 20),
      host: 2,
      server: 2,
      'checking-saved': null,
      password: 6,
      checking: null,
      failed: null,
    });
  });

  it('addBusy: only the three steps that wait', () => {
    const busy = Object.fromEntries(
      everyStep(SCREEN).map(([name, state]) => [name, addBusy(view(state))]),
    );
    expect(busy).toEqual({
      address: null,
      looking: 'Looking up settings...',
      found: null,
      blocked: null,
      nothing: null,
      providers: null,
      host: null,
      server: null,
      'checking-saved': 'Checking your saved mailboxes...',
      password: null,
      checking: 'Checking the login...',
      failed: null,
    });
    expect(addBusy(view(stateOf({ step: 'checking', waiting: true })))).toBe(CHALLENGE);
    // A wait is only said while the login is checked.
    expect(addBusy(view(stateOf({ step: 'password', waiting: true })))).toBeNull();
  });

  it('addNote: the note when it fits the line, cleaned; otherwise nothing', () => {
    const noted = view(stateOf({ step: 'password', note: 'Type the password.' }));
    expect(addNote(noted, 80)).toBe('Type the password.');
    expect(addNote(noted, 18)).toBe('Type the password.');
    expect(addNote(noted, 17)).toBeNull();
    expect(addNote(view(stateOf({ step: 'password' })), 80)).toBeNull();
    const dashed = view(stateOf({ step: 'password', note: `a ${cp(0x2014)} b${cp(0x1b)}` }));
    expect(addNote(dashed, 80)).toBe('a - b');
  });

  it('addHelp: the keys of each step, Esc and q or Ctrl+C the last to go', () => {
    const texts = (state: AppState): string => helpLine(addHelp(view(state)), 200).trimEnd();
    const helps = Object.fromEntries(
      everyStep(SCREEN).map(([name, state]) => [name, texts(state)]),
    );
    expect(helps).toEqual({
      address: 'Enter next  Esc back  Ctrl+C quit',
      looking: 'Esc back  q quit',
      found: 'y use this server  c provider list  m enter server  Up/Down scroll  Esc back  q quit',
      blocked: 'Up/Down scroll  Esc back  q quit',
      nothing: 'c provider list  m enter server  Up/Down scroll  Esc back  q quit',
      providers: 'Up/Down move  Enter choose  m enter server  Esc back  q quit',
      host: 'Enter next  Esc back  Ctrl+C quit',
      server: 'Enter next  Tab switch field  Esc back  Ctrl+C quit',
      'checking-saved': 'Esc back  q quit',
      password: 'Enter add mailbox  Esc back  Ctrl+C quit',
      checking: 'Ctrl+C quit',
      failed: 'Up/Down scroll  Esc back  q quit',
    });
    for (const [, state] of everyStep(SMALLEST)) {
      const line = helpLine(addHelp(view(state)), 40).trimEnd();
      expect(line).toMatch(/(Esc back|Ctrl\+C quit)/);
      const ranks = addHelp(view(state)).map((item) => item.rank);
      expect(new Set(ranks).size).toBe(ranks.length);
    }
  });
});
