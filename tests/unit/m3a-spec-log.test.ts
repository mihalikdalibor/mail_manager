import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { eventText } from '../../src/cli/log-text.js';
import {
  EVENT_FIELDS,
  EVENT_KIND,
  eventLevel,
  parseLogLine,
  renderEvent,
  searchFinish,
  validateRecord,
} from '../../src/core/log/index.js';
import type { LogEvent, LogRecord, RunContext } from '../../src/core/log/index.js';

// M3a search.finish (spec): the builder, its level and kind, the reader's schema, the mm logs text,
// the catalog row in docs/LOGGING.md and the canary (no filter value reaches any line).

const CTX: RunContext = {
  run: '0123456789abcdef',
  ver: '0.9.0',
  now: () => Date.UTC(2026, 9, 13, 9, 0, 0),
  level: 'debug',
};
const FILE_DATE = '2026-10-13';
const ACCT = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';

const CANARY_ADDRESS = 'canary@secret-domain.example';
const CANARY_WORD = 'CANARYWORD';
const CANARY_DAY = '2019-03-04';
const CANARY_SIZE = '7654321';
const CANARIES = [CANARY_ADDRESS, CANARY_WORD, CANARY_DAY, CANARY_SIZE];

const LOGGING_MD = readFileSync(new URL('../../docs/LOGGING.md', import.meta.url), 'utf8');

type SearchFinishFields = Parameters<typeof searchFinish>[0];

function cast<T>(value: unknown): T {
  return value as T;
}

function fields(e: LogEvent): Record<string, unknown> {
  return { ...e };
}

function render(e: LogEvent): { kind: string; record: LogRecord; line: string } {
  const r = renderEvent(e, CTX);
  if (r === null) throw new Error('not rendered');
  return r;
}

function validate(line: string): ReturnType<typeof validateRecord> {
  const parsed = parseLogLine(line);
  if (parsed === null) throw new Error('not parsed');
  return validateRecord(parsed, 'app', FILE_DATE);
}

function edited(line: string, change: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), ...change });
}

function without(line: string, key: string): string {
  const obj = JSON.parse(line) as Record<string, unknown>;
  delete obj[key];
  return JSON.stringify(obj);
}

const OK: SearchFinishFields = {
  acct: ACCT,
  count: 37,
  bytes: 5000,
  ms: 1200,
  criteria: ['from', 'larger'],
  outcome: 'ok',
};

const FAILED: SearchFinishFields = {
  acct: ACCT,
  count: 0,
  bytes: 0,
  ms: 80,
  criteria: ['word'],
  outcome: 'failed',
  reason: 'search-failed',
};

describe('searchFinish builder', () => {
  it('ok: count, bytes, rounded ms and criteria names in CRITERIA order, no reason', () => {
    const e = searchFinish({
      acct: ACCT,
      count: 37,
      bytes: 5000,
      ms: 1200.4,
      criteria: ['larger', 'from', 'from', 'nonsense'],
      outcome: 'ok',
    });
    expect(fields(e)).toEqual({
      event: 'search.finish',
      acct: ACCT,
      count: 37,
      bytes: 5000,
      ms: 1200,
      criteria: ['from', 'larger'],
      outcome: 'ok',
    });
    expect(Object.keys(e)).not.toContain('reason');
  });

  it('failed always has a reason: unexpected when none is given or it is unknown', () => {
    const none = searchFinish({ ...FAILED, reason: undefined });
    expect(fields(none)['reason']).toBe('unexpected');
    const unknown = searchFinish(cast<SearchFinishFields>({ ...FAILED, reason: 'nope' }));
    expect(fields(unknown)['reason']).toBe('unexpected');
  });

  it.each(['search-failed', 'too-many-matches', 'connection-lost'] as const)(
    'failed keeps the reason %s',
    (reason) => {
      expect(fields(searchFinish({ ...FAILED, reason }))['reason']).toBe(reason);
    },
  );

  it('bad input is cleaned: a non-UUID acct is dropped, a negative count is 0, an unknown outcome is failed', () => {
    const badAcct = searchFinish({ ...OK, acct: 'x' });
    expect(fields(badAcct)['acct']).toBeUndefined();
    expect(Object.keys(render(badAcct).record)).not.toContain('acct');

    expect(fields(searchFinish({ ...OK, count: -1 }))['count']).toBe(0);

    const weird = searchFinish(cast<SearchFinishFields>({ ...OK, outcome: 'weird' }));
    expect(fields(weird)['outcome']).toBe('failed');
    expect(fields(weird)['reason']).toBe('unexpected');
  });

  it.each<unknown>([NaN, Infinity, -Infinity, 2 ** 60, '12', null, undefined])(
    'garbage count %j → 0, and garbage ms → 0',
    (n) => {
      const e = fields(
        searchFinish(cast<SearchFinishFields>({ ...OK, count: n, bytes: n, ms: n })),
      );
      expect(e).toMatchObject({ count: 0, bytes: 0, ms: 0 });
    },
  );

  it('an uppercase UUID is lowercased; acct may be omitted', () => {
    expect(fields(searchFinish({ ...OK, acct: ACCT.toUpperCase() }))['acct']).toBe(ACCT);
    const noAcct = searchFinish({ ...OK, acct: undefined });
    expect(Object.keys(render(noAcct).record)).not.toContain('acct');
  });

  it('level and kind: info when ok, warn when failed; kind app; the catalog field order', () => {
    expect(eventLevel(searchFinish(OK))).toBe('info');
    expect(eventLevel(searchFinish(FAILED))).toBe('warn');
    expect(EVENT_KIND['search.finish']).toBe('app');
    expect(EVENT_FIELDS['search.finish']).toEqual([
      'acct',
      'count',
      'bytes',
      'ms',
      'criteria',
      'outcome',
      'reason',
    ]);
    expect(render(searchFinish(OK)).kind).toBe('app');
  });
});

