import { beforeAll, describe, expect, it } from 'vitest';
import {
  SeedRefusedError,
  SeedVerifyError,
  TestGroundError,
} from '../support/test-ground/errors.js';
import {
  TestFolder,
  type FolderClient,
  type ServerMessage,
} from '../support/test-ground/folder.js';
import {
  MESSAGE_COUNT,
  buildTestGround,
  type SeededMessage,
  type TestGround,
} from '../support/test-ground/generator.js';
import { buildManifest, type SeedFlag } from '../support/test-ground/manifest.js';
import { planSeed, seedTestGround, verifySeed } from '../support/test-ground/seed.js';

// Offline tests of the seed logic (M1b-3b): the pure planSeed/verifySeed over a small
// hand-built ground, and seedTestGround over a recording in-memory FolderClient.

const DAY_MS = 86_400_000;

// ---------- a small hand-built ground ----------

function seedIdOf(version: number, index: number): string {
  return `v${version}-${String(index).padStart(3, '0')}`;
}

function message(index: number, flags: SeedFlag[], version = 1): SeededMessage {
  const seedId = seedIdOf(version, index);
  const messageId = `<${seedId}@mm-test.invalid>`;
  const internalDate = new Date(Date.UTC(2024, 0, 1, 10, 0, 0) + index * DAY_MS).toISOString();
  const subject = `Test message ${index}`;
  const raw = Buffer.from(
    [
      `X-MM-Test-Seed: ${seedId}`,
      `Message-ID: ${messageId}`,
      'From: Sender <sender@example.test>',
      'To: mm-test@mm-test.invalid',
      `Subject: ${subject}`,
      '',
      `Body ${index} ${'.'.repeat(index * 17)}`,
      '',
    ].join('\r\n'),
  );
  return {
    raw,
    facts: {
      seedId,
      index,
      messageId,
      from: { name: 'Sender', address: 'sender@example.test', domain: 'example.test' },
      to: 'mm-test@mm-test.invalid',
      subject,
      sentDate: internalDate,
      internalDate,
      dateOffsetDays: 0,
      size: raw.length,
      flags: [...flags].sort(),
      attachments: [],
    },
  };
}

function groundOf(messages: SeededMessage[], version = 1): TestGround {
  return {
    version,
    messages,
    manifest: buildManifest(
      version,
      messages.map((m) => m.facts),
    ),
  };
}

const M1 = message(1, []);
const M2 = message(2, ['\\Seen']);
const M3 = message(3, ['\\Flagged']);
const M4 = message(4, ['\\Flagged', '\\Seen']);
const GROUND = groundOf([M1, M2, M3, M4]);

function server(m: SeededMessage, uid: number, over: Partial<ServerMessage> = {}): ServerMessage {
  return {
    uid,
    seedId: m.facts.seedId,
    messageId: m.facts.messageId,
    size: m.facts.size,
    internalDate: new Date(m.facts.internalDate),
    flags: [...m.facts.flags],
    keywords: [],
    ...over,
  };
}

function allServer(): ServerMessage[] {
  return GROUND.messages.map((m, i) => server(m, i + 1));
}

const NO_UNEXPECTED = { foreign: 0, duplicate: 0, olderVersion: 0, changed: 0 };

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

// ---------- planSeed ----------

