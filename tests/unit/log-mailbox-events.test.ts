import { describe, it, expect } from 'vitest';
import { accountFailureReason } from '../../src/core/accounts.js';
import { MAILBOX_ERROR_CODES, MailboxError } from '../../src/core/mailbox/errors.js';
import { FALLBACK_OF } from '../../src/core/mailbox/folders.js';
import type { FallbackFeature } from '../../src/core/mailbox/folders.js';
import {
  EVENT_FIELDS,
  EVENT_KIND,
  browseFinish,
  capabilityFallback,
  eventLevel,
  foldersList,
  parseLogLine,
  renderEvent,
  statsFinish,
  validateRecord,
} from '../../src/core/log/index.js';
import type {
  AccountFailureReason,
  LogEvent,
  LogRecord,
  RunContext,
} from '../../src/core/log/index.js';

// M2a folders.list + imap.capability-fallback, M2b-2 browse.finish and M2c-1 stats.finish events:
// builders, levels, kinds, canaries and read-back validation, pinned from the spec.

const CTX: RunContext = {
  run: '0123456789abcdef',
  ver: '0.9.0',
  now: () => Date.UTC(2026, 9, 1, 9, 0, 0),
  level: 'debug',
};
const FILE_DATE = '2026-10-01';
const ACCT = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';

const PASSWORD = 'hunter2-ÄŠť';
const EMAIL = 'canary@secret-domain.example';
const HOST = 'imap.secret-host.example';
const FOLDER_SK = 'Tajný priečinok';
const FOLDER_PATH = 'INBOX/secret-folder';
const SENDER = 'boss@sender-canary.example';
const SENDER_DOMAIN = 'sender-canary.example';
const SUBJECT = 'Quarterly canary subject';
const CANARIES = [
  PASSWORD,
  EMAIL,
  HOST,
  FOLDER_SK,
  FOLDER_PATH,
  SENDER,
  SENDER_DOMAIN,
  SUBJECT,
  'secret',
  'canary',
];

type FoldersListFields = Parameters<typeof foldersList>[0];
type BrowseFinishFields = Parameters<typeof browseFinish>[0];
type StatsFinishFields = Parameters<typeof statsFinish>[0];

const BROWSE_OK: BrowseFinishFields = {
  acct: ACCT,
  folders: 3,
  mails: 400,
  marked: 12,
  bytes: 4_300_000,
  reconnects: 1,
  ms: 2300,
  outcome: 'ok',
};

const STATS_OK: StatsFinishFields = {
  acct: ACCT,
  folders: 12,
  messages: 45_210,
  bytes: 3_200_000_000,
  ms: 41_000,
  outcome: 'ok',
};

const MAILBOX_CODES = [
  'list-failed',
  'connection-lost',
  'folder-unavailable',
  'folder-not-found',
  'gmail-all-hidden',
] as const;

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
  expect(parsed).not.toBeNull();
  if (parsed === null) throw new Error('not parsed');
  return validateRecord(parsed, 'app', FILE_DATE);
}

function edited(line: string, change: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), ...change });
}

const FEATURES: FallbackFeature[] = ['status-size', 'quota', 'list-status'];

