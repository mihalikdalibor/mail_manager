import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LOG_EVENT_NAMES } from '../../src/core/log/index.js';

const LOGGING_MD = readFileSync(new URL('../../docs/LOGGING.md', import.meta.url), 'utf8');

interface CatalogRow {
  name: string;
  emittedFrom: string;
}

/** Rows of the "### Foundation (M1b-4)" table: `| `event.name` | Kind | Level | Fields | OWASP | Emitted from |`. */
function foundationRows(md: string): CatalogRow[] {
  const start = md.indexOf('### Foundation (M1b-4)');
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = md.slice(md.indexOf('\n', start) + 1);
  const next = rest.search(/^#{1,3} /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  const rows: CatalogRow[] = [];
  for (const line of section.split('\n')) {
    const m = /^\|\s*`([a-z0-9.-]+)`\s*\|/.exec(line);
    if (!m?.[1]) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    expect(cells).toHaveLength(6);
    rows.push({ name: m[1], emittedFrom: cells[5] ?? '' });
  }
  return rows;
}

describe('docs/LOGGING.md event catalog', () => {
  const rows = foundationRows(LOGGING_MD);

  it('has foundation rows', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it('lists every event the code can emit', () => {
    const names = rows.map((r) => r.name);
    for (const name of LOG_EVENT_NAMES) expect(names).toContain(name);
  });

  it.each(['M1b-4a', 'M1b-4b'])('every row marked as emitted from %s exists in the code', (ms) => {
    const emitted = rows.filter((r) => r.emittedFrom === ms).map((r) => r.name);
    expect(emitted.length).toBeGreaterThan(0);
    for (const name of emitted) expect(LOG_EVENT_NAMES).toContain(name);
  });
});
