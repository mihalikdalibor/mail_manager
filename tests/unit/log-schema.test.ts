import { describe, it, expect } from 'vitest';
import { formatLine, parseLogLine, renderEvent, toRecord } from '../../src/core/log/index.js';
import type { LogEvent, LogRecord, RunContext } from '../../src/core/log/index.js';

const CTX: RunContext = {
  run: '5f3a9c1e2b7d4a60',
  ver: '0.5.0',
  now: () => Date.UTC(2026, 8, 23, 10, 15, 2, 123),
  level: 'debug',
};

const EVENTS: LogEvent[] = [
  {
    event: 'command.start',
    cmd: 'discover',
    opts: ['email'],
    ver: '0.5.0',
    node: '22',
    os: 'linux',
  },
  { event: 'command.finish', cmd: 'discover', outcome: 'interrupted', exit: 130, ms: 7 },
  { event: 'error.unexpected', errClass: 'TypeError', code: 'ERR_X', stack: ['foo (a.js:1:1)'] },
  { event: 'log.truncated' },
];

const BASE: LogRecord = toRecord(EVENTS[0] as LogEvent, CTX);

function line(overrides: Record<string, unknown>, drop: string[] = []): string {
  const rec: Record<string, unknown> = { ...BASE, ...overrides };
  for (const k of drop) delete rec[k];
  return JSON.stringify(rec);
}

describe('parseLogLine', () => {
  it.each(EVENTS.map((e) => [e.event, e] as const))('round-trips a rendered %s line', (_n, e) => {
    const r = renderEvent(e, CTX);
    expect(r).not.toBeNull();
    expect(parseLogLine(r?.line ?? '')).toEqual({ kind: 'app', record: r?.record });
  });

  it('recognises security lines by their prefix', () => {
    const l = formatLine(BASE, 'security');
    expect(parseLogLine(l)).toEqual({ kind: 'security', record: BASE });
  });

  it('accepts lines up to the cap (4096 bytes, plus the prefix for security lines)', () => {
    const short = line({ pad: '' });
    const pad = 'x'.repeat(4096 - Buffer.byteLength(short));
    const atCap = line({ pad });
    expect(Buffer.byteLength(atCap)).toBe(4096);
    expect(parseLogLine(atCap)?.kind).toBe('app');
    expect(parseLogLine(`mm-security ${atCap}`)?.kind).toBe('security');
  });

  it.each([
    ['an empty line', ''],
    ['garbage', 'hello world'],
    ['truncated JSON', line({}).slice(0, 40)],
    ['a JSON array', '[1,2,3]'],
    ['a JSON number', '42'],
    ['JSON null', 'null'],
    ['a JSON string', '"text"'],
    ['a malformed run id', line({ run: 'xyz' })],
    ['an upper-case run id', line({ run: '5F3A9C1E2B7D4A60' })],
    ['a 15-character run id', line({ run: '5f3a9c1e2b7d4a6' })],
    ['a bad level', line({ level: 'fatal' })],
    ['a missing v', line({}, ['v'])],
    ['a non-numeric v', line({ v: '1' })],
    ['a missing event', line({}, ['event'])],
    ['a non-ISO ts', line({ ts: 'yesterday' })],
    ['a date-only ts', line({ ts: '2026-09-23' })],
    ['a missing ts', line({}, ['ts'])],
    ['an unknown prefix', `mm-securityX${line({})}`],
    ['an over-long app line', line({ pad: 'x'.repeat(5000) })],
    ['an over-long security line', `mm-security ${line({ pad: 'x'.repeat(5000) })}`],
    [
      'a security line one byte over the cap',
      `mm-security ${line({ pad: 'x'.repeat(4097 - line({ pad: '' }).length) })}`,
    ],
  ])('returns null for %s', (_label, input) => {
    expect(parseLogLine(input)).toBeNull();
  });

  it('never throws on arbitrary input', () => {
    let seed = 42;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const alphabet = '{}[]":,.\\ abcmm-security0123456789\u0000\u2028ü\n';
    const inputs: string[] = [
      '{"__proto__":{"polluted":1},"ts":"x"}',
      `${'['.repeat(2000)}${']'.repeat(2000)}`,
      'mm-security ',
      'mm-security',
      '\uFEFF{}',
      '{"ts":"2026-09-23T10:15:02.123Z","event":{"x":1},"level":"info","run":"5f3a9c1e2b7d4a60","v":1}',
    ];
    for (let i = 0; i < 300; i++) {
      const len = rand(200);
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[rand(alphabet.length)] ?? '';
      inputs.push(s);
    }
    for (const input of inputs) expect(() => parseLogLine(input)).not.toThrow();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