describe('foldersList builder', () => {
  it('ok keeps every field', () => {
    expect(fields(foldersList({ acct: ACCT, folders: 12, ms: 340, outcome: 'ok' }))).toEqual({
      event: 'folders.list',
      acct: ACCT,
      folders: 12,
      ms: 340,
      outcome: 'ok',
    });
  });

  it('an uppercase UUID is lowercased', () => {
    const e = foldersList({ acct: ACCT.toUpperCase(), folders: 1, ms: 1, outcome: 'ok' });
    expect(fields(e)['acct']).toBe(ACCT);
  });

  it.each(['3f2a91c0', 'not-a-uuid', `${ACCT}0`, '', EMAIL, HOST])(
    'a non-UUID acct %j is dropped',
    (acct) => {
      const e = foldersList({ acct, folders: 1, ms: 1, outcome: 'ok' });
      expect(fields(e)['acct']).toBeUndefined();
      expect(Object.keys(render(e).record)).not.toContain('acct');
    },
  );

  it('acct may be omitted', () => {
    expect(fields(foldersList({ folders: 0, ms: 0, outcome: 'ok' }))['acct']).toBeUndefined();
  });

  it.each<unknown>([-1, NaN, Infinity, -Infinity, 2 ** 60, '12', null, undefined, FOLDER_SK])(
    'garbage count %j → 0',
    (n) => {
      const e = fields(foldersList(cast<FoldersListFields>({ folders: n, ms: n, outcome: 'ok' })));
      expect(e['folders']).toBe(0);
      expect(e['ms']).toBe(0);
    },
  );

  it('ms is rounded', () => {
    expect(fields(foldersList({ folders: 3, ms: 12.6, outcome: 'ok' }))['ms']).toBe(13);
    expect(fields(foldersList({ folders: 3, ms: 12.4, outcome: 'ok' }))['ms']).toBe(12);
  });

  it('large but safe counts are kept', () => {
    expect(fields(foldersList({ folders: 5000, ms: 600_000, outcome: 'ok' }))).toMatchObject({
      folders: 5000,
      ms: 600_000,
    });
  });

  it.each<unknown>(['maybe', 'OK', '', undefined, null, 1, HOST])(
    'invalid outcome %j → failed with reason unexpected',
    (outcome) => {
      const e = fields(foldersList(cast<FoldersListFields>({ folders: 1, ms: 1, outcome })));
      expect(e['outcome']).toBe('failed');
      expect(e['reason']).toBe('unexpected');
    },
  );

  it.each<AccountFailureReason>([
    'list-failed',
    'connection-lost',
    'folder-unavailable',
    'auth-failed',
    'timeout',
    'blocked',
    'not-found',
    'unexpected',
  ])('failed keeps the valid reason %s', (reason) => {
    const e = foldersList({ acct: ACCT, folders: 0, ms: 5, outcome: 'failed', reason });
    expect(fields(e)['reason']).toBe(reason);
  });

  it.each<unknown>([undefined, 'nope', 'List-Failed', '', 7, null, FOLDER_PATH])(
    'failed with reason %j → unexpected',
    (reason) => {
      const e = foldersList(
        cast<FoldersListFields>({ folders: 0, ms: 0, outcome: 'failed', reason }),
      );
      expect(fields(e)['reason']).toBe('unexpected');
    },
  );

  it.each<unknown>(['list-failed', 'nope'])('ok drops the reason %j', (reason) => {
    const e = foldersList(cast<FoldersListFields>({ folders: 1, ms: 1, outcome: 'ok', reason }));
    expect(fields(e)['reason']).toBeUndefined();
    expect(Object.keys(render(e).record)).not.toContain('reason');
  });

  it('level info when ok, warn when failed; kind app', () => {
    const ok = foldersList({ folders: 1, ms: 1, outcome: 'ok' });
    const failed = foldersList({ folders: 0, ms: 1, outcome: 'failed', reason: 'list-failed' });
    expect(eventLevel(ok)).toBe('info');
    expect(eventLevel(failed)).toBe('warn');
    expect(EVENT_KIND['folders.list']).toBe('app');
    expect(render(ok).kind).toBe('app');
    expect(render(ok).record.level).toBe('info');
    expect(render(failed).record.level).toBe('warn');
  });
});

