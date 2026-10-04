import { describe, it, expect, vi } from 'vitest';
import { foldersJson, quotaLine, totalsLine } from '../../src/cli/folders-text.js';
import {
  AccountError,
  createLocalGuard,
  openAccountSession,
  withAccountSession,
} from '../../src/core/accounts.js';
import { LocalCredentialProvider } from '../../src/core/credentials.js';
import type { MailAccount } from '../../src/core/db/repos.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { buildServerFeatures, sanitizeCapabilities } from '../../src/core/imap/features.js';
import type {
  ImapClientLike,
  ImapSession,
  OpenSessionOptions,
} from '../../src/core/imap/session.js';
import { NullEventLog } from '../../src/core/log/index.js';
import {
  listFolders,
  type FolderSession,
  type FolderTree,
} from '../../src/core/mailbox/folders.js';

// Regression tests for the M2a independent review: subscription state as imapflow really
// reports it, Gmail name-guessed roles, truncated totals, --no-size quota text, LIST-STATUS gaps,
// untruncated JSON paths, the XLIST \Inbox role, and withAccountSession directly (plus
// openAccountSession, which it is built on since M2b-2).

interface Entry {
  path: string;
  specialUse?: string;
  specialUseSource?: 'extension' | 'name' | 'user';
  /** imapflow: true, or left undefined — never false. */
  subscribed?: true;
  status?: { path: string; messages: number; unseen: number };
}

function fake(entries: Entry[], caps: Record<string, true> = {}) {
  const calls: string[] = [];
  const client = {
    mailbox: false as { exists: number } | false,
    list: () => {
      calls.push('list');
      return Promise.resolve(
        entries.map((e) => ({
          pathAsListed: e.path,
          name: e.path.split('/').at(-1) ?? e.path,
          delimiter: '/',
          parent: [],
          parentPath: '',
          flags: new Set<string>(),
          listed: true,
          ...e,
        })),
      );
    },
    status: (path: string) => {
      calls.push(`status ${path}`);
      return Promise.resolve({ path, messages: 2, unseen: 1 });
    },
    getQuota: () => Promise.resolve(false as const),
    getMailboxLock: (path: string) => {
      calls.push(`examine ${path}`);
      client.mailbox = { exists: 2 };
      return Promise.resolve({ path, release: () => undefined });
    },
    fetch: () =>
      (async function* () {
        await Promise.resolve();
        yield { seq: 1, size: 10 };
        yield { seq: 2, size: 20 };
      })(),
  };
  const capRecord = sanitizeCapabilities({ IMAP4REV1: true, ...caps });
  const session: FolderSession = {
    client: client as unknown as ImapClientLike,
    features: buildServerFeatures(capRecord, new Set()),
    closed: false,
  };
  return { session, calls };
}

describe('subscription state (review #1)', () => {
  it('a folder imapflow leaves without `subscribed` is unsubscribed → (hidden)', async () => {
    const { session } = fake([{ path: 'INBOX', subscribed: true }, { path: 'Old' }]);
    const tree = await listFolders(session, { sizes: false });
    expect(tree.folders.find((f) => f.path === 'Old')?.subscribed).toBe(false);
    expect(tree.folders.find((f) => f.path === 'INBOX')?.subscribed).toBe(true);
  });
});

describe('Gmail roles guessed from names (review #2, #5)', () => {
  const GMAIL = { 'X-GM-EXT-1': true as const };

  it('a label "Spam" with a name-guessed \\Junk role is overlapping, not summed or sized', async () => {
    const { session, calls } = fake(
      [
        { path: 'INBOX' },
        { path: '[Gmail]/All Mail', specialUse: '\\All', specialUseSource: 'extension' },
        { path: 'Spam', specialUse: '\\Junk', specialUseSource: 'name' },
      ],
      GMAIL,
    );
    const tree = await listFolders(session, { sizes: true });
    expect(tree.folders.find((f) => f.path === 'Spam')?.overlapping).toBe(true);
    expect(tree.totals?.messages).toBe(2); // All Mail only
    expect(calls).not.toContain('examine Spam');
    expect(calls).toContain('examine [Gmail]/All Mail');
  });

  it('All Mail hidden: totals unknown and nothing is sized by the fallback', async () => {
    const { session, calls } = fake(
      [
        { path: 'INBOX' },
        { path: '[Gmail]/Spam', specialUse: '\\Junk', specialUseSource: 'extension' },
      ],
      GMAIL,
    );
    const tree = await listFolders(session, { sizes: true });
    expect(tree.gmailAllHidden).toBe(true);
    expect(calls.some((c) => c.startsWith('examine '))).toBe(false);
  });
});

describe('LIST-STATUS gaps (review #6)', () => {
  it('a folder missing from the LIST-STATUS reply gets its own STATUS', async () => {
    const { session, calls } = fake(
      [{ path: 'INBOX', status: { path: 'INBOX', messages: 5, unseen: 0 } }, { path: 'Gap' }],
      { 'LIST-STATUS': true },
    );
    const tree = await listFolders(session, { sizes: false });
    expect(calls).toEqual(['list', 'status Gap']);
    expect(tree.folders.find((f) => f.path === 'Gap')?.messages).toBe(2);
    expect(tree.unreadable).toBe(0);
  });
});

describe('XLIST \\Inbox (review #8)', () => {
  it('a localised inbox marked \\Inbox gets the inbox role', async () => {
    const { session } = fake([
      { path: 'Archiv' },
      { path: 'Posteingang', specialUse: '\\Inbox', specialUseSource: 'extension' },
    ]);
    const tree = await listFolders(session, { sizes: false });
    expect(tree.folders[0]?.path).toBe('Posteingang');
    expect(tree.folders[0]?.role).toBe('inbox');
  });
});

