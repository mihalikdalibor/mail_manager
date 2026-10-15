import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { eventText } from '../../src/cli/log-text.js';
import { isValidAuditEntry } from '../../src/core/audit.js';
import {
  EVENT_FIELDS,
  EVENT_KIND,
  eventLevel,
  filterDelete,
  filterSave,
  parseLogLine,
  renderEvent,
  validateRecord,
} from '../../src/core/log/index.js';
import type { LogEvent, LogRecord, RunContext } from '../../src/core/log/index.js';

// M3c filter.save / filter.delete (spec): the builders, their level and kind, the reader's schema,
// the mm logs texts, the catalog section in docs/LOGGING.md and the audit details.

const CTX: RunContext = {
  run: '0123456789abcdef',
  ver: '0.10.0',
  now: () => Date.UTC(2026, 9, 15, 9, 0, 0),
  level: 'debug',
};
const FILE_DATE = '2026-10-15';
const FILTER_ID = '11111111-1111-4111-8111-111111111111';

const LOGGING_MD = readFileSync(new URL('../../docs/LOGGING.md', import.meta.url), 'utf8');

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

type SaveFields = Parameters<typeof filterSave>[0];
type DeleteFields = Parameters<typeof filterDelete>[0];

const SAVE_OK: SaveFields = { filter: FILTER_ID, replaced: false, outcome: 'ok' };
const SAVE_FAILED: SaveFields = { outcome: 'failed', reason: 'duplicate' };
const DELETE_OK: DeleteFields = { filter: FILTER_ID, outcome: 'ok' };
const DELETE_FAILED: DeleteFields = { outcome: 'failed', reason: 'not-found' };

describe('filterSave builder', () => {
  it('ok: the filter id and replaced, no reason', () => {
    const e = filterSave({ filter: FILTER_ID, replaced: true, outcome: 'ok' });
    expect(fields(e)).toEqual({
      event: 'filter.save',
      filter: FILTER_ID,
      replaced: true,
      outcome: 'ok',
    });
    expect(Object.keys(e)).not.toContain('reason');
  });

  it('failed drops replaced and keeps the reason', () => {
    const e = filterSave({ filter: FILTER_ID, replaced: true, outcome: 'failed', reason: 'limit' });
    expect(fields(e)).toEqual({
      event: 'filter.save',
      filter: FILTER_ID,
      outcome: 'failed',
      reason: 'limit',
    });
    expect(Object.keys(e)).not.toContain('replaced');
  });

  it('failed without a reason, or with an unknown one, has reason unexpected', () => {
    expect(fields(filterSave({ ...SAVE_FAILED, reason: undefined }))['reason']).toBe('unexpected');
    const unknown = filterSave(cast<SaveFields>({ ...SAVE_FAILED, reason: 'nope' }));
    expect(fields(unknown)['reason']).toBe('unexpected');
  });

  it.each(['duplicate', 'not-found', 'limit', 'database', 'unexpected'] as const)(
    'failed keeps the reason %s',
    (reason) => {
      expect(fields(filterSave({ ...SAVE_FAILED, reason }))['reason']).toBe(reason);
    },
  );

  it('a non-UUID filter id is dropped; an unknown outcome is failed', () => {
    const badId = filterSave({ ...SAVE_OK, filter: 'my-filter' });
    expect(fields(badId)['filter']).toBeUndefined();
    expect(Object.keys(render(badId).record)).not.toContain('filter');

    const weird = filterSave(cast<SaveFields>({ ...SAVE_OK, outcome: 'weird' }));
    expect(fields(weird)['outcome']).toBe('failed');
    expect(fields(weird)['reason']).toBe('unexpected');
  });

  it('the filter id may be omitted (a save that failed before any row existed)', () => {
    const e = filterSave(SAVE_FAILED);
    expect(Object.keys(render(e).record)).not.toContain('filter');
  });

  it('an uppercase UUID is lowercased', () => {
    expect(fields(filterSave({ ...SAVE_OK, filter: FILTER_ID.toUpperCase() }))['filter']).toBe(
      FILTER_ID,
    );
  });

  it('level and kind: info when ok, warn when failed; kind app; the catalog field order', () => {
    expect(eventLevel(filterSave(SAVE_OK))).toBe('info');
    expect(eventLevel(filterSave(SAVE_FAILED))).toBe('warn');
    expect(EVENT_KIND['filter.save']).toBe('app');
    expect(EVENT_FIELDS['filter.save']).toEqual(['filter', 'replaced', 'outcome', 'reason']);
    expect(render(filterSave(SAVE_OK)).kind).toBe('app');
  });
});

