import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { imapErrorText } from '../../src/cli/imap-errors.js';
import { ImapSessionError } from '../../src/core/imap/errors.js';
import { openSession } from '../../src/core/imap/session.js';
import { defaultDiscoveryDeps, discover } from '../../src/core/providers/discover.js';
import type { ImapSettings } from '../../src/core/providers/settings.js';

// Real login to the dedicated test mailbox. The address, host and password come from env and
// are never printed: assertions compare single fields or booleans, so a failing diff can't
// show them. No folder is opened (the mm-test folder guard comes with the test ground).
//
// Exactly ONE wrong-password attempt per run — providers ban IPs after repeated failures
// (fail2ban-style). Never add more, and never enable vitest `retry` for this suite: a retry
// would repeat the wrong-password attempt.
const address = process.env.MM_TEST_IMAP_USER?.trim() ?? '';
const password = process.env.MM_TEST_IMAP_PASS ?? '';
const fallbackHost = process.env.MM_TEST_IMAP_HOST?.trim() ?? '';
const clientVersion = 'integration-test';

describe.skipIf(address === '' || password === '')('imap session (live)', () => {
  const captured: string[] = [];
  const inspected: string[] = [];
  let settings: ImapSettings;

  beforeAll(async () => {
    // Everything the code under test writes is captured (and swallowed) for the leak check.
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    }
    // vitest routes console.* in workers through its own channel, so capture those too.
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => inspect(arg, { depth: 10 })).join(' '));
      });
    }
    // Real DNS only; no HTTP, so the domain is never sent to ISPDB/autoconfig.
    const result = await discover(address, {
      ...defaultDiscoveryDeps(5000),
      fetch: () => Promise.reject(new Error('no HTTP in this test')),
    });
    if (result.status === 'found') {
      settings = result.imap;
    } else if (fallbackHost !== '') {
      settings = { host: fallbackHost, port: 993, username: address };
    } else {
      throw new Error('Discovery found no IMAP host; set MM_TEST_IMAP_HOST as a fallback');
    }
  });

  afterAll(() => {
    vi.restoreAllMocks();
    const everything = [...captured, ...inspected].join('\n');
    // Checked last so a leak anywhere in the run fails the suite.
    expect(everything.includes(password)).toBe(false);
  });

  it('logs in on the discovered host and reports the measured features', async () => {
    const session = await openSession({ settings, password, clientVersion });
    try {
      inspected.push(inspect(session, { depth: 10 }), JSON.stringify(session));
      expect(session.features.uidplus).toBe(true);
      expect(session.features.move).toBe(true);
      expect(session.features.quota).toBe(true);
      expect(Object.keys(session.capabilities).length).toBeGreaterThan(0);
      expect(session.capabilities.IMAP4REV1).toBe(true);
      expect(['string', 'undefined']).toContain(typeof session.serverName);
      expect(JSON.stringify(session).includes(password)).toBe(false);
      expect(session.client.options.auth).toBeUndefined();
    } finally {
      await session.logout();
    }
    expect(session.closed).toBe(true);
  });

  it('one wrong password → auth-failed with the generic message', async () => {
    const wrong = `mm-wrong-${randomUUID()}`;
    const caught = await openSession({ settings, password: wrong, clientVersion }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(caught).toBeInstanceOf(ImapSessionError);
    const err = caught as ImapSessionError;
    inspected.push(inspect(err, { depth: 10 }), JSON.stringify(err), String(err));
    expect(err.reason).toBe('auth-failed');
    expect(imapErrorText(err.reason, { kind: 'this-computer' })).toBe(
      imapErrorText('timeout', { kind: 'this-computer' }),
    );
    for (const text of inspected) expect(text.includes(wrong)).toBe(false);
  });
});
