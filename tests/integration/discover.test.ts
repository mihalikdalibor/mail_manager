import { describe, expect, it } from 'vitest';
import { defaultDiscoveryDeps, discover } from '../../src/core/providers/discover.js';

// Real DNS only; HTTP is disabled so the real domain is never sent to ISPDB/autoconfig even if
// the MX lookup fails (offline, SERVFAIL) and discovery falls through. The address comes
// from env and is never written to a tracked file or printed: assertions compare single
// fields so a failure diff can't show the whole result.
const address = process.env.MM_TEST_IMAP_USER?.trim() ?? '';

describe.skipIf(address === '')('provider discovery (live DNS)', () => {
  it('finds the Websupport preset for the test mailbox via its MX records', async () => {
    const result = await discover(address, {
      ...defaultDiscoveryDeps(5000),
      fetch: () => Promise.reject(new Error('no HTTP in this test')),
    });
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.source).toBe('preset-mx');
    expect(result.provider?.id).toBe('websupport');
    expect(result.imap.host).toBe('imap.m1.websupport.sk');
    expect(result.imap.port).toBe(993);
    expect(result.imap.username.toLowerCase() === address.toLowerCase()).toBe(true);
  });
});
