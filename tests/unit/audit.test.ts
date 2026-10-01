import { describe, it, expect, vi } from 'vitest';
import { auditEntrySchema, isValidAuditEntry, recordAudit } from '../../src/core/audit.js';
import { AUDIT_ACTIONS, RepoError } from '../../src/core/db/repos.js';
import type { AuditEntry, AuditRepo, RepoErrorCode } from '../../src/core/db/repos.js';
import {
  auditFailureReason,
  auditWriteFailed,
  MemoryEventLog,
  renderEvent,
} from '../../src/core/log/index.js';
import type { EventLog, LogEvent, RunContext } from '../../src/core/log/index.js';

// M1b-4d audit trail: entry validation and recordAudit, pinned from the spec.

const CTX: RunContext = {
  run: '0123456789abcdef',
  ver: '0.6.0',
  now: () => Date.UTC(2026, 8, 29, 8, 0, 0),
  level: 'debug',
};

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = 'fedcba9876543210';
const ACCOUNT_ACTIONS = ['account.add', 'account.remove', 'account.password-update'] as const;
const OTHER_ACTIONS = AUDIT_ACTIONS.filter(
  (a) => !(ACCOUNT_ACTIONS as readonly string[]).includes(a),
);

function entry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { action: 'mail.trash', result: 'ok', ...extra };
}

function fullEntry(): AuditEntry {
  return {
    accountId: ACCOUNT_ID,
    action: 'mail.trash',
    folder: 'INBOX/Staré',
    messageCount: 12,
    bytes: 345_678,
    result: 'partial',
    reason: 'uidvalidity-changed',
    runId: RUN_ID,
  };
}

function valid(e: unknown): boolean {
  const byGuard = isValidAuditEntry(e);
  // The exported schema and the guard must agree.
  expect(auditEntrySchema.safeParse(e).success).toBe(byGuard);
  return byGuard;
}