describe('capabilityFallback builder', () => {
  it.each(FEATURES)('%s → its fallback', (feature) => {
    expect(fields(capabilityFallback(feature))).toEqual({
      event: 'imap.capability-fallback',
      feature,
      fallback: FALLBACK_OF[feature],
    });
  });

  it('the three pairs are exactly the spec ones', () => {
    expect(fields(capabilityFallback('status-size'))['fallback']).toBe('fetch-size-sum');
    expect(fields(capabilityFallback('quota'))['fallback']).toBe('folder-sum');
    expect(fields(capabilityFallback('list-status'))['fallback']).toBe('status-per-folder');
  });

  it.each<unknown>(['nope', '', undefined, null, 3, HOST, 'STATUS-SIZE'])(
    'an unknown feature %j still gives a valid pair',
    (feature) => {
      const e = fields(capabilityFallback(cast<FallbackFeature>(feature)));
      const pairs = Object.entries(FALLBACK_OF);
      expect(pairs).toContainEqual([e['feature'], e['fallback']]);
    },
  );

  it('level warn, kind app (unlike other imap.* events)', () => {
    const e = capabilityFallback('quota');
    expect(eventLevel(e)).toBe('warn');
    expect(EVENT_KIND['imap.capability-fallback']).toBe('app');
    const r = render(e);
    expect(r.kind).toBe('app');
    expect(r.record.level).toBe('warn');
    expect(r.line.startsWith('{')).toBe(true);
  });
});

describe('browseFinish builder', () => {
  it('ok keeps every field, in the catalog order', () => {
    const e = browseFinish(BROWSE_OK);
    expect(fields(e)).toEqual({ event: 'browse.finish', ...BROWSE_OK });
    expect(EVENT_FIELDS['browse.finish']).toEqual([
      'acct',
      'folders',
      'mails',
      'marked',
      'bytes',
      'reconnects',
      'ms',
      'outcome',
      'reason',
    ]);
    expect(Object.keys(render(e).record)).toEqual([
      'ts',
      'event',
      'acct',
      'folders',
      'mails',
      'marked',
      'bytes',
      'reconnects',
      'ms',
      'outcome',
      'level',
      'run',
      'v',
    ]);
  });

  it('interrupted keeps every field, no reason', () => {
    const e = fields(browseFinish({ ...BROWSE_OK, outcome: 'interrupted' }));
    expect(e['outcome']).toBe('interrupted');
    expect(e['reason']).toBeUndefined();
  });

  it.each(['3f2a91c0', 'not-a-uuid', '', EMAIL, HOST])('a non-UUID acct %j is dropped', (acct) => {
    const e = browseFinish({ ...BROWSE_OK, acct });
    expect(fields(e)['acct']).toBeUndefined();
    expect(Object.keys(render(e).record)).not.toContain('acct');
  });

  it('an uppercase UUID is lowercased; acct may be omitted', () => {
    expect(fields(browseFinish({ ...BROWSE_OK, acct: ACCT.toUpperCase() }))['acct']).toBe(ACCT);
    const noAcct = browseFinish({ ...BROWSE_OK, acct: undefined });
    expect(fields(noAcct)['acct']).toBeUndefined();
    expect(Object.keys(render(noAcct).record)).not.toContain('acct');
  });

  it.each<unknown>([-1, NaN, Infinity, -Infinity, 2 ** 60, '12', null, undefined, FOLDER_SK])(
    'garbage count %j → 0',
    (n) => {
      const e = fields(
        browseFinish(
          cast<BrowseFinishFields>({
            folders: n,
            mails: n,
            marked: n,
            bytes: n,
            reconnects: n,
            ms: n,
            outcome: 'ok',
          }),
        ),
      );
      for (const f of ['folders', 'mails', 'marked', 'bytes', 'reconnects', 'ms']) {
        expect(e[f], f).toBe(0);
      }
    },
  );

  it('a fractional count → 0 (ms is rounded instead)', () => {
    const e = fields(
      browseFinish({
        ...BROWSE_OK,
        folders: 1.5,
        mails: 1.5,
        marked: 1.5,
        bytes: 1.5,
        reconnects: 1.5,
        ms: 1.5,
      }),
    );
    expect(e).toMatchObject({ folders: 0, mails: 0, marked: 0, bytes: 0, reconnects: 0, ms: 2 });
  });

  it('ms is rounded', () => {
    expect(fields(browseFinish({ ...BROWSE_OK, ms: 12.6 }))['ms']).toBe(13);
    expect(fields(browseFinish({ ...BROWSE_OK, ms: 12.4 }))['ms']).toBe(12);
  });

  it.each<unknown>(['maybe', 'OK', 'quit', 'interrupt', '', undefined, null, 1, HOST])(
    'invalid outcome %j → failed with reason unexpected',
    (outcome) => {
      const e = fields(browseFinish(cast<BrowseFinishFields>({ ...BROWSE_OK, outcome })));
      expect(e['outcome']).toBe('failed');
      expect(e['reason']).toBe('unexpected');
    },
  );

  it.each<AccountFailureReason>([
    'connection-lost',
    'folder-unavailable',
    'auth-failed',
    'blocked',
    'unexpected',
  ])('failed keeps the valid reason %s', (reason) => {
    expect(fields(browseFinish({ ...BROWSE_OK, outcome: 'failed', reason }))['reason']).toBe(
      reason,
    );
  });

  it.each<unknown>([undefined, 'nope', '', 7, null, FOLDER_PATH])(
    'failed with reason %j → unexpected',
    (reason) => {
      const e = browseFinish(cast<BrowseFinishFields>({ ...BROWSE_OK, outcome: 'failed', reason }));
      expect(fields(e)['reason']).toBe('unexpected');
    },
  );

  it.each<[string, unknown]>([
    ['ok', 'connection-lost'],
    ['interrupted', 'unexpected'],
    ['interrupted', 'nope'],
  ])('%s drops the reason %j', (outcome, reason) => {
    const e = browseFinish(cast<BrowseFinishFields>({ ...BROWSE_OK, outcome, reason }));
    expect(fields(e)['reason']).toBeUndefined();
    expect(Object.keys(render(e).record)).not.toContain('reason');
  });

  it('level info for ok and interrupted, warn for failed; kind app', () => {
    const ok = browseFinish(BROWSE_OK);
    const interrupted = browseFinish({ ...BROWSE_OK, outcome: 'interrupted' });
    const failed = browseFinish({ ...BROWSE_OK, outcome: 'failed', reason: 'unexpected' });
    expect(eventLevel(ok)).toBe('info');
    expect(eventLevel(interrupted)).toBe('info');
    expect(eventLevel(failed)).toBe('warn');
    expect(EVENT_KIND['browse.finish']).toBe('app');
    expect(render(ok).kind).toBe('app');
    expect(render(interrupted).record.level).toBe('info');
    expect(render(failed).record.level).toBe('warn');
  });
});