describe('planSeed', () => {
  it('empty folder → everything missing, in index order', () => {
    const plan = planSeed([], GROUND);
    expect(plan.missing.map((m) => m.facts.seedId)).toEqual([
      'v1-001',
      'v1-002',
      'v1-003',
      'v1-004',
    ]);
    expect(plan.flagDrift).toEqual([]);
    expect(plan.unexpected).toEqual(NO_UNEXPECTED);
  });

  it('complete and matching → nothing to do', () => {
    const plan = planSeed(allServer(), GROUND);
    expect(plan.missing).toEqual([]);
    expect(plan.flagDrift).toEqual([]);
    expect(plan.unexpected).toEqual(NO_UNEXPECTED);
  });

  it('missing messages come back in index order, whatever the server order', () => {
    const plan = planSeed([server(M3, 10), server(M1, 11)], GROUND);
    expect(plan.missing.map((m) => m.facts.seedId)).toEqual(['v1-002', 'v1-004']);
    expect(plan.missing[0]).toBe(M2);
    expect(plan.unexpected).toEqual(NO_UNEXPECTED);
  });

  it('a message without a seed id is foreign', () => {
    const foreign = server(M1, 99, { seedId: null, messageId: '<other@example.test>' });
    const plan = planSeed([...allServer(), foreign], GROUND);
    expect(plan.unexpected).toEqual({ ...NO_UNEXPECTED, foreign: 1 });
    expect(plan.missing).toEqual([]);
  });

  it.each(['v1-999', 'v1-000', 'v1-005'])('an unknown seed id (%s) is foreign', (seedId) => {
    const plan = planSeed([...allServer(), server(M1, 99, { seedId })], GROUND);
    expect(plan.unexpected).toEqual({ ...NO_UNEXPECTED, foreign: 1 });
  });

  it.each(['garbage', '', 'v1-01x', 'v-001', 'vX-001', 'v1_001', '1-001'])(
    'a malformed seed id (%j) is foreign',
    (seedId) => {
      const plan = planSeed([...allServer(), server(M1, 99, { seedId })], GROUND);
      expect(plan.unexpected).toEqual({ ...NO_UNEXPECTED, foreign: 1 });
    },
  );

  it('a seed id seen again is a duplicate; the first occurrence is classified normally', () => {
    const plan = planSeed([server(M1, 1), server(M2, 2), server(M1, 3)], GROUND);
    expect(plan.unexpected).toEqual({ ...NO_UNEXPECTED, duplicate: 1 });
    expect(plan.missing.map((m) => m.facts.seedId)).toEqual(['v1-003', 'v1-004']);
    expect(plan.flagDrift).toEqual([]);
  });

  it('three copies of one seed id count as two duplicates', () => {
    const plan = planSeed([...allServer(), server(M2, 7), server(M2, 8)], GROUND);
    expect(plan.unexpected).toEqual({ ...NO_UNEXPECTED, duplicate: 2 });
  });

  it.each([
    ['v0-001', 0],
    ['v2-001', 2],
    ['v2-004', 2],
  ])('a seed id of another version (%s) is older version', (seedId) => {
    const plan = planSeed([...allServer(), server(M1, 99, { seedId })], GROUND);
    expect(plan.unexpected).toEqual({ ...NO_UNEXPECTED, olderVersion: 1 });
  });

  it('older version is judged against ground.version, not a constant', () => {
    const v2 = groundOf([message(1, [], 2)], 2);
    const plan = planSeed([server(M1, 1)], v2);
    expect(plan.unexpected).toEqual({ ...NO_UNEXPECTED, olderVersion: 1 });
    expect(plan.missing.map((m) => m.facts.seedId)).toEqual(['v2-001']);
  });

  it.each<[string, Partial<ServerMessage>]>([
    ['size differs', { size: M2.facts.size + 1 }],
    ['size smaller', { size: M2.facts.size - 1 }],
    [
      'internal date differs by a second',
      { internalDate: new Date(Date.parse(M2.facts.internalDate) + 1000) },
    ],
    ['internal date is an invalid Date', { internalDate: new Date(Number.NaN) }],
  ])('%s → changed', (_label, over) => {
    const messages = allServer().map((s) => (s.seedId === 'v1-002' ? { ...s, ...over } : s));
    const plan = planSeed(messages, GROUND);
    expect(plan.unexpected).toEqual({ ...NO_UNEXPECTED, changed: 1 });
  });

  it('counts every kind at once', () => {
    const plan = planSeed(
      [
        server(M1, 1),
        server(M1, 2),
        server(M2, 3, { seedId: null }),
        server(M2, 4, { seedId: 'v0-002' }),
        server(M3, 5, { size: 1 }),
      ],
      GROUND,
    );
    expect(plan.unexpected).toEqual({ foreign: 1, duplicate: 1, olderVersion: 1, changed: 1 });
  });

  it('a system-flag difference is drift: manifest flags plus the server keywords', () => {
    const messages = allServer().map((s) => {
      if (s.seedId === 'v1-001') return { ...s, flags: ['\\Seen'], keywords: ['$Junk'] };
      if (s.seedId === 'v1-002')
        return { ...s, flags: [], keywords: ['$HasAttachment', 'NonJunk'] };
      if (s.seedId === 'v1-003') return { ...s, flags: ['\\Answered', '\\Flagged'] };
      return s;
    });
    const plan = planSeed(messages, GROUND);

    expect(plan.unexpected).toEqual(NO_UNEXPECTED);
    expect(plan.missing).toEqual([]);
    const drift = [...plan.flagDrift].sort((a, b) => a.uid - b.uid);
    expect(drift.map((d) => [d.uid, d.seedId])).toEqual([
      [1, 'v1-001'],
      [2, 'v1-002'],
      [3, 'v1-003'],
    ]);
    expect(sorted(drift[0]?.flags ?? ['?'])).toEqual(['$Junk']);
    expect(sorted(drift[1]?.flags ?? [])).toEqual(sorted(['\\Seen', '$HasAttachment', 'NonJunk']));
    expect(sorted(drift[2]?.flags ?? [])).toEqual(['\\Flagged']);
  });

  it('a keyword-only difference is not drift', () => {
    const messages = allServer().map((s) => ({ ...s, keywords: ['$HasAttachment', '$Junk'] }));
    const plan = planSeed(messages, GROUND);
    expect(plan.flagDrift).toEqual([]);
    expect(plan.unexpected).toEqual(NO_UNEXPECTED);
  });
});

