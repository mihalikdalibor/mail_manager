import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  CHALLENGE_NOTICE,
  RECONNECT_FAILED_TEXT,
  createBrowser,
} from '../../src/cli/browser/controller.js';
import type {
  BrowseResult,
  BrowserDeps,
  BrowserSession,
} from '../../src/cli/browser/controller.js';
import type { Rendered } from '../../src/cli/browser/render.js';
import type { Keypress, Screen } from '../../src/cli/browser/state.js';
import type { Terminal } from '../../src/cli/browser/terminal.js';
import { CHALLENGE_DELAY_MS } from '../../src/cli/login-guard-text.js';
import { basketTotals } from '../../src/core/mailbox/basket.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { MailboxError } from '../../src/core/mailbox/errors.js';
import type { FolderInfo } from '../../src/core/mailbox/folders.js';
import type { FolderSnapshot, MessageRow, PageResult } from '../../src/core/mailbox/messages.js';
import type { loadPage } from '../../src/core/mailbox/messages.js';

// M2b-2 controller (spec): keys -> reducer -> effects, driven with a fake Terminal (records the
// frames, exposes the key/resize handlers), a fake `load`, fake sessions with a `logout` spy and a
// fake `reconnect`. No IMAP, no real terminal, no real clock for the challenge wait.

// --- fixtures -------------------------------------------------------------------------------

function folder(path: string, over: Partial<FolderInfo> = {}): FolderInfo {
  const parts = path.split('/');
  return {
    path,
    name: parts[parts.length - 1] ?? path,
    parentPath: parts.length > 1 ? parts.slice(0, -1).join('/') : null,
    depth: parts.length - 1,
    delimiter: '/',
    role: null,
    roleSource: null,
    selectable: true,
    subscribed: true,
    messages: 0,
    unseen: 0,
    bytes: 0,
    sizeSource: 'server',
    overlapping: false,
    ...over,
  };
}

// Root rows: INBOX (cursor starts here), Sent, Projects.
const FOLDERS: FolderInfo[] = [
  folder('INBOX', {
    messages: 3,
    bytes: 5_000_000,
    sizeSource: 'server',
    role: 'inbox',
    roleSource: 'path',
  }),
  folder('Sent', { messages: 0 }),
  folder('Projects', { messages: 0 }),
  folder('Projects/Alpha', { messages: 0 }),
];

// Wide enough for the whole challenge notice (64 characters) and the status help.
const SCREEN: Screen = { rows: 24, cols: 100 };
// Below 37 columns the too-small text is the short "Too small - need 40x8".
const SMALL: Screen = { rows: 5, cols: 30 };
const SNAP: FolderSnapshot = { path: 'INBOX', uidValidity: '7', exists: 3 };

function mailRow(seq: number): MessageRow {
  return {
    seq,
    uid: 1000 + seq,
    received: new Date(Date.UTC(2026, 0, 1)),
    from: `Sender ${String(seq)}`,
    subject: `Subject ${String(seq)}`,
    bytes: seq,
    attachment: false,
  };
}

function inboxPage(): PageResult {
  return { kind: 'page', snapshot: SNAP, page: 0, rows: [3, 2, 1].map(mailRow) };
}

const k = (name: string, extra: Keypress = {}): Keypress => ({ name, sequence: name, ...extra });
const ENTER = k('return', { sequence: '\r' });
const DOWN = k('down', { sequence: '\x1b[B' });
const SPACE = k('space', { sequence: ' ' });
const CTRL_C = k('c', { ctrl: true, sequence: '\x03' });
// How readline delivers a lone Esc.
const ESC = k('escape', { meta: true, sequence: '\x1b' });

// --- fakes ----------------------------------------------------------------------------------

interface FakeTerminal extends Terminal {
  readonly frames: Rendered[];
  /** onKey / onResize / draw / clear, in order. */
  readonly events: string[];
  screen: Screen;
  failDraw: Error | null;
  /** The spies behind `restore` / `close`. */
  readonly restoreSpy: ReturnType<typeof vi.fn<() => void>>;
  readonly closeSpy: ReturnType<typeof vi.fn<() => void>>;
  key(key: Keypress): void;
  resize(): void;
  registered(): boolean;
}

