import { validateMasterKeyEnv, type EnvSource } from './config.js';
import { accountAad, decryptSecret, encryptSecret, type EncryptedSecret } from './crypto.js';
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
  encryptPassword(ref: { userId: string; accountId: string }, password: string): EncryptedSecret;
  decryptPassword(account: Pick<MailAccount, 'id' | 'userId' | 'secret'>): string;
}

export class LocalCredentialProvider implements CredentialProvider {
  constructor(private readonly opts: { masterKey: Buffer; masterKeyVersion: number }) {}

  encryptPassword(ref: { userId: string; accountId: string }, password: string): EncryptedSecret {
    return encryptSecret(
      password,
      this.opts.masterKey,
      this.opts.masterKeyVersion,
      accountAad(ref.userId, ref.accountId),
    );
  }

  decryptPassword(account: Pick<MailAccount, 'id' | 'userId' | 'secret'>): string {
    if (account.secret.keyVersion !== this.opts.masterKeyVersion) {
      throw new CredentialError(
        `Secret was encrypted with key version ${account.secret.keyVersion}, current is ${this.opts.masterKeyVersion}`,
      );
    }
    return decryptSecret(
      account.secret,
      this.opts.masterKey,
      accountAad(account.userId, account.id),
    );
  }
}

export function createLocalCredentialProvider(env: EnvSource = process.env): CredentialProvider {
  const result = validateMasterKeyEnv(env);
  if (!result.ok) {
    throw new CredentialError(result.issues.map((i) => `${i.variable} ${i.problem}`).join('; '));
  }
  const { masterKey, masterKeyVersion } = result.value;
  if (!masterKey) throw new CredentialError('MM_MASTER_KEY is not set — run `mm keygen`');
  return new LocalCredentialProvider({ masterKey, masterKeyVersion });
}