// ---------- verifySeed ----------

describe('verifySeed', () => {
  it('complete and matching → 0 (server order and keywords do not matter)', () => {
    const messages = allServer()
      .reverse()
      .map((s) => ({ ...s, keywords: ['$HasAttachment'] }));
    expect(verifySeed(messages, GROUND)).toBe(0);
  });

  it('a missing message is a mismatch', () => {
    expect(verifySeed(allServer().slice(1), GROUND)).toBeGreaterThan(0);
    expect(verifySeed([], GROUND)).toBeGreaterThan(0);
  });

  it('an extra server message is a mismatch', () => {
    expect(verifySeed([...allServer(), server(M1, 99, { seedId: null })], GROUND)).toBeGreaterThan(
      0,
    );
    expect(verifySeed([...allServer(), server(M1, 99)], GROUND)).toBeGreaterThan(0);
  });

  it.each<[string, Partial<ServerMessage>]>([
    ['size', { size: M3.facts.size + 1 }],
    ['internal date', { internalDate: new Date(Date.parse(M3.facts.internalDate) - 1000) }],
    ['invalid internal date', { internalDate: new Date(Number.NaN) }],
    ['a system flag dropped', { flags: [] }],
    ['a system flag added', { flags: ['\\Flagged', '\\Seen'] }],
  ])('one message with a different %s → 1', (_label, over) => {
    const messages = allServer().map((s) => (s.seedId === 'v1-003' ? { ...s, ...over } : s));
    expect(verifySeed(messages, GROUND)).toBe(1);
  });

  it('counts each differing message', () => {
    const messages = allServer().map((s) =>
      s.seedId === 'v1-002' || s.seedId === 'v1-004' ? { ...s, flags: [] } : s,
    );
    expect(verifySeed(messages, GROUND)).toBe(2);
  });
});

// ---------- seedTestGround over a recording fake ----------

interface StoredMessage {
  uid: number;
  seedId: string | null;
  messageId: string | null;
  size: number;
  internalDate: Date;
  /** Everything the server has, keywords included. */
  flags: string[];
}

type LoggedMethod = Exclude<keyof FolderClient, 'namespacePrefix' | 'selectedPath'>;

interface Call {
  method: LoggedMethod;
  args: unknown[];
}

const WRITES: ReadonlySet<LoggedMethod> = new Set<LoggedMethod>([
  'create',
  'unsubscribe',
  'delete',
  'append',
  'setFlags',
]);

const SYSTEM = new Set(['\\Answered', '\\Deleted', '\\Draft', '\\Flagged', '\\Seen']);

