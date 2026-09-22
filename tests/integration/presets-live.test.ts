import { connect } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/core/providers/presets.js';

// Keeps the built-in presets honest: every IMAP host (and alternative host) must accept
// implicit TLS on 993 with a valid certificate and answer with an IMAP greeting.
// No login, no credentials — only the greeting is read. Needs internet access.

const GREETING_TIMEOUT_MS = 10_000;

function imapGreeting(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 993, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${host}: no greeting within ${GREETING_TIMEOUT_MS} ms`));
    }, GREETING_TIMEOUT_MS);
    socket.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      socket.end();
      resolve(chunk.toString('latin1').split('\r\n')[0] ?? '');
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`${host}: ${err.code ?? err.name}`));
    });
  });
}

const hosts = [
  ...new Set(PRESETS.flatMap((p) => [...(p.imap ? [p.imap.host] : []), ...p.altHosts])),
];

describe('built-in presets answer on 993 (live network, no login)', () => {
  it.each(hosts)('%s', async (host) => {
    const greeting = await imapGreeting(host);
    expect(greeting.startsWith('* OK') || greeting.startsWith('* PREAUTH')).toBe(true);
  });
});
