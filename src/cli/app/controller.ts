import { accountFailureReason } from '../../core/accounts.js';
import { AuthError, type AuthService } from '../../core/auth.js';
import type { LogLevel } from '../../core/config.js';
import type { MailAccount } from '../../core/db/repos.js';
import { compileFilter, FilterError } from '../../core/filters/compile.js';
import { ImapSessionError } from '../../core/imap/errors.js';
import { LOGOUT_TIMEOUT_MS } from '../../core/imap/session.js';
import {
  authFailureReason,
  authLogin,
  authLoginFailed,
  authLogout,
  browseFinish,
  capabilityFallback,
  foldersList,
  safeEmit,
  searchFinish,
  statsFinish,
  type AccountFailureReason,
  type BrowseOutcome,
  type EventLog,
  type ReadResult,
} from '../../core/log/index.js';
import { MailboxError, type MailboxErrorCode } from '../../core/mailbox/errors.js';
import {
  listFolders as readFolderTree,
  type FallbackFeature,
  type FolderSession,
  type FolderTree,
  type SizeProgress,
} from '../../core/mailbox/folders.js';
import { loadPage } from '../../core/mailbox/messages.js';
import { SearchStopped, loadMatches, searchFolder } from '../../core/mailbox/search.js';
import { collectStats, type MailboxStats } from '../../core/mailbox/stats.js';
import type { DiscoveryResult, DiscoverySource } from '../../core/providers/discover.js';
import { DiscoveryInputError } from '../../core/providers/email.js';
import type { ImapSettings } from '../../core/providers/settings.js';
import type { RememberedUsers } from '../../core/remembered-users.js';
import { COUNTED_REASONS } from '../../core/security/login-guard.js';
import { accountErrorText } from '../account-text.js';
import {
  CHALLENGE_NOTICE,
  RECONNECT_FAILED_TEXT,
  type BrowserSession,
} from '../browser/controller.js';
import type { Rendered } from '../browser/render.js';
import type { Keypress } from '../browser/state.js';
import type { Terminal } from '../browser/terminal.js';
import { isUserFacing } from '../error-text.js';
import { imapErrorText } from '../imap-errors.js';
import { LOG_FOLDER_PROBLEM, formatReport } from '../log-text.js';
import { CHALLENGE_DELAY_MS } from '../login-guard-text.js';
import { browseFinishData } from './mailbox.js';
import { reduceApp, startApp } from './reduce.js';
import { renderApp } from './render.js';
import {
  appKeyOf,
  asciiText,
  initialApp,
  type AppAction,
  type AppEffect,
  type AppState,
  type BrowseFinishData,
  type LogsWindow,
  type MailboxRow,
} from './state.js';

// Runs the app (M2d): keys and resizes go through the pure reducer, every new state is drawn
// as one frame, and the reducer's effects run here - the session check, a sign-in, a sign-out,
// forgetting an address, the mailbox list, opening and closing a mailbox, the pages and the
// reconnect of the browser inside it, the read of its stats, the read of the logs, the steps of
// adding a mailbox, quit. Effects are started without waiting for each other; a result that
// arrives after the end is dropped, a stale one is dropped by the reducer. Ctrl+C ends at once
// in every mode. The caller opens and closes the terminal.
//
// The password is read from the `sign-in` effect straight into `auth.login`: no variable here
// holds it, and nothing typed is logged. A sign-in, a failed one and a sign-out write the same
// events as `mm login` / `mm logout`.
//
// A mailbox (M2d-2) is one guarded login - `r` and a reconnect are one more each, asked for by
// a key, never automatic - and its session belongs to this controller: it is logged out on
// every way out (Left, quit, Ctrl+C, a crash), also one that only arrives after the mailbox was
// left. Every open and close gets a new visit number, and a result carrying another one is
// dropped without a screen or a log line. The logins of one mailbox run one after another, and
// each checks its visit again when its turn comes: one that waited behind a slow login is not
// made once its mailbox was left or the app has ended. Opening writes `folders.list` (and the
// server fallbacks, once each per run), a visit that opened a folder writes `browse.finish`
// once - ids, counts and reason codes only, never a name, an address or the text of an error.
//
// The stats of a mailbox (M2d-3) are read behind its bars on a second guarded login and a
// session of their own, so folders keep opening meanwhile. One login per read - started by the
// folders arriving or by a key, never repeated here. That session is this controller's too: it
// is logged out when its read ends and on every way out of the mailbox, also when it only
// arrives afterwards. A read has no cancel: logging its session out stops it, and what it still
// reports is dropped. A read that ended writes `stats.finish` (counts and a reason code), one
// that was stopped writes nothing; a failure never ends the app.
//
// A filter of the open folder (M3a) is one search on the mailbox's session, and its pages are
// read by UID on the same session, each with the visit and session checks above. A search that
// ended writes `search.finish` once (counts, bytes and the names of the criteria); a stopped one
// writes nothing. A search is stopped by its number: a newer search, or a `stop-search` (Back to
// the plain list) bumps the mailbox's `searchId`, and the older one ends without an answer. No
// filter text, address, word, date or size reaches a log line or an error text.
//
// The logs screen (M2d-5) shows what `mm logs` prints: the same read, the same report, every
// line made ASCII. This run's own lines are part of it - only its "still running" marker is
// left out. Looking at the logs writes no log line, and nothing here can delete one.
//
// Adding a mailbox (M2d-4) is three calls, each asked for by a key: the lookup of the settings
// (public data, no login), the check that the mailbox isn't saved yet, and the add itself - one
// guarded login with the typed password, saved only when it works. The password is read from
// the `add-mailbox` effect straight into `deps.addMailbox`: no variable here holds it. A login
// the mail server rejected is never repeated here - the password field comes back. This
// controller logs nothing for any of it: `account.add` and its audit row are the core's.

/** What the app needs of a mailbox session: the folders, the pages of a folder, a logout. */
export type MailboxSession = FolderSession & BrowserSession;

