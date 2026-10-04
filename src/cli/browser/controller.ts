import type { Basket } from '../../core/mailbox/basket.js';
import { MailboxError } from '../../core/mailbox/errors.js';
import type { FolderInfo } from '../../core/mailbox/folders.js';
import { loadPage, type MessageSession } from '../../core/mailbox/messages.js';
import { isUserFacing } from '../error-text.js';
import { CHALLENGE_DELAY_MS } from '../login-guard-text.js';
import { render, type RenderOptions } from './render.js';
import {
  initialState,
  keyOf,
  reduce,
  type BrowserAction,
  type BrowserEffect,
  type BrowserState,
  type BrowserStats,
  type Keypress,
} from './state.js';
import type { Terminal } from './terminal.js';

// Runs the folder browser (M2b-2): keys and resizes go through the pure reducer, every new state
// is drawn as one frame, and the reducer's effects run here - page loads on the current session,
// a reconnect (log out the old session, then one guarded login, never automatic), quit. Effects
// are started in order without waiting for each other (imapflow queues the IMAP commands).
// Results from a replaced session or after the end are dropped. Ctrl+C ends at once in every
// mode. The caller opens and closes the terminal and logs out `sessions.current` at the end.

export interface BrowserSession extends MessageSession {
  logout(): Promise<void>;
}

export interface BrowserDeps {
  terminal: Terminal;
  title: string;
  folders: readonly FolderInfo[];
  /** false = --no-size: no folder size column. */
  sizes: boolean;
  /** The current session; replaced on reconnect. The caller logs out `sessions.current` at the end. */
  sessions: { current: BrowserSession };
  /** One new guarded login. Errors propagate. */
  reconnect: (onChallenge: () => Promise<void>) => Promise<BrowserSession>;
  /** A reconnect error that isn't user-facing (the shell logs error.unexpected). */
  onUnexpected?: (err: unknown) => void;
  load?: typeof loadPage;
  /** Tests only: CHALLENGE_NOTICE names the default 5 seconds whatever this is. */
  challengeDelayMs?: number;
  /** Render option (tests). */
  formatDate?: (d: Date) => string;
}

export interface BrowseResult {
  end: 'quit' | 'interrupt';
  stats: BrowserStats;
  basket: Basket;
  /** The last reconnect failure, unless a later reconnect succeeded. */
  reconnectError?: unknown;
}

export interface Browser {
  /** Latest state (for browse.finish from an exit hook). */
  readonly state: BrowserState;
  /**
   * Registers `terminal.onKey` and `terminal.onResize` synchronously (createBrowser registers
   * nothing), draws the first frame, then runs until quit / Ctrl+C. Rejects on an unexpected
   * error. Call once.
   */
  run(): Promise<BrowseResult>;
}

/** Short enough to stay whole on the status line at 80 columns (64 characters). */
export const CHALLENGE_NOTICE = 'Several wrong passwords - waiting 5 seconds before trying again.';
export const RECONNECT_FAILED_TEXT =
  "Couldn't reconnect - showing what is loaded. Details after you quit.";

/** Rejects a challenge wait once the browser has ended; never shown, never logged. */
function browserClosed(): Error {
  return new Error('browser closed');
}

function isCtrlC(key: Keypress): boolean {
  return key.ctrl === true && key.name === 'c';
}

