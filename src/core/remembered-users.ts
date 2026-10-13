import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { parseEmail } from './providers/email.js';

// The e-mail addresses of earlier Mail Manager sign-ins, kept so the app's sign-in page (M2d)
// can offer them again. Addresses only — never passwords or tokens. This is local config, not
// a log; the file is read back as untrusted input (it can be edited by hand).

export const MAX_REMEMBERED = 10;
export const REMEMBERED_FILE = 'users.json';

export interface RememberedUsers {
  /** Newest first. */
  list(): string[];
  /** Puts the address first. Text that isn't an address is ignored. */
  add(email: string): void;
  remove(email: string): void;
}

const fileSchema = z.strictObject({
  v: z.literal(1),
  emails: z.array(z.string().max(320)).max(100),
});

/**
 * The address as it is stored (the form `authEmailTarget` hashes): trimmed, the name lower-cased,
 * the domain lower-case ASCII. null when the text isn't an address.
 */
export function normalizeEmail(input: string): string | null {
  try {
    const parsed = parseEmail(input);
    return `${parsed.localPart.toLowerCase()}@${parsed.domain}`;
  } catch {
    return null;
  }
}

/** Valid addresses only, normalised, the first of each kept, at most MAX_REMEMBERED. */
function cleaned(emails: readonly string[]): string[] {
  const out: string[] = [];
  for (const email of emails) {
    const address = normalizeEmail(email);
    if (address !== null && !out.includes(address)) out.push(address);
  }
  return out.slice(0, MAX_REMEMBERED);
}

function withFirst(emails: readonly string[], address: string): string[] {
  return [address, ...emails.filter((e) => e !== address)].slice(0, MAX_REMEMBERED);
}

/**
 * The list in <dir>/users.json as `{"v":1,"emails":[...]}`: dir 700, file 600, atomic writes.
 * No method throws: a missing, unreadable or corrupt file is an empty list, and a write that
 * fails is dropped.
 */
export class FileRememberedUsers implements RememberedUsers {
  readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, REMEMBERED_FILE);
  }

  private read(): string[] {
    if (!existsSync(this.file)) return [];
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      const parsed = fileSchema.safeParse(data);
      return parsed.success ? cleaned(parsed.data.emails) : [];
    } catch {
      // Unreadable or corrupt file = nothing remembered. Never echo its contents.
      return [];
    }
  }

  private write(emails: readonly string[]): void {
    if (emails.length === 0) {
      rmSync(this.file, { force: true });
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    // Unique tmp name: concurrent mm processes never share (or clobber) a tmp file.
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ v: 1, emails }), { mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600); // umask can't widen it, but be explicit
      renameSync(tmp, this.file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  list(): string[] {
    return this.read();
  }

  add(email: string): void {
    try {
      const address = normalizeEmail(email);
      if (address === null) return;
      this.write(withFirst(this.read(), address));
    } catch {
      // Remembering is a convenience: it must never fail a sign-in.
    }
  }

  remove(email: string): void {
    try {
      const address = normalizeEmail(email);
      if (address === null) return;
      const emails = this.read();
      if (!emails.includes(address)) return;
      this.write(emails.filter((e) => e !== address));
    } catch {
      // As in add(): nothing the caller does may depend on this file.
    }
  }
}

/** The same list in memory (tests). */
export class MemoryRememberedUsers implements RememberedUsers {
  private emails: string[];

  constructor(initial: readonly string[] = []) {
    this.emails = cleaned(initial);
  }

  list(): string[] {
    return [...this.emails];
  }

  add(email: string): void {
    const address = normalizeEmail(email);
    if (address === null) return;
    this.emails = withFirst(this.emails, address);
  }

  remove(email: string): void {
    const address = normalizeEmail(email);
    if (address === null) return;
    this.emails = this.emails.filter((e) => e !== address);
  }
}
