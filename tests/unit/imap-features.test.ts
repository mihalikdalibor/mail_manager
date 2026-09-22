import { describe, it, expect } from 'vitest';
import {
  MAX_CAPABILITIES,
  MAX_CAPABILITY_NAME,
  buildServerFeatures,
  sanitizeCapabilities,
  sanitizeServerName,
  type CapabilityRecord,
  type ServerFeatures,
} from '../../src/core/imap/features.js';

// Measured post-auth capability set of the Websupport (Dovecot) test mailbox. imapflow keys
// its Map with the server's spelling, so 'IMAP4rev1' arrives mixed case.
const WEBSUPPORT_CAPS = [
  'IMAP4rev1',
  'SASL-IR',
  'LOGIN-REFERRALS',
  'ID',
  'ENABLE',
  'IDLE',
  'SORT',
  'SORT=DISPLAY',
  'THREAD=REFERENCES',
  'THREAD=REFS',
  'THREAD=ORDEREDSUBJECT',
  'MULTIAPPEND',
  'URL-PARTIAL',
  'CATENATE',
  'UNSELECT',
  'CHILDREN',
  'NAMESPACE',
  'UIDPLUS',
  'LIST-EXTENDED',
  'I18NLEVEL=1',
  'CONDSTORE',
  'QRESYNC',
  'ESEARCH',
  'ESORT',
  'SEARCHRES',
  'WITHIN',
  'CONTEXT=SEARCH',
  'LIST-STATUS',
  'BINARY',
  'MOVE',
  'SNIPPET=FUZZY',
  'PREVIEW=FUZZY',
  'PREVIEW',
  'STATUS=SIZE',
  'SAVEDATE',
  'LITERAL+',
  'NOTIFY',
  'COMPRESS=DEFLATE',
  'QUOTA',
];

function websupportMap(): Map<string, boolean | number> {
  return new Map(WEBSUPPORT_CAPS.map((c) => [c, true]));
}

function caps(...names: string[]): CapabilityRecord {
  return sanitizeCapabilities(new Map(names.map((n) => [n, true])));
}

const ALL_FALSE: Omit<ServerFeatures, 'appendLimit'> = {
  uidplus: false,
  move: false,
  specialUse: false,
  quota: false,
  statusSize: false,
  condstore: false,
  qresync: false,
  esearch: false,
  within: false,
  listStatus: false,
  objectId: false,
  gmail: false,
  idle: false,
  compress: false,
  rev2: false,
};