function tree(over: Partial<FolderTree>): FolderTree {
  return {
    folders: [],
    totals: { messages: 1, unseen: 0, bytes: 100, sizeSource: 'sum' },
    quota: null,
    truncated: false,
    unreadable: 0,
    gmailAllHidden: false,
    fallbacks: new Set(),
    ...over,
  };
}

describe('texts (review #3, #4, #7)', () => {
  it('truncated: the totals say they cover the first 5,000 folders only', () => {
    const t = tree({ truncated: true });
    expect(totalsLine(t, { sizes: true })).toContain('(first 5,000 folders only)');
    expect(totalsLine(tree({}), { sizes: true })).not.toContain('first 5,000');
  });

  it('no quota: the same "not available" text with and without sizes', () => {
    expect(quotaLine(tree({}))).toBe('Quota: not available from the mail server');
  });

  it('JSON paths are not cut, so parent still matches a path', () => {
    const long = 'a'.repeat(300);
    const child = `${long}/b`;
    const json = foldersJson(
      tree({
        folders: [
          {
            path: long,
            name: long,
            parentPath: null,
            depth: 0,
            delimiter: '/',
            role: null,
            roleSource: null,
            selectable: true,
            subscribed: true,
            messages: 0,
            unseen: 0,
            bytes: 0,
            sizeSource: 'sum',
            overlapping: false,
          },
          {
            path: child,
            name: 'b',
            parentPath: long,
            depth: 1,
            delimiter: '/',
            role: null,
            roleSource: null,
            selectable: true,
            subscribed: true,
            messages: 0,
            unseen: 0,
            bytes: 0,
            sizeSource: 'sum',
            overlapping: false,
          },
        ],
      }),
      'acct',
    );
    expect(json.folders[1]?.parent).toBe(json.folders[0]?.path);
    expect(json.folders[1]?.path).toBe(child);
  });
});

describe('withAccountSession / openAccountSession (review #10, M2b-2)', () => {
  const MASTER = Buffer.alloc(32, 7);
  const credentials = new LocalCredentialProvider({ masterKey: MASTER, masterKeyVersion: 1 });
  const ID = '3f2a91c0-5d4a-4b6f-9e21-7a8c0d1e2f34';
  const USER = '22222222-2222-4222-8222-222222222222';
  const HOST = 'imap.example-test-domain.eu';
  const EMAIL = 'someone@example-test-domain.eu';

  function account(provider = credentials): MailAccount {
    return {
      id: ID,
      userId: USER,
      label: null,
      email: EMAIL,
      provider: 'custom',
      host: HOST,
      port: 993,
      username: EMAIL,
      authType: 'password',
      secret: provider.encryptPassword(
        { userId: USER, accountId: ID, host: HOST, port: 993, username: EMAIL },
        'pw-1',
      ),
      capabilities: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastCheckedAt: null,
    };
  }

  function deps(open: ReturnType<typeof vi.fn>) {
    const log = new NullEventLog();
    return {
      credentials,
      log,
      guard: createLocalGuard(undefined, log),
      clientVersion: 'test',
      onChallenge: () => Promise.resolve(),
      open: open as never,
    };
  }

  it('logs in once with the saved password, runs fn, logs out — also when fn throws', async () => {
    const logout = vi.fn(() => Promise.resolve());
    const open = vi.fn<(o: OpenSessionOptions) => Promise<ImapSession>>(() =>
      Promise.resolve({ logout } as unknown as ImapSession),
    );
    await expect(
      withAccountSession(deps(open), account(), () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({ password: 'pw-1' });
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('an unreadable secret never reaches a login', async () => {
    const open = vi.fn();
    const other = new LocalCredentialProvider({
      masterKey: Buffer.alloc(32, 9),
      masterKeyVersion: 1,
    });
    await expect(
      withAccountSession(deps(open), account(other), () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(AccountError);
    expect(open).not.toHaveBeenCalled();
  });

  it('withAccountSession returns what fn returns and logs out once', async () => {
    const logout = vi.fn(() => Promise.resolve());
    const session = { logout } as unknown as ImapSession;
    const open = vi.fn<(o: OpenSessionOptions) => Promise<ImapSession>>(() =>
      Promise.resolve(session),
    );
    const fn = vi.fn((s: ImapSession) => Promise.resolve(s === session ? 42 : 0));
    await expect(withAccountSession(deps(open), account(), fn)).resolves.toBe(42);
    expect(open).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('openAccountSession returns the open session and leaves the logout to the caller', async () => {
    const logout = vi.fn(() => Promise.resolve());
    const session = { logout } as unknown as ImapSession;
    const open = vi.fn<(o: OpenSessionOptions) => Promise<ImapSession>>(() =>
      Promise.resolve(session),
    );
    await expect(openAccountSession(deps(open), account())).resolves.toBe(session);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({
      password: 'pw-1',
      settings: { host: HOST, port: 993, username: EMAIL },
    });
    expect(logout).not.toHaveBeenCalled();
  });

  it('openAccountSession: a login error propagates unchanged, one attempt, no retry', async () => {
    const failure = new ImapSessionError('auth-failed');
    const open = vi.fn<(o: OpenSessionOptions) => Promise<ImapSession>>(() =>
      Promise.reject(failure),
    );
    await expect(openAccountSession(deps(open), account())).rejects.toBe(failure);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('openAccountSession: an unreadable secret never reaches a login', async () => {
    const open = vi.fn();
    const other = new LocalCredentialProvider({
      masterKey: Buffer.alloc(32, 9),
      masterKeyVersion: 1,
    });
    await expect(openAccountSession(deps(open), account(other))).rejects.toBeInstanceOf(
      AccountError,
    );
    expect(open).not.toHaveBeenCalled();
  });
});
