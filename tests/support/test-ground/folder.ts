import { ImapFlow } from 'imapflow';
import type { ImapSession } from '../../../src/core/imap/session.js';
import { FolderGuardError, TestGroundError } from './errors.js';

// The folder guard of the test ground: every folder operation goes through TestFolder, which
// accepts exactly one path — the server's `mm-test` (personal namespace prefix + 'mm-test') —
// and refuses anything else before a single IMAP command is sent. Tests and scripts never use
// the IMAP client directly.
//
// Deliberately absent: messageDelete, mailboxClose, messageMove, mailboxRename and expunge
// (CLOSE and EXPUNGE remove \Deleted mail). Unseed deletes the whole folder instead.

export const TEST_FOLDER = 'mm-test';

/** IMAP system flags; keywords (e.g. Dovecot's $HasAttachment) are server-managed and ignored. */
export const SYSTEM_FLAGS: readonly string[] = [
  '\\Answered',
  '\\Deleted',
  '\\Draft',
  '\\Flagged',
  '\\Seen',
];

export interface ServerMessage {
  uid: number;
  /** X-MM-Test-Seed value; the header name is matched case-insensitively. */
  seedId: string | null;
  /** Envelope Message-ID, with angle brackets. */
  messageId: string | null;
  size: number;
  /** Invalid Date when the server value was unparsable. */
  internalDate: Date;
  /** Sorted system flags only (no \Recent). */
  flags: string[];
  /** Other flags the server has (kept when flags are reset), sorted. */
  keywords: string[];
}

export function parseSeedId(headers: Buffer | undefined): string | null {
  if (headers === undefined) return null;
  // Unfold first (RFC 5322: CRLF + whitespace continues the previous line).
  const text = headers.toString('latin1').replace(/\r?\n[ \t]+/g, ' ');
  const match = /^x-mm-test-seed:[ \t]*(\S+)/im.exec(text);
  return match?.[1] ?? null;
}

export function normalizeFlags(flags: Iterable<string>): { flags: string[]; keywords: string[] } {
  const system: string[] = [];
  const keywords: string[] = [];
  for (const flag of flags) {
    const known = SYSTEM_FLAGS.find((s) => s.toLowerCase() === flag.toLowerCase());
    if (known !== undefined) {
      if (!system.includes(known)) system.push(known);
    } else if (flag.toLowerCase() !== '\\recent' && !keywords.includes(flag)) {
      keywords.push(flag);
    }
  }
  return { flags: system.sort(), keywords: keywords.sort() };
}

/** The only IMAP surface the test ground uses. The ImapFlow adapter implements it; unit tests fake it. */
export interface FolderClient {
  /** '' when none. Read-only getter. */
  namespacePrefix(): string;
  /** Read-only getter. */
  selectedPath(): string | null;
  /** Selectable folders only. */
  listPaths(): Promise<string[]>;
  /** true = created, false = already existed. */
  create(path: string): Promise<boolean>;
  /** false when the server declined (e.g. not subscribed); never throws for that. */
  unsubscribe(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
  /** STATUS MESSAGES. */
  messageCount(path: string): Promise<number>;
  select(path: string): Promise<{ release(): void }>;
  /** Messages of the selected folder; [] when it is empty. */
  fetchMessages(): Promise<ServerMessage[]>;
  append(path: string, raw: Buffer, flags: string[], internalDate: Date): Promise<void>;
  /** Replaces the message's flags. */
  setFlags(uid: number, flags: string[]): Promise<void>;
}

export function testFolderPath(prefix: string): string {
  return `${prefix}${TEST_FOLDER}`;
}

export interface OpenTestFolder {
  fetchMessages(): Promise<ServerMessage[]>;
  append(raw: Buffer, flags: string[], internalDate: Date): Promise<void>;
  setFlags(uid: number, flags: string[]): Promise<void>;
  /** Idempotent; afterwards every method throws. */
  release(): void;
}

function fail(what: string): never {
  // Fixed text only: imapflow results/errors can carry server text.
  throw new TestGroundError(`The mail server did not complete: ${what}.`);
}

const NOT_SELECTABLE = ['\\noselect', '\\nonexistent'];

/** @internal Exported for offline unit tests over a stubbed ImapFlow.prototype object. */
export function imapFolderClient(client: ImapFlow): FolderClient {
  return {
    namespacePrefix: () => client.namespace?.prefix ?? '',
    selectedPath: () => (client.mailbox ? client.mailbox.path : null),

    async listPaths() {
      const entries = await client.list();
      return entries
        .filter((e) => ![...e.flags].some((f) => NOT_SELECTABLE.includes(f.toLowerCase())))
        .map((e) => e.path);
    },

    async create(path) {
      // imapflow returns undefined (instead of throwing) when the connection isn't usable.
      const result = (await client.mailboxCreate(path)) as { created?: boolean } | undefined;
      if (!result) fail('create folder');
      return result.created === true;
    },

    async unsubscribe(path) {
      return (await client.mailboxUnsubscribe(path)) === true;
    },

    async delete(path) {
      const result = (await client.mailboxDelete(path)) as unknown;
      if (!result) fail('delete folder');
    },

    async messageCount(path) {
      const status = (await client.status(path, { messages: true })) as
        { messages?: number } | false | undefined;
      if (!status || typeof status.messages !== 'number') fail('read folder status');
      return status.messages;
    },

    select: (path) => client.getMailboxLock(path),

    async fetchMessages() {
      if (!client.mailbox) return [];
      // The cached count only moves on EXISTS responses; NOOP collects any pending ones first
      // (right after APPENDs, a stale 0 would make verify see an empty folder).
      if (client.mailbox.exists === 0) await client.noop();
      if (!client.mailbox || client.mailbox.exists === 0) return [];
      const messages = await client.fetchAll('1:*', {
        uid: true,
        size: true,
        flags: true,
        internalDate: true,
        envelope: true,
        headers: ['x-mm-test-seed'],
      });
      return messages.map((m): ServerMessage => {
        const date = m.internalDate;
        return {
          uid: m.uid,
          seedId: parseSeedId(m.headers),
          messageId: m.envelope?.messageId ?? null,
          size: m.size ?? -1,
          internalDate:
            date instanceof Date ? date : new Date(typeof date === 'string' ? date : NaN),
          ...normalizeFlags(m.flags ?? []),
        };
      });
    },

    async append(path, raw, flags, internalDate) {
      if (!(await client.append(path, raw, flags, internalDate))) fail('upload a test message');
    },

    async setFlags(uid, flags) {
      if (!(await client.messageFlagsSet(String(uid), flags, { uid: true }))) fail('set flags');
    },
  };
}

export class TestFolder {
  readonly path: string;
  readonly #client: FolderClient;
  #openHandle: { released: boolean } | null = null;