function headerValue(raw: Buffer, name: string): string | null {
  const end = raw.indexOf('\r\n\r\n');
  const block = raw.subarray(0, end === -1 ? raw.length : end).toString('latin1');
  for (const line of block.replace(/\r\n(?=[ \t])/g, '').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0 && line.slice(0, colon).toLowerCase() === name.toLowerCase()) {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

class FakeFolderClient implements FolderClient {
  selected: string | null = null;
  readonly folders = new Map<string, { nextUid: number; messages: StoredMessage[] }>();
  readonly calls: Call[] = [];
  locksHeld = 0;
  /** The server silently drops this flag on APPEND (a flag it doesn't allow). */
  dropFlagOnAppend: string | undefined;

  constructor(folders: string[] = []) {
    for (const path of folders) this.folders.set(path, { nextUid: 1, messages: [] });
  }

  writes(): Call[] {
    return this.calls.filter((c) => WRITES.has(c.method));
  }

  appends(): { raw: Buffer; flags: string[]; internalDate: Date }[] {
    return this.calls
      .filter((c) => c.method === 'append')
      .map((c) => ({
        raw: c.args[1] as Buffer,
        flags: c.args[2] as string[],
        internalDate: c.args[3] as Date,
      }));
  }

  /** Puts a message straight into a folder, as if it was there before the run. */
  put(path: string, m: Omit<StoredMessage, 'uid'>): number {
    const folder = this.folders.get(path);
    if (folder === undefined) throw new Error('fake: no such folder');
    const uid = folder.nextUid++;
    folder.messages.push({ uid, ...m, internalDate: new Date(m.internalDate.getTime()) });
    return uid;
  }

  putSeeded(
    path: string,
    m: SeededMessage,
    over: Partial<Omit<StoredMessage, 'uid'>> = {},
  ): number {
    return this.put(path, {
      seedId: m.facts.seedId,
      messageId: m.facts.messageId,
      size: m.facts.size,
      internalDate: new Date(m.facts.internalDate),
      flags: [...m.facts.flags],
      ...over,
    });
  }

  stored(path: string): StoredMessage[] {
    return this.folders.get(path)?.messages ?? [];
  }

  private log(method: LoggedMethod, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  namespacePrefix(): string {
    return '';
  }

  selectedPath(): string | null {
    return this.selected;
  }

  listPaths(): Promise<string[]> {
    this.log('listPaths');
    return Promise.resolve([...this.folders.keys()]);
  }

  create(path: string): Promise<boolean> {
    this.log('create', path);
    if (this.folders.has(path)) return Promise.resolve(false);
    this.folders.set(path, { nextUid: 1, messages: [] });
    return Promise.resolve(true);
  }

  unsubscribe(path: string): Promise<boolean> {
    this.log('unsubscribe', path);
    return Promise.resolve(true);
  }

  delete(path: string): Promise<void> {
    this.log('delete', path);
    this.folders.delete(path);
    return Promise.resolve();
  }

  messageCount(path: string): Promise<number> {
    this.log('messageCount', path);
    const folder = this.folders.get(path);
    if (folder === undefined) return Promise.reject(new Error('fake: no such folder'));
    return Promise.resolve(folder.messages.length);
  }

  select(path: string): Promise<{ release(): void }> {
    this.log('select', path);
    if (!this.folders.has(path)) return Promise.reject(new Error('fake: no such folder'));
    this.selected = path;
    this.locksHeld++;
    return Promise.resolve({
      release: () => {
        this.locksHeld--;
      },
    });
  }

  fetchMessages(): Promise<ServerMessage[]> {
    this.log('fetchMessages');
    const folder = this.selected === null ? undefined : this.folders.get(this.selected);
    if (folder === undefined) return Promise.reject(new Error('fake: nothing selected'));
    return Promise.resolve(
      folder.messages.map((m): ServerMessage => ({
        uid: m.uid,
        seedId: m.seedId,
        messageId: m.messageId,
        size: m.size,
        internalDate: new Date(m.internalDate.getTime()),
        flags: m.flags.filter((f) => SYSTEM.has(f)).sort(),
        keywords: m.flags.filter((f) => !SYSTEM.has(f) && f !== '\\Recent').sort(),
      })),
    );
  }

  append(path: string, raw: Buffer, flags: string[], internalDate: Date): Promise<void> {
    this.log('append', path, raw, [...flags], new Date(internalDate.getTime()));
    const folder = this.folders.get(path);
    if (folder === undefined) return Promise.reject(new Error('fake: no such folder'));
    folder.messages.push({
      uid: folder.nextUid++,
      seedId: headerValue(raw, 'X-MM-Test-Seed'),
      messageId: headerValue(raw, 'Message-ID'),
      size: raw.length,
      internalDate: new Date(internalDate.getTime()),
      flags: flags.filter((f) => f !== this.dropFlagOnAppend),
    });
    return Promise.resolve();
  }

  setFlags(uid: number, flags: string[]): Promise<void> {
    this.log('setFlags', uid, [...flags]);
    const folder = this.selected === null ? undefined : this.folders.get(this.selected);
    const message = folder?.messages.find((m) => m.uid === uid);
    if (message === undefined) return Promise.reject(new Error('fake: no such uid'));
    message.flags = [...flags];
    return Promise.resolve();
  }
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('seedTestGround', () => {
  it('missing folder → created, every message appended in index order with its flags and date', async () => {
    const fake = new FakeFolderClient(['INBOX']);
    const report = await seedTestGround(TestFolder.fromClient(fake), GROUND);

    expect(report).toEqual({ created: true, appended: 4, flagsReset: 0, total: 4 });
    expect(fake.calls.filter((c) => c.method === 'create')).toEqual([
      { method: 'create', args: ['mm-test'] },
    ]);
    const appends = fake.appends();
    expect(appends).toHaveLength(4);
    GROUND.messages.forEach((m, i) => {
      const a = appends[i];
      expect(a?.raw.equals(m.raw), m.facts.seedId).toBe(true);
      expect(sorted(a?.flags ?? ['?'])).toEqual(m.facts.flags);
      expect(a?.internalDate.getTime()).toBe(Date.parse(m.facts.internalDate));
    });
    expect(
      fake.calls.filter((c) => c.method === 'append').every((c) => c.args[0] === 'mm-test'),
    ).toBe(true);
    expect(fake.calls.some((c) => c.method === 'setFlags')).toBe(false);
    expect(fake.locksHeld).toBe(0);
  });

  it('existing empty folder → not created, everything appended', async () => {
    const fake = new FakeFolderClient(['mm-test']);
    const report = await seedTestGround(TestFolder.fromClient(fake), GROUND);
    expect(report).toEqual({ created: false, appended: 4, flagsReset: 0, total: 4 });
    expect(fake.stored('mm-test').map((m) => m.seedId)).toEqual([
      'v1-001',
      'v1-002',
      'v1-003',
      'v1-004',
    ]);
  });

  it('complete folder → appended 0, flagsReset 0, no writes', async () => {
    const fake = new FakeFolderClient(['mm-test']);
    for (const m of GROUND.messages) fake.putSeeded('mm-test', m);
    const report = await seedTestGround(TestFolder.fromClient(fake), GROUND);
    expect(report).toEqual({ created: false, appended: 0, flagsReset: 0, total: 4 });
    expect(fake.writes()).toEqual([]);
    expect(fake.locksHeld).toBe(0);
  });

  it('a second run after a first one is a no-op', async () => {
    const fake = new FakeFolderClient();
    const folder = TestFolder.fromClient(fake);
    await seedTestGround(folder, GROUND);
    const before = fake.writes().length;
    const report = await seedTestGround(folder, GROUND);
    expect(report).toEqual({ created: false, appended: 0, flagsReset: 0, total: 4 });
    expect(fake.writes()).toHaveLength(before);
  });

  it('partial folder (interrupted seed) → only the missing ones, in index order', async () => {
    const fake = new FakeFolderClient(['mm-test']);
    fake.putSeeded('mm-test', M3);
    fake.putSeeded('mm-test', M1);
    const report = await seedTestGround(TestFolder.fromClient(fake), GROUND);

    expect(report).toEqual({ created: false, appended: 2, flagsReset: 0, total: 4 });
    expect(fake.appends().map((a) => headerValue(a.raw, 'X-MM-Test-Seed'))).toEqual([
      'v1-002',
      'v1-004',
    ]);
  });

  it('flag drift → STORE with manifest flags plus the server keywords, nothing appended', async () => {
    const fake = new FakeFolderClient(['mm-test']);
    fake.putSeeded('mm-test', M1);
    const uid2 = fake.putSeeded('mm-test', M2, { flags: ['\\Flagged', '$HasAttachment'] });
    fake.putSeeded('mm-test', M3, { flags: ['\\Flagged', '$Junk'] });
    fake.putSeeded('mm-test', M4);

    const report = await seedTestGround(TestFolder.fromClient(fake), GROUND);

    expect(report).toEqual({ created: false, appended: 0, flagsReset: 1, total: 4 });
    const stores = fake.calls.filter((c) => c.method === 'setFlags');
    expect(stores).toHaveLength(1);
    expect(stores[0]?.args[0]).toBe(uid2);
    expect(sorted(stores[0]?.args[1] as string[])).toEqual(sorted(['\\Seen', '$HasAttachment']));
    expect(fake.calls.some((c) => c.method === 'append')).toBe(false);
    expect(fake.locksHeld).toBe(0);
  });

  it('drift and missing together → reset and append', async () => {
    const fake = new FakeFolderClient(['mm-test']);
    fake.putSeeded('mm-test', M1, { flags: ['\\Seen'] });
    const report = await seedTestGround(TestFolder.fromClient(fake), GROUND);
    expect(report).toEqual({ created: false, appended: 3, flagsReset: 1, total: 4 });
    // Flags are reset before any append (the drift set only holds messages already there).
    const writes = fake.writes().map((c) => c.method);
    expect(writes.indexOf('setFlags')).toBeLessThan(writes.indexOf('append'));
    expect(writes.lastIndexOf('setFlags')).toBeLessThan(writes.indexOf('append'));
  });

  it('reports progress as (appended so far, missing count)', async () => {
    const fake = new FakeFolderClient(['mm-test']);
    fake.putSeeded('mm-test', M2);
    const progress: [number, number][] = [];
    await seedTestGround(TestFolder.fromClient(fake), GROUND, (appended, missing) => {
      progress.push([appended, missing]);
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every(([, missing]) => missing === 3)).toBe(true);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]?.[0]).toBeGreaterThan(progress[i - 1]?.[0] ?? Infinity);
    }
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  type Setup = (fake: FakeFolderClient) => void;
  it.each<[string, Setup, keyof typeof NO_UNEXPECTED]>([
    [
      'foreign',
      (f) => f.putSeeded('mm-test', M3, { seedId: null, messageId: '<other@example.test>' }),
      'foreign',
    ],
    ['duplicate', (f) => f.putSeeded('mm-test', M2), 'duplicate'],
    ['older version', (f) => f.putSeeded('mm-test', M2, { seedId: 'v0-002' }), 'olderVersion'],
    ['changed', (f) => f.putSeeded('mm-test', M4, { size: M4.facts.size + 3 }), 'changed'],
  ])('%s message → SeedRefusedError with counts and zero writes', async (_label, setup, kind) => {
    const fake = new FakeFolderClient(['mm-test']);
    // Drift and missing messages too: none of them may be touched on refusal.
    fake.putSeeded('mm-test', M1, { flags: ['\\Seen'] });
    fake.putSeeded('mm-test', M2);
    setup(fake);
    const before = JSON.stringify(fake.stored('mm-test'));

    const err = await caught(() => seedTestGround(TestFolder.fromClient(fake), GROUND));

    expect(err).toBeInstanceOf(SeedRefusedError);
    expect(err).toBeInstanceOf(TestGroundError);
    expect((err as SeedRefusedError).counts).toEqual({ ...NO_UNEXPECTED, [kind]: 1 });
    expect(fake.writes()).toEqual([]);
    expect(JSON.stringify(fake.stored('mm-test'))).toBe(before);
    expect(fake.locksHeld).toBe(0);
  });

  it('a flag the server drops on APPEND → SeedVerifyError with the mismatch count', async () => {
    const fake = new FakeFolderClient(['mm-test']);
    fake.dropFlagOnAppend = '\\Flagged';
    const err = await caught(() => seedTestGround(TestFolder.fromClient(fake), GROUND));

    expect(err).toBeInstanceOf(SeedVerifyError);
    expect(err).toBeInstanceOf(TestGroundError);
    expect((err as SeedVerifyError).mismatches).toBeGreaterThan(0);
    expect(fake.locksHeld).toBe(0);
  });
});

describe('seedTestGround with the real 150-message ground', () => {
  let real: TestGround;
  beforeAll(async () => {
    real = await buildTestGround();
  }, 60_000);

  it('uploads everything into an empty folder, then a second run is a no-op', async () => {
    const fake = new FakeFolderClient();
    const folder = TestFolder.fromClient(fake);

    const first = await seedTestGround(folder, real);
    expect(first).toEqual({
      created: true,
      appended: MESSAGE_COUNT,
      flagsReset: 0,
      total: MESSAGE_COUNT,
    });
    expect(fake.stored('mm-test').map((m) => m.seedId)).toEqual(
      real.messages.map((m) => m.facts.seedId),
    );

    const second = await seedTestGround(folder, real);
    expect(second).toEqual({ created: false, appended: 0, flagsReset: 0, total: MESSAGE_COUNT });
  }, 30_000);
});
