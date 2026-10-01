import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM output, all binary fields base64-encoded (stored as text in the DB). */
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

/** Deliberately generic: messages never include plaintext, key material or ciphertext. */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new CryptoError(`Key must be ${KEY_BYTES} bytes`);
}

/** What a stored mailbox secret is bound to (AAD v2). */
export interface AccountBinding {
  userId: string;
  accountId: string;
  host: string;
  port: number;
  username: string;
}

/**
 * Binds a ciphertext to one account of one user and to the server it logs in to: copied into
 * another row it won't decrypt, and neither will it after the row's host, port or username was
 * changed in the database — so the password can never be sent to a swapped server. JSON keeps
 * the fields unambiguous (a `:` in a username can't shift them).
 */
export function accountAad(b: AccountBinding): string {
  return `mail_accounts:v2:${JSON.stringify([b.userId, b.accountId, b.host.toLowerCase(), b.port, b.username])}`;
}

export function encryptSecret(
  plaintext: string,
  key: Buffer,
  keyVersion: number,
  aad: string,
): EncryptedSecret {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion,
  };
}

export function decryptSecret(secret: EncryptedSecret, key: Buffer, aad: string): string {
  assertKey(key);
  const iv = Buffer.from(secret.iv, 'base64');
  const tag = Buffer.from(secret.tag, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoError('Decryption failed');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Node's message ("Unsupported state or unable to authenticate data") adds nothing useful.
    throw new CryptoError('Decryption failed');
  }
}
