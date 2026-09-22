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

/** Binds a ciphertext to one account of one user: copied into another row it won't decrypt. */
export function accountAad(userId: string, accountId: string): string {
  return `mail_accounts:${userId}:${accountId}`;
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
