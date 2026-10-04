import * as readline from 'node:readline';
import type { Rendered } from './render.js';
import type { Keypress, Screen } from './state.js';

// The terminal shell of the folder browser (M2b-2): raw mode, the alternate screen, full-frame
// redraws and keys. It writes only escape sequences and the rendered lines - nothing else is
// printed. The screen is always given back: restore() on q / Ctrl+C / an error (the command calls
// close()), and until then process hooks restore it on an exit, a signal or a crash. A terminal
// that is gone (SIGHUP) makes writes fail: those failures are ignored, the process is ending.

export type KeypressListener = (str: string | undefined, key: Keypress | undefined) => void;

export interface TerminalInput {
  setRawMode(mode: boolean): unknown;
  on(event: 'keypress', fn: KeypressListener): unknown;
  removeListener(event: 'keypress', fn: KeypressListener): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface TerminalOutput {
  rows?: number | undefined;
  columns?: number | undefined;
  write(chunk: string): unknown;
  on(event: 'resize', fn: () => void): unknown;
  removeListener(event: 'resize', fn: () => void): unknown;
}

export interface TerminalProcess {
  prependListener(event: 'exit', fn: (code: number) => void): unknown;
  prependListener(
    event: 'uncaughtException' | 'unhandledRejection',
    fn: (err: unknown) => void,
  ): unknown;
  /** SIGINT is prepended (before runCli's handler); SIGTERM / SIGHUP may be prepended too. */
  prependListener(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP', fn: () => void): unknown;
  removeListener(event: 'exit', fn: (code: number) => void): unknown;
  removeListener(
    event: 'uncaughtException' | 'unhandledRejection',
    fn: (err: unknown) => void,
  ): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP', fn: () => void): unknown;
  exit(code?: number): never;
}

export interface TerminalIo {
  input: TerminalInput;
  output: TerminalOutput;
  proc: TerminalProcess;
  /** Turns on readline keypress events for `input` (tests pass a no-op). Default io: `() => readline.emitKeypressEvents(process.stdin)`. */
  emitKeypressEvents: () => void;
}

export interface TerminalOptions {
  /** Default: process.stdin / process.stdout / process + the readline call above. */
  io?: TerminalIo;
  /** An exit before close() (signal, crash, external SIGINT): runs after the screen is restored. */
  onExit?: (code: number) => void;
}

export interface Terminal {
  /** stdout rows/columns; undefined → 0 (the renderer then shows "too small"). */
  size(): Screen;
  draw(frame: Rendered): void;
  clear(): void;
  /** One handler; `key` is `{ sequence: str }` when readline gives no key object. */
  onKey(fn: (key: Keypress) => void): void;
  onResize(fn: () => void): void;
  restore(): void;
  close(): void;
}

/** Alternate screen, cursor hidden, line wrap off, clear. */
export const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J';
/** Attributes reset, line wrap on, cursor shown, main screen back. */
export const LEAVE_SCREEN = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';
/** Erases the whole line first: a line drawn narrower than measured leaves no stale cells. */
const ERASE_LINE = '\x1b[2K';
const REVERSE = '\x1b[7m';
const REVERSE_OFF = '\x1b[27m';

function processIo(): TerminalIo {
  return {
    input: process.stdin,
    output: process.stdout,
    proc: process,
    emitKeypressEvents: () => {
      readline.emitKeypressEvents(process.stdin);
    },
  };
}

/** Hooks first, then keypress events + raw mode + ENTER_SCREEN. A failing setRawMode(true) → undone, rethrown. */
export function openTerminal(options: TerminalOptions = {}): Terminal {
  const { input, output, proc, emitKeypressEvents } = options.io ?? processIo();
  let restored = false;
  let closed = false;
  let keyListener: KeypressListener | null = null;
  let resizeListener: (() => void) | null = null;

  function write(chunk: string): void {
    try {
      output.write(chunk);
    } catch {
      // The terminal is gone (e.g. after SIGHUP): nothing left to draw on.
    }
  }

  function restore(): void {
    if (restored) return;
    restored = true;
    write(LEAVE_SCREEN);
    try {
      input.setRawMode(false);
    } catch {
      // The terminal is gone: there is no mode left to reset.
    }
    try {
      input.pause();
    } catch {
      // Already closed.
    }
  }

  const onProcExit = (code: number): void => {
    restore();
    try {
      options.onExit?.(code);
    } catch {
      // The process is ending: there is nowhere left to report this.
    }
  };
  const onCrash = (): void => {
    restore();
  };
  const onSigint = (): void => proc.exit(130);
  const onSigterm = (): void => proc.exit(143);
  const onSighup = (): void => proc.exit(129);

  function removeHooks(): void {
    proc.removeListener('exit', onProcExit);
    proc.removeListener('uncaughtException', onCrash);
    proc.removeListener('unhandledRejection', onCrash);
    proc.removeListener('SIGINT', onSigint);
    proc.removeListener('SIGTERM', onSigterm);
    proc.removeListener('SIGHUP', onSighup);
  }

  // Prepended: the screen is back before runCli logs command.finish or prints "Unexpected
  // error", and an external SIGINT exits here before runCli's own handler runs.
  proc.prependListener('exit', onProcExit);
  proc.prependListener('uncaughtException', onCrash);
  proc.prependListener('unhandledRejection', onCrash);
  proc.prependListener('SIGINT', onSigint);
  proc.prependListener('SIGTERM', onSigterm);
  proc.prependListener('SIGHUP', onSighup);

  try {
    emitKeypressEvents();
    input.setRawMode(true);
  } catch (err) {
    removeHooks();
    throw err;
  }
  try {
    input.resume();
    output.write(ENTER_SCREEN);
  } catch (err) {
    restore();
    removeHooks();
    throw err;
  }

  return {
    size: () => ({ rows: output.rows ?? 0, cols: output.columns ?? 0 }),
    draw: (frame) => {
      const lines = frame.lines.map(
        (line, i) =>
          ERASE_LINE + (i === frame.cursorLine ? `${REVERSE}${line}${REVERSE_OFF}` : line),
      );
      write(HOME + lines.join('\r\n'));
    },
    clear: () => {
      write(CLEAR);
    },
    onKey: (fn) => {
      if (closed) return;
      if (keyListener !== null) input.removeListener('keypress', keyListener);
      keyListener = (str, key) => {
        fn(key ?? { sequence: str });
      };
      input.on('keypress', keyListener);
    },
    onResize: (fn) => {
      if (closed) return;
      if (resizeListener !== null) output.removeListener('resize', resizeListener);
      resizeListener = fn;
      output.on('resize', resizeListener);
    },
    restore,
    close: () => {
      restore();
      if (closed) return;
      closed = true;
      removeHooks();
      if (keyListener !== null) input.removeListener('keypress', keyListener);
      if (resizeListener !== null) output.removeListener('resize', resizeListener);
      keyListener = null;
      resizeListener = null;
    },
  };
}