describe('filterDelete builder', () => {
  it('ok: the filter id, no replaced and no reason', () => {
    const e = filterDelete(DELETE_OK);
    expect(fields(e)).toEqual({ event: 'filter.delete', filter: FILTER_ID, outcome: 'ok' });
    expect(Object.keys(e)).not.toContain('reason');
  });

  it('replaced is never a delete field, even when given', () => {
    const e = filterDelete(cast<DeleteFields>({ ...DELETE_OK, replaced: true }));
    expect(Object.keys(e)).not.toContain('replaced');
  });

  it('failed keeps the reason; a missing reason or an unknown one is unexpected', () => {
    expect(fields(filterDelete(DELETE_FAILED))['reason']).toBe('not-found');
    expect(fields(filterDelete({ ...DELETE_FAILED, reason: undefined }))['reason']).toBe(
      'unexpected',
    );
    const unknown = filterDelete(cast<DeleteFields>({ ...DELETE_FAILED, reason: 'nope' }));
    expect(fields(unknown)['reason']).toBe('unexpected');
  });

  it('a non-UUID filter id is dropped', () => {
    const e = filterDelete({ ...DELETE_OK, filter: 'my-filter' });
    expect(Object.keys(render(e).record)).not.toContain('filter');
  });

  it('level and kind: info when ok, warn when failed; kind app; the catalog field order', () => {
    expect(eventLevel(filterDelete(DELETE_OK))).toBe('info');
    expect(eventLevel(filterDelete(DELETE_FAILED))).toBe('warn');
    expect(EVENT_KIND['filter.delete']).toBe('app');
    expect(EVENT_FIELDS['filter.delete']).toEqual(['filter', 'outcome', 'reason']);
    expect(render(filterDelete(DELETE_OK)).kind).toBe('app');
  });
});

describe('filter.save and filter.delete reader (validateRecord)', () => {
  it('ok and failed lines of both events round-trip as readable records', () => {
    for (const e of [
      filterSave(SAVE_OK),
      filterSave(SAVE_FAILED),
      filterDelete(DELETE_OK),
      filterDelete(DELETE_FAILED),
    ]) {
      const { record, line } = render(e);
      expect(validate(line)).toEqual({ record });
    }
  });

  it('a reason on an ok line makes it unreadable (both events)', () => {
    expect(validate(edited(render(filterSave(SAVE_OK)).line, { reason: 'limit' }))).toEqual({
      skipped: 'unreadable',
    });
    expect(validate(edited(render(filterDelete(DELETE_OK)).line, { reason: 'limit' }))).toEqual({
      skipped: 'unreadable',
    });
  });

  it('a failed line without a reason makes it unreadable (both events)', () => {
    expect(validate(without(render(filterSave(SAVE_FAILED)).line, 'reason'))).toEqual({
      skipped: 'unreadable',
    });
    expect(validate(without(render(filterDelete(DELETE_FAILED)).line, 'reason'))).toEqual({
      skipped: 'unreadable',
    });
  });

  it('a filter id that is not a UUID makes the line unreadable', () => {
    const { line } = render(filterSave(SAVE_OK));
    expect(validate(edited(line, { filter: 'my-filter' }))).toEqual({ skipped: 'unreadable' });
  });

  it('replaced on a delete line makes it unreadable', () => {
    const { line } = render(filterDelete(DELETE_OK));
    expect(validate(edited(line, { replaced: false }))).toEqual({ skipped: 'unreadable' });
  });
});