function fakeTerminal(screen: Screen = SCREEN): FakeTerminal {
  let keyHandler: ((key: Keypress) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  const restore = vi.fn<() => void>();
  const close = vi.fn<() => void>();
  const t: FakeTerminal = {
    frames: [],
    events: [],
    screen,
    failDraw: null,
    size: () => t.screen,
    draw: (frame) => {
      if (t.failDraw !== null) throw t.failDraw;
      t.events.push('draw');
      t.frames.push(frame);
    },
    clear: () => {
      t.events.push('clear');
    },
    onKey: (fn) => {
      t.events.push('onKey');
      keyHandler = fn;
    },
    onResize: (fn) => {
      t.events.push('onResize');
      resizeHandler = fn;
    },
    restore,
    close,
    restoreSpy: restore,
    closeSpy: close,
    key: (key) => {
      if (keyHandler === null) throw new Error('no key handler registered');
      keyHandler(key);
    },
    resize: () => {
      if (resizeHandler === null) throw new Error('no resize handler registered');
      resizeHandler();
    },
    registered: () => keyHandler !== null && resizeHandler !== null,
  };
  return t;
}

function text(frame: Rendered | undefined): string {
  return (frame?.lines ?? []).join('\n');
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending microtask and the I/O queue run (setImmediate stays real). */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function stillRunning(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false), settle().then(() => true)]);
}

type Session = BrowserSession & { name: string };

interface Harness {
  t: FakeTerminal;
  deps: BrowserDeps;
  /** What happened, in order: `logout:<name>`, `reconnect`. */
  order: string[];
  load: ReturnType<typeof vi.fn<typeof loadPage>>;
  reconnect: ReturnType<typeof vi.fn<BrowserDeps['reconnect']>>;
  onUnexpected: ReturnType<typeof vi.fn<(err: unknown) => void>>;
  old: Session;
  fresh: Session;
  /** The spies behind `old.logout` / `fresh.logout`. */
  oldLogout: ReturnType<typeof vi.fn<() => Promise<void>>>;
  freshLogout: ReturnType<typeof vi.fn<() => Promise<void>>>;
  done: Promise<BrowseResult>;
}

function makeHarness(over: Partial<BrowserDeps> = {}, screen: Screen = SCREEN): Harness {
  const order: string[] = [];
  const session = (
    name: string,
  ): { session: Session; logout: ReturnType<typeof vi.fn<() => Promise<void>>> } => {
    const logout = vi.fn<() => Promise<void>>(() => {
      order.push(`logout:${name}`);
      return Promise.resolve();
    });
    return {
      session: { name, client: {}, closed: false, logout } as unknown as Session,
      logout,
    };
  };
  const { session: old, logout: oldLogout } = session('old');
  const { session: fresh, logout: freshLogout } = session('fresh');
  const t = fakeTerminal(screen);
  const load = vi.fn<typeof loadPage>(() => Promise.resolve(inboxPage()));
  const reconnect = vi.fn<BrowserDeps['reconnect']>(() => {
    order.push('reconnect');
    return Promise.resolve(fresh);
  });
  const onUnexpected = vi.fn<(err: unknown) => void>();
  const deps: BrowserDeps = {
    terminal: t,
    title: 'Test mailbox',
    folders: FOLDERS,
    sizes: true,
    sessions: { current: old },
    reconnect,
    onUnexpected,
    load,
    formatDate: () => '2026-01-01',
    ...over,
  };
  const browser = createBrowser(deps);
  return {
    t,
    deps,
    order,
    load,
    reconnect,
    onUnexpected,
    old,
    fresh,
    oldLogout,
    freshLogout,
    done: browser.run(),
  };
}

async function press(h: Harness, ...keys: Keypress[]): Promise<void> {
  for (const key of keys) {
    h.t.key(key);
    await settle();
  }
}

const last = (h: Harness): string => text(h.t.frames.at(-1));

/** INBOX opened and its three mails shown. */
async function openInbox(h: Harness): Promise<void> {
  await press(h, ENTER);
  expect(last(h)).toContain('Subject 3');
}

/** The first load fails with a lost connection: the "reconnect?" question is up. */
async function toReconnectAsk(h: Harness): Promise<void> {
  h.load.mockRejectedValueOnce(new MailboxError('connection-lost'));
  await press(h, ENTER);
  expect(last(h)).toContain('Connection closed - reconnect? (y/N)');
}

afterEach(() => {
  vi.useRealTimers();
});

// --- tests ----------------------------------------------------------------------------------

