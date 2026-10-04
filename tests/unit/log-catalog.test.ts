import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LOG_EVENT_NAMES } from '../../src/core/log/index.js';

const LOGGING_MD = readFileSync(new URL('../../docs/LOGGING.md', import.meta.url), 'utf8');

interface CatalogRow {
  name: string;
  emittedFrom: string;
}

/** The catalog tables whose rows are events: `| `event.name` | Kind | Level | Fields | OWASP | Emitted from |`. */
const CATALOG_TABLES = [
  '### Foundation (M1b-4)',
  '### Account commands (M1c-1)',
  '### Mailbox insight (M2a)',
  '### Folder browser (M2b-2)',
  '### Mailbox stats (M2c-1)',
];

function tableRows(md: string, heading: string): CatalogRow[] {
  const start = md.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
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

function catalogRows(md: string): CatalogRow[] {
  return CATALOG_TABLES.flatMap((heading) => tableRows(md, heading));
}

describe('docs/LOGGING.md event catalog', () => {
  const rows = catalogRows(LOGGING_MD);

  it.each(CATALOG_TABLES)('has rows in %s', (heading) => {
    expect(tableRows(LOGGING_MD, heading).length).toBeGreaterThan(0);
  });

  it('lists every event the code can emit', () => {
    const names = rows.map((r) => r.name);
    for (const name of LOG_EVENT_NAMES) expect(names).toContain(name);
  });

  it.each(['M1b-4a', 'M1b-4b', 'M1b-4d', 'M1c-1', 'M2a', 'M2b-2', 'M2c-1'])(
    'every row marked as emitted from %s exists in the code',
    (ms) => {
      const emitted = rows.filter((r) => r.emittedFrom === ms).map((r) => r.name);
      expect(emitted.length).toBeGreaterThan(0);
      for (const name of emitted) expect(LOG_EVENT_NAMES).toContain(name);
    },
  );
});
