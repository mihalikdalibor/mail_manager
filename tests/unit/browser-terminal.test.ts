import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { ENTER_SCREEN, LEAVE_SCREEN, openTerminal } from '../../src/cli/browser/terminal.js';
import type { TerminalIo, TerminalOptions } from '../../src/cli/browser/terminal.js';

// M2b-2 terminal shell (spec): raw mode + alternate screen, full-frame redraw, idempotent restore
// and the process hooks. Only fake streams and a fake process are used — the real terminal is
// never touched. The fake `process.exit` runs the 'exit' listeners like the real one, then throws
// a sentinel so a test can stop where the real process would have ended.

const SENTINEL = new Error('process.exit called');
const ESC = '\x1b';
const HOOK_EVENTS = [
  'exit',
  'uncaughtException',
  'unhandledRejection',
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
] as const;

class FakeInput extends EventEmitter {
  readonly setRawMode = vi.fn((mode: boolean) => {
    this.log.push(`raw:${String(mode)}`);
  });
  readonly resume = vi.fn(() => {
    this.log.push('resume');
  });
  readonly pause = vi.fn(() => {
    this.log.push('pause');
  });

  constructor(private readonly log: string[]) {
    super();
  }
}

class FakeOutput extends EventEmitter {
  rows: number | undefined = 24;
  columns: number | undefined = 80;
  readonly chunks: string[] = [];
  failWrites = false;

  constructor(private readonly log: string[]) {
    super();
  }

  write(chunk: string): boolean {
    if (this.failWrites) throw new Error('EIO: terminal is gone');
    this.log.push('write');
    this.chunks.push(chunk);
    return true;
  }
}

class FakeProc extends EventEmitter {
  readonly exits: number[] = [];

  constructor(private readonly log: string[]) {
    super();
  }

  override prependListener(event: string | symbol, fn: (...args: unknown[]) => void): this {
    if (typeof event === 'string') this.log.push(`hook:${event}`);
    return super.prependListener(event, fn);
  }

  exit(code?: number): never {
    this.exits.push(code ?? 0);
    this.emit('exit', code ?? 0);
    throw SENTINEL;
  }
}

interface Rig {
  io: TerminalIo;
  input: FakeInput;
  output: FakeOutput;
  proc: FakeProc;
  log: string[];
  emitKeypressEvents: ReturnType<typeof vi.fn>;
  /** What an "earlier" listener (runCli's own) saw when it ran. */
  earlier: { event: string; restored: boolean }[];
}

function rig(): Rig {
  const log: string[] = [];
  const input = new FakeInput(log);
  const output = new FakeOutput(log);
  const proc = new FakeProc(log);
  const emitKeypressEvents = vi.fn(() => {
    log.push('keypress-events');
  });
  const earlier: Rig['earlier'] = [];
  // Listeners registered before the terminal opens, like runCli's own handlers.
  for (const event of HOOK_EVENTS) {
    proc.on(event, () => {
      earlier.push({ event, restored: output.chunks.includes(LEAVE_SCREEN) });
    });
  }
  const io = {
    input,
    output,
    proc,
    emitKeypressEvents,
  } as unknown as TerminalIo;
  return { io, input, output, proc, log, emitKeypressEvents, earlier };
}

function counts(r: Rig): Record<string, number> {
  const c: Record<string, number> = {};
  for (const event of HOOK_EVENTS) c[`proc:${event}`] = r.proc.listenerCount(event);
  c['input:keypress'] = r.input.listenerCount('keypress');
  c['output:resize'] = r.output.listenerCount('resize');
  return c;
}

function open(r: Rig, options: Omit<TerminalOptions, 'io'> = {}): ReturnType<typeof openTerminal> {
  return openTerminal({ io: r.io, ...options });
}

function leaves(r: Rig): number {
  return r.output.chunks.filter((c) => c === LEAVE_SCREEN).length;
}

describe('the escape sequences', () => {
  it('ENTER_SCREEN = alternate screen, cursor hidden, wrap off, clear', () => {
    expect(ENTER_SCREEN).toBe(`${ESC}[?1049h${ESC}[?25l${ESC}[?7l${ESC}[2J`);
  });

  it('LEAVE_SCREEN = attributes reset, wrap on, cursor shown, main screen back', () => {
    expect(LEAVE_SCREEN).toBe(`${ESC}[0m${ESC}[?7h${ESC}[?25h${ESC}[?1049l`);
  });
});