describe('start', () => {
  it('createBrowser registers nothing and draws nothing; run() does both, handlers first', () => {
    const t = fakeTerminal();
    const deps: BrowserDeps = {
      terminal: t,
      title: 'Test mailbox',
      folders: FOLDERS,
      sizes: true,
      sessions: { current: {} as BrowserSession },
      reconnect: () => Promise.reject(new Error('unused')),
    };
    const browser = createBrowser(deps);
    expect(t.events).toEqual([]);
    expect(t.registered()).toBe(false);
    const done = browser.run();
    // Synchronously: both handlers registered before the first frame.
    expect(t.registered()).toBe(true);
    expect(t.events.indexOf('onKey')).toBeLessThan(t.events.indexOf('draw'));
    expect(t.events.indexOf('onResize')).toBeLessThan(t.events.indexOf('draw'));
    expect(t.frames).toHaveLength(1);
    t.key(CTRL_C);
    return expect(done).resolves.toMatchObject({ end: 'interrupt' });
  });

  it('the first frame shows the title and the root folders at the terminal size', async () => {
    const h = makeHarness();
    expect(h.t.frames).toHaveLength(1);
    const first = text(h.t.frames[0]);
    expect(first).toContain('Test mailbox');
    expect(first).toContain('INBOX');
    expect(first).toContain('Projects');
    expect(h.t.frames[0]?.lines).toHaveLength(SCREEN.rows);
    await press(h, CTRL_C);
    await h.done;
  });

  it('sizes: false leaves out the folder size cell; sizes: true shows it', async () => {
    const withSizes = makeHarness();
    const inboxLine = (h: Harness): string =>
      h.t.frames[0]?.lines.find((l) => l.includes('INBOX/')) ?? '';
    expect(inboxLine(withSizes)).toMatch(/MB/);
    await press(withSizes, CTRL_C);
    await withSizes.done;

    const without = makeHarness({ sizes: false });
    expect(inboxLine(without)).toContain('INBOX/');
    expect(inboxLine(without)).not.toMatch(/MB/);
    expect(inboxLine(without)).toMatch(/\b3\b/);
    await press(without, CTRL_C);
    await without.done;
  });
});

describe('loading', () => {
  it('Enter on a folder: load(sessions.current, path, null, 0); the result is drawn', async () => {
    const h = makeHarness();
    await press(h, ENTER);
    expect(h.load).toHaveBeenCalledTimes(1);
    const [session, path, expected, page] = h.load.mock.calls[0] ?? [];
    expect(session).toBe(h.old);
    expect([path, expected, page]).toEqual(['INBOX', null, 0]);
    const frame = last(h);
    expect(frame).toContain('Subject 3');
    expect(frame).toContain('Sender 2');
    await press(h, CTRL_C);
    await h.done;
  });

  it('a load result from a session that is no longer current is dropped', async () => {
    const pending = deferred<PageResult>();
    const h = makeHarness();
    h.load.mockReturnValueOnce(pending.promise);
    await press(h, ENTER);
    expect(last(h)).not.toContain('Subject 3');
    // The session was replaced meanwhile (what a reconnect does).
    h.deps.sessions.current = h.fresh;
    pending.resolve(inboxPage());
    await settle();
    expect(last(h)).not.toContain('Subject 3');
    await press(h, CTRL_C);
    await h.done;
  });

  it('a load result after the browser ended is ignored: no draw, no error', async () => {
    const pending = deferred<PageResult>();
    const h = makeHarness();
    h.load.mockReturnValueOnce(pending.promise);
    await press(h, ENTER);
    await press(h, CTRL_C);
    await h.done;
    const frames = h.t.frames.length;
    pending.resolve(inboxPage());
    await settle();
    expect(h.t.frames).toHaveLength(frames);
  });

  it('a load that fails after the browser ended is ignored too', async () => {
    const pending = deferred<PageResult>();
    const h = makeHarness();
    h.load.mockReturnValueOnce(pending.promise);
    await press(h, ENTER);
    await press(h, CTRL_C);
    await h.done;
    const frames = h.t.frames.length;
    pending.reject(new MailboxError('connection-lost'));
    await settle();
    expect(h.t.frames).toHaveLength(frames);
  });

  it('a load rejecting with something that is not a MailboxError rejects run()', async () => {
    const h = makeHarness();
    h.load.mockRejectedValueOnce(new Error('boom'));
    h.t.key(ENTER);
    await expect(h.done).rejects.toThrow('boom');
  });

  it('a MailboxError of another kind is shown, the browser keeps running', async () => {
    const h = makeHarness();
    h.load.mockRejectedValueOnce(new MailboxError('folder-unavailable'));
    await press(h, ENTER);
    expect(await stillRunning(h.done)).toBe(true);
    expect(last(h)).toContain("Couldn't open this folder");
    await press(h, CTRL_C);
    await h.done;
  });

  it('a throwing draw rejects run()', async () => {
    const h = makeHarness();
    h.t.failDraw = new Error('terminal gone');
    h.t.key(DOWN);
    await expect(h.done).rejects.toThrow('terminal gone');
  });

  it('resize: clear, then a frame at the new size', async () => {
    const h = makeHarness();
    h.t.screen = { rows: 30, cols: 120 };
    h.t.events.length = 0;
    h.t.resize();
    await settle();
    expect(h.t.events.slice(0, 2)).toEqual(['clear', 'draw']);
    expect(h.t.frames.at(-1)?.lines).toHaveLength(30);
    await press(h, CTRL_C);
    await h.done;
  });

  it('resize to too small and back: "Too small" first, the normal screen again after', async () => {
    const h = makeHarness();
    h.t.screen = SMALL;
    h.t.resize();
    await settle();
    expect(last(h)).toContain('Too small - need 40x8');
    expect(last(h)).not.toContain('INBOX');
    h.t.screen = SCREEN;
    h.t.resize();
    await settle();
    expect(last(h)).toContain('INBOX');
    await press(h, CTRL_C);
    await h.done;
  });
});

