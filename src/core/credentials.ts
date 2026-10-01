import { validateMasterKeyEnv, type EnvSource } from './config.js';
import {
  accountAad,
  decryptSecret,
  encryptSecret,
  type AccountBinding,
  type EncryptedSecret,
} from './crypto.js';
import type { MailAccount } from './db/repos.js';

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

/**
 * The only way to turn a stored secret back into a mailbox password. Local today; a hosted
 * implementation can later decrypt server-side without callers changing.
 */
export interface CredentialProvider {
  /** `ref` is the account the secret is bound to (user, id, host, port, username). */
  encryptPassword(ref: AccountBinding, password: string): EncryptedSecret;
  /** Fails (CryptoError) when the row's id, user, host, port or username differ from encryption. */
  decryptPassword(account: StoredAccountSecret): string;
}

export type StoredAccountSecret = Pick<
  MailAccount,
  'id' | 'userId' | 'host' | 'port' | 'username' | 'secret'
>;

export class LocalCredentialProvider implements CredentialProvider {
  constructor(private readonly opts: { masterKey: Buffer; masterKeyVersion: number }) {}

  encryptPassword(ref: AccountBinding, password: string): EncryptedSecret {
    return encryptSecret(
      password,
      this.opts.masterKey,
      this.opts.masterKeyVersion,
      accountAad(ref),
    );
  }

  decryptPassword(account: StoredAccountSecret): string {
    if (account.secret.keyVersion !== this.opts.masterKeyVersion) {
      throw new CredentialError(
        `Secret was encrypted with key version ${account.secret.keyVersion}, current is ${this.opts.masterKeyVersion}`,
      );
    }
    return decryptSecret(
      account.secret,
      this.opts.masterKey,
      accountAad({
        userId: account.userId,
        accountId: account.id,
        host: account.host,
        port: account.port,
        username: account.username,
      }),
    );
  }
}

export function createLocalCredentialProvider(env: EnvSource = process.env): CredentialProvider {
  const result = validateMasterKeyEnv(env);
  if (!result.ok) {
    const problems = result.issues.map((i) => `${i.variable} ${i.problem}`).join('; ');
    throw new CredentialError(
      `${problems} — fix it in .env.local, or create a new key with \`mm keygen\` (mailboxes saved with the old key then need \`mm account remove\` + \`mm account add\`)`,
    );
  }
  const { masterKey, masterKeyVersion } = result.value;
  if (!masterKey) throw new CredentialError('MM_MASTER_KEY is not set — run `mm keygen`');
  return new LocalCredentialProvider({ masterKey, masterKeyVersion });
}