export function createBrowser(deps: BrowserDeps): Browser {
  const { terminal, sessions } = deps;
  const load = deps.load ?? loadPage;
  const challengeDelayMs = deps.challengeDelayMs ?? CHALLENGE_DELAY_MS;
  const renderOptions: RenderOptions = {
    sizes: deps.sizes,
    ...(deps.formatDate !== undefined && { formatDate: deps.formatDate }),
  };

  let state = initialState(deps.title, deps.folders, terminal.size());
  let ended = false;
  let reconnectError: unknown;
  let running: Promise<BrowseResult> | null = null;
  let resolveRun: (result: BrowseResult) => void = () => undefined;
  let rejectRun: (err: unknown) => void = () => undefined;
  /** The login guard's challenge wait in progress: finish() ends it early. */
  let challenge: { timer: ReturnType<typeof setTimeout>; settle: () => void } | null = null;

  function stopChallenge(): void {
    if (challenge === null) return;
    clearTimeout(challenge.timer);
    challenge.settle();
  }

  function finish(end: BrowseResult['end']): void {
    if (ended) return;
    ended = true;
    stopChallenge();
    resolveRun({ end, stats: state.stats, basket: state.basket, reconnectError });
  }

  function fail(err: unknown): void {
    if (ended) return;
    ended = true;
    stopChallenge();
    rejectRun(err);
  }

  /** Runs a handler unless the browser has ended; an exception ends run() with it. */
  function guarded(fn: () => void): void {
    if (ended) return;
    try {
      fn();
    } catch (err) {
      fail(err);
    }
  }

  function draw(): void {
    terminal.draw(render(state, renderOptions));
  }

  function dispatch(action: BrowserAction): void {
    const out = reduce(state, action);
    state = out.state;
    draw();
    for (const effect of out.effects) {
      if (ended) return;
      start(effect);
    }
  }

  function start(effect: BrowserEffect): void {
    switch (effect.type) {
      case 'load':
        startLoad(effect);
        return;
      case 'reconnect':
        reconnectNow().catch(fail);
        return;
      case 'quit':
        finish('quit');
        return;
    }
  }

  function startLoad(effect: Extract<BrowserEffect, { type: 'load' }>): void {
    const session = sessions.current;
    const { generation, path, page } = effect;
    const stale = (): boolean => ended || session !== sessions.current;
    load(session, path, effect.expected, page).then(
      (result) => {
        if (stale()) return;
        guarded(() => {
          dispatch({ type: 'page-loaded', generation, path, page, result });
        });
      },
      (err: unknown) => {
        if (stale()) return;
        if (!(err instanceof MailboxError)) {
          fail(err);
          return;
        }
        guarded(() => {
          dispatch({ type: 'load-failed', generation, path, page, code: err.code });
        });
      },
    );
  }

  /** The guard asked for a challenge: the notice, then the wait (cut short by the end). */
  function onChallenge(): Promise<void> {
    if (ended) return Promise.reject(browserClosed());
    guarded(() => {
      dispatch({ type: 'notice', text: CHALLENGE_NOTICE });
    });
    if (ended) return Promise.reject(browserClosed());
    return new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        challenge = null;
        if (ended) reject(browserClosed());
        else resolve();
      };
      challenge = { timer: setTimeout(settle, challengeDelayMs), settle };
    });
  }

  async function reconnectNow(): Promise<void> {
    // ImapSession.logout is best effort and never throws (capped at 5 s).
    await sessions.current.logout();
    // Ctrl+C during that logout: no login after the end.
    if (ended) return;
    let session: BrowserSession;
    try {
      session = await deps.reconnect(onChallenge);
    } catch (err) {
      if (ended) return;
      reconnectError = err;
      if (!isUserFacing(err)) deps.onUnexpected?.(err);
      guarded(() => {
        dispatch({ type: 'reconnect-failed', text: RECONNECT_FAILED_TEXT });
      });
      return;
    }
    if (ended) {
      await session.logout();
      return;
    }
    sessions.current = session;
    reconnectError = undefined;
    guarded(() => {
      dispatch({ type: 'reconnected' });
    });
  }

  function onKey(key: Keypress): void {
    if (ended) return;
    if (isCtrlC(key)) {
      finish('interrupt');
      return;
    }
    guarded(() => {
      dispatch({ type: 'key', key: keyOf(key) });
    });
  }

  function onResize(): void {
    guarded(() => {
      terminal.clear();
      dispatch({ type: 'resize', screen: terminal.size() });
    });
  }

  return {
    get state() {
      return state;
    },
    run() {
      if (running !== null) return running;
      running = new Promise<BrowseResult>((resolve, reject) => {
        resolveRun = resolve;
        rejectRun = reject;
      });
      terminal.onKey(onKey);
      terminal.onResize(onResize);
      guarded(draw);
      return running;
    },
  };
}