describe('audit entry validation', () => {
  it('accepts a minimal entry for every action', () => {
    for (const action of AUDIT_ACTIONS) expect(valid(entry({ action }))).toBe(true);
  });

  it('accepts a full entry', () => {
    expect(valid(fullEntry())).toBe(true);
  });

  it.each(['ok', 'partial', 'failed', 'aborted'])('accepts result %j', (result) => {
    expect(valid(entry({ result }))).toBe(true);
  });

  it.each<unknown>(['success', 'OK', '', null, 1])('rejects result %j', (result) => {
    expect(valid(entry({ result }))).toBe(false);
  });

  it('rejects a missing result or action', () => {
    expect(valid({ action: 'mail.trash' })).toBe(false);
    expect(valid({ result: 'ok' })).toBe(false);
  });

  it.each<unknown>(['foo.bar', 'mail.delete', 'Mail.Trash', 'mail.trash ', '', null, 3])(
    'rejects action %j',
    (action) => {
      expect(valid(entry({ action }))).toBe(false);
    },
  );

  it.each<unknown>([null, undefined, 'mail.trash', 42, [], [entry()]])(
    'rejects the non-object %j',
    (raw) => {
      expect(valid(raw)).toBe(false);
    },
  );

  it.each([
    ['subject', 'Hello'],
    ['from', 'a@x.sk'],
    ['userId', '22222222-2222-4222-8222-222222222222'],
    ['id', 1],
    ['createdAt', new Date()],
    ['account_id', ACCOUNT_ID],
  ])('is strict: rejects the unknown key %s', (key, value) => {
    expect(valid(entry({ [key]: value }))).toBe(false);
  });

  describe('accountId', () => {
    it('accepts a UUID', () => {
      expect(valid(entry({ accountId: ACCOUNT_ID }))).toBe(true);
    });

    it.each<unknown>([
      '',
      'u1',
      `${ACCOUNT_ID}0`,
      ACCOUNT_ID.replace(/-/g, ''),
      `${ACCOUNT_ID}\n`,
      'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
      42,
      null,
    ])('rejects %j', (accountId) => {
      expect(valid(entry({ accountId }))).toBe(false);
    });
  });

  describe('folder', () => {
    it.each(['INBOX', 'INBOX/Sub folder', 'Došlá pošta', '[Gmail]/Kôš', 'a'.repeat(1024)])(
      'accepts %j',
      (folder) => {
        expect(valid(entry({ folder }))).toBe(true);
      },
    );

    it('rejects a 1025-character folder', () => {
      expect(valid(entry({ folder: 'a'.repeat(1025) }))).toBe(false);
    });

    it.each([
      ['NUL', 'INBOX\u0000x'],
      ['newline', 'INBOX\nforged'],
      ['carriage return', 'INBOX\rx'],
      ['tab', 'INBOX\tx'],
      ['escape', 'INBOX\u001b[31m'],
      ['DEL', 'INBOX\u007f'],
      ['right-to-left override', 'INBOX‮gpj.exe'],
      ['zero-width space', 'IN​BOX'],
      ['left-to-right mark', 'INBOX‎'],
      ['left-to-right isolate', '⁦INBOX'],
    ])('rejects a folder with a %s', (_label, folder) => {
      expect(valid(entry({ folder }))).toBe(false);
    });

    it.each<unknown>([42, null, ['INBOX']])('rejects the non-string %j', (folder) => {
      expect(valid(entry({ folder }))).toBe(false);
    });
  });

  describe('messageCount', () => {
    it.each([0, 1, 2147483647])('accepts %d', (messageCount) => {
      expect(valid(entry({ messageCount }))).toBe(true);
    });

    it.each<unknown>([-1, 2147483648, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null])(
      'rejects %j',
      (messageCount) => {
        expect(valid(entry({ messageCount }))).toBe(false);
      },
    );
  });

  describe('bytes', () => {
    it.each([0, 1, 2147483648, Number.MAX_SAFE_INTEGER])('accepts %d', (bytes) => {
      expect(valid(entry({ bytes }))).toBe(true);
    });

    it.each<unknown>([
      -1,
      Number.MAX_SAFE_INTEGER + 1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1',
      null,
    ])('rejects %j', (bytes) => {
      expect(valid(entry({ bytes }))).toBe(false);
    });
  });

  describe('reason', () => {
    it.each(['a', 'user-cancelled', 'uidvalidity-changed', 'abc123', 'x'.repeat(60)])(
      'accepts %j',
      (reason) => {
        expect(valid(entry({ reason }))).toBe(true);
      },
    );

    it.each<unknown>([
      '',
      'x'.repeat(61),
      'Upper',
      'with space',
      'under_score',
      'dot.x',
      'a\n',
      'Invalid credentials (AUTHENTICATIONFAILED)',
      42,
      null,
    ])('rejects %j', (reason) => {
      expect(valid(entry({ reason }))).toBe(false);
    });
  });

  describe('runId', () => {
    it('accepts 16 lowercase hex characters', () => {
      expect(valid(entry({ runId: RUN_ID }))).toBe(true);
    });

    it.each<unknown>([
      '',
      'fedcba987654321',
      'fedcba98765432100',
      'FEDCBA9876543210',
      'fedcba987654321g',
      'fedcba987654321\n',
      42,
      null,
    ])('rejects %j', (runId) => {
      expect(valid(entry({ runId }))).toBe(false);
    });
  });

  describe('details per action', () => {
    describe.each(ACCOUNT_ACTIONS)('%s', (action) => {
      it.each([undefined, { provider: 'gmail' }, { provider: 'm365-business' }])(
        'accepts details %j',
        (details) => {
          const e = details === undefined ? entry({ action }) : entry({ action, details });
          expect(valid(e)).toBe(true);
        },
      );

      it.each([['a'.repeat(40)], ['custom'], ['x1-2']])('accepts provider %j', (provider) => {
        expect(valid(entry({ action, details: { provider } }))).toBe(true);
      });

      it.each<[string, unknown]>([
        ['an upper-case provider', { provider: 'Gmail' }],
        ['a 41-character provider', { provider: 'a'.repeat(41) }],
        ['a provider with a dot (host)', { provider: 'imap.secret-host.example' }],
        ['a provider with an @', { provider: 'canary@secret-domain.example' }],
        ['an empty provider', { provider: '' }],
        ['a numeric provider', { provider: 123 }],
        ['an extra key', { provider: 'gmail', host: 'imap.gmail.com' }],
        ['only an unknown key', { email: 'a@x.sk' }],
        ['a string', 'gmail'],
        ['an array', ['gmail']],
        ['a number', 1],
      ])('rejects %s', (_label, details) => {
        expect(valid(entry({ action, details }))).toBe(false);
      });
    });

    describe.each(OTHER_ACTIONS)('%s', (action) => {
      it('accepts no details', () => {
        expect(valid(entry({ action }))).toBe(true);
      });

      it.each<unknown>([{}, { provider: 'gmail' }, { query: 'from:x' }, null, 'x', []])(
        'rejects details %j',
        (details) => {
          expect(valid(entry({ action, details }))).toBe(false);
        },
      );
    });
  });
});