describe('openTerminal', () => {
  it('enables keypress events, sets raw mode on, resumes the input and enters the screen', () => {
    const r = rig();
    open(r);
    expect(r.emitKeypressEvents).toHaveBeenCalledTimes(1);
    expect(r.input.setRawMode.mock.calls).toEqual([[true]]);
    expect(r.input.resume).toHaveBeenCalledTimes(1);
    expect(r.output.chunks.join('')).toBe(ENTER_SCREEN);
  });

  it('the process hooks are installed before keypress events, raw mode and the screen', () => {
    const r = rig();
    open(r);
    const hooks = r.log.filter((l) => l.startsWith('hook:'));
    for (const event of HOOK_EVENTS) expect(hooks).toContain(`hook:${event}`);
    const lastHook = r.log.map((l) => l.startsWith('hook:')).lastIndexOf(true);
    expect(lastHook).toBeLessThan(r.log.indexOf('keypress-events'));
    expect(r.log.indexOf('keypress-events')).toBeLessThan(r.log.indexOf('raw:true'));
    expect(r.log.indexOf('raw:true')).toBeLessThan(r.log.indexOf('resume'));
    expect(r.log.indexOf('resume')).toBeLessThan(r.log.indexOf('write'));
  });

  it('a throwing setRawMode(true): rethrown as is, no hook left behind, nothing entered', () => {
    const r = rig();
    const before = counts(r);
    const refused = new Error('raw mode refused');
    r.input.setRawMode.mockImplementation(() => {
      throw refused;
    });
    expect(() => open(r)).toThrow(refused);
    expect(counts(r)).toEqual(before);
    expect(r.output.chunks).not.toContain(ENTER_SCREEN);
    expect(r.input.resume).not.toHaveBeenCalled();
    // A failed open leaves nothing behind that could still fire.
    r.proc.emit('exit', 1);
    expect(r.output.chunks.join('')).not.toContain(LEAVE_SCREEN);
  });
});

describe('size', () => {
  it('reports the output rows and columns', () => {
    const r = rig();
    r.output.rows = 31;
    r.output.columns = 101;
    expect(open(r).size()).toEqual({ rows: 31, cols: 101 });
  });

  it('undefined rows/columns (not a TTY) count as 0', () => {
    const r = rig();
    r.output.rows = undefined;
    r.output.columns = undefined;
    expect(open(r).size()).toEqual({ rows: 0, cols: 0 });
  });
});

describe('draw', () => {
  it('is one write: ESC[H, then every line erased first, joined by CRLF; the cursor line in reverse video', () => {
    const r = rig();
    const t = open(r);
    const before = r.output.chunks.length;
    t.draw({ lines: ['alpha', 'beta', 'gamma'], cursorLine: 1 });
    expect(r.output.chunks.slice(before)).toEqual([
      `${ESC}[H` + `${ESC}[2Kalpha\r\n` + `${ESC}[2K${ESC}[7mbeta${ESC}[27m\r\n` + `${ESC}[2Kgamma`,
    ]);
  });

  it('cursorLine null: no reverse video anywhere', () => {
    const r = rig();
    const t = open(r);
    const before = r.output.chunks.length;
    t.draw({ lines: ['one', 'two'], cursorLine: null });
    const frame = r.output.chunks.slice(before).join('');
    expect(frame).toBe(`${ESC}[H${ESC}[2Kone\r\n${ESC}[2Ktwo`);
    expect(frame).not.toContain(`${ESC}[7m`);
  });

  it('the cursor on the first and on the last line is highlighted there', () => {
    const r = rig();
    const t = open(r);
    t.draw({ lines: ['a', 'b'], cursorLine: 0 });
    t.draw({ lines: ['a', 'b'], cursorLine: 1 });
    const [first, last] = r.output.chunks.slice(-2);
    expect(first).toBe(`${ESC}[H${ESC}[2K${ESC}[7ma${ESC}[27m\r\n${ESC}[2Kb`);
    expect(last).toBe(`${ESC}[H${ESC}[2Ka\r\n${ESC}[2K${ESC}[7mb${ESC}[27m`);
  });

  it('never ends a line with ESC[K (with wrap off it would erase the last cell)', () => {
    const r = rig();
    const t = open(r);
    const before = r.output.chunks.length;
    t.draw({ lines: ['x'.repeat(80), 'y'.repeat(80)], cursorLine: 0 });
    const frame = r.output.chunks.slice(before).join('');
    expect(frame).not.toContain(`${ESC}[K`);
    expect(frame.endsWith('y'.repeat(80))).toBe(true);
  });
});