export interface AppDeps {
  terminal: Terminal;
  version: string;
  auth: AuthService;
  /** The signed-in user's saved mailboxes. Errors propagate. */
  listMailboxes: () => Promise<readonly MailAccount[]>;
  remembered: RememberedUsers;
  log: EventLog;
  /** Log target of a typed e-mail (an HMAC, or `invalid`); one key for the whole run. */
  loginTarget: (email: string) => string;
  /**
   * An error that isn't user-facing and doesn't end the app - from the mailbox list, a
   * reconnect or a stats read: the shell logs error.unexpected. (One that ends run() is the
   * caller's to log.)
   */
  onUnexpected?: (err: unknown) => void;
  /** The saved mailbox with this id; throws AccountError('not-found') when it is gone. */
  findAccount: (accountId: string) => Promise<MailAccount>;
  /** One guarded login with its saved password; errors propagate. Never retried here. */
  openSession: (account: MailAccount, onChallenge: () => Promise<void>) => Promise<MailboxSession>;
  /** The folder tree with sizes; default: the core's listFolders. */
  listFolders?: (
    session: MailboxSession,
    onProgress: (progress: SizeProgress) => void,
  ) => Promise<FolderTree>;
  load?: typeof loadPage;
  /** The search of a folder; default: the core's searchFolder. */
  search?: typeof searchFolder;
  /** A page of matches by UID; default: the core's loadMatches. */
  loadMatches?: typeof loadMatches;
  /**
   * The local logs of the last `sinceMs`, as `mm logs` reads them: validated records, never raw
   * lines. Errors propagate.
   */
  readLogs: (o: { sinceMs: number; securityOnly: boolean; level: LogLevel }) => Promise<ReadResult>;
  /** The id of this run: its "interrupted or still running" marker is not shown in the logs. */
  ownRun?: string;
  /** The clock the logs' "today" is taken from; default Date.now. */
  now?: () => number;
  /**
   * The IMAP settings of an address, found without a login; `onProgress` names each source
   * before it is asked. Rejects with DiscoveryInputError for text that is not an address.
   */
  discover: (
    address: string,
    onProgress: (source: DiscoverySource) => void,
  ) => Promise<DiscoveryResult>;
  /** Rejects with AccountError('duplicate') when this address + server is saved already. */
  assertNotSaved: (o: { email: string; host: string; provider: string }) => Promise<void>;
  /**
   * One guarded login with the typed password; the mailbox is saved only when it works. Errors
   * propagate. Never retried here.
   */
  addMailbox: (
    o: {
      userId: string;
      email: string;
      settings: ImapSettings;
      provider: string;
      password: string;
    },
    onChallenge: () => Promise<void>,
  ) => Promise<MailAccount>;
  /** Why no mailbox can be added (the key is missing or broken), in plain words; null: one can. */
  addProblem?: string | null;
  /** The stats of a mailbox, read on a session of their own; default: the core's collectStats. */
  collectStats?: (
    session: MailboxSession,
    tree: FolderTree,
    options: { timeZone: string; onProgress: (progress: SizeProgress) => void },
  ) => Promise<MailboxStats>;
  /** The IANA zone the stats count years and show days in; default: this computer's. */
  timeZone?: string;
  /** Read the stats as soon as a mailbox's folders are there (default); false: only on `s`. */
  autoStats?: boolean;
  /** Tests only: CHALLENGE_NOTICE names the default 5 seconds whatever this is. */
  challengeDelayMs?: number;
}

export interface AppResult {
  end: 'quit' | 'interrupt';
  /** The last reconnect failure, unless a later login to that mailbox worked. */
  reconnectError?: unknown;
  /** The mailbox of `reconnectError`: set exactly when that is. */
  reconnectAccount?: MailAccount;
}

export interface App {
  /** Latest state. */
  readonly state: AppState;
  /**
   * Registers `terminal.onKey` and `terminal.onResize` synchronously (createApp registers
   * nothing), draws the first frame, then checks the session and runs until quit / Ctrl+C.
   * Rejects on an unexpected error. Call once.
   */
  run(): Promise<AppResult>;
  /**
   * Resolves once a sign-out that was in flight when the app ended has finished, and with it
   * every mailbox logout and every mailbox login still under way (a session that arrives late
   * is logged out) - at once when there is none. The mailbox part waits LOGOUT_TIMEOUT_MS at
   * most: a login that takes longer is abandoned. Never rejects.
   */
  settled(): Promise<void>;
  /**
   * For the terminal's exit hook (a signal, a crash): writes `browse.finish` of the open
   * mailbox when a folder was opened and it isn't written yet. Synchronous - no logout here.
   */
  onExit(code: number): void;
}

/** One visit of a mailbox, from Enter on Home until it is left. */
interface OpenMailbox {
  /** Its number: a result carrying another one belongs to a visit that is over. */
  visit: number;
  accountId: string;
  /** null until it was found. */
  account: MailAccount | null;
  /** null until the login worked, and while a reconnect is under way. */
  session: MailboxSession | null;
  /** When the mailbox was opened. */
  startedAt: number;
  /** `browse.finish` of this visit is written. */
  finished: boolean;
  /** The stats read under way; null before the first, and again once it ended or was stopped. */
  stats: StatsRun | null;
  /** Bumped by every search that starts and every stop: a search with an older number ends. */
  searchId: number;
}

/** One stats read of an open mailbox. */
interface StatsRun {
  /** The reducer's token of this read: what it reports carries it. */
  token: number;
  /** Its own session: null until its login worked, and again once it is logged out. */
  session: MailboxSession | null;
}

/** One wait the login guard asked for before a login. */
interface ChallengeWait {
  timer: ReturnType<typeof setTimeout>;
  /** Whether its login is still wanted. */
  live: () => boolean;
  /** Ends the wait: on to the login when it is still wanted, otherwise without it. */
  settle: () => void;
}

