import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  MAX_LINE_BYTES,
  commandFinish,
  commandStart,
  outcomeFor,
  renderEvent,
  stackFrames,
  unexpectedError,
} from '../../src/core/log/index.js';
import type { LogEvent, RunContext } from '../../src/core/log/index.js';

const RT = { ver: '0.5.0', node: '22.13.0', os: 'linux' };
const CTX: RunContext = {
  run: '0123456789abcdef',
  ver: '0.5.0',
  now: () => Date.UTC(2026, 8, 23),
  level: 'debug',
};

const PASSWORD = 'hunter2-ÄŠť';
const ADDRESS = 'canary@secret-domain.example';
const HOST = 'imap.secret-host.example';
const SUBJECT = 'Tajný predmet';
const CANARIES = [PASSWORD, ADDRESS, HOST, SUBJECT, 'hunter2', 'secret-domain', 'secret-host'];

type Unexpected = Extract<LogEvent, { event: 'error.unexpected' }>;

function asUnexpected(e: LogEvent): Unexpected {
  if (e.event !== 'error.unexpected') throw new Error(`expected error.unexpected, got ${e.event}`);
  return e;
}

/** An Error whose stack is replaced by a crafted header + frame lines. */
function withStack(frames: string[], message = 'msg', name = 'Error'): Error {
  const e = new Error(message);
  if (name !== 'Error') e.name = name;
  e.stack = [`${name}: ${message}`, ...frames].join('\n');
  return e;
}

