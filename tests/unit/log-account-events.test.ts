import { describe, it, expect } from 'vitest';
import { eventText } from '../../src/cli/log-text.js';
import {
  accountEvent,
  parseLogLine,
  renderEvent,
  validateRecord,
} from '../../src/core/log/index.js';
import type {
  AccountEventFields,
  AccountFailureReason,
  LogEvent,
  LogRecord,
  RunContext,
} from '../../src/core/log/index.js';

// M1c-1 account.* events: the accountEvent builder, rendering, read-back validation and the
// `mm logs` text, pinned from the spec.

const CTX: RunContext = {
  run: '0123456789abcdef',
  ver: '0.7.0',
  now: () => Date.UTC(2026, 9, 1, 9, 0, 0),
  level: 'debug',
};
const FILE_DATE = '2026-10-01';
const ACCT = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';
const NAMES = ['account.add', 'account.test', 'account.password-update', 'account.remove'] as const;

function render(e: LogEvent): { kind: string; record: LogRecord; line: string } {
  const r = renderEvent(e, CTX);
  if (r === null) throw new Error('not rendered');
  return r;
}

function fields(e: LogEvent): Record<string, unknown> {
  return { ...e };
}

describe('accountEvent builder', () => {
  it.each(NAMES)('%s: ok keeps acct + provider, sets the event name', (name) => {
    expect(fields(accountEvent(name, { acct: ACCT, provider: 'gmail', outcome: 'ok' }))).toEqual({
      event: name,
      acct: ACCT,
      provider: 'gmail',
      outcome: 'ok',
    });
  });

  it('a non-UUID acct is dropped', () => {
    for (const acct of [
      '3f2a91c0',
      'not-a-uuid',
      `${ACCT}0`,
      '',
      'someone@example-test-domain.eu',
    ]) {
      const e = accountEvent('account.add', { acct, provider: 'gmail', outcome: 'ok' });
      expect(fields(e)['acct']).toBeUndefined();
    }
  });

  it('an uppercase UUID is lowercased', () => {
    const e = accountEvent('account.test', {
      acct: ACCT.toUpperCase(),
      provider: 'gmail',
      outcome: 'ok',
    });
    expect(fields(e)['acct']).toBe(ACCT);
  });

  it('acct may be omitted', () => {
    const e = accountEvent('account.add', {
      provider: 'custom',
      outcome: 'failed',
      reason: 'duplicate',
    });
    expect(Object.keys(render(e).record)).not.toContain('acct');
  });

  it.each<unknown>([
    'Bad Provider!',
    'imap.example-test-domain.eu',
    '',
    'x'.repeat(41),
    undefined,
    42,
  ])('provider %j → custom', (provider) => {
    const f = { provider, outcome: 'ok' } as unknown as AccountEventFields;
    expect(fields(accountEvent('account.add', f))['provider']).toBe('custom');
  });

  it.each(['websupport', 'custom', 'm365-business'])('provider %j is kept', (provider) => {
    expect(fields(accountEvent('account.add', { provider, outcome: 'ok' }))['provider']).toBe(
      provider,
    );
  });

  it.each<unknown>(['maybe', 'OK', '', undefined, null, 1])(
    'invalid outcome %j → failed (with reason unexpected)',
    (outcome) => {
      const f = { acct: ACCT, provider: 'gmail', outcome } as unknown as AccountEventFields;
      const e = fields(accountEvent('account.remove', f));
      expect(e['outcome']).toBe('failed');
      expect(e['reason']).toBe('unexpected');
    },
  );

  it.each<AccountFailureReason>([
    'auth-failed',
    'timeout',
    'blocked',
    'duplicate',
    'not-found',
    'secret-unreadable',
    'unsupported',
    'database',
    'unexpected',
  ])('failed keeps the valid reason %s', (reason) => {
    const e = accountEvent('account.add', { provider: 'gmail', outcome: 'failed', reason });
    expect(fields(e)['reason']).toBe(reason);
  });

  it.each<unknown>([undefined, 'nope', 'Auth-Failed', '', 7, null])(
    'failed with reason %j → unexpected',
    (reason) => {
      const f = { provider: 'gmail', outcome: 'failed', reason } as unknown as AccountEventFields;
      expect(fields(accountEvent('account.add', f))['reason']).toBe('unexpected');
    },
  );

  it.each<unknown>(['auth-failed', 'nope', 'unexpected'])('ok drops the reason %j', (reason) => {
    const f = {
      acct: ACCT,
      provider: 'gmail',
      outcome: 'ok',
      reason,
    } as unknown as AccountEventFields;
    const e = accountEvent('account.password-update', f);
    expect(fields(e)['reason']).toBeUndefined();
    expect(Object.keys(render(e).record)).not.toContain('reason');
  });
});