/** Exit hook codes that mean "stopped": Ctrl+C from outside, SIGHUP, SIGTERM. Others failed. */
const INTERRUPT_CODES: ReadonlySet<number> = new Set([130, 129, 143]);

const DAY_MS = 86_400_000;
/** How far back each window of the logs screen reads. */
const LOGS_WINDOW_MS: Record<LogsWindow, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

/** Shown for a stats read that failed for a reason that isn't the user's to read. */
export const STATS_UNEXPECTED_TEXT = 'Unexpected error while reading the stats.';

/** Rejects a login or a challenge wait of a mailbox that was left; never shown, never logged. */
function visitClosed(): Error {
  return new Error('mailbox closed');
}

/** Whether two frames put the same on the screen. */
function sameFrame(a: Rendered, b: Rendered): boolean {
  return (
    a.cursorLine === b.cursorLine &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line === b.lines[i])
  );
}

/** The byte Ctrl+C sends (ETX). */
const CTRL_C_BYTE = String.fromCharCode(3);

/**
 * Ctrl+C - also right after Esc: within its escape timeout readline joins the two into one
 * unnamed Meta keypress whose sequence is Esc followed by the Ctrl+C byte. Nothing else a
 * terminal sends ends with that byte.
 */
function isCtrlC(key: Keypress): boolean {
  if (key.ctrl === true && key.name === 'c') return true;
  return typeof key.sequence === 'string' && key.sequence.endsWith(CTRL_C_BYTE);
}

/** `fn()` as a promise: a synchronous throw becomes a rejection. */
function attempt<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(fn());
  });
}

/** What Home shows of a saved mailbox - never its secret, host or username. */
function rowOf(account: MailAccount): MailboxRow {
  return {
    id: account.id,
    email: account.email,
    provider: account.provider,
    lastCheckedAt: account.lastCheckedAt,
  };
}