function thrower(message: string): Error {
  try {
    throw new Error(message);
  } catch (err) {
    return err as Error;
  }
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mm-builders-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('commandStart', () => {
  it('builds a command.start event with the runtime info', () => {
    expect(commandStart('discover', ['email'], RT)).toEqual({
      event: 'command.start',
      cmd: 'discover',
      opts: ['email'],
      ver: '0.5.0',
      node: '22.13.0',
      os: 'linux',
    });
  });

  it('keeps a multi-word command path', () => {
    const e = commandStart('account add', [], RT);
    expect(e).toMatchObject({ cmd: 'account add', opts: [] });
  });

  it('dedupes option names and keeps only safe names', () => {
    const e = commandStart(
      'login',
      [
        'email',
        'email',
        'dry-run',
        'a b',
        'e=mail',
        '',
        'č',
        ADDRESS,
        'x'.repeat(41),
        'y'.repeat(40),
      ],
      RT,
    );
    if (e.event !== 'command.start') throw new Error('wrong event');
    expect([...e.opts].sort()).toEqual(['dry-run', 'email', 'y'.repeat(40)].sort());
  });

  it('keeps at most 30 option names', () => {
    const names = Array.from({ length: 50 }, (_, i) => `opt${i}`);
    const e = commandStart('x', names, RT);
    if (e.event !== 'command.start') throw new Error('wrong event');
    expect(e.opts).toHaveLength(30);
    for (const o of e.opts) expect(names).toContain(o);
  });

  it('restricts cmd to [a-z0-9 -] and 100 characters', () => {
    const e = commandStart(`Account ADD\n{"x":1}${ADDRESS}${'a'.repeat(200)}`, [], RT);
    if (e.event !== 'command.start') throw new Error('wrong event');
    expect(e.cmd).toMatch(/^[a-z0-9 -]{0,100}$/);
    expect(e.cmd).not.toContain('@');
  });
});

describe('outcomeFor / commandFinish', () => {
  it.each([
    [0, 'ok'],
    [130, 'interrupted'],
    [1, 'failed'],
    [2, 'failed'],
    [255, 'failed'],
    [-1, 'failed'],
  ] as const)('exit %i → %s', (code, outcome) => {
    expect(outcomeFor(code)).toBe(outcome);
    expect(commandFinish('doctor', code, 10)).toMatchObject({ outcome, exit: code });
  });

  it('builds a command.finish event with a rounded duration', () => {
    expect(commandFinish('doctor', 1, 12.6)).toEqual({
      event: 'command.finish',
      cmd: 'doctor',
      outcome: 'failed',
      exit: 1,
      ms: 13,
    });
  });

  it.each([-5, NaN])('clamps a bad duration (%s) to 0', (ms) => {
    expect(commandFinish('doctor', 0, ms)).toMatchObject({ ms: 0 });
  });
});

describe('unexpectedError: errClass', () => {
  it('uses a well-formed err.name', () => {
    expect(unexpectedError(new TypeError('x'), root)).toMatchObject({
      event: 'error.unexpected',
      errClass: 'TypeError',
    });
    const e = new Error('x');
    e.name = 'My_Err2';
    expect(unexpectedError(e, root)).toMatchObject({ errClass: 'My_Err2' });
    e.name = `A${'b'.repeat(40)}`;
    expect(unexpectedError(e, root)).toMatchObject({ errClass: `A${'b'.repeat(40)}` });
  });

  it.each([
    ['with a space', 'bad name'],
    ['with an @', ADDRESS],
    ['non-ASCII', PASSWORD],
    ['too long', `A${'b'.repeat(41)}`],
    ['starting with a digit', '1Error'],
    ['empty', ''],
  ])('falls back to Error for a name %s', (_label, name) => {
    const e = new Error('x');
    e.name = name;
    expect(unexpectedError(e, root)).toMatchObject({ errClass: 'Error' });
  });

  it.each([
    ['a string', 'str'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a plain object', { message: 'x' }],
  ])('reports NonError with no stack for %s', (_label, thrown) => {
    const e = asUnexpected(unexpectedError(thrown, root));
    expect(e.errClass).toBe('NonError');
    expect(e.stack).toEqual([]);
    expect(e.code).toBeUndefined();
  });
});

describe('unexpectedError: code', () => {
  function withCode(code: unknown): Error {
    return Object.assign(new Error('x'), { code });
  }

  it.each(['ENOTFOUND', 'ERR_SOCKET_1', 'A'.repeat(40)])('keeps %s', (code) => {
    expect(asUnexpected(unexpectedError(withCode(code), root)).code).toBe(code);
  });

  it.each([
    ['numeric', 42],
    ['lower case', 'enotfound'],
    ['too long', 'A'.repeat(41)],
    ['with a dash', 'ERR-X'],
    ['with an address', ADDRESS],
    ['empty', ''],
  ])('drops a %s code', (_label, code) => {
    const e = asUnexpected(unexpectedError(withCode(code), root));
    expect(e.code).toBeUndefined();
    expect('code' in (renderEvent(e, CTX)?.record ?? {})).toBe(false);
  });
});

describe('stackFrames', () => {
  it('returns relative frames of a real error and never the message', () => {
    const frames = stackFrames(thrower(`boom ${PASSWORD}`), process.cwd());
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(10);
    expect(frames.some((f) => f.includes('tests/unit/log-builders.test.ts:'))).toBe(true);
    for (const f of frames) {
      expect(f).not.toContain('boom');
      expect(f).not.toContain(homedir());
      expect(f.length).toBeLessThanOrEqual(200);
    }
  });

  it('accepts a header written with Error when err.name was set after the stack was read', () => {
    const e = new Error('secret message');
    void e.stack;
    e.name = 'MyErr';
    expect(e.stack?.startsWith('Error: secret message')).toBe(true);
    const frames = stackFrames(e, process.cwd());
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.join('\n')).not.toContain('secret message');
  });

  it('accepts a subclass header (V8 formats it lazily from err.name)', () => {
    class MyErr extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'MyErr';
      }
    }
    const e = new MyErr('secret message');
    const frames = stackFrames(e, process.cwd());
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.join('\n')).not.toContain('secret message');
  });

  it('accepts a header written with the constructor name', () => {
    class OtherErr extends Error {}
    const e = new OtherErr('m');
    e.name = 'Renamed';
    e.stack = `OtherErr: m\n    at foo (${root}/a.js:1:1)`;
    expect(stackFrames(e, root)).toHaveLength(1);
  });

  it('accepts an error created with an empty message (V8 header without a colon)', () => {
    const frames = stackFrames(new Error(), process.cwd());
    expect(frames.length).toBeGreaterThan(0);
  });

  it('returns [] when the stack does not start with the header', () => {
    const e = new Error('msg');
    e.stack = `garbage\n    at foo (${root}/a.js:1:1)`;
    expect(stackFrames(e, root)).toEqual([]);
    e.stack = `Error: other message\n    at foo (${root}/a.js:1:1)`;
    expect(stackFrames(e, root)).toEqual([]);
  });

  it('returns [] when the message changed after the stack was first read', () => {
    const e = new Error('first');
    void e.stack;
    e.message = `second ${ADDRESS}`;
    expect(stackFrames(e, process.cwd())).toEqual([]);
  });

  it('cuts a multi-line message that contains fake frames', () => {
    const msg = `failed\n    at leak (${root}/${ADDRESS}.js:1:1)\n    at ${ADDRESS} (/home/x/secret.js:1:1)`;
    const e = withStack([`    at real (${root}/src/real.js:5:6)`], msg);
    const frames = stackFrames(e, root);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('real');
    expect(frames[0]).toContain('src/real.js:5:6');
    expect(frames.join('\n')).not.toContain('leak');
  });

  it('makes paths under the root relative with /', () => {
    const [f] = stackFrames(withStack([`    at foo (${root}${sep}src${sep}a.js:1:2)`]), root);
    expect(f).toContain('foo');
    expect(f).toContain('src/a.js:1:2');
    expect(f).not.toContain(root);
  });

  it('handles an anonymous frame without parentheses', () => {
    const [f] = stackFrames(withStack([`    at ${root}/src/a.js:3:4`]), root);
    expect(f).toContain('src/a.js:3:4');
    expect(f).not.toContain(root);
  });

  it('converts file:// URLs under the root to relative paths', () => {
    const url = `${pathToFileURL(root).href}/src/a.js`;
    const [f] = stackFrames(withStack([`    at foo (${url}:3:4)`]), root);
    expect(f).toContain('src/a.js:3:4');
    expect(f).not.toContain('file:');
    expect(f).not.toContain(root);
  });

  it.each([
    ['another absolute path', `/etc/${HOST}/a.js:1:1`],
    ['the home dir', `${homedir()}/x/a.js:1:1`],
    ['a relative path', `src/${HOST}.js:1:1`],
    ['a sibling of the root with the same prefix', `${root}-evil/a.js:1:1`],
    ['a file:// URL outside the root', `file:///${HOST}/a.js:1:1`],
  ])('replaces %s with <external>', (_label, location) => {
    const [f] = stackFrames(withStack([`    at foo (${location})`]), root);
    expect(f).toContain('<external>');
    expect(f).not.toContain(HOST);
    expect(f).not.toContain(homedir());
    expect(f).not.toContain(`${root}-evil`);
  });

  it.each(['node:internal/process/task_queues:95:5', 'native', '<anonymous>'])(
    'keeps the location %s',
    (location) => {
      const [f] = stackFrames(withStack([`    at foo (${location})`]), root);
      expect(f).toContain(location);
    },
  );

  it.each(['foo', 'Object.<anonymous>', 'new Foo', 'Array.map [as x]', '$fn_1'])(
    'keeps the function name %s',
    (name) => {
      const [f] = stackFrames(withStack([`    at ${name} (${root}/a.js:1:1)`]), root);
      expect(f).toContain(name);
    },
  );

  it.each([ADDRESS, PASSWORD, SUBJECT, HOST, 'a"b', 'x'.repeat(81)])(
    'replaces the function name %s with <fn>',
    (name) => {
      const [f] = stackFrames(withStack([`    at ${name} (${root}/a.js:1:1)`]), root);
      expect(f).toContain('<fn>');
      expect(f).not.toContain(name);
    },
  );

  it('collapses eval frames to "eval"', () => {
    const inner = `file://${homedir()}/${HOST}/a.js`;
    const frames = stackFrames(
      withStack([
        `    at eval (eval at ${ADDRESS} (${inner}:1:1), <anonymous>:1:1)`,
        `    at eval at foo (${root}/a.js:1:1)`,
      ]),
      root,
    );
    expect(frames).toEqual(['eval', 'eval']);
  });

  it('replaces non-printable-ASCII, quotes and backslashes with ?', () => {
    const [f] = stackFrames(withStack([`    at foo (${root}/sü"b\\d\u0001/a.js:1:1)`]), root);
    expect(f).toContain('s??b?d?/a.js:1:1');
    expect(f).toMatch(/^[\x20-\x7e]*$/);
    expect(f).not.toMatch(/["\\]/);
  });

  it('caps each frame at 200 characters and the stack at 10 frames', () => {
    const lines = Array.from(
      { length: 15 },
      (_, i) => `    at f${i} (${root}/${'d'.repeat(400)}.js:1:1)`,
    );
    const frames = stackFrames(withStack(lines), root);
    expect(frames).toHaveLength(10);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(200);
    expect(frames[0]).toContain('f0');
  });

  it('survives throwing getters and a non-string stack', () => {
    const e = new Error('x');
    Object.defineProperty(e, 'stack', {
      get() {
        throw new Error('stack getter');
      },
    });
    expect(stackFrames(e, root)).toEqual([]);
    const f = new Error('x');
    Object.defineProperty(f, 'stack', { value: 42 });
    expect(stackFrames(f, root)).toEqual([]);
  });
});