describe('statsFinish builder', () => {
  it('ok keeps every field, in the catalog order', () => {
    const e = statsFinish(STATS_OK);
    expect(fields(e)).toEqual({ event: 'stats.finish', ...STATS_OK });
    expect(EVENT_FIELDS['stats.finish']).toEqual([
      'acct',
      'folders',
      'messages',
      'bytes',
      'ms',
      'outcome',
      'reason',
    ]);
    expect(Object.keys(render(e).record)).toEqual([
      'ts',
      'event',
      'acct',
      'folders',
      'messages',
      'bytes',
      'ms',
      'outcome',
      'level',
      'run',
      'v',
    ]);
  });

  it('failed with 0 counts keeps the reason', () => {
    const e = statsFinish({
      acct: ACCT,
      folders: 0,
      messages: 0,
      bytes: 0,
      ms: 900,
      outcome: 'failed',
      reason: 'connection-lost',
    });
    expect(fields(e)).toEqual({
      event: 'stats.finish',
      acct: ACCT,
      folders: 0,
      messages: 0,
      bytes: 0,
      ms: 900,
      outcome: 'failed',
      reason: 'connection-lost',
    });
  });

  it.each(['3f2a91c0', 'not-a-uuid', '', EMAIL, HOST])('a non-UUID acct %j is dropped', (acct) => {
    const e = statsFinish({ ...STATS_OK, acct });
    expect(fields(e)['acct']).toBeUndefined();
    expect(Object.keys(render(e).record)).not.toContain('acct');
  });

  it('an uppercase UUID is lowercased; acct may be omitted', () => {
    expect(fields(statsFinish({ ...STATS_OK, acct: ACCT.toUpperCase() }))['acct']).toBe(ACCT);
    const noAcct = statsFinish({ ...STATS_OK, acct: undefined });
    expect(fields(noAcct)['acct']).toBeUndefined();
    expect(Object.keys(render(noAcct).record)).not.toContain('acct');
  });

  it.each<unknown>([-1, NaN, Infinity, -Infinity, 2 ** 60, '12', null, undefined, FOLDER_SK])(
    'garbage count %j → 0',
    (n) => {
      const e = fields(
        statsFinish(
          cast<StatsFinishFields>({
            folders: n,
            messages: n,
            bytes: n,
            ms: n,
            outcome: 'ok',
          }),
        ),
      );
      for (const f of ['folders', 'messages', 'bytes', 'ms']) expect(e[f], f).toBe(0);
    },
  );

  it('a fractional count → 0 (ms is rounded instead)', () => {
    const e = fields(
      statsFinish({ ...STATS_OK, folders: 1.5, messages: 1.5, bytes: 1.5, ms: 1.5 }),
    );
    expect(e).toMatchObject({ folders: 0, messages: 0, bytes: 0, ms: 2 });
  });

  it('large but safe byte counts are kept', () => {
    const bytes = 2 ** 45;
    expect(fields(statsFinish({ ...STATS_OK, bytes }))['bytes']).toBe(bytes);
  });

  it.each<unknown>(['maybe', 'OK', 'interrupted', '', undefined, null, 1, HOST])(
    'invalid outcome %j → failed with reason unexpected',
    (outcome) => {
      const e = fields(statsFinish(cast<StatsFinishFields>({ ...STATS_OK, outcome })));
      expect(e['outcome']).toBe('failed');
      expect(e['reason']).toBe('unexpected');
    },
  );

  it.each<AccountFailureReason>([...MAILBOX_CODES, 'auth-failed', 'blocked', 'unexpected'])(
    'failed keeps the valid reason %s',
    (reason) => {
      expect(fields(statsFinish({ ...STATS_OK, outcome: 'failed', reason }))['reason']).toBe(
        reason,
      );
    },
  );

  it.each<unknown>([undefined, 'nope', '', 7, null, FOLDER_PATH, SENDER])(
    'failed with reason %j → unexpected',
    (reason) => {
      const e = statsFinish(cast<StatsFinishFields>({ ...STATS_OK, outcome: 'failed', reason }));
      expect(fields(e)['reason']).toBe('unexpected');
    },
  );

  it.each<unknown>(['folder-not-found', 'nope'])('ok drops the reason %j', (reason) => {
    const e = statsFinish(cast<StatsFinishFields>({ ...STATS_OK, reason }));
    expect(fields(e)['reason']).toBeUndefined();
    expect(Object.keys(render(e).record)).not.toContain('reason');
  });

  it('level info when ok, warn when failed; kind app', () => {
    const ok = statsFinish(STATS_OK);
    const failed = statsFinish({ ...STATS_OK, outcome: 'failed', reason: 'gmail-all-hidden' });
    expect(eventLevel(ok)).toBe('info');
    expect(eventLevel(failed)).toBe('warn');
    expect(EVENT_KIND['stats.finish']).toBe('app');
    expect(render(ok).kind).toBe('app');
    expect(render(ok).record.level).toBe('info');
    expect(render(failed).record.level).toBe('warn');
  });
});