describe('sanitizeCapabilities', () => {
  it('limits are the documented constants', () => {
    expect(MAX_CAPABILITIES).toBe(256);
    expect(MAX_CAPABILITY_NAME).toBe(64);
  });

  it('uppercases names (imapflow reports IMAP4rev1 mixed case)', () => {
    const out = sanitizeCapabilities(websupportMap());
    expect(out['IMAP4REV1']).toBe(true);
    expect(Object.keys(out)).not.toContain('IMAP4rev1');
    expect(Object.keys(out)).toHaveLength(WEBSUPPORT_CAPS.length);
  });

  it('accepts a Map and a plain record alike', () => {
    const fromMap = sanitizeCapabilities(new Map<string, unknown>([['idle', true]]));
    const fromRecord = sanitizeCapabilities({ idle: true });
    expect(fromMap).toEqual({ IDLE: true });
    expect(fromRecord).toEqual({ IDLE: true });
  });

  it('returns names sorted', () => {
    const out = sanitizeCapabilities(new Map([...websupportMap()].reverse()));
    const keys = Object.keys(out);
    expect(keys).toEqual([...keys].sort());
    expect(keys[0]).toBe('BINARY');
  });

  it('keeps true and non-negative safe integers; drops every other value', () => {
    const out = sanitizeCapabilities({
      APPENDLIMIT: 35651584,
      ZERO: 0,
      MAXSAFE: Number.MAX_SAFE_INTEGER,
      IDLE: true,
      FALSEVAL: false,
      NEG: -1,
      FRACTION: 1.5,
      NAN: Number.NaN,
      INF: Number.POSITIVE_INFINITY,
      TOOBIG: Number.MAX_SAFE_INTEGER + 2,
      STR: '123',
      OBJ: { a: 1 },
      ARR: [1],
      NUL: null,
      UNDEF: undefined,
      BIG: 5n,
    });
    expect(out).toEqual({
      APPENDLIMIT: 35651584,
      IDLE: true,
      MAXSAFE: Number.MAX_SAFE_INTEGER,
      ZERO: 0,
    });
  });

  it('drops names that do not match the capability pattern', () => {
    const out = sanitizeCapabilities({
      '': true,
      '-LEADING': true,
      '=LEADING': true,
      'HAS SPACE': true,
      'CRLF\r\nX': true,
      'NUL\0': true,
      'ESC\u001b[31m': true,
      'ZW\u200bSP': true,
      ÜNICODE: true,
      'A(B)': true,
      'A"B': true,
      'A{5}': true,
      ['X'.repeat(65)]: true,
      ['Y'.repeat(64)]: true,
      'AUTH=PLAIN': true,
      'LITERAL+': true,
      'X-GM-EXT-1': true,
      'A.B_C/D': true,
      '9LIVES': true,
    });
    expect(Object.keys(out)).toEqual(
      ['9LIVES', 'A.B_C/D', 'AUTH=PLAIN', 'LITERAL+', 'X-GM-EXT-1', 'Y'.repeat(64)].sort(),
    );
  });

  it('caps the result at 256 entries: the first 256 valid names in sorted order', () => {
    const input = new Map<string, unknown>();
    // Insert in reverse so insertion order != sorted order.
    for (let i = 299; i >= 0; i--) input.set(`CAP${String(i).padStart(3, '0')}`, true);
    input.set('bad name', true);
    const out = sanitizeCapabilities(input);
    const keys = Object.keys(out);
    expect(keys).toHaveLength(256);
    expect(keys[0]).toBe('CAP000');
    expect(keys[255]).toBe('CAP255');
    expect(out['CAP256']).toBeUndefined();
  });

  it('a __proto__ key neither appears nor changes the prototype', () => {
    const poisoned = JSON.parse('{"__proto__": {"polluted": true}, "IDLE": true}') as Record<
      string,
      unknown
    >;
    const out = sanitizeCapabilities(poisoned);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['IDLE']);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect((out as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    const fromMap = sanitizeCapabilities(
      new Map<string, unknown>([
        ['__proto__', { polluted: true }],
        ['constructor', true],
        ['IDLE', true],
      ]),
    );
    expect(Object.getPrototypeOf(fromMap)).toBe(Object.prototype);
    expect(Object.keys(fromMap).sort()).toEqual(['CONSTRUCTOR', 'IDLE']);
    expect((fromMap as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('returns a fresh object (no aliasing of the input)', () => {
    const input = { IDLE: true };
    const out = sanitizeCapabilities(input);
    expect(out).not.toBe(input);
  });
});

describe('buildServerFeatures', () => {
  it('Websupport (Dovecot) fixture', () => {
    const f = buildServerFeatures(sanitizeCapabilities(websupportMap()), new Set(['CONDSTORE']));
    expect(f).toEqual<ServerFeatures>({
      uidplus: true,
      move: true,
      specialUse: false,
      quota: true,
      statusSize: true,
      condstore: true,
      qresync: true,
      esearch: true,
      within: true,
      listStatus: true,
      objectId: false,
      gmail: false,
      idle: true,
      compress: true,
      rev2: false,
      appendLimit: undefined,
    });
  });

  it('no capabilities → every flag false, appendLimit undefined', () => {
    expect(buildServerFeatures({}, new Set())).toEqual({ ...ALL_FALSE, appendLimit: undefined });
  });

  it.each<[string, keyof Omit<ServerFeatures, 'appendLimit' | 'rev2'>]>([
    ['UIDPLUS', 'uidplus'],
    ['MOVE', 'move'],
    ['SPECIAL-USE', 'specialUse'],
    ['QUOTA', 'quota'],
    ['STATUS=SIZE', 'statusSize'],
    ['CONDSTORE', 'condstore'],
    ['QRESYNC', 'qresync'],
    ['ESEARCH', 'esearch'],
    ['WITHIN', 'within'],
    ['LIST-STATUS', 'listStatus'],
    ['OBJECTID', 'objectId'],
    ['X-GM-EXT-1', 'gmail'],
    ['IDLE', 'idle'],
    ['COMPRESS=DEFLATE', 'compress'],
  ])('%s alone sets only %s', (cap, flag) => {
    const f = buildServerFeatures(caps(cap), new Set());
    expect(f).toEqual({ ...ALL_FALSE, [flag]: true, appendLimit: undefined });
  });

  it('near-miss names do not count (STATUS, COMPRESS=OTHER, X-GM-EXT-2)', () => {
    const f = buildServerFeatures(caps('STATUS', 'COMPRESS=OTHER', 'X-GM-EXT-2'), new Set());
    expect(f).toEqual({ ...ALL_FALSE, appendLimit: undefined });
  });

  it('CONDSTORE counts when only enabled', () => {
    expect(buildServerFeatures({}, new Set(['CONDSTORE'])).condstore).toBe(true);
  });

  it('appendLimit is the numeric APPENDLIMIT value, otherwise undefined', () => {
    expect(buildServerFeatures({ APPENDLIMIT: 35651584 }, new Set()).appendLimit).toBe(35651584);
    expect(buildServerFeatures({ APPENDLIMIT: 0 }, new Set()).appendLimit).toBe(0);
    // APPENDLIMIT without a value (per-mailbox limits) → no global number.
    expect(buildServerFeatures({ APPENDLIMIT: true }, new Set()).appendLimit).toBeUndefined();
  });

  describe('IMAP4rev2', () => {
    const FOLDED = {
      esearch: true,
      idle: true,
      listStatus: true,
      move: true,
      specialUse: true,
      statusSize: true,
      uidplus: true,
    };

    it('advertised and enabled → rev2 true and its built-in extensions count as present', () => {
      const f = buildServerFeatures(caps('IMAP4rev2'), new Set(['IMAP4REV2']));
      expect(f).toEqual({ ...ALL_FALSE, ...FOLDED, rev2: true, appendLimit: undefined });
    });

    it('rev2 does not imply extensions outside the rev2 base', () => {
      const f = buildServerFeatures(caps('IMAP4REV2'), new Set(['IMAP4REV2']));
      expect(f.condstore).toBe(false);
      expect(f.qresync).toBe(false);
      expect(f.quota).toBe(false);
      expect(f.within).toBe(false);
      expect(f.objectId).toBe(false);
      expect(f.gmail).toBe(false);
      expect(f.compress).toBe(false);
    });

    it('advertised but NOT enabled → rev2 false and nothing folded', () => {
      const f = buildServerFeatures(caps('IMAP4REV2'), new Set());
      expect(f).toEqual({ ...ALL_FALSE, appendLimit: undefined });
    });

    it('enabled but NOT advertised → rev2 false and nothing folded', () => {
      const f = buildServerFeatures({}, new Set(['IMAP4REV2']));
      expect(f).toEqual({ ...ALL_FALSE, appendLimit: undefined });
    });
  });
});

describe('sanitizeServerName', () => {
  it('returns a plain server name', () => {
    expect(sanitizeServerName({ name: 'Dovecot' })).toBe('Dovecot');
    expect(sanitizeServerName({ name: 'Microsoft Exchange-2019.x_1' })).toBe(
      'Microsoft Exchange-2019.x_1',
    );
    expect(sanitizeServerName({ name: 'N'.repeat(64) })).toBe('N'.repeat(64));
  });

  it('never returns the version or any other key', () => {
    const out = sanitizeServerName({ name: 'Dovecot', version: '2.3.21', vendor: 'secret' });
    expect(out).toBe('Dovecot');
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'Dovecot'],
    ['a number', 42],
    ['no name', { version: '1.0' }],
    ['numeric name', { name: 5 }],
    ['empty name', { name: '' }],
    ['too long', { name: 'N'.repeat(65) }],
    ['control chars', { name: 'Dove\r\ncot' }],
    ['escape sequence', { name: '\u001b[31mred' }],
    ['brackets', { name: '<script>' }],
    ['slash', { name: 'a/b' }],
    ['zero-width', { name: 'Dove\u200bcot' }],
  ])('%s → undefined', (_label, info) => {
    expect(sanitizeServerName(info)).toBeUndefined();
  });
});