describe('unexpectedError: robustness', () => {
  it('survives throwing name, stack and code getters', () => {
    const e = new Error('x');
    for (const key of ['name', 'stack', 'code']) {
      Object.defineProperty(e, key, {
        get() {
          throw new Error(`${key} getter ${PASSWORD}`);
        },
      });
    }
    let ev: LogEvent | undefined;
    expect(() => {
      ev = unexpectedError(e, root);
    }).not.toThrow();
    expect(ev?.event).toBe('error.unexpected');
    expect(JSON.stringify(ev)).not.toContain('hunter2');
  });

  it('survives a non-string stack', () => {
    const e = new Error('x');
    Object.defineProperty(e, 'stack', { value: { toString: () => PASSWORD } });
    const ev = asUnexpected(unexpectedError(e, root));
    expect(ev.stack).toEqual([]);
  });

  it('worst case: 10 frames of 200 hostile characters still fit in one line', () => {
    const hostile = '"\\\u0001\u001b\u2028'.repeat(80);
    const lines = Array.from({ length: 12 }, () => `    at foo (${root}/${hostile}.js:1:1)`);
    const r = renderEvent(unexpectedError(withStack(lines), root), CTX);
    expect(r).not.toBeNull();
    expect(r?.record.event).toBe('error.unexpected');
    expect(Buffer.byteLength(r?.line ?? '', 'utf8')).toBeLessThanOrEqual(MAX_LINE_BYTES);
  });
});