export function createApp(deps: AppDeps): App {
  const { terminal, auth, remembered, log } = deps;
  const listFolders =
    deps.listFolders ??
    ((session, onProgress) => readFolderTree(session, { sizes: true, onProgress }));
  const load = deps.load ?? loadPage;
  const search = deps.search ?? searchFolder;
  const loadMatchPage = deps.loadMatches ?? loadMatches;
  const collect = deps.collectStats ?? collectStats;
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const challengeDelayMs = deps.challengeDelayMs ?? CHALLENGE_DELAY_MS;

  let state = initialApp(deps.version, terminal.size(), {
    autoStats: deps.autoStats ?? true,
    addProblem: deps.addProblem ?? null,
  });
  /** The frame on the screen; null when the next one has to be drawn whatever it is. */
  let onScreen: Rendered | null = null;
  let ended = false;
  let running: Promise<AppResult> | null = null;
  let resolveRun: (result: AppResult) => void = () => undefined;
  let rejectRun: (err: unknown) => void = () => undefined;
  /** The latest sign-out with its event, errors swallowed: it is finished even after the end. */
  let signingOut: Promise<void> = Promise.resolve();
  /** The mailbox on screen, from its `open-mailbox` to its `close-mailbox`. */
  let mailbox: OpenMailbox | null = null;
  /** Bumped by every open and close of a mailbox. */
  let visit = 0;
  /** Mailbox logouts and logins under way: settled() waits for them. */
  const pending = new Set<Promise<void>>();
  /** Server fallbacks already logged in this run. */
  const fallbacksLogged = new Set<FallbackFeature>();
  /**
   * The last reconnect that failed and its mailbox: reported when the app ends ("Details after
   * you quit."), so leaving the mailbox keeps it. A login to that mailbox that works drops it.
   */
  let reconnectFailure: { error: unknown; account: MailAccount } | null = null;
  /** The login guard's challenge waits in progress: leaving the mailbox ends them early. */
  const challenges = new Set<ChallengeWait>();
  /**
   * Per mailbox (account id) the last login asked for, settled whatever became of it: the next
   * login of that mailbox starts after it.
   */
  const loginTails = new Map<string, Promise<void>>();

  function finish(end: AppResult['end']): void {
    if (ended) return;
    ended = true;
    closeMailbox(leavingData(), end === 'interrupt' ? 'interrupted' : 'ok');
    resolveRun(
      reconnectFailure === null
        ? { end }
        : {
            end,
            reconnectError: reconnectFailure.error,
            reconnectAccount: reconnectFailure.account,
          },
    );
  }

  function fail(err: unknown): void {
    if (ended) return;
    ended = true;
    closeMailbox(leavingData(), 'failed', accountFailureReason(err));
    rejectRun(err);
  }

  /** Runs a handler unless the app has ended; an exception ends run() with it. */
  function guarded(fn: () => void): void {
    if (ended) return;
    try {
      fn();
    } catch (err) {
      fail(err);
    }
  }

  /** Draws the state; with `onlyChanges` nothing is written when the screen shows it already. */
  function draw(onlyChanges = false): void {
    const frame = renderApp(state, { timeZone });
    if (onlyChanges && onScreen !== null && sameFrame(onScreen, frame)) return;
    terminal.draw(frame);
    onScreen = frame;
  }

  function runEffects(effects: readonly AppEffect[]): void {
    for (const effect of effects) {
      if (ended) return;
      start(effect);
    }
  }

  function dispatch(action: AppAction, onlyChanges = false): void {
    const out = reduceApp(state, action);
    state = out.state;
    draw(onlyChanges);
    runEffects(out.effects);
  }

  /** A result arrives: dropped after the end, otherwise one more step of the reducer. */
  function answer(action: () => AppAction): void {
    guarded(() => {
      dispatch(action());
    });
  }

  /**
   * What a stats read reports: a step of the reducer too, but drawn only when the screen
   * changes - a read behind an open folder must not draw that folder again with every step.
   */
  function statsAnswer(action: () => AppAction): void {
    guarded(() => {
      dispatch(action(), true);
    });
  }

  function start(effect: AppEffect): void {
    switch (effect.type) {
      case 'check-session':
        checkSession(effect.generation);
        return;
      case 'sign-in':
        signIn(effect);
        return;
      case 'sign-out':
        signOut(effect.generation);
        return;
      case 'forget':
        remembered.remove(effect.email);
        dispatch({ type: 'remembered', emails: remembered.list() });
        return;
      case 'load-mailboxes':
        loadMailboxes(effect.generation);
        return;
      case 'open-mailbox':
        openMailbox(effect);
        return;
      case 'close-mailbox':
        closeMailbox(effect.finish, 'ok');
        return;
      case 'load-page':
        loadMailboxPage(effect);
        return;
      case 'search-folder':
        searchMailbox(effect);
        return;
      case 'load-matches':
        loadMailboxMatches(effect);
        return;
      case 'stop-search':
        if (mailbox !== null) mailbox.searchId += 1;
        return;
      case 'reconnect-mailbox':
        reconnectMailbox(effect.browserToken);
        return;
      case 'read-stats':
        readStats(effect);
        return;
      case 'read-logs':
        readLogs(effect);
        return;
      case 'discover':
        discoverSettings(effect);
        return;
      case 'check-saved':
        checkSaved(effect);
        return;
      case 'add-mailbox':
        addMailbox(effect);
        return;
      case 'quit':
        finish('quit');
        return;
    }
  }

  function checkSession(generation: number): void {
    attempt(() => auth.currentUser()).then(
      (user) => {
        answer(() => {
          // Remembered here too: a user who signed in with `mm login` is still listed after
          // Log out.
          if (user !== null && user.email !== '') remembered.add(user.email);
          return { type: 'session', generation, user, remembered: remembered.list() };
        });
      },
      (err: unknown) => {
        if (err instanceof AuthError && err.code === 'unreachable') {
          answer(() => ({ type: 'session-failed', generation, remembered: remembered.list() }));
          return;
        }
        fail(err);
      },
    );
  }

  function signIn(effect: Extract<AppEffect, { type: 'sign-in' }>): void {
    const { generation, email } = effect;
    // The password goes from the effect into the call and nowhere else.
    attempt(() => auth.login(email, effect.password)).then(
      (user) => {
        if (ended) return;
        safeEmit(log, () => authLogin(user.userId));
        answer(() => {
          if (user.email !== '') remembered.add(user.email);
          return { type: 'signed-in', generation, user, remembered: remembered.list() };
        });
      },
      (err: unknown) => {
        if (ended) return;
        // The target is an HMAC of the typed e-mail, never the e-mail.
        safeEmit(log, () => authLoginFailed(authFailureReason(err), deps.loginTarget(email)));
        if (!(err instanceof AuthError)) {
          fail(err);
          return;
        }
        const reason =
          err.code === 'invalid_credentials'
            ? 'invalid-credentials'
            : err.code === 'unreachable'
              ? 'unreachable'
              : 'unknown';
        answer(() => ({ type: 'sign-in-failed', generation, reason }));
      },
    );
  }

  function signOut(generation: number): void {
    // Not dropped when the app ends meanwhile (Ctrl+C): the session is revoked and the event
    // written either way - only the screen no longer follows.
    const done = attempt(() => auth.logout()).then((result) => {
      safeEmit(log, () => authLogout(result));
    });
    signingOut = done.then(
      () => undefined,
      () => undefined,
    );
    done.then(
      () => {
        answer(() => ({ type: 'signed-out', generation, remembered: remembered.list() }));
      },
      (err: unknown) => {
        fail(err);
      },
    );
  }

  function loadMailboxes(generation: number): void {
    attempt(() => deps.listMailboxes()).then(
      (accounts) => {
        answer(() => ({ type: 'mailboxes', generation, rows: accounts.map(rowOf) }));
      },
      (err: unknown) => {
        if (ended) return;
        guarded(() => {
          if (!isUserFacing(err)) deps.onUnexpected?.(err);
        });
        if (ended) return;
        // Was it the sign-in that ended? Only a clear "nobody is signed in" says so.
        attempt(() => auth.currentUser()).then(
          (user) => {
            answer(() =>
              user === null
                ? { type: 'session-ended', generation, remembered: remembered.list() }
                : { type: 'mailboxes-failed', generation },
            );
          },
          () => {
            answer(() => ({ type: 'mailboxes-failed', generation }));
          },
        );
      },
    );
  }

  /** `work` in the background: settled() waits for it; what it can't handle ends run(). */
  function background(work: Promise<void>): void {
    const done = work.catch(fail);
    pending.add(done);
    void done.then(() => pending.delete(done));
  }

  /** Logs a session out; ImapSession.logout is best effort and never throws (capped at 5 s). */
  function logOut(session: MailboxSession): Promise<void> {
    const done = attempt(() => session.logout()).catch(() => undefined);
    background(done);
    return done;
  }

  /** What the mailbox on screen would report if it were left now. */
  function leavingData(): BrowseFinishData | null {
    return state.view.kind === 'mailbox' ? browseFinishData(state.view) : null;
  }

  /** `browse.finish`, once per visit and only for one that opened a folder. */
  function logVisit(
    opened: OpenMailbox,
    data: BrowseFinishData | null,
    outcome: BrowseOutcome,
    reason?: AccountFailureReason,
  ): void {
    if (data === null || opened.finished) return;
    opened.finished = true;
    safeEmit(log, () =>
      browseFinish({
        acct: opened.accountId,
        folders: data.folders,
        mails: data.mails,
        marked: data.marked,
        bytes: data.bytes,
        reconnects: data.reconnects,
        // Since the mailbox was opened: the bars are part of the visit.
        ms: Date.now() - opened.startedAt,
        outcome,
        reason,
      }),
    );
  }

  /**
   * The mailbox is left: from here on every result of its visit is stale, a login of it that
   * still waits for its turn is not made, a challenge wait ends without its login, its stats
   * read is stopped, and its sessions are logged out. Safe to call without a mailbox.
   */
  function closeMailbox(
    data: BrowseFinishData | null,
    outcome: BrowseOutcome,
    reason?: AccountFailureReason,
  ): void {
    visit += 1;
    stopChallenge();
    const opened = mailbox;
    mailbox = null;
    if (opened === null) return;
    stopStats(opened);
    if (opened.session !== null) void logOut(opened.session);
    logVisit(opened, data, outcome, reason);
  }

  /**
   * Ends the waits nobody waits for any more - their logins are not made. One whose login is
   * still wanted keeps its time: ending it here would start that login before the guard's
   * delay is over.
   */
  function stopChallenge(): void {
    // A wait leaves the set as it settles.
    for (const wait of challenges) {
      if (wait.live()) continue;
      clearTimeout(wait.timer);
      wait.settle();
    }
  }

  /**
   * The guard asked for a challenge: the notice (null: this login has no place for one), then
   * the wait, then `done` - the login starts. A mailbox that is left (or the end of the app)
   * cuts the wait short and rejects it, so no login is made for nobody.
   */
  function challengeWait(
    live: () => boolean,
    notice: (() => AppAction) | null,
    done?: () => AppAction,
  ): Promise<void> {
    if (!live()) return Promise.reject(visitClosed());
    if (notice !== null) answer(notice);
    if (!live()) return Promise.reject(visitClosed());
    return new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        challenges.delete(wait);
        if (done !== undefined && live()) answer(done);
        // Drawing that frame may have ended the app: no login then.
        if (live()) resolve();
        else reject(visitClosed());
      };
      const wait: ChallengeWait = { timer: setTimeout(settle, challengeDelayMs), live, settle };
      challenges.add(wait);
    });
  }

  /**
   * One login to `account`, after every earlier login of that mailbox has settled: they run one
   * after another. When its turn comes it is made only while `live()` holds - a visit that was
   * left while it waited, or the end of the app, rejects it and the mail server is not asked.
   */
  function login(
    account: MailAccount,
    live: () => boolean,
    notice: (() => AppAction) | null,
    done?: () => AppAction,
  ): Promise<MailboxSession> {
    const previous = loginTails.get(account.id) ?? Promise.resolve();
    const run = previous.then(() => {
      if (!live()) throw visitClosed();
      return deps.openSession(account, () => challengeWait(live, notice, done));
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    loginTails.set(account.id, tail);
    // Dropped once nothing waits behind it.
    void tail.then(() => {
      if (loginTails.get(account.id) === tail) loginTails.delete(account.id);
    });
    return run;
  }

  function openMailbox(effect: Extract<AppEffect, { type: 'open-mailbox' }>): void {
    // `r` on the failed screen opens again: whatever the failed attempt left goes first.
    closeMailbox(null, 'ok');
    const opened: OpenMailbox = {
      visit,
      accountId: effect.accountId,
      account: null,
      session: null,
      startedAt: Date.now(),
      finished: false,
      stats: null,
      searchId: 0,
    };
    mailbox = opened;
    background(logIn(opened, effect.generation));
  }

  /** A login to this mailbox worked: a reconnect of it that failed earlier is history. */
  function loggedIn(account: MailAccount): void {
    if (reconnectFailure?.account.id === account.id) reconnectFailure = null;
  }

  /** A login or folder read failed: the log line, then the failed screen or the crash path. */
  function openFailed(opened: OpenMailbox, generation: number, err: unknown): void {
    safeEmit(log, () =>
      foldersList({
        acct: opened.accountId,
        folders: 0,
        ms: Date.now() - opened.startedAt,
        outcome: 'failed',
        reason: accountFailureReason(err),
      }),
    );
    if (isUserFacing(err)) {
      const text = accountErrorText(err, opened.account ?? undefined);
      answer(() => ({ type: 'mailbox-failed', generation, text }));
      return;
    }
    // Not ours: run() ends with it, and whoever called it reports it - once.
    fail(err);
  }

  /**
   * Finds the mailbox and logs in - one attempt, in its turn. Whatever arrives after the
   * mailbox was left is dropped: nothing is shown or logged, and a session is logged out at
   * once.
   */
  async function logIn(opened: OpenMailbox, generation: number): Promise<void> {
    const live = (): boolean => !ended && opened.visit === visit;
    let session: MailboxSession;
    try {
      const account = await deps.findAccount(opened.accountId);
      // Left meanwhile: no login for a mailbox nobody waits for.
      if (!live()) return;
      opened.account = account;
      session = await login(
        account,
        live,
        () => ({ type: 'challenge', generation }),
        () => ({ type: 'challenge-done', generation }),
      );
      loggedIn(account);
    } catch (err) {
      if (live()) openFailed(opened, generation, err);
      return;
    }
    if (!live()) {
      await logOut(session);
      return;
    }
    opened.session = session;
    answer(() => ({ type: 'mailbox-reading', generation }));
    // Drawing that frame may have ended the app (and logged the session out): no read then.
    if (!live()) return;
    readFolders(opened, generation, session);
  }

  function readFolders(opened: OpenMailbox, generation: number, session: MailboxSession): void {
    const live = (): boolean => !ended && opened.visit === visit;
    attempt(() =>
      listFolders(session, (progress) => {
        if (live()) answer(() => ({ type: 'mailbox-progress', generation, progress }));
      }),
    ).then(
      (tree) => {
        if (!live()) return;
        for (const feature of tree.fallbacks) {
          if (fallbacksLogged.has(feature)) continue;
          fallbacksLogged.add(feature);
          safeEmit(log, () => capabilityFallback(feature));
        }
        safeEmit(log, () =>
          foldersList({
            acct: opened.accountId,
            folders: tree.folders.length,
            ms: Date.now() - opened.startedAt,
            outcome: 'ok',
          }),
        );
        answer(() => ({ type: 'mailbox-opened', generation, tree }));
      },
      (err: unknown) => {
        // Left while reading: its logout made the read fail, which is nobody's failure.
        if (!live()) return;
        opened.session = null;
        void logOut(session);
        openFailed(opened, generation, err);
      },
    );
  }

  function loadMailboxPage(effect: Extract<AppEffect, { type: 'load-page' }>): void {
    const { browserToken, browserGeneration: generation, path, page } = effect;
    const opened = mailbox;
    if (opened === null) return;
    const session = opened.session;
    if (session === null) {
      // No session to read on (a reconnect didn't give one): the browser asks to reconnect.
      answer(() => ({
        type: 'browser',
        browserToken,
        action: { type: 'load-failed', generation, path, page, code: 'connection-lost' },
      }));
      return;
    }
    // Dropped: after the end, after the mailbox was left, on a session a reconnect replaced.
    const stale = (): boolean => ended || opened.visit !== visit || opened.session !== session;
    attempt(() => load(session, path, effect.expected, page)).then(
      (result) => {
        if (stale()) return;
        answer(() => ({
          type: 'browser',
          browserToken,
          action: { type: 'page-loaded', generation, path, page, result },
        }));
      },
      (err: unknown) => {
        if (stale()) return;
        if (!(err instanceof MailboxError)) {
          fail(err);
          return;
        }
        answer(() => ({
          type: 'browser',
          browserToken,
          action: { type: 'load-failed', generation, path, page, code: err.code },
        }));
      },
    );
  }

  /** A page of a filtered list, by UID: answered like a page of the folder. */
  function loadMailboxMatches(effect: Extract<AppEffect, { type: 'load-matches' }>): void {
    const { browserToken, browserGeneration: generation, path, page } = effect;
    const opened = mailbox;
    if (opened === null) return;
    const session = opened.session;
    if (session === null) {
      answer(() => ({
        type: 'browser',
        browserToken,
        action: { type: 'load-failed', generation, path, page, code: 'connection-lost' },
      }));
      return;
    }
    // Dropped: after the end, after the mailbox was left, on a session a reconnect replaced.
    const stale = (): boolean => ended || opened.visit !== visit || opened.session !== session;
    attempt(() => loadMatchPage(session, path, effect.expected, page, effect.uids)).then(
      (result) => {
        if (stale()) return;
        answer(() => ({
          type: 'browser',
          browserToken,
          action: { type: 'page-loaded', generation, path, page, result },
        }));
      },
      (err: unknown) => {
        if (stale()) return;
        if (!(err instanceof MailboxError)) {
          fail(err);
          return;
        }
        answer(() => ({
          type: 'browser',
          browserToken,
          action: { type: 'load-failed', generation, path, page, code: err.code },
        }));
      },
    );
  }

  /**
   * The search of the open folder on the mailbox's session: one search at a time (a newer one
   * or a stop ends the older one by its number), `search.finish` once when it ended.
   */
  function searchMailbox(effect: Extract<AppEffect, { type: 'search-folder' }>): void {
    const { browserToken, browserGeneration: generation, path } = effect;
    const opened = mailbox;
    if (opened === null) return;
    const session = opened.session;
    const failed = (code: MailboxErrorCode): AppAction => ({
      type: 'browser',
      browserToken,
      action: { type: 'search-failed', generation, path, code },
    });
    if (session === null) {
      answer(() => failed('connection-lost'));
      return;
    }
    opened.searchId += 1;
    const id = opened.searchId;
    const startedAt = Date.now();
    const stale = (): boolean => ended || opened.visit !== visit || opened.session !== session;
    const stopped = (): boolean => stale() || opened.searchId !== id;
    let criteria: readonly string[] = [];
    const finished = (
      outcome: 'ok' | 'failed',
      count: number,
      bytes: number,
      reason?: AccountFailureReason,
    ): void => {
      safeEmit(log, () =>
        searchFinish({
          acct: opened.accountId,
          count,
          bytes,
          ms: Date.now() - startedAt,
          criteria,
          outcome,
          reason,
        }),
      );
    };
    attempt(async () => {
      // "now" of `older:` / `newer:`: the injectable clock, so tests can fix it.
      const compiled = compileFilter(effect.filter, { now: new Date((deps.now ?? Date.now)()) });
      criteria = compiled.criteria;
      return search(session, path, compiled, {
        shouldStop: stopped,
        onProgress: (done, total) => {
          if (stopped()) return;
          answer(() => ({
            type: 'browser',
            browserToken,
            action: { type: 'search-progress', generation, path, done, total },
          }));
        },
      });
    }).then(
      (result) => {
        if (stopped()) return;
        finished('ok', result.matches.length, result.bytes);
        answer(() => ({
          type: 'browser',
          browserToken,
          action: { type: 'search-done', generation, path, result },
        }));
      },
      (err: unknown) => {
        if (stopped() || err instanceof SearchStopped) return;
        if (err instanceof FilterError) {
          finished('failed', 0, 0, 'search-failed');
          answer(() => failed('search-failed'));
          return;
        }
        if (!(err instanceof MailboxError)) {
          finished('failed', 0, 0, 'unexpected');
          fail(err);
          return;
        }
        finished('failed', 0, 0, err.code);
        answer(() => failed(err.code));
      },
    );
  }

  function reconnectMailbox(browserToken: number): void {
    const opened = mailbox;
    if (opened === null || opened.account === null) return;
    background(reconnect(opened, opened.account, browserToken));
  }

  /**
   * Logs the old session out, then one new login - asked for by a key, never repeated here.
   * The new session is the mailbox's from then on, whatever became of the browser that asked
   * (the reducer drops an answer for a browser that was left).
   */
  async function reconnect(
    opened: OpenMailbox,
    account: MailAccount,
    browserToken: number,
  ): Promise<void> {
    const live = (): boolean => !ended && opened.visit === visit;
    const old = opened.session;
    opened.session = null;
    if (old !== null) await logOut(old);
    // Left during that logout: no login after it.
    if (!live()) return;
    let session: MailboxSession;
    try {
      // No `done`: the browser drops the notice itself when the reconnect ends.
      session = await login(account, live, () => ({
        type: 'browser',
        browserToken,
        action: { type: 'notice', text: CHALLENGE_NOTICE },
      }));
    } catch (err) {
      if (!live()) return;
      reconnectFailure = { error: err, account };
      guarded(() => {
        if (!isUserFacing(err)) deps.onUnexpected?.(err);
      });
      answer(() => ({
        type: 'browser',
        browserToken,
        action: { type: 'reconnect-failed', text: RECONNECT_FAILED_TEXT },
      }));
      return;
    }
    loggedIn(account);
    if (!live()) {
      await logOut(session);
      return;
    }
    opened.session = session;
    answer(() => ({ type: 'browser', browserToken, action: { type: 'reconnected' } }));
  }

  function readStats(effect: Extract<AppEffect, { type: 'read-stats' }>): void {
    const opened = mailbox;
    if (opened === null || opened.account === null) return;
    // One read at a time: whatever an earlier one still holds goes first.
    stopStats(opened);
    const read: StatsRun = { token: effect.statsToken, session: null };
    opened.stats = read;
    background(runStats(opened, opened.account, read, effect.tree));
  }

  /** The read is over or stopped: nothing of it counts from here on, its session is logged out. */
  function endStats(opened: OpenMailbox, read: StatsRun): void {
    if (opened.stats === read) opened.stats = null;
    const session = read.session;
    read.session = null;
    if (session !== null) void logOut(session);
  }

  /** Stops the stats read of `opened`, when one is under way. */
  function stopStats(opened: OpenMailbox): void {
    if (opened.stats !== null) endStats(opened, opened.stats);
  }

  /** A read failed: the log line, then its text for the stats screen - the app goes on. */
  function statsFailed(opened: OpenMailbox, read: StatsRun, startedAt: number, err: unknown): void {
    safeEmit(log, () =>
      statsFinish({
        acct: opened.accountId,
        folders: 0,
        messages: 0,
        bytes: 0,
        ms: Date.now() - startedAt,
        outcome: 'failed',
        reason: accountFailureReason(err),
      }),
    );
    let text = STATS_UNEXPECTED_TEXT;
    if (isUserFacing(err)) text = accountErrorText(err, opened.account ?? undefined);
    else {
      // Not ours - but the stats are an extra behind the mailbox: reported, and the app goes on.
      guarded(() => deps.onUnexpected?.(err));
    }
    statsAnswer(() => ({ type: 'stats-failed', statsToken: read.token, text }));
  }

  /**
   * One stats read: one login in its turn, then the read on that session - one attempt, never
   * repeated here. Stopped (the mailbox left, the app ended, another read started), it shows
   * and logs nothing: a session that arrives then is logged out at once, and a read whose
   * session was logged out fails as nobody's failure.
   */
  async function runStats(
    opened: OpenMailbox,
    account: MailAccount,
    read: StatsRun,
    tree: FolderTree,
  ): Promise<void> {
    const live = (): boolean => !ended && opened.visit === visit && opened.stats === read;
    const startedAt = Date.now();
    let stats: MailboxStats;
    try {
      // No notice: neither the bars nor the stats screen has a place for the guard's wait. (And
      // no loggedIn(): a reconnect of the mailbox's own session that failed is still to be
      // explained when the app ends.)
      const session = await login(account, live, null);
      if (!live()) {
        await logOut(session);
        return;
      }
      read.session = session;
      stats = await collect(session, tree, {
        timeZone,
        onProgress: (progress) => {
          if (!live()) return;
          statsAnswer(() => ({ type: 'stats-progress', statsToken: read.token, progress }));
        },
      });
    } catch (err) {
      if (!live()) return;
      endStats(opened, read);
      statsFailed(opened, read, startedAt, err);
      return;
    }
    // Stopped as it finished: whoever stopped it has logged its session out.
    if (!live()) return;
    endStats(opened, read);
    safeEmit(log, () =>
      statsFinish({
        acct: opened.accountId,
        folders: stats.folders.length,
        messages: stats.totals.messages,
        bytes: stats.totals.bytes,
        ms: Date.now() - startedAt,
        outcome: 'ok',
      }),
    );
    statsAnswer(() => ({ type: 'stats-ready', statsToken: read.token, stats }));
  }

  /**
   * Reads the logs for the logs screen and hands it the report as lines. The read can't be
   * stopped: what it returns after a newer one was asked for, or after the screen was left, is
   * dropped here, before it is made into lines. Nothing is logged for looking.
   */
  function readLogs(effect: Extract<AppEffect, { type: 'read-logs' }>): void {
    const { generation, securityOnly, warnOnly } = effect;
    const sinceMs = LOGS_WINDOW_MS[effect.window];
    attempt(() => deps.readLogs({ sinceMs, securityOnly, level: warnOnly ? 'warn' : 'info' })).then(
      (result) => {
        if (generation !== state.generation) return;
        answer(() => {
          const problem = LOG_FOLDER_PROBLEM[result.folder];
          if (problem !== undefined) return { type: 'logs-failed', generation, text: problem };
          // This run is the one that is still running: its marker would say nothing new.
          const interrupted = result.interrupted.filter((run) => run.run !== deps.ownRun);
          const lines = formatReport(
            { ...result, interrupted },
            {
              now: (deps.now ?? Date.now)(),
              sinceMs,
              ...(warnOnly && { level: 'warn' as const }),
              ...(securityOnly && { securityOnly: true }),
              timeZone,
              narrowWith: 'keys',
            },
          );
          return { type: 'logs-read', generation, lines: lines.map(asciiText) };
        });
      },
      (err: unknown) => {
        fail(err);
      },
    );
  }

  /**
   * Looks up the IMAP settings of the typed address. What the lookup reports after its step was
   * left (Esc) belongs to an older request and is dropped.
   */
  function discoverSettings(effect: Extract<AppEffect, { type: 'discover' }>): void {
    const { generation } = effect;
    const waitedFor = (): boolean => generation === state.generation;
    attempt(() =>
      deps.discover(effect.address, (source) => {
        if (waitedFor()) answer(() => ({ type: 'discover-progress', generation, source }));
      }),
    ).then(
      (result) => {
        if (waitedFor()) answer(() => ({ type: 'discovered', generation, result }));
      },
      (err: unknown) => {
        // The reducer checked the address already; a lookup that still refuses it says why.
        if (!(err instanceof DiscoveryInputError)) {
          fail(err);
          return;
        }
        const text = err.message;
        if (waitedFor()) answer(() => ({ type: 'add-failed', generation, text }));
      },
    );
  }

  /** Is the mailbox saved already? Asked before a password is. */
  function checkSaved(effect: Extract<AppEffect, { type: 'check-saved' }>): void {
    const { generation, email, host, provider } = effect;
    const waitedFor = (): boolean => generation === state.generation;
    attempt(() => deps.assertNotSaved({ email, host, provider })).then(
      () => {
        if (waitedFor()) answer(() => ({ type: 'saved-checked', generation }));
      },
      (err: unknown) => {
        if (!isUserFacing(err)) {
          fail(err);
          return;
        }
        const text = accountErrorText(err);
        if (waitedFor()) answer(() => ({ type: 'add-failed', generation, text }));
      },
    );
  }

  /**
   * `deps.addMailbox` as a promise (a synchronous throw becomes a rejection). A function of its
   * own so that the effect - and with it the password - is in no scope that outlives the call:
   * it goes from the effect into the call and nowhere else.
   */
  function startAdd(
    effect: Extract<AppEffect, { type: 'add-mailbox' }>,
    userId: string,
    onChallenge: () => Promise<void>,
  ): Promise<MailAccount> {
    return attempt(() =>
      deps.addMailbox(
        {
          userId,
          email: effect.email,
          settings: effect.settings,
          provider: effect.provider,
          password: effect.password,
        },
        onChallenge,
      ),
    );
  }

  /**
   * One login with the typed password and, when it works, the saved mailbox - one attempt,
   * never repeated here. A password the mail server may have rejected brings the field back
   * (the login guard counts those); any other failure that has a text for the user ends the
   * add with it; one that has none ends the app. settled() waits for the call: it can't be
   * called back, and a login that works still saves the mailbox. An end of the app during the
   * guard's wait abandons the add instead: no login was made, so the core is told nothing and
   * settled() does not wait for it.
   */
  function addMailbox(effect: Extract<AppEffect, { type: 'add-mailbox' }>): void {
    const { generation } = effect;
    const user = state.current;
    if (user === null) {
      fail(new Error('a mailbox can only be added by a signed-in user'));
      return;
    }
    // Ended during the guard's wait: no login is made, and the add was interrupted, not refused.
    // The core is told nothing - a rejection it would log and audit as a failed add - so its
    // call never returns, and settled() has nothing of it left to wait for.
    let abandon: () => void = () => undefined;
    const abandoned = new Promise<void>((resolve) => {
      abandon = resolve;
    });
    // The login is wanted for as long as the app runs: leaving a mailbox doesn't end its wait.
    const onChallenge = (): Promise<void> =>
      challengeWait(
        () => !ended,
        () => ({ type: 'challenge', generation }),
        () => ({ type: 'challenge-done', generation }),
      ).catch((err: unknown) => {
        if (!ended) throw err;
        abandon();
        return new Promise<never>(() => undefined);
      });
    background(
      Promise.race([
        startAdd(effect, user.userId, onChallenge).then(
          (account) => {
            answer(() => ({
              type: 'mailbox-added',
              generation,
              id: account.id,
              email: account.email,
            }));
          },
          (err: unknown) => {
            // After the end nobody is told - and the core has logged what happened.
            if (ended) return;
            if (
              err instanceof ImapSessionError &&
              (COUNTED_REASONS.has(err.reason) || err.reason === 'invalid-credentials-input')
            ) {
              const text = imapErrorText(err.reason, { kind: 'this-computer' });
              answer(() => ({ type: 'add-rejected', generation, text }));
              return;
            }
            if (!isUserFacing(err)) throw err;
            const text = accountErrorText(err);
            answer(() => ({ type: 'add-failed', generation, text }));
          },
        ),
        abandoned,
      ]),
    );
  }

  function onKey(key: Keypress): void {
    if (ended) return;
    if (isCtrlC(key)) {
      finish('interrupt');
      return;
    }
    answer(() => ({ type: 'key', key: appKeyOf(key) }));
  }

  function onResize(): void {
    guarded(() => {
      terminal.clear();
      // The screen is empty now: whatever comes next is drawn.
      onScreen = null;
      dispatch({ type: 'resize', screen: terminal.size() });
    });
  }

  return {
    get state() {
      return state;
    },
    run() {
      if (running !== null) return running;
      running = new Promise<AppResult>((resolve, reject) => {
        resolveRun = resolve;
        rejectRun = reject;
      });
      terminal.onKey(onKey);
      terminal.onResize(onResize);
      guarded(() => {
        const out = startApp(state);
        state = out.state;
        draw();
        runEffects(out.effects);
      });
      return running;
    },
    settled() {
      // A slow login must not keep the process: its part of the wait has an end.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const capped = Promise.race([
        Promise.all(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, LOGOUT_TIMEOUT_MS);
        }),
      ]).finally(() => {
        clearTimeout(timer);
      });
      return Promise.all([signingOut, capped]).then(() => undefined);
    },
    onExit(code) {
      if (mailbox === null) return;
      if (INTERRUPT_CODES.has(code)) logVisit(mailbox, leavingData(), 'interrupted');
      else logVisit(mailbox, leavingData(), 'failed', 'unexpected');
    },
  };
}