describe('canaries', () => {
  const hostile: LogEvent[] = [
    foldersList(
      cast<FoldersListFields>({
        acct: EMAIL,
        folders: FOLDER_SK,
        ms: PASSWORD,
        outcome: HOST,
        reason: FOLDER_PATH,
      }),
    ),
    foldersList(
      cast<FoldersListFields>({
        acct: HOST,
        folders: 1,
        ms: 1,
        outcome: 'failed',
        reason: PASSWORD,
      }),
    ),
    foldersList(
      cast<FoldersListFields>({ acct: ACCT, folders: 1, ms: 1, outcome: 'ok', reason: EMAIL }),
    ),
    capabilityFallback(cast<FallbackFeature>(FOLDER_PATH)),
    capabilityFallback(cast<FallbackFeature>(EMAIL)),
    capabilityFallback(cast<FallbackFeature>(PASSWORD)),
    browseFinish(
      cast<BrowseFinishFields>({
        acct: EMAIL,
        folders: FOLDER_SK,
        mails: FOLDER_PATH,
        marked: HOST,
        bytes: PASSWORD,
        reconnects: EMAIL,
        ms: HOST,
        outcome: FOLDER_PATH,
        reason: PASSWORD,
      }),
    ),
    browseFinish(
      cast<BrowseFinishFields>({ ...BROWSE_OK, acct: HOST, outcome: 'failed', reason: EMAIL }),
    ),
    browseFinish(
      cast<BrowseFinishFields>({
        ...BROWSE_OK,
        outcome: 'ok',
        reason: FOLDER_SK,
        // Fields the builder doesn't know never reach the line.
        path: FOLDER_PATH,
        subject: PASSWORD,
        from: EMAIL,
        host: HOST,
      }),
    ),
    statsFinish(
      cast<StatsFinishFields>({
        acct: SENDER,
        folders: FOLDER_SK,
        messages: SUBJECT,
        bytes: SENDER_DOMAIN,
        ms: HOST,
        outcome: FOLDER_PATH,
        reason: PASSWORD,
      }),
    ),
    statsFinish(
      cast<StatsFinishFields>({ ...STATS_OK, acct: EMAIL, outcome: 'failed', reason: SENDER }),
    ),
    statsFinish(
      cast<StatsFinishFields>({
        ...STATS_OK,
        reason: SUBJECT,
        // Fields the builder doesn't know never reach the line.
        path: FOLDER_PATH,
        folder: FOLDER_SK,
        sender: SENDER,
        domain: SENDER_DOMAIN,
        subject: SUBJECT,
        address: EMAIL,
        host: HOST,
        password: PASSWORD,
      }),
    ),
  ];

  it.each(hostile.map((e, i) => [i, e] as const))('hostile event %i renders no canary', (_i, e) => {
    const { line } = render(e);
    for (const c of CANARIES) expect(line).not.toContain(c);
  });

  it('hostile events still round-trip as valid records', () => {
    for (const e of hostile) {
      const { record, line } = render(e);
      expect(validate(line)).toEqual({ record });
    }
  });
});