describe('canary: no secret reaches a rendered error line', () => {
  const home = homedir();
  const message = `login ${ADDRESS} pass ${PASSWORD} host ${HOST} subject ${SUBJECT} in ${home}/x\n    at ${ADDRESS} (/home/x/secret.js:1:1)`;

  function canaryErrors(): unknown[] {
    const real = thrower(message);
    Object.assign(real, { code: PASSWORD, cause: new Error(message) });

    const named = thrower(message);
    named.name = PASSWORD;

    const addressName = thrower(message);
    addressName.name = ADDRESS;
    Object.assign(addressName, { code: ADDRESS });

    const crafted = withStack(
      [
        `    at leak (${home}/${ADDRESS}-dir/a.js:1:1)`,
        `    at ${SUBJECT} (${home}/secret.js:1:1)`,
        `    at eval (eval at canary (file://${home}/${HOST}/x.js:1:1), <anonymous>:1:1)`,
        `    at ${PASSWORD} (file:///${HOST}/a.js:1:1)`,
        `    at bär (${HOST}:993)`,
        `    at foo (file://${home}/${ADDRESS}/b.js:2:3)`,
        `    at Object.<anonymous> (${home}/.config/mail-manager/${SUBJECT}.js:1:1)`,
      ],
      message,
    );

    const lateMessage = thrower('harmless');
    void lateMessage.stack;
    lateMessage.message = message;

    const getters = new Error(message);
    for (const key of ['name', 'stack', 'code']) {
      Object.defineProperty(getters, key, {
        get() {
          throw new Error(message);
        },
      });
    }

    return [
      real,
      named,
      addressName,
      crafted,
      lateMessage,
      getters,
      message,
      { name: ADDRESS, message, stack: `Error: ${message}`, code: 'ENOTFOUND' },
    ];
  }

  function checkRoot(r: string): void {
    for (const err of canaryErrors()) {
      const rendered = renderEvent(unexpectedError(err, r), CTX);
      expect(rendered).not.toBeNull();
      const line = rendered?.line ?? '';
      for (const c of CANARIES) expect(line).not.toContain(c);
      expect(line).not.toContain(home);
      expect(line).not.toContain('ÄŠť');
      expect(line).not.toContain('Tajn');
    }
  }

  it('with a temp dir as root', () => {
    checkRoot(root);
  });

  it('with the working directory as root', () => {
    checkRoot(process.cwd());
  });
});