describe('quitting', () => {
  it('q with no marks ends with "quit"', async () => {
    const h = makeHarness();
    h.t.key(k('q'));
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
  });

  it('Esc in the shape readline delivers it ({ name: "escape", meta: true }) quits', async () => {
    const h = makeHarness();
    h.t.key(ESC);
    await expect(h.done).resolves.toMatchObject({ end: 'quit' });
  });

  it('other Meta keys (Alt+q) do nothing', async () => {
    const h = makeHarness();
    await press(h, k('q', { meta: true }));
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, CTRL_C);
    await h.done;
  });

  it('q with marks asks first; any other key stays; y quits and the basket is in the result', async () => {
    const h = makeHarness();
    await openInbox(h);
    await press(h, SPACE);
    await press(h, k('q'));
    expect(last(h)).toContain('Quit and drop 1 mark? (y/N)');
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, k('n'));
    expect(last(h)).not.toContain('Quit and drop');
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, k('q'), k('y'));
    const result = await h.done;
    expect(result.end).toBe('quit');
    expect(basketTotals(result.basket)).toMatchObject({ count: 1, bytes: 3 });
  });

  it('stats in the result match the walk', async () => {
    const h = makeHarness();
    await openInbox(h);
    await press(h, k('q'));
    const result = await h.done;
    expect(result.stats).toEqual({ foldersOpened: 1, mailsLoaded: 3, reconnects: 0 });
    expect(result.reconnectError).toBeUndefined();
  });

  it('after the end every key and resize is a no-op', async () => {
    const h = makeHarness();
    await press(h, CTRL_C);
    await h.done;
    const frames = h.t.frames.length;
    const events = h.t.events.length;
    h.t.key(DOWN);
    h.t.key(ENTER);
    h.t.resize();
    await settle();
    expect(h.t.frames).toHaveLength(frames);
    expect(h.t.events).toHaveLength(events);
    expect(h.load).not.toHaveBeenCalled();
  });
});

describe('Ctrl+C ends at once in every mode', () => {
  const modes: [string, (h: Harness) => Promise<void>, Screen?][] = [
    ['browse', () => Promise.resolve()],
    [
      'confirm-quit',
      async (h) => {
        await openInbox(h);
        await press(h, SPACE, k('q'));
        expect(last(h)).toContain('Quit and drop');
      },
    ],
    ['reconnect-ask', toReconnectAsk],
    [
      'reconnecting',
      async (h) => {
        h.reconnect.mockReturnValue(new Promise<Session>(() => undefined));
        await toReconnectAsk(h);
        await press(h, k('y'));
        expect(h.reconnect).toHaveBeenCalledTimes(1);
        expect(last(h)).toContain('Reconnecting...');
      },
    ],
    [
      'too small',
      (h) => {
        expect(last(h)).toContain('Too small');
        return Promise.resolve();
      },
      SMALL,
    ],
  ];

  it.each(modes)('%s -> end "interrupt"', async (_name, setup, screen) => {
    const h = makeHarness({}, screen);
    await setup(h);
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
  });

  it('the result of an interrupt carries the stats and the basket', async () => {
    const h = makeHarness();
    await openInbox(h);
    await press(h, SPACE);
    h.t.key(CTRL_C);
    const result = await h.done;
    expect(result.end).toBe('interrupt');
    expect(result.stats.mailsLoaded).toBe(3);
    expect(basketTotals(result.basket).count).toBe(1);
  });
});