  private constructor(client: FolderClient) {
    this.#client = client;
    this.path = testFolderPath(client.namespacePrefix());
  }

  static fromSession(session: ImapSession): TestFolder {
    const client: unknown = session.client;
    if (!(client instanceof ImapFlow)) {
      throw new TestGroundError('The test ground needs a real IMAP session.');
    }
    // On Gmail a folder is a label: unseed would leave the mail in All Mail (Gmail comes in M3).
    if (session.capabilities['X-GM-EXT-1'] !== undefined) {
      throw new TestGroundError(
        'The test ground supports the Websupport test mailbox only, not Gmail (see docs/TESTING.md).',
      );
    }
    return new TestFolder(imapFolderClient(client));
  }

  static fromClient(client: FolderClient): TestFolder {
    return new TestFolder(client);
  }

  /** The first statement of every operation: nothing reaches the client for another path. */
  #guard(path: string): void {
    if (path !== this.path) throw new FolderGuardError();
  }

  selectedPath(): string | null {
    return this.#client.selectedPath();
  }

  async exists(path: string = this.path): Promise<boolean> {
    this.#guard(path);
    return (await this.#client.listPaths()).includes(path);
  }

  async create(path: string = this.path): Promise<boolean> {
    this.#guard(path);
    return this.#client.create(path);
  }

  async remove(path: string = this.path): Promise<void> {
    this.#guard(path);
    // imapflow would send CLOSE first, which expunges \Deleted messages.
    if (this.#client.selectedPath() === path) {
      throw new TestGroundError('mm-test is open; unseed needs a fresh session.');
    }
    await this.#client.delete(path);
    // Best effort (CREATE auto-subscribed it): a server may decline for an unsubscribed folder,
    // which must not block unseed. The caller re-checks that the folder is gone.
    await this.#client.unsubscribe(path);
  }

  async messageCount(path: string = this.path): Promise<number> {
    this.#guard(path);
    return this.#client.messageCount(path);
  }

  async open(path: string = this.path): Promise<OpenTestFolder> {
    this.#guard(path);
    // A second mailbox lock while the first is held would wait forever.
    if (this.#openHandle !== null && !this.#openHandle.released) {
      throw new TestGroundError('mm-test is already open.');
    }
    // Reserved before the await, so two overlapping open() calls can't both pass the check.
    const handle = { released: false };
    this.#openHandle = handle;
    let lock: { release(): void };
    try {
      lock = await this.#client.select(path);
    } catch (err) {
      handle.released = true;
      throw err;
    }
    const client = this.#client;
    const check = (): void => {
      if (handle.released) throw new TestGroundError('This mm-test handle was already released.');
      if (client.selectedPath() !== path) throw new FolderGuardError();
    };
    return {
      fetchMessages: async () => {
        check();
        return client.fetchMessages();
      },
      append: async (raw, flags, internalDate) => {
        check();
        return client.append(path, raw, flags, internalDate);
      },
      setFlags: async (uid, flags) => {
        check();
        return client.setFlags(uid, flags);
      },
      release: () => {
        if (handle.released) return;
        handle.released = true;
        lock.release();
      },
    };
  }
}