describe('stackFrames: review fixes', () => {
  it('accepts a Node-style header with the error code in brackets', () => {
    const e = new TypeError(`msg ${PASSWORD}`);
    Object.assign(e, { code: 'ERR_INVALID_ARG_TYPE' });
    e.stack = `TypeError [ERR_INVALID_ARG_TYPE]: msg ${PASSWORD}\n    at foo (${root}/a.js:1:1)`;
    const frames = stackFrames(e, root);
    expect(frames).toHaveLength(1);
    expect(frames.join('\n')).not.toContain('msg');
    expect(frames.join('\n')).not.toContain('hunter2');
  });

  it('keeps the frames of a real Node internal error', () => {
    let caught: unknown;
    try {
      Buffer.from(123 as unknown as string);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as { code?: unknown }).code).toBe('ERR_INVALID_ARG_TYPE');
    const frames = stackFrames(caught as Error, process.cwd());
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.join('\n')).not.toContain('argument');
  });

  it('a non-frame line ends the frame block', () => {
    const e = withStack(
      [`    at a (${root}/x.js:1:1)`, 'Caused by: secret', `    at leakyName (${root}/y.js:1:1)`],
      'm',
    );
    const frames = stackFrames(e, root);
    expect(frames).toHaveLength(1);
    expect(frames.join('\n')).not.toContain('leakyName');
    expect(frames.join('\n')).not.toContain('secret');
  });

  it('drops the function name of a frame outside the root', () => {
    const [f] = stackFrames(withStack(['    at Hunter2Password (/tmp/x.js:1:1)']), root);
    expect(f).toBe('<fn> (<external>)');
  });

  it.each(['<anonymous>', 'native'])('drops the function name for a %s location', (location) => {
    const [f] = stackFrames(withStack([`    at imap.gmail.com (${location})`]), root);
    expect(f).toContain('<fn>');
    expect(f).not.toContain('imap.gmail.com');
  });

  it('keeps the function name for a node: location', () => {
    const [f] = stackFrames(
      withStack(['    at Module._compile (node:internal/modules/cjs/loader:1705:14)']),
      root,
    );
    expect(f).toContain('Module._compile');
  });

  it('replaces a name with inner spaces by <fn>', () => {
    const [f] = stackFrames(withStack([`    at leaky name (${root}/x.js:1:1)`]), root);
    expect(f).toContain('<fn>');
    expect(f).not.toContain('leaky');
    expect(f).toContain('x.js:1:1');
  });

  it.each(['async fn', 'new Foo', 'Object.<anonymous>', 'obj.fn [as alias]'])(
    'keeps %s inside the root',
    (name) => {
      const [f] = stackFrames(withStack([`    at ${name} (${root}/x.js:1:1)`]), root);
      expect(f).toContain(name);
      expect(f).toContain('x.js:1:1');
    },
  );

  it.each([
    ['a path climbing out of the root', (r: string) => `${r}/../../home/x/secret.ts:1:1`],
    ['a path climbing out to a sibling', (r: string) => `${r}/sub/../../x-secret/a.js:1:1`],
    ['the root itself', (r: string) => r],
    ['the root itself with a position', (r: string) => `${r}:1:1`],
  ])('treats %s as <external>', (_label, location) => {
    const [f] = stackFrames(withStack([`    at foo (${location(root)})`]), root);
    expect(f).toContain('<external>');
    expect(f).not.toContain('..');
    expect(f).not.toContain('secret');
  });
});