describe('clear and resize', () => {
  it('clear writes ESC[2J', () => {
    const r = rig();
    const t = open(r);
    const before = r.output.chunks.length;
    t.clear();
    expect(r.output.chunks.slice(before)).toEqual([`${ESC}[2J`]);
  });

  it('the resize handler fires on a resize of the output, each time', () => {
    const r = rig();
    const t = open(r);
    const fn = vi.fn();
    t.onResize(fn);
    r.output.emit('resize');
    r.output.emit('resize');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('keys', () => {
  it('the handler gets the readline key object', () => {
    const r = rig();
    const t = open(r);
    const fn = vi.fn();
    t.onKey(fn);
    const key = { name: 'up', sequence: `${ESC}[A`, ctrl: false, meta: false, shift: false };
    r.input.emit('keypress', undefined, key);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(key);
  });

  it('without a key object the handler gets { sequence: str }', () => {
    const r = rig();
    const t = open(r);
    const fn = vi.fn();
    t.onKey(fn);
    r.input.emit('keypress', 'x', undefined);
    expect(fn).toHaveBeenCalledWith({ sequence: 'x' });
  });
});

describe('restore', () => {
  it('writes LEAVE_SCREEN, sets raw mode off and pauses the input', () => {
    const r = rig();
    const t = open(r);
    t.restore();
    expect(leaves(r)).toBe(1);
    expect(r.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(r.input.pause).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second and third call do nothing', () => {
    const r = rig();
    const t = open(r);
    t.restore();
    t.restore();
    t.restore();
    expect(leaves(r)).toBe(1);
    expect(r.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(r.input.pause).toHaveBeenCalledTimes(1);
  });

  it('a throwing write is swallowed, raw mode is still turned off', () => {
    const r = rig();
    const t = open(r);
    r.output.failWrites = true;
    expect(() => t.restore()).not.toThrow();
    expect(r.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(r.input.pause).toHaveBeenCalledTimes(1);
  });

  it('a throwing setRawMode(false) is swallowed, the screen is left and the input paused', () => {
    const r = rig();
    const t = open(r);
    r.input.setRawMode.mockImplementation(() => {
      throw new Error('EIO');
    });
    expect(() => t.restore()).not.toThrow();
    expect(leaves(r)).toBe(1);
    expect(r.input.pause).toHaveBeenCalledTimes(1);
  });

  it('a throwing pause is swallowed', () => {
    const r = rig();
    const t = open(r);
    r.input.pause.mockImplementation(() => {
      throw new Error('EIO');
    });
    expect(() => t.restore()).not.toThrow();
    expect(leaves(r)).toBe(1);
  });
});

describe('close', () => {
  it('restores once and removes every listener the terminal added', () => {
    const r = rig();
    const before = counts(r);
    const t = open(r);
    t.onKey(() => undefined);
    t.onResize(() => undefined);
    expect(counts(r)).not.toEqual(before);
    t.close();
    expect(leaves(r)).toBe(1);
    expect(counts(r)).toEqual(before);
  });

  it('after restore(), close() writes LEAVE_SCREEN no second time', () => {
    const r = rig();
    const t = open(r);
    t.restore();
    t.close();
    t.close();
    expect(leaves(r)).toBe(1);
  });

  it('after close(), an exit no longer restores or calls onExit', () => {
    const r = rig();
    const onExit = vi.fn();
    const t = open(r, { onExit });
    t.close();
    r.proc.emit('exit', 1);
    expect(onExit).not.toHaveBeenCalled();
    expect(leaves(r)).toBe(1);
  });

  it('after close(), keys and resizes no longer reach the handlers', () => {
    const r = rig();
    const t = open(r);
    const onKey = vi.fn();
    const onResize = vi.fn();
    t.onKey(onKey);
    t.onResize(onResize);
    t.close();
    r.input.emit('keypress', 'a', { name: 'a' });
    r.output.emit('resize');
    expect(onKey).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();
  });
});

describe('abnormal ends (before close)', () => {
  it('a process exit restores the screen, then calls onExit(code) — before an earlier listener', () => {
    const r = rig();
    const calls: string[] = [];
    const onExit = vi.fn((code: number) => {
      calls.push(`onExit:${String(code)}:restored=${String(leaves(r) === 1)}`);
    });
    open(r, { onExit });
    r.proc.on('exit', () => calls.push('earlier'));
    r.proc.emit('exit', 7);
    expect(onExit).toHaveBeenCalledWith(7);
    expect(calls).toEqual(['onExit:7:restored=true', 'earlier']);
    expect(leaves(r)).toBe(1);
  });

  it('an exit without an onExit option still restores', () => {
    const r = rig();
    open(r);
    expect(() => r.proc.emit('exit', 0)).not.toThrow();
    expect(leaves(r)).toBe(1);
  });

  it('an exit after restore(): onExit still runs, no second LEAVE_SCREEN', () => {
    const r = rig();
    const onExit = vi.fn();
    const t = open(r, { onExit });
    t.restore();
    r.proc.emit('exit', 1);
    expect(leaves(r)).toBe(1);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it("SIGINT (from outside) → exit(130) before runCli's own handler runs", () => {
    const r = rig();
    const onExit = vi.fn();
    open(r, { onExit });
    expect(() => r.proc.emit('SIGINT')).toThrow(SENTINEL);
    expect(r.proc.exits).toEqual([130]);
    expect(r.earlier.filter((e) => e.event === 'SIGINT')).toEqual([]);
    // The exit path restored the screen and told the owner.
    expect(leaves(r)).toBe(1);
    expect(onExit).toHaveBeenCalledWith(130);
  });

  it('SIGTERM → exit(143), the screen restored, onExit(143)', () => {
    const r = rig();
    const onExit = vi.fn();
    open(r, { onExit });
    expect(() => r.proc.emit('SIGTERM')).toThrow(SENTINEL);
    expect(r.proc.exits).toEqual([143]);
    expect(leaves(r)).toBe(1);
    expect(onExit).toHaveBeenCalledWith(143);
  });

  it('SIGHUP → exit(129), the screen restored, onExit(129)', () => {
    const r = rig();
    const onExit = vi.fn();
    open(r, { onExit });
    expect(() => r.proc.emit('SIGHUP')).toThrow(SENTINEL);
    expect(r.proc.exits).toEqual([129]);
    expect(leaves(r)).toBe(1);
    expect(onExit).toHaveBeenCalledWith(129);
  });

  it.each(['uncaughtException', 'unhandledRejection'] as const)(
    '%s restores the screen before an earlier listener (runCli prints "Unexpected error") runs',
    (event) => {
      const r = rig();
      open(r);
      r.proc.emit(event, new Error('boom'));
      const seen = r.earlier.filter((e) => e.event === event);
      expect(seen).toEqual([{ event, restored: true }]);
      expect(leaves(r)).toBe(1);
    },
  );

  it('after the crash restore, the exit that follows does not write LEAVE_SCREEN again', () => {
    const r = rig();
    const onExit = vi.fn();
    open(r, { onExit });
    r.proc.emit('uncaughtException', new Error('boom'));
    r.proc.emit('exit', 1);
    expect(leaves(r)).toBe(1);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('after close(), the signal and crash hooks are gone', () => {
    const r = rig();
    const before = counts(r);
    const t = open(r);
    t.close();
    expect(counts(r)).toEqual(before);
    // Only the earlier listeners remain: nothing exits, nothing is written.
    expect(() => r.proc.emit('SIGINT')).not.toThrow();
    expect(() => r.proc.emit('SIGTERM')).not.toThrow();
    expect(() => r.proc.emit('SIGHUP')).not.toThrow();
    expect(r.proc.exits).toEqual([]);
  });
});
