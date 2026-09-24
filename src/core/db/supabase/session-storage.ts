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
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EnvSource } from '../../config.js';

/** Matches supabase-js's `auth.storage` contract (string values). */
export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Deletes all stored session data. */
  clear(): void;
  /** true when no session data is stored (a missing or corrupt file counts as empty). */
  isEmpty(): boolean;
}

/** Config dir: MM_CONFIG_DIR → $XDG_CONFIG_HOME/mail-manager → ~/.config/mail-manager. */
export function sessionDir(env: EnvSource = process.env): string {
  const explicit = env['MM_CONFIG_DIR']?.trim();
  if (explicit) return explicit;
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  return join(xdg || join(homedir(), '.config'), 'mail-manager');
}

/**
 * Session tokens in <dir>/session.json: dir 700, file 600, atomic writes.
 * The file holds a refresh token, so it must never be readable by other users.
 */
export class FileSessionStorage implements SessionStorage {
  readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'session.json');
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) if (typeof v === 'string') out[k] = v;
      return out;
    } catch {
      // Corrupt file = logged out. Never echo its contents.
      return {};
    }
  }

  private write(data: Record<string, string>): void {
    if (Object.keys(data).length === 0) {
      this.clear();
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    // Unique tmp name: concurrent mm processes never share (or clobber) a tmp file.
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600); // umask can't widen it, but be explicit
      renameSync(tmp, this.file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  getItem(key: string): string | null {
    return this.read()[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.write({ ...this.read(), [key]: value });
  }

  removeItem(key: string): void {
    const data = this.read();
    delete data[key];
    this.write(data);
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }

  isEmpty(): boolean {
    return Object.keys(this.read()).length === 0;
  }
}

export class MemorySessionStorage implements SessionStorage {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }

  isEmpty(): boolean {
    return this.data.size === 0;
  }
}