describe('connection lost and reconnect', () => {
  it('connection-lost shows the question; n goes offline and moving no longer asks', async () => {
    const h = makeHarness();
    await toReconnectAsk(h);
    await press(h, k('n'));
    expect(last(h)).toContain('Offline - showing what is loaded (r = reconnect).');
    await press(h, DOWN, k('up'));
    expect(last(h)).not.toContain('reconnect? (y/N)');
    expect(h.reconnect).not.toHaveBeenCalled();
    await press(h, CTRL_C);
    await h.done;
  });

  it('r while offline reconnects with no question', async () => {
    const h = makeHarness();
    await toReconnectAsk(h);
    await press(h, k('n'));
    await press(h, k('r'));
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.deps.sessions.current).toBe(h.fresh);
    expect(last(h)).not.toContain('reconnect? (y/N)');
    await press(h, CTRL_C);
    await h.done;
  });

  it('r at the question counts as y', async () => {
    const h = makeHarness();
    await toReconnectAsk(h);
    await press(h, k('r'));
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.deps.sessions.current).toBe(h.fresh);
    await press(h, CTRL_C);
    await h.done;
  });

  it('y: the old session is logged out first, then one reconnect; the cursor page is reloaded on the new session', async () => {
    const h = makeHarness();
    await toReconnectAsk(h);
    await press(h, k('y'));
    expect(h.order).toEqual(['logout:old', 'reconnect']);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.deps.sessions.current).toBe(h.fresh);
    expect(h.load).toHaveBeenCalledTimes(2);
    const [session, path, expected, page] = h.load.mock.calls[1] ?? [];
    expect(session).toBe(h.fresh);
    expect([path, expected, page]).toEqual(['INBOX', null, 0]);
    expect(last(h)).toContain('Subject 3');
    h.t.key(k('q'));
    const result = await h.done;
    expect(result.stats.reconnects).toBe(1);
    expect(result.reconnectError).toBeUndefined();
  });

  it('entering "reconnecting" shows Reconnecting...; a failure text from an earlier try is cleared', async () => {
    const pending = deferred<BrowserSession>();
    const h = makeHarness();
    h.reconnect.mockRejectedValueOnce(new ImapSessionError('auth-failed'));
    await toReconnectAsk(h);
    h.t.key(k('y'));
    expect(last(h)).toContain('Reconnecting...');
    await settle();
    expect(last(h)).toContain(RECONNECT_FAILED_TEXT);
    h.reconnect.mockReturnValue(pending.promise);
    h.t.key(k('r'));
    expect(last(h)).toContain('Reconnecting...');
    expect(last(h)).not.toContain(RECONNECT_FAILED_TEXT);
    await settle();
    expect(last(h)).toContain('Reconnecting...');
    h.t.key(CTRL_C);
    await h.done;
  });

  it('a failed reconnect: the failure text, offline, the error kept; user-facing -> no onUnexpected; not retried', async () => {
    const err = new ImapSessionError('auth-failed');
    const h = makeHarness();
    h.reconnect.mockRejectedValue(err);
    await toReconnectAsk(h);
    await press(h, k('y'));
    expect(last(h)).toContain(RECONNECT_FAILED_TEXT);
    await settle();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(await stillRunning(h.done)).toBe(true);
    h.t.key(CTRL_C);
    const result = await h.done;
    expect(result.reconnectError).toBe(err);
    expect(result.stats.reconnects).toBe(0);
  });

  it('a failed reconnect leaves the user offline: moving does not ask again', async () => {
    const h = makeHarness();
    h.reconnect.mockRejectedValue(new ImapSessionError('auth-failed'));
    await toReconnectAsk(h);
    await press(h, k('y'));
    await press(h, DOWN);
    expect(last(h)).not.toContain('reconnect? (y/N)');
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    await press(h, CTRL_C);
    await h.done;
  });

  it('a reconnect error that is not user-facing also goes to onUnexpected, once', async () => {
    const err = new Error('boom');
    const h = makeHarness();
    h.reconnect.mockRejectedValue(err);
    await toReconnectAsk(h);
    await press(h, k('y'));
    expect(h.onUnexpected).toHaveBeenCalledTimes(1);
    expect(h.onUnexpected).toHaveBeenCalledWith(err);
    expect(last(h)).toContain(RECONNECT_FAILED_TEXT);
    h.t.key(CTRL_C);
    expect((await h.done).reconnectError).toBe(err);
  });

  it('a later successful reconnect clears the kept error and the failure text', async () => {
    const h = makeHarness();
    h.reconnect
      .mockRejectedValueOnce(new ImapSessionError('auth-failed'))
      .mockResolvedValueOnce(h.fresh);
    await toReconnectAsk(h);
    await press(h, k('y'));
    expect(last(h)).toContain(RECONNECT_FAILED_TEXT);
    await press(h, k('r'));
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    expect(h.deps.sessions.current).toBe(h.fresh);
    expect(last(h)).not.toContain(RECONNECT_FAILED_TEXT);
    h.t.key(k('q'));
    const result = await h.done;
    expect(result.reconnectError).toBeUndefined();
    expect(result.stats.reconnects).toBe(1);
  });

  it('a failed reconnect after a failed one keeps the newest error', async () => {
    const second = new ImapSessionError('timeout');
    const h = makeHarness();
    h.reconnect
      .mockRejectedValueOnce(new ImapSessionError('auth-failed'))
      .mockRejectedValueOnce(second);
    await toReconnectAsk(h);
    await press(h, k('y'), k('r'));
    h.t.key(CTRL_C);
    expect((await h.done).reconnectError).toBe(second);
  });
});