function fakeRepo(write: AuditRepo['write']): AuditRepo & { writeMock: ReturnType<typeof vi.fn> } {
  const writeMock = vi.fn(write);
  return {
    write: writeMock,
    listRecent: () => Promise.reject(new Error('listRecent must not be called')),
    writeMock,
  };
}

const okRepo = () => fakeRepo(() => Promise.resolve());

/** A log that fails on every emit (full disk, bad sink) — recordAudit must still settle. */
const throwingLog: EventLog = {
  emit: () => {
    throw new Error('log sink broken');
  },
};

function onlyEvent(log: MemoryEventLog): Record<string, unknown> {
  expect(log.records).toHaveLength(1);
  return log.records[0] ?? {};
}

describe('recordAudit', () => {
  it('writes a valid entry and returns true without emitting', async () => {
    const repo = okRepo();
    const log = new MemoryEventLog(CTX);
    const e = fullEntry();
    await expect(recordAudit(repo, e, log)).resolves.toBe(true);
    expect(repo.writeMock).toHaveBeenCalledTimes(1);
    expect(repo.writeMock).toHaveBeenCalledWith(fullEntry());
    expect(log.records).toHaveLength(0);
  });

  it('waits for the write before resolving', async () => {
    let finish: () => void = () => undefined;
    const repo = fakeRepo(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let settled = false;
    const pending = recordAudit(repo, fullEntry(), new MemoryEventLog(CTX)).then((r) => {
      settled = true;
      return r;
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await expect(pending).resolves.toBe(true);
  });

  it('rejects an invalid entry without calling the repo and emits reason invalid', async () => {
    const repo = okRepo();
    const log = new MemoryEventLog(CTX);
    const bad = { ...fullEntry(), messageCount: -1 };
    await expect(recordAudit(repo, bad, log)).resolves.toBe(false);
    expect(repo.writeMock).not.toHaveBeenCalled();
    const rec = onlyEvent(log);
    expect(rec).toMatchObject({
      event: 'audit.write-failed',
      action: 'mail.trash',
      reason: 'invalid',
      level: 'error',
    });
  });

  it('uses action "other" when the action itself is not an audit action', async () => {
    const repo = okRepo();
    const log = new MemoryEventLog(CTX);
    const bad = { action: 'canary@secret-domain.example', result: 'ok' } as unknown as AuditEntry;
    await expect(recordAudit(repo, bad, log)).resolves.toBe(false);
    expect(repo.writeMock).not.toHaveBeenCalled();
    expect(onlyEvent(log)).toMatchObject({ action: 'other', reason: 'invalid' });
    expect(log.lines.join('\n')).not.toContain('canary');
  });

  it('rejects an unknown top-level key (e.g. a subject) without writing', async () => {
    const repo = okRepo();
    const log = new MemoryEventLog(CTX);
    const bad = { ...fullEntry(), subject: 'LEAKCANARY subject' } as unknown as AuditEntry;
    await expect(recordAudit(repo, bad, log)).resolves.toBe(false);
    expect(repo.writeMock).not.toHaveBeenCalled();
    expect(onlyEvent(log)).toMatchObject({ reason: 'invalid' });
    expect(log.lines.join('\n')).not.toContain('LEAKCANARY');
  });

  it.each<[RepoErrorCode, string]>([
    ['forbidden', 'forbidden'],
    ['unavailable', 'unavailable'],
    ['conflict', 'conflict'],
    ['not_found', 'not-found'],
    ['unknown', 'unknown'],
  ])('maps a RepoError(%s) from the write to reason %s', async (code, reason) => {
    const repo = fakeRepo(() => Promise.reject(new RepoError(code, 'Database error LEAKCANARY')));
    const log = new MemoryEventLog(CTX);
    await expect(recordAudit(repo, fullEntry(), log)).resolves.toBe(false);
    expect(repo.writeMock).toHaveBeenCalledTimes(1);
    expect(onlyEvent(log)).toMatchObject({
      event: 'audit.write-failed',
      action: 'mail.trash',
      reason,
      level: 'error',
    });
    expect(log.lines.join('\n')).not.toContain('LEAKCANARY');
  });

  it.each<[string, unknown]>([
    ['a plain Error', new Error('LEAKCANARY boom')],
    ['a TypeError', new TypeError('fetch failed LEAKCANARY')],
    ['a string', 'LEAKCANARY'],
    ['undefined', undefined],
    ['null', null],
    ['a RepoError look-alike object', { name: 'RepoError', code: 'forbidden', message: 'x' }],
  ])('maps %s thrown by the write to reason unknown', async (_label, thrownValue) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error rejections are the point
    const repo = fakeRepo(() => Promise.reject(thrownValue));
    const log = new MemoryEventLog(CTX);
    await expect(recordAudit(repo, fullEntry(), log)).resolves.toBe(false);
    expect(onlyEvent(log)).toMatchObject({ reason: 'unknown' });
    expect(log.lines.join('\n')).not.toContain('LEAKCANARY');
  });

  it('handles a write that throws synchronously', async () => {
    const repo = fakeRepo(() => {
      throw new RepoError('forbidden', 'sync');
    });
    const log = new MemoryEventLog(CTX);
    await expect(recordAudit(repo, fullEntry(), log)).resolves.toBe(false);
    expect(onlyEvent(log)).toMatchObject({ reason: 'forbidden' });
  });

  describe('never throws with a throwing EventLog', () => {
    it('valid entry → true', async () => {
      await expect(recordAudit(okRepo(), fullEntry(), throwingLog)).resolves.toBe(true);
    });

    it('invalid entry → false', async () => {
      const bad = { ...fullEntry(), runId: 'nope' };
      await expect(recordAudit(okRepo(), bad, throwingLog)).resolves.toBe(false);
    });

    it('failed write → false', async () => {
      const repo = fakeRepo(() => Promise.reject(new RepoError('unavailable', 'x')));
      await expect(recordAudit(repo, fullEntry(), throwingLog)).resolves.toBe(false);
    });

    it('non-Error rejection → false', async () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error rejection is the point
      const repo = fakeRepo(() => Promise.reject('boom'));
      await expect(recordAudit(repo, fullEntry(), throwingLog)).resolves.toBe(false);
    });
  });

  describe('the event never carries row values', () => {
    const FOLDER = 'LEAKCANARYFOLDER/Súkromné';
    const PROVIDER = 'leakcanaryprov';
    const REASON = 'leakcanary-reason';
    const CANARY_RUN = 'c0ffee00c0ffee00';
    const CANARY_ACCOUNT = 'abcdef01-2345-4678-89ab-cdef01234567';

    function canaryEntry(): AuditEntry {
      return {
        accountId: CANARY_ACCOUNT,
        action: 'account.add',
        details: { provider: PROVIDER },
        result: 'failed',
        reason: REASON,
        runId: CANARY_RUN,
        messageCount: 987654,
        bytes: 555444333,
      };
    }

    function expectClean(log: MemoryEventLog): void {
      expect(log.lines).toHaveLength(1);
      const line = log.lines.join('\n');
      for (const value of [
        'LEAKCANARY',
        PROVIDER,
        REASON,
        CANARY_RUN,
        CANARY_ACCOUNT,
        '987654',
        '555444333',
      ]) {
        expect(line).not.toContain(value);
      }
      const rec: Record<string, unknown> = log.records[0] ?? {};
      expect(Object.keys(rec)).toEqual(['ts', 'event', 'action', 'reason', 'level', 'run', 'v']);
      expect(rec['run']).toBe(CTX.run);
    }

    it('on a failed write', async () => {
      const log = new MemoryEventLog(CTX);
      const repo = fakeRepo(() => Promise.reject(new RepoError('forbidden', 'x')));
      const e = { ...canaryEntry(), action: 'mail.move' as const, folder: FOLDER };
      delete e.details;
      await expect(recordAudit(repo, e, log)).resolves.toBe(false);
      expectClean(log);
      expect(log.records[0]).toMatchObject({ action: 'mail.move', reason: 'forbidden' });
    });

    it('on a failed account write with a provider', async () => {
      const log = new MemoryEventLog(CTX);
      const repo = fakeRepo(() => Promise.reject(new Error('LEAKCANARY')));
      await expect(recordAudit(repo, canaryEntry(), log)).resolves.toBe(false);
      expectClean(log);
      expect(log.records[0]).toMatchObject({ action: 'account.add', reason: 'unknown' });
    });

    it('on an invalid entry (bad folder)', async () => {
      const log = new MemoryEventLog(CTX);
      const repo = okRepo();
      const e = { ...canaryEntry(), folder: `${FOLDER}\n{"event":"forged"}` };
      await expect(recordAudit(repo, e, log)).resolves.toBe(false);
      expect(repo.writeMock).not.toHaveBeenCalled();
      expectClean(log);
      expect(log.lines.join('\n')).not.toContain('forged');
      expect(log.records[0]).toMatchObject({ action: 'account.add', reason: 'invalid' });
    });
  });
});

describe('auditFailureReason', () => {
  it.each<[RepoErrorCode, string]>([
    ['forbidden', 'forbidden'],
    ['unavailable', 'unavailable'],
    ['conflict', 'conflict'],
    ['not_found', 'not-found'],
    ['unknown', 'unknown'],
  ])('RepoError(%s) → %s', (code, reason) => {
    expect(auditFailureReason(new RepoError(code, 'x'))).toBe(reason);
  });

  it.each<unknown>([
    new Error('forbidden'),
    'forbidden',
    undefined,
    null,
    { code: 'forbidden' },
    { name: 'RepoError', code: 'conflict' },
  ])('non-RepoError %j → unknown', (err) => {
    expect(auditFailureReason(err)).toBe('unknown');
  });
});

describe('auditWriteFailed', () => {
  it.each(AUDIT_ACTIONS)('keeps the audit action %s', (action) => {
    expect(auditWriteFailed(action, 'forbidden')).toEqual({
      event: 'audit.write-failed',
      action,
      reason: 'forbidden',
    });
  });

  it.each(['', 'foo.bar', 'Mail.Trash', 'mail.trash\n', 'canary@secret-domain.example'])(
    'maps the non-audit action %j to other',
    (action) => {
      expect(auditWriteFailed(action, 'invalid')).toEqual({
        event: 'audit.write-failed',
        action: 'other',
        reason: 'invalid',
      });
    },
  );

  it('renders as an app line at level error with fields action, reason', () => {
    const event: LogEvent = auditWriteFailed('mail.expunge', 'unavailable');
    const r = renderEvent(event, CTX);
    expect(r?.kind).toBe('app');
    expect(r?.record.level).toBe('error');
    expect(Object.keys(r?.record ?? {})).toEqual([
      'ts',
      'event',
      'action',
      'reason',
      'level',
      'run',
      'v',
    ]);
    expect(r?.line.startsWith('{')).toBe(true);
  });
});

// Round 2 (review hardening).

/** An entry whose `action` getter throws — validation and recordAudit must not throw. */
function throwingActionEntry(): AuditEntry {
  const e: Record<string, unknown> = { result: 'ok' };
  Object.defineProperty(e, 'action', {
    enumerable: true,
    get: () => {
      throw new Error('LEAKCANARY getter');
    },
  });
  return e as unknown as AuditEntry;
}

describe('recordAudit never throws on hostile input', () => {
  it.each<[string, () => AuditEntry]>([
    ['null', () => null as never],
    ['undefined', () => undefined as never],
    ['an entry with a throwing action getter', throwingActionEntry],
  ])('%s → false, action other, reason invalid, no repo call', async (_label, make) => {
    const repo = okRepo();
    const log = new MemoryEventLog(CTX);
    await expect(recordAudit(repo, make(), log)).resolves.toBe(false);
    expect(repo.writeMock).not.toHaveBeenCalled();
    expect(onlyEvent(log)).toMatchObject({
      event: 'audit.write-failed',
      action: 'other',
      reason: 'invalid',
    });
    expect(log.lines.join('\n')).not.toContain('LEAKCANARY');
  });

  it('resolves false with a throwing EventLog too', async () => {
    await expect(recordAudit(okRepo(), throwingActionEntry(), throwingLog)).resolves.toBe(false);
    await expect(recordAudit(okRepo(), null as never, throwingLog)).resolves.toBe(false);
  });

  it('isValidAuditEntry returns false (no throw) for a throwing getter', () => {
    expect(() => isValidAuditEntry(throwingActionEntry())).not.toThrow();
    expect(isValidAuditEntry(throwingActionEntry())).toBe(false);
  });
});

describe('auditWriteFailed runtime allowlists', () => {
  it.each<unknown>(['bogus', '', 'Forbidden', 'not_found', null, undefined, 42])(
    'maps the reason %j to unknown',
    (reason) => {
      expect(auditWriteFailed('mail.trash', reason as never)).toEqual({
        event: 'audit.write-failed',
        action: 'mail.trash',
        reason: 'unknown',
      });
    },
  );

  it.each(['forbidden', 'unavailable', 'conflict', 'not-found', 'unknown', 'invalid'] as const)(
    'keeps the reason %s',
    (reason) => {
      expect(auditWriteFailed('backup', reason).reason).toBe(reason);
    },
  );

  it.each([
    'LEAKCANARY/Súkromné',
    'INBOX/LEAKCANARY',
    'leakcanaryprov',
    'imap.leakcanary-host.example',
    'leakcanary@secret-domain.example',
    'mail.trash\n{"event":"leakcanary"}',
  ])('never renders the action-like value %j', (action) => {
    const r = renderEvent(auditWriteFailed(action, 'invalid'), CTX);
    expect(r).not.toBeNull();
    expect(r?.line.toLowerCase()).not.toContain('leakcanary');
    expect(r?.record['action']).toBe('other');
  });
});

describe('folder rules (round 2)', () => {
  it.each(['INBOX', 'Archív/2024', '📁 Projekty', 'ok\u{1F4C1}'])('accepts %j', (folder) => {
    expect(valid(entry({ folder }))).toBe(true);
  });

  it.each([
    ['an address', 'Other Users/alice@example.com'],
    ['a lone @', '@'],
    ['a line separator', 'INBOX x'],
    ['a paragraph separator', 'INBOX x'],
    ['an Arabic letter mark', 'INBOX؜'],
    ['a tag character', 'INBOX\u{E0041}'],
    ['a lone high surrogate', 'lone\ud800'],
    ['a lone low surrogate', '\udc00x'],
    ['NUL', 'INBOX\u0000'],
    ['a newline', 'INBOX\n'],
    ['a right-to-left override', 'INBOX‮'],
    ['a zero-width space', 'IN​BOX'],
  ])('rejects a folder with %s', (_label, folder) => {
    expect(valid(entry({ folder }))).toBe(false);
  });
});
