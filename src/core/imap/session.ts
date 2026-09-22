import { Resolver } from 'node:dns/promises';
import { inspect } from 'node:util';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { hostFromUserInput } from '../providers/email.js';
import type { ImapSettings } from '../providers/settings.js';
import {
  ImapSessionError,
  isNetworkDownCandidate,
  mapImapError,
  validateCredentialsInput,
  type ImapFailureReason,
} from './errors.js';
import {
  buildServerFeatures,
  sanitizeCapabilities,
  sanitizeServerName,
  type CapabilityRecord,
  type ServerFeatures,
} from './features.js';

// One IMAP login, done safely:
// - implicit TLS on 993 with certificate verification, TLS 1.2+; no STARTTLS, no plaintext;
// - logging off (imapflow's logger would see server text);
// - NO RETRY on failure, by design: repeated wrong passwords get IPs banned by providers
//   (fail2ban-style) and would make this a brute-force tool. The attempt policy is the
//   login guard (M1b-2b), not this module;
// - the password is removed from the client options as soon as connect() settles;
// - every failure becomes an ImapSessionError (reason + safe code, never server text).

/** The part of ImapFlow this module uses (a fake implements it in tests). */
export interface ImapClientLike {
  options: ImapFlowOptions;
  capabilities: Map<string, boolean | number>;
  enabled: Set<string>;
  serverInfo: unknown;
  usable: boolean;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  on(event: 'error' | 'close', listener: (arg?: unknown) => void): unknown;
}

export interface OpenSessionOptions {
  settings: ImapSettings;
  password: string;
  /** Sent in the IMAP ID command with name 'mail-manager'. */
  clientVersion: string;
  timeouts?: { connectMs?: number; greetingMs?: number; socketMs?: number };
  createClient?: (options: ImapFlowOptions) => ImapClientLike;
  /** Resolves true when the internet is reachable; only asked after a network-down error. */
  checkConnectivity?: () => Promise<boolean>;
}

export const LOGOUT_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 10_000;
// imapflow's default. With auto-IDLE off an idle session is closed after this; callers
// check `closed` and open a new session instead of reusing a dead one.
const SOCKET_TIMEOUT_MS = 5 * 60_000;
const CONNECTIVITY_HOST = 'one.one.one.one';

async function defaultCheckConnectivity(): Promise<boolean> {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  try {
    await resolver.resolve4(CONNECTIVITY_HOST);
    return true;
  } catch {
    return false;
  }
}

function dropPassword(client: ImapClientLike): void {
  delete client.options.auth;
}

export class ImapSession {
  readonly host: string;
  readonly username: string;
  readonly serverName: string | undefined;
  readonly features: ServerFeatures;
  readonly capabilities: CapabilityRecord;
  // Private fields: never shown by util.inspect or JSON.stringify.
  readonly #client: ImapClientLike;
  #closed = false;
  #lastErrorReason: ImapFailureReason | undefined;

  constructor(client: ImapClientLike, host: string, username: string) {
    this.#client = client;
    this.host = host;
    this.username = username;
    this.capabilities = sanitizeCapabilities(client.capabilities);
    this.features = buildServerFeatures(this.capabilities, client.enabled);
    this.serverName = sanitizeServerName(client.serverInfo);
  }

  /** The connection closed (logout, idle timeout, server drop, error). Open a new session. */
  get closed(): boolean {
    return this.#closed;
  }

  get lastErrorReason(): ImapFailureReason | undefined {
    return this.#lastErrorReason;
  }

  /** The underlying client, for mailbox operations (M2+). */
  get client(): ImapClientLike {
    return this.#client;
  }

  /** @internal Called by the client's event listeners. */
  markClosed(reason?: ImapFailureReason): void {
    this.#closed = true;
    if (reason !== undefined) this.#lastErrorReason = reason;
  }

  /** Best-effort LOGOUT, capped at LOGOUT_TIMEOUT_MS, then close. Never throws. */
  async logout(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#client.logout(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, LOGOUT_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // Logging out of a dead connection is fine.
    } finally {
      clearTimeout(timer);
      try {
        this.#client.close();
      } catch {
        // Already closed.
      }
      this.#closed = true;
    }
  }

  toJSON(): {
    host: string;
    username: string;
    serverName: string | undefined;
    features: ServerFeatures;
  } {
    return {
      host: this.host,
      username: this.username,
      serverName: this.serverName,
      features: this.features,
    };
  }

  [inspect.custom](): string {
    return `ImapSession ${inspect(this.toJSON())}`;
  }
}

/** Connects and logs in once. Rejects only with ImapSessionError. */
export async function openSession(opts: OpenSessionOptions): Promise<ImapSession> {
  const { settings, password } = opts;
  const inputError = validateCredentialsInput(settings.username, password);
  if (inputError !== null) throw inputError;

  // Defence in depth: discovery/manual entry already validated the host.
  const host = hostFromUserInput(settings.host);
  if (host === null || settings.port !== 993) throw new ImapSessionError('unexpected');

  const createClient =
    opts.createClient ?? ((options: ImapFlowOptions): ImapClientLike => new ImapFlow(options));
  let client: ImapClientLike;
  try {
    client = createClient({
      host,
      port: 993,
      secure: true,
      servername: host,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: { user: settings.username, pass: password },
      logger: false,
      logRaw: false,
      emitLogs: false,
      disableAutoIdle: true,
      // Not needed before M5 backups; also skips recently changed imapflow code paths.
      disableCompression: true,
      clientInfo: {
        name: 'mail-manager',
        version: opts.clientVersion,
        vendor: false,
        'support-url': false,
      },
      connectionTimeout: opts.timeouts?.connectMs ?? CONNECT_TIMEOUT_MS,
      greetingTimeout: opts.timeouts?.greetingMs ?? GREETING_TIMEOUT_MS,
      socketTimeout: opts.timeouts?.socketMs ?? SOCKET_TIMEOUT_MS,
    });
  } catch (err) {
    // Constructor failures (bad options) must not escape as raw library errors.
    throw mapImapError(err);
  }

  // Attached before connect(): an unhandled 'error' event would crash the process.
  // Events before the session exists are reported through connect()'s rejection instead.
  const opened: { session?: ImapSession } = {};
  client.on('error', (err) => opened.session?.markClosed(mapImapError(err).reason));
  client.on('close', () => opened.session?.markClosed());

  try {
    await client.connect();
  } catch (err) {
    const preAuthCaps = new Set(client.capabilities.keys());
    dropPassword(client);
    const internetReachable = isNetworkDownCandidate(err)
      ? await (opts.checkConnectivity ?? defaultCheckConnectivity)().catch(() => true)
      : undefined;
    try {
      client.close();
    } catch {
      // Already closed.
    }
    throw mapImapError(
      err,
      internetReachable === undefined ? { preAuthCaps } : { preAuthCaps, internetReachable },
    );
  }

  dropPassword(client);
  opened.session = new ImapSession(client, host, settings.username);
  return opened.session;
}