describe('mm logs text for filter.save and filter.delete', () => {
  function text(e: LogEvent): string {
    return eventText(render(e).record);
  }

  it('a new filter reads as filter saved, a replaced one as filter replaced', () => {
    expect(text(filterSave(SAVE_OK))).toBe('filter saved');
    expect(text(filterSave({ ...SAVE_OK, replaced: true }))).toBe('filter replaced');
  });

  it('a failed save reads as its words', () => {
    expect(text(filterSave(SAVE_FAILED))).toBe('filter save failed: duplicate');
  });

  it('a delete reads as filter deleted', () => {
    expect(text(filterDelete(DELETE_OK))).toBe('filter deleted');
  });

  it('a failed delete reads as its words (not-found as not found)', () => {
    expect(text(filterDelete(DELETE_FAILED))).toBe('filter delete failed: not found');
  });

  it('the text never shows the filter id', () => {
    for (const e of [filterSave(SAVE_OK), filterDelete(DELETE_OK)]) {
      expect(text(e)).not.toContain(FILTER_ID);
    }
  });
});

describe('docs/LOGGING.md catalog', () => {
  /** The text from the M3c heading to the next heading (or the end of the file). */
  function section(): string {
    const start = LOGGING_MD.indexOf('### Saved filters (M3c)');
    if (start < 0) return '';
    const body = LOGGING_MD.indexOf('\n', start) + 1;
    const next = LOGGING_MD.slice(body).search(/^#{1,3} /m);
    return next < 0 ? LOGGING_MD.slice(start) : LOGGING_MD.slice(start, body + next);
  }

  function row(text: string, event: string): string[] {
    const line = text.split('\n').find((l) => l.startsWith(`| \`${event}\``));
    expect(line, `no catalog row for ${event}`).toBeDefined();
    return (line ?? '')
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
  }

  it('has a Saved filters (M3c) section right after the Filters (M3a) section', () => {
    const filters = LOGGING_MD.indexOf('### Filters (M3a)');
    const saved = LOGGING_MD.indexOf('### Saved filters (M3c)');
    expect(filters).toBeGreaterThanOrEqual(0);
    expect(saved).toBeGreaterThan(filters);
  });

  it('lists filter.save and filter.delete under the section, emitted from M3c', () => {
    const save = row(section(), 'filter.save');
    expect(save).toHaveLength(6);
    expect(save[1]).toMatch(/^A\s*\+\s*Au\b/);
    expect(save[5]).toBe('M3c');

    const del = row(section(), 'filter.delete');
    expect(del).toHaveLength(6);
    expect(del[1]).toMatch(/^A\s*\+\s*Au\b/);
    expect(del[5]).toBe('M3c');
  });

  it('the Later milestones M3 row no longer lists the filter events', () => {
    const m3 = LOGGING_MD.split('\n').find((l) => /^\|\s*M3\s*\|/.test(l));
    expect(m3).toBeDefined();
    expect(m3).not.toContain('filter.save');
    expect(m3).not.toContain('filter.delete');
  });
});

describe('audit details for filter.save and filter.delete', () => {
  it('filter.save with the filter id and replaced is a valid entry', () => {
    expect(
      isValidAuditEntry({
        action: 'filter.save',
        details: { filter: FILTER_ID, replaced: false },
        result: 'ok',
      }),
    ).toBe(true);
  });

  it('filter.save without details, with a name key, or with a bad id is refused', () => {
    expect(isValidAuditEntry({ action: 'filter.save', result: 'ok' })).toBe(false);
    expect(
      isValidAuditEntry({
        action: 'filter.save',
        details: { filter: FILTER_ID, replaced: false, name: 'big-old' },
        result: 'ok',
      }),
    ).toBe(false);
    expect(
      isValidAuditEntry({
        action: 'filter.save',
        details: { filter: 'big-old', replaced: false },
        result: 'ok',
      }),
    ).toBe(false);
  });

  it('filter.delete with the filter id is a valid entry; with replaced it is refused', () => {
    expect(
      isValidAuditEntry({
        action: 'filter.delete',
        details: { filter: FILTER_ID },
        result: 'ok',
      }),
    ).toBe(true);
    expect(
      isValidAuditEntry({
        action: 'filter.delete',
        details: { filter: FILTER_ID, replaced: false },
        result: 'ok',
      }),
    ).toBe(false);
  });

  it('filter.delete without details is refused', () => {
    expect(isValidAuditEntry({ action: 'filter.delete', result: 'ok' })).toBe(false);
  });
});
