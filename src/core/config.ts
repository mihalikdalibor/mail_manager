import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { validateMasterKey } from './master-key.js';

export type EnvSource = Record<string, string | undefined>;

export interface EnvIssue {
  variable: string;
  problem: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; issues: EnvIssue[] };

export interface SupabaseEnv {
  url: string;
  publishableKey: string;
}

export interface MasterKeyEnv {
  masterKey: Buffer | undefined;
  masterKeyVersion: number;
}

export interface AppConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  masterKey: Buffer | undefined;
  masterKeyVersion: number;
}

/** Thrown by getConfig. Message and issues contain variable names only, never values. */
export class ConfigError extends Error {
  readonly issues: EnvIssue[];

  constructor(issues: EnvIssue[]) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  - ${i.variable} ${i.problem}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Repo root: two levels up from src/core (tsx) or dist/core (built). */
export function projectRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Loads <root>/.env.local, then <root>/.env into `target`.
 * Keys already present in `target` are never overwritten, so real env > .env.local > .env.
 */
export function loadEnvFiles(root: string = projectRoot(), target: EnvSource = process.env): void {
  // One call per file: with a path array dotenv reports only the last file's error.
  for (const name of ['.env.local', '.env']) {
    const result = loadDotenv({ path: join(root, name), processEnv: target, quiet: true });
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    // A missing file is normal (.env usually doesn't exist); anything else is surfaced by code only.
    if (result.error && code !== 'ENOENT') {
      throw new ConfigError([
        { variable: name, problem: `cannot be read in ${root} (${code ?? 'unknown error'})` },
      ]);
    }
  }
}

/** Empty or whitespace-only values count as unset. */
function read(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === '' ? undefined : value;
}

function missing(env: EnvSource, name: string, legacyName?: string): EnvIssue {
  let hint = '';
  if (legacyName && read(env, legacyName) !== undefined) {
    hint = ` (found ${legacyName} — rename it)`;
  } else if (env[name] !== undefined) {
    // An exported-but-empty shell variable blocks the value from the env files.
    hint = ' (set but empty — check your shell environment)';
  }
  return { variable: name, problem: `is missing${hint}` };
}

const httpsUrl = z.url({ protocol: /^https$/ });

export function validateSupabaseEnv(env: EnvSource): Validation<SupabaseEnv> {
  const issues: EnvIssue[] = [];
  const url = read(env, 'SUPABASE_URL');
  const publishableKey = read(env, 'SUPABASE_PUBLISHABLE_KEY');

  if (url === undefined) issues.push(missing(env, 'SUPABASE_URL', 'VITE_SUPABASE_URL'));
  else if (!httpsUrl.safeParse(url).success) {
    issues.push({ variable: 'SUPABASE_URL', problem: 'must be a valid https:// URL' });
  } else {
    const parsed = new URL(url);
    if (parsed.username !== '' || parsed.password !== '') {
      issues.push({ variable: 'SUPABASE_URL', problem: 'must not contain credentials' });
    }
  }
  if (publishableKey === undefined) {
    issues.push(missing(env, 'SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_ANON_KEY'));
  }

  if (issues.length > 0 || url === undefined || publishableKey === undefined) {
    return { ok: false, issues };
  }
  return { ok: true, value: { url, publishableKey } };
}

// Plain decimal only: z.coerce.number() would also accept '0x10' or '1e2'.
const keyVersion = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number);

export function validateMasterKeyEnv(env: EnvSource): Validation<MasterKeyEnv> {
  const issues: EnvIssue[] = [];
  const rawKey = read(env, 'MM_MASTER_KEY');
  const rawVersion = read(env, 'MM_MASTER_KEY_VERSION');

  let masterKey: Buffer | undefined;
  if (rawKey !== undefined) {
    const result = validateMasterKey(rawKey);
    if (result.ok) masterKey = result.key;
    else issues.push({ variable: 'MM_MASTER_KEY', problem: result.reason });
  }

  let masterKeyVersion = 1;
  if (rawVersion !== undefined) {
    const parsed = keyVersion.safeParse(rawVersion);
    if (parsed.success) masterKeyVersion = parsed.data;
    else issues.push({ variable: 'MM_MASTER_KEY_VERSION', problem: 'must be a positive integer' });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { masterKey, masterKeyVersion } };
}

/** Full app config. Throws ConfigError listing every problem. */
export function getConfig(env: EnvSource = process.env): AppConfig {
  const supabase = validateSupabaseEnv(env);
  const masterKey = validateMasterKeyEnv(env);
  if (!supabase.ok || !masterKey.ok) {
    throw new ConfigError([
      ...(supabase.ok ? [] : supabase.issues),
      ...(masterKey.ok ? [] : masterKey.issues),
    ]);
  }
  return {
    supabaseUrl: supabase.value.url,
    supabasePublishableKey: supabase.value.publishableKey,
    masterKey: masterKey.value.masterKey,
    masterKeyVersion: masterKey.value.masterKeyVersion,
  };
}