describe('search.finish reader (validateRecord)', () => {
  it('ok and failed lines round-trip as readable records', () => {
    for (const e of [searchFinish(OK), searchFinish(FAILED)]) {
      const { record, line } = render(e);
      expect(validate(line)).toEqual({ record });
    }
  });

  it('a criterion that is a value (an address), not a name, makes the line unreadable', () => {
    const { line } = render(searchFinish(OK));
    expect(validate(edited(line, { criteria: ['from', CANARY_ADDRESS] }))).toEqual({
      skipped: 'unreadable',
    });
  });

  it('a reason on an ok line makes it unreadable', () => {
    const { line } = render(searchFinish(OK));
    expect(validate(edited(line, { reason: 'search-failed' }))).toEqual({
      skipped: 'unreadable',
    });
  });

  it('a failed line without a reason makes it unreadable', () => {
    const { line } = render(searchFinish(FAILED));
    expect(validate(without(line, 'reason'))).toEqual({ skipped: 'unreadable' });
  });

  it('an extra field such as the filter text makes it unreadable', () => {
    const { line } = render(searchFinish(OK));
    expect(validate(edited(line, { filter: 'from:shop.example' }))).toEqual({
      skipped: 'unreadable',
    });
  });
});

describe('mm logs text for search.finish', () => {
  function text(e: LogEvent): string {
    return eventText(render(e).record);
  }

  it('ok: count, duration and the criteria names', () => {
    expect(text(searchFinish(OK))).toBe('mail filter: 37 mails found in 1.2 s (from, larger)');
  });

  it('one mail is singular', () => {
    expect(text(searchFinish({ ...OK, count: 1 }))).toBe(
      'mail filter: 1 mail found in 1.2 s (from, larger)',
    );
  });

  it('no criteria reads as (no criteria)', () => {
    expect(text(searchFinish({ ...OK, criteria: [] }))).toBe(
      'mail filter: 37 mails found in 1.2 s (no criteria)',
    );
  });

  it('failed search-failed reads as its words', () => {
    expect(text(searchFinish(FAILED))).toBe('mail filter failed: search failed');
  });

  it('failed too-many-matches reads as its words', () => {
    expect(text(searchFinish({ ...FAILED, reason: 'too-many-matches' }))).toBe(
      'mail filter failed: too many matches',
    );
  });
});

describe('canary: no filter value reaches a line', () => {
  it('criteria values, an address as acct and a word as reason are dropped', () => {
    const e = searchFinish(
      cast<SearchFinishFields>({
        acct: CANARY_ADDRESS,
        count: 1,
        bytes: 1,
        ms: 1,
        criteria: CANARIES,
        outcome: 'failed',
        reason: CANARY_WORD,
      }),
    );
    const json = JSON.stringify(e);
    const { line } = render(e);
    for (const c of CANARIES) {
      expect(json, `event leaks ${c}`).not.toContain(c);
      expect(line, `line leaks ${c}`).not.toContain(c);
    }
  });
});

describe('docs/LOGGING.md catalog', () => {
  it('lists search.finish under M3a', () => {
    expect(LOGGING_MD).toContain('### Filters (M3a)');
    const row = LOGGING_MD.split('\n').find((l) => /^\|\s*`search\.finish`\s*\|/.test(l));
    expect(row).toBeDefined();
    const cells = (row ?? '')
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    expect(cells).toHaveLength(6);
    expect(cells[5]).toBe('M3a');
  });
});