describe('the `r` key', () => {
  it('online, in browse mode: nothing', async () => {
    const h = makeHarness();
    await openInbox(h);
    await press(h, k('r'));
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(last(h)).not.toContain('Reconnecting');
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, CTRL_C);
    await h.done;
  });

  it('while the window is too small: nothing', async () => {
    const h = makeHarness({}, SMALL);
    await press(h, k('r'));
    expect(h.reconnect).not.toHaveBeenCalled();
    await press(h, CTRL_C);
    await h.done;
  });

  it('at the quit question: cancels the question like any other key', async () => {
    const h = makeHarness();
    await openInbox(h);
    await press(h, SPACE, k('q'));
    expect(last(h)).toContain('Quit and drop');
    await press(h, k('r'));
    expect(last(h)).not.toContain('Quit and drop');
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(await stillRunning(h.done)).toBe(true);
    await press(h, CTRL_C);
    await h.done;
  });

  it('while reconnecting: ignored', async () => {
    const pending = deferred<BrowserSession>();
    const h = makeHarness();
    h.reconnect.mockReturnValue(pending.promise);
    await toReconnectAsk(h);
    await press(h, k('y'));
    await press(h, k('r'), k('r'));
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(last(h)).toContain('Reconnecting...');
    await press(h, CTRL_C);
    await h.done;
  });
});