describe('read-back validation', () => {
  const valid: [string, LogEvent][] = [
    ['folders ok', foldersList({ acct: ACCT, folders: 7, ms: 120, outcome: 'ok' })],
    ['folders ok without acct', foldersList({ folders: 0, ms: 0, outcome: 'ok' })],
    [
      'folders list-failed',
      foldersList({ acct: ACCT, folders: 0, ms: 9, outcome: 'failed', reason: 'list-failed' }),
    ],
    [
      'folders connection-lost',
      foldersList({ folders: 2, ms: 9, outcome: 'failed', reason: 'connection-lost' }),
    ],
    ...FEATURES.map((f): [string, LogEvent] => [`fallback ${f}`, capabilityFallback(f)]),
    ['browse ok', browseFinish(BROWSE_OK)],
    ['browse interrupted', browseFinish({ ...BROWSE_OK, outcome: 'interrupted' })],
    ['browse failed', browseFinish({ ...BROWSE_OK, outcome: 'failed', reason: 'connection-lost' })],
    ['stats ok', statsFinish(STATS_OK)],
    ...MAILBOX_CODES.map((reason): [string, LogEvent] => [
      `stats failed ${reason}`,
      statsFinish({ folders: 0, messages: 0, bytes: 0, ms: 5, outcome: 'failed', reason }),
    ]),
    [
      'stats empty, no acct',
      statsFinish({ folders: 0, messages: 0, bytes: 0, ms: 0, outcome: 'ok' }),
    ],
    [
      'browse empty, no acct',
      browseFinish({
        folders: 0,
        mails: 0,
        marked: 0,
        bytes: 0,
        reconnects: 0,
        ms: 0,
        outcome: 'ok',
      }),
    ],
  ];

  it.each(valid)('%s: render → parse → validate round-trips', (_n, e) => {
    const { record, line } = render(e);
    const result = validate(line);
    expect(result).toEqual({ record });
    if ('record' in result) expect(Object.keys(result.record)).toEqual(Object.keys(record));
  });

  it('folders.list ok with a reason is rejected', () => {
    const { line } = render(foldersList({ acct: ACCT, folders: 1, ms: 1, outcome: 'ok' }));
    expect(validate(edited(line, { reason: 'list-failed' }))).toEqual({ skipped: 'unreadable' });
  });

  it('folders.list failed without a reason is rejected', () => {
    const { line } = render(
      foldersList({ folders: 1, ms: 1, outcome: 'failed', reason: 'list-failed' }),
    );
    const obj = JSON.parse(line) as Record<string, unknown>;
    delete obj['reason'];
    expect(validate(JSON.stringify(obj))).toEqual({ skipped: 'unreadable' });
  });

  it('folders.list with a negative count or an extra field is rejected', () => {
    const { line } = render(foldersList({ folders: 1, ms: 1, outcome: 'ok' }));
    expect(validate(edited(line, { folders: -1 }))).toEqual({ skipped: 'unreadable' });
    expect(validate(edited(line, { path: FOLDER_PATH }))).toEqual({ skipped: 'unreadable' });
  });

  it.each<[FallbackFeature, string]>([
    ['status-size', 'folder-sum'],
    ['quota', 'fetch-size-sum'],
    ['list-status', 'folder-sum'],
  ])('a capability-fallback line %s/%s (mismatched) is rejected', (feature, fallback) => {
    const { line } = render(capabilityFallback(feature));
    expect(validate(edited(line, { fallback }))).toEqual({ skipped: 'unreadable' });
  });

  it('a capability-fallback line with an unknown feature is rejected', () => {
    const { line } = render(capabilityFallback('quota'));
    expect(validate(edited(line, { feature: 'nope' }))).toEqual({ skipped: 'unreadable' });
  });

  it.each(['ok', 'interrupted'] as const)(
    'browse.finish %s with a reason is rejected',
    (outcome) => {
      const { line } = render(browseFinish({ ...BROWSE_OK, outcome }));
      expect(validate(edited(line, { reason: 'unexpected' }))).toEqual({ skipped: 'unreadable' });
    },
  );

  it('browse.finish failed without a reason is rejected', () => {
    const { line } = render(
      browseFinish({ ...BROWSE_OK, outcome: 'failed', reason: 'unexpected' }),
    );
    const obj = JSON.parse(line) as Record<string, unknown>;
    delete obj['reason'];
    expect(validate(JSON.stringify(obj))).toEqual({ skipped: 'unreadable' });
  });

  it('browse.finish with a wrong level, a bad count or an extra field is rejected', () => {
    const { line } = render(browseFinish({ ...BROWSE_OK, outcome: 'interrupted' }));
    expect(validate(edited(line, { level: 'warn' }))).toEqual({ skipped: 'unreadable' });
    expect(validate(edited(line, { marked: -1 }))).toEqual({ skipped: 'unreadable' });
    expect(validate(edited(line, { bytes: 1.5 }))).toEqual({ skipped: 'unreadable' });
    expect(validate(edited(line, { outcome: 'quit' }))).toEqual({ skipped: 'unreadable' });
    expect(validate(edited(line, { path: FOLDER_PATH }))).toEqual({ skipped: 'unreadable' });
  });

  it('a browse.finish line in a security file is rejected', () => {
    const { line } = render(browseFinish(BROWSE_OK));
    const parsed = parseLogLine(`mm-security ${line}`);
    if (parsed === null) throw new Error('not parsed');
    expect(validateRecord(parsed, 'security', FILE_DATE)).toEqual({ skipped: 'unreadable' });
  });

  it('stats.finish ok with a reason is rejected', () => {
    const { line } = render(statsFinish(STATS_OK));
    expect(validate(edited(line, { reason: 'folder-not-found' }))).toEqual({
      skipped: 'unreadable',
    });
  });

  it('stats.finish failed without a reason is rejected', () => {
    const { line } = render(
      statsFinish({ ...STATS_OK, outcome: 'failed', reason: 'gmail-all-hidden' }),
    );
    const obj = JSON.parse(line) as Record<string, unknown>;
    delete obj['reason'];
    expect(validate(JSON.stringify(obj))).toEqual({ skipped: 'unreadable' });
  });

  it('stats.finish with a wrong level, a bad count, an unknown value or an extra field is rejected', () => {
    const { line } = render(statsFinish(STATS_OK));
    expect(validate(edited(line, { level: 'warn' }))).toEqual({ skipped: 'unreadable' });
    expect(validate(edited(line, { messages: -1 }))).toEqual({ skipped: 'unreadable' });
    expect(validate(edited(line, { bytes: 1.5 }))).toEqual({ skipped: 'unreadable' });
    expect(validate(edited(line, { outcome: 'interrupted' }))).toEqual({ skipped: 'unreadable' });
    expect(validate(edited(line, { folder: FOLDER_PATH }))).toEqual({ skipped: 'unreadable' });
    expect(validate(edited(line, { sender: SENDER }))).toEqual({ skipped: 'unreadable' });
    const failed = render(statsFinish({ ...STATS_OK, outcome: 'failed', reason: 'unexpected' }));
    expect(validate(edited(failed.line, { reason: 'nope' }))).toEqual({ skipped: 'unreadable' });
  });

  it('a stats.finish line in a security file is rejected', () => {
    const { line } = render(statsFinish(STATS_OK));
    const parsed = parseLogLine(`mm-security ${line}`);
    if (parsed === null) throw new Error('not parsed');
    expect(validateRecord(parsed, 'security', FILE_DATE)).toEqual({ skipped: 'unreadable' });
  });

  it('a folders.list line in a security file is rejected', () => {
    const { line } = render(foldersList({ folders: 1, ms: 1, outcome: 'ok' }));
    const parsed = parseLogLine(`mm-security ${line}`);
    if (parsed === null) throw new Error('not parsed');
    expect(validateRecord(parsed, 'security', FILE_DATE)).toEqual({ skipped: 'unreadable' });
  });
});

describe('MailboxError', () => {
  it.each(MAILBOX_CODES)('%s: code, name, fixed message', (code) => {
    const err = new MailboxError(code);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.name).toBe('MailboxError');
    expect(err.message).not.toBe('');
  });

  it.each(MAILBOX_CODES)('accountFailureReason maps MailboxError %s to its code', (code) => {
    expect(accountFailureReason(new MailboxError(code))).toBe(code);
  });

  it('every code is listed once in MAILBOX_ERROR_CODES', () => {
    expect([...MAILBOX_ERROR_CODES].sort()).toEqual([...MAILBOX_CODES].sort());
  });

  it('the new M2c-1 codes have their fixed core messages', () => {
    expect(new MailboxError('folder-not-found').message).toBe('There is no folder with that path');
    expect(new MailboxError('gmail-all-hidden').message).toBe('Gmail hides All Mail from IMAP');
  });
});