describe('rendering', () => {
  it.each(NAMES)('%s failed: key order, warn level, app kind', (name) => {
    const r = render(
      accountEvent(name, {
        acct: ACCT,
        provider: 'gmail',
        outcome: 'failed',
        reason: 'auth-failed',
      }),
    );
    expect(r.kind).toBe('app');
    expect(Object.keys(r.record)).toEqual([
      'ts',
      'event',
      'acct',
      'provider',
      'outcome',
      'reason',
      'level',
      'run',
      'v',
    ]);
    expect(r.record.level).toBe('warn');
    expect(r.line.startsWith('{')).toBe(true);
  });

  it.each(NAMES)('%s ok: key order without reason, info level', (name) => {
    const r = render(accountEvent(name, { acct: ACCT, provider: 'gmail', outcome: 'ok' }));
    expect(Object.keys(r.record)).toEqual([
      'ts',
      'event',
      'acct',
      'provider',
      'outcome',
      'level',
      'run',
      'v',
    ]);
    expect(r.record.level).toBe('info');
  });
});

describe('read-back validation', () => {
  const variants: [string, AccountEventFields][] = [
    ['ok with acct', { acct: ACCT, provider: 'gmail', outcome: 'ok' }],
    ['ok without acct', { provider: 'custom', outcome: 'ok' }],
    ['failed with acct', { acct: ACCT, provider: 'gmail', outcome: 'failed', reason: 'timeout' }],
    ['failed without acct', { provider: 'custom', outcome: 'failed', reason: 'duplicate' }],
    ['failed blocked', { provider: 'websupport', outcome: 'failed', reason: 'blocked' }],
  ];

  for (const name of NAMES) {
    it.each(variants)(`${name} %s: render → parse → validate round-trips`, (_v, f) => {
      const { record, line } = render(accountEvent(name, f));
      const parsed = parseLogLine(line);
      expect(parsed).not.toBeNull();
      if (parsed === null) return;
      const result = validateRecord(parsed, 'app', FILE_DATE);
      expect(result).toEqual({ record });
      if ('record' in result) expect(Object.keys(result.record)).toEqual(Object.keys(record));
    });
  }

  function handMade(extra: Record<string, unknown>): string {
    return JSON.stringify({
      ts: '2026-10-01T09:00:00.000Z',
      event: 'account.add',
      ...extra,
      run: CTX.run,
      v: 1,
    });
  }

  it.each<[string, Record<string, unknown>]>([
    [
      'ok with a reason',
      { acct: ACCT, provider: 'gmail', outcome: 'ok', reason: 'auth-failed', level: 'info' },
    ],
    [
      'failed without a reason',
      { acct: ACCT, provider: 'gmail', outcome: 'failed', level: 'warn' },
    ],
    [
      'failed with an unknown reason',
      { provider: 'gmail', outcome: 'failed', reason: 'nope', level: 'warn' },
    ],
    ['ok at warn level', { provider: 'gmail', outcome: 'ok', level: 'warn' }],
    ['acct not a UUID', { acct: '3f2a91c0', provider: 'gmail', outcome: 'ok', level: 'info' }],
    [
      'an extra field',
      { provider: 'gmail', outcome: 'ok', host: 'imap.example-test-domain.eu', level: 'info' },
    ],
  ])('a hand-made record (%s) is rejected', (_name, extra) => {
    const parsed = parseLogLine(handMade(extra));
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(validateRecord(parsed, 'app', FILE_DATE)).toEqual({ skipped: 'unreadable' });
  });

  it('a hand-made valid record passes (control for the cases above)', () => {
    const parsed = parseLogLine(
      handMade({ provider: 'gmail', outcome: 'failed', reason: 'auth-failed', level: 'warn' }),
    );
    if (parsed === null) throw new Error('not parsed');
    expect(validateRecord(parsed, 'app', FILE_DATE)).toHaveProperty('record');
  });

  it('an account line in a security file is rejected', () => {
    const { line } = render(accountEvent('account.add', { provider: 'gmail', outcome: 'ok' }));
    const parsed = parseLogLine(`mm-security ${line}`);
    if (parsed === null) throw new Error('not parsed');
    expect(validateRecord(parsed, 'security', FILE_DATE)).toEqual({ skipped: 'unreadable' });
  });
});

describe('eventText never shows the account id', () => {
  const outcomes: [string, AccountEventFields][] = [
    ['ok', { acct: ACCT, provider: 'gmail', outcome: 'ok' }],
    ['failed', { acct: ACCT, provider: 'gmail', outcome: 'failed', reason: 'auth-failed' }],
  ];

  for (const name of NAMES) {
    it.each(outcomes)(`${name} %s`, (_o, f) => {
      const text = eventText(render(accountEvent(name, f)).record);
      expect(text).not.toBe('');
      expect(text).not.toContain(ACCT);
      expect(text).not.toContain(ACCT.slice(0, 8));
      expect(text).toContain('gmail');
    });
  }
});