describe('the login guard challenge during a reconnect', () => {
  function challengeHarness(over: Partial<BrowserDeps> = {}): Harness & { opened: string[] } {
    const opened: string[] = [];
    const h = makeHarness(over);
    h.reconnect.mockImplementation(async (onChallenge) => {
      h.order.push('reconnect');
      await onChallenge();
      opened.push('login');
      return h.fresh;
    });
    return Object.assign(h, { opened });
  }

  it('the notice is drawn during the wait; the login continues after 5 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(CHALLENGE_DELAY_MS).toBe(5000);
    const h = challengeHarness();
    await toReconnectAsk(h);
    await press(h, k('y'));
    expect(last(h)).toContain(CHALLENGE_NOTICE);
    expect(h.opened).toEqual([]);
    await vi.advanceTimersByTimeAsync(CHALLENGE_DELAY_MS - 1);
    expect(h.opened).toEqual([]);
    expect(h.deps.sessions.current).toBe(h.old);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(h.opened).toEqual(['login']);
    expect(h.deps.sessions.current).toBe(h.fresh);
    // The notice is gone once the reconnect worked.
    expect(last(h)).not.toContain(CHALLENGE_NOTICE);
    h.t.key(k('q'));
    await h.done;
  });

  it('challengeDelayMs shortens the wait (tests only); the notice still says 5 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = challengeHarness({ challengeDelayMs: 1000 });
    await toReconnectAsk(h);
    await press(h, k('y'));
    expect(last(h)).toContain('waiting 5 seconds');
    await vi.advanceTimersByTimeAsync(999);
    expect(h.opened).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(h.opened).toEqual(['login']);
    h.t.key(k('q'));
    await h.done;
  });

  it('Ctrl+C during the wait: onChallenge rejects, the opener is never reached, nothing unexpected, the timer is cleared', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = challengeHarness();
    let seen: unknown;
    h.reconnect.mockImplementation(async (onChallenge) => {
      h.order.push('reconnect');
      try {
        await onChallenge();
      } catch (err) {
        seen = err;
        throw err;
      }
      h.opened.push('login');
      return h.fresh;
    });
    await toReconnectAsk(h);
    await press(h, k('y'));
    expect(last(h)).toContain(CHALLENGE_NOTICE);
    h.t.key(CTRL_C);
    const result = await h.done;
    await settle();
    expect(result.end).toBe('interrupt');
    expect(seen).toBeInstanceOf(Error);
    expect(h.opened).toEqual([]);
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(result.reconnectError).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CHALLENGE_DELAY_MS * 2);
    expect(h.opened).toEqual([]);
    expect(h.deps.sessions.current).toBe(h.old);
  });
});

describe('the end during a reconnect', () => {
  it('Ctrl+C while the old session is still being logged out: reconnect is never called', async () => {
    const slowLogout = deferred<void>();
    const h = makeHarness();
    h.oldLogout.mockReturnValue(slowLogout.promise);
    await toReconnectAsk(h);
    await press(h, k('y'));
    expect(h.oldLogout).toHaveBeenCalledTimes(1);
    expect(h.reconnect).not.toHaveBeenCalled();
    h.t.key(CTRL_C);
    await expect(h.done).resolves.toMatchObject({ end: 'interrupt' });
    slowLogout.resolve();
    await settle();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.deps.sessions.current).toBe(h.old);
  });

  it('a reconnect that rejects after the end: no onUnexpected, no reconnectError', async () => {
    const pending = deferred<BrowserSession>();
    const h = makeHarness();
    h.reconnect.mockReturnValue(pending.promise);
    await toReconnectAsk(h);
    await press(h, k('y'));
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    h.t.key(CTRL_C);
    const result = await h.done;
    pending.reject(new Error('late failure'));
    await settle();
    expect(h.onUnexpected).not.toHaveBeenCalled();
    expect(result.reconnectError).toBeUndefined();
  });

  it('a reconnect that resolves after the end: that session is logged out and ignored', async () => {
    const pending = deferred<BrowserSession>();
    const h = makeHarness();
    h.reconnect.mockReturnValue(pending.promise);
    await toReconnectAsk(h);
    await press(h, k('y'));
    h.t.key(CTRL_C);
    await h.done;
    const frames = h.t.frames.length;
    pending.resolve(h.fresh);
    await settle();
    expect(h.freshLogout).toHaveBeenCalledTimes(1);
    expect(h.deps.sessions.current).toBe(h.old);
    expect(h.t.frames).toHaveLength(frames);
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  it('onChallenge called after the end rejects without drawing a notice', async () => {
    const pending = deferred<BrowserSession>();
    let onChallenge: (() => Promise<void>) | undefined;
    const h = makeHarness();
    h.reconnect.mockImplementation((fn) => {
      onChallenge = fn;
      return pending.promise;
    });
    await toReconnectAsk(h);
    await press(h, k('y'));
    h.t.key(CTRL_C);
    await h.done;
    const frames = h.t.frames.length;
    await expect(onChallenge?.()).rejects.toBeInstanceOf(Error);
    expect(h.t.frames).toHaveLength(frames);
    pending.reject(new Error('closed'));
    await settle();
    expect(h.onUnexpected).not.toHaveBeenCalled();
  });

  it('the controller never restores or closes the terminal itself', async () => {
    const h = makeHarness();
    h.t.key(k('q'));
    await h.done;
    expect(h.t.restoreSpy).not.toHaveBeenCalled();
    expect(h.t.closeSpy).not.toHaveBeenCalled();
  });
});
