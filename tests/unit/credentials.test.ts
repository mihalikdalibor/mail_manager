import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  CredentialError,
  createLocalCredentialProvider,
  LocalCredentialProvider,
} from '../../src/core/credentials.js';
import { CryptoError, type EncryptedSecret } from '../../src/core/crypto.js';
import { generateMasterKey } from '../../src/core/master-key.js';

const PASSWORD = 'hunter2-ÄŠť';
const REF = {
  userId: 'user-1',
  accountId: 'acct-1',
  host: 'imap.example-test-domain.eu',
  port: 993,
  username: 'someone@example-test-domain.eu',
};

/** The stored row for REF, with optional changes (as if edited in the database). */
function row(
  secret: EncryptedSecret,
  changes: Partial<{
    id: string;
    userId: string;
    host: string;
    port: number;
    username: string;
  }> = {},
) {
  return {
    id: REF.accountId,
    userId: REF.userId,
    host: REF.host,
    port: REF.port,
    username: REF.username,
    secret,
    ...changes,
  };
}

function provider(masterKey = randomBytes(32), masterKeyVersion = 1): LocalCredentialProvider {
  return new LocalCredentialProvider({ masterKey, masterKeyVersion });
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected function to throw');
}

describe('LocalCredentialProvider', () => {
  it('round-trips a password', () => {
    const p = provider();
    const secret = p.encryptPassword(REF, PASSWORD);
    expect(secret.keyVersion).toBe(1);
    expect(JSON.stringify(secret)).not.toContain(PASSWORD);
    expect(p.decryptPassword(row(secret))).toBe(PASSWORD);
  });

  it('echoes the configured key version', () => {
    const p = provider(randomBytes(32), 3);
    expect(p.encryptPassword(REF, PASSWORD).keyVersion).toBe(3);
  });

  it('fails when the accountId differs on decrypt (AAD binding)', () => {
    const p = provider();
    const secret = p.encryptPassword(REF, PASSWORD);
    const err = thrown(() => p.decryptPassword(row(secret, { id: 'acct-2' })));
    expect(err).toBeInstanceOf(CryptoError);
    expect((err as Error).message).not.toContain(PASSWORD);
  });

  it('fails when the userId differs on decrypt (AAD binding)', () => {
    const p = provider();
    const secret = p.encryptPassword(REF, PASSWORD);
    const err = thrown(() => p.decryptPassword(row(secret, { userId: 'user-2' })));
    expect(err).toBeInstanceOf(CryptoError);
  });

  it.each([
    ['host', { host: 'imap.attacker.example' }],
    ['port', { port: 994 }],
    ['username', { username: 'other@example-test-domain.eu' }],
  ] as const)('fails when the %s was changed in the database (AAD v2)', (_field, changes) => {
    const p = provider();
    const secret = p.encryptPassword(REF, PASSWORD);
    const err = thrown(() => p.decryptPassword(row(secret, changes)));
    expect(err).toBeInstanceOf(CryptoError);
    expect((err as Error).message).not.toContain(PASSWORD);
  });

  it('a host that differs only in case still decrypts (hosts are case-insensitive)', () => {
    const p = provider();
    const secret = p.encryptPassword(REF, PASSWORD);
    expect(p.decryptPassword(row(secret, { host: REF.host.toUpperCase() }))).toBe(PASSWORD);
  });

  it('fails with a different master key', () => {
    const secret = provider().encryptPassword(REF, PASSWORD);
    const err = thrown(() => provider().decryptPassword(row(secret)));
    expect(err).toBeInstanceOf(CryptoError);
  });

  it('rejects a secret with a different key version, naming both versions', () => {
    const masterKey = randomBytes(32);
    const secret = provider(masterKey, 1).encryptPassword(REF, PASSWORD);
    const err = thrown(() => provider(masterKey, 2).decryptPassword(row(secret)));
    expect(err).toBeInstanceOf(CredentialError);
    const message = (err as Error).message;
    expect(message).toContain('1');
    expect(message).toContain('2');
    expect(message).not.toContain(PASSWORD);
  });
});

describe('createLocalCredentialProvider', () => {
  it('builds a working provider from env with default version 1', () => {
    const p = createLocalCredentialProvider({ MM_MASTER_KEY: generateMasterKey() });
    const secret = p.encryptPassword(REF, PASSWORD);
    expect(secret.keyVersion).toBe(1);
    expect(p.decryptPassword(row(secret))).toBe(PASSWORD);
  });

  it('honours MM_MASTER_KEY_VERSION', () => {
    const p = createLocalCredentialProvider({
      MM_MASTER_KEY: generateMasterKey(),
      MM_MASTER_KEY_VERSION: '4',
    });
    expect(p.encryptPassword(REF, PASSWORD).keyVersion).toBe(4);
  });

  it('decrypts what another provider with the same env key encrypted', () => {
    const env = { MM_MASTER_KEY: generateMasterKey() };
    const secret = createLocalCredentialProvider(env).encryptPassword(REF, PASSWORD);
    const again = createLocalCredentialProvider({ ...env });
    expect(again.decryptPassword(row(secret))).toBe(PASSWORD);
  });

  it.each([
    ['missing', {}],
    ['undefined', { MM_MASTER_KEY: undefined }],
    ['empty', { MM_MASTER_KEY: '' }],
  ])('throws CredentialError mentioning mm keygen when the key is %s', (_label, env) => {
    const err = thrown(() => createLocalCredentialProvider(env));
    expect(err).toBeInstanceOf(CredentialError);
    expect((err as Error).message).toContain('mm keygen');
  });

  it.each([
    ['non-base64', 'LEAKCANARY not base64!!'],
    ['16-byte key', randomBytes(16).toString('base64')],
    ['33-byte key', randomBytes(33).toString('base64')],
  ])('throws CredentialError naming MM_MASTER_KEY (not its value) for a %s', (_label, value) => {
    const err = thrown(() => createLocalCredentialProvider({ MM_MASTER_KEY: value }));
    expect(err).toBeInstanceOf(CredentialError);
    const message = (err as Error).message;
    expect(message).toContain('MM_MASTER_KEY');
    expect(message).not.toContain(value);
    expect(message).not.toContain('LEAKCANARY');
  });
});
