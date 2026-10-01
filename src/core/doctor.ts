import { AuthError } from './auth.js';
import { validateMasterKeyEnv, validateSupabaseEnv, type EnvSource } from './config.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorDeps {
  env: EnvSource;
  fetch: typeof globalThis.fetch;
  nodeVersion: string;
  timeoutMs: number;
  /** Current login, if any. May refresh and rewrite the stored session as a side effect. */
  session?: () => Promise<{ email: string } | null>;
  /** Local log folder check (src/core/log/health.ts); omitted → no `logs` result. */
  logs?: () => CheckResult;
}

const MIN_NODE: readonly [number, number, number] = [22, 13, 0];

function checkNode(version: string): CheckResult {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  let ok = true;
  for (let i = 0; i < MIN_NODE.length; i++) {
    const have = parts[i] ?? 0;
    const need = MIN_NODE[i] ?? 0;
    if (have !== need) {
      ok = have > need;
      break;
    }
  }
  return {
    name: 'node',
    status: ok ? 'ok' : 'fail',
    detail: ok ? `v${version}` : `v${version} is too old, need >= ${MIN_NODE.join('.')}`,
  };
}

function formatIssues(issues: { variable: string; problem: string }[]): string {
  return issues.map((i) => `${i.variable} ${i.problem}`).join('; ');
}

/** GET with the publishable key. Redirects are never followed (fetch would forward `apikey`). */
function supabaseGet(endpoint: URL, key: string, deps: DoctorDeps): Promise<Response> {
  // The publishable key is not a JWT: send it only as `apikey`, never as Bearer.
  return deps.fetch(endpoint, {
    headers: { apikey: key },
    redirect: 'manual',
    signal: AbortSignal.timeout(deps.timeoutMs),
  });
}

function isRedirect(res: Response): boolean {
  return res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
}

/** Maps a thrown fetch error. Never includes err.message or cause details: they can carry request data. */
function networkFailure(name: string, where: string, err: unknown, deps: DoctorDeps): CheckResult {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return {
      name,
      status: 'fail',
      detail: `${where}: timeout after ${deps.timeoutMs} ms — is the project paused? Resume it in the Supabase dashboard`,
    };
  }
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
  return { name, status: 'fail', detail: `${where}: unreachable${code}` };
}

async function checkSupabaseApi(url: string, key: string, deps: DoctorDeps): Promise<CheckResult> {
  const name = 'supabase-api';
  // new URL() with an absolute path handles a trailing slash on the base.
  const endpoint = new URL('/auth/v1/health', url);
  const where = endpoint.host;
  try {
    const res = await supabaseGet(endpoint, key, deps);
    if (res.ok) {
      let version = '';
      try {
        const body = (await res.json()) as { version?: unknown };
        if (typeof body.version === 'string') version = ` (auth ${body.version})`;
      } catch {
        // Body is informational only.
      }
      return { name, status: 'ok', detail: `${where} reachable, key accepted${version}` };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        name,
        status: 'fail',
        detail: `${where}: key rejected (HTTP ${res.status}) — check SUPABASE_PUBLISHABLE_KEY`,
      };
    }
    if (isRedirect(res)) {
      return { name, status: 'fail', detail: `${where}: unexpected redirect — check SUPABASE_URL` };
    }
    return { name, status: 'fail', detail: `${where}: unexpected HTTP ${res.status}` };
  } catch (err) {
    return networkFailure(name, where, err, deps);
  }
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/** Tables the app needs; each must exist and be closed to anon (RLS + grants). */
const TABLES = ['mail_accounts', 'audit_log'] as const;

/** One table: null when present and anon is blocked, else the failing check result. */
async function probeTable(
  name: string,
  table: string,
  url: string,
  key: string,
  deps: DoctorDeps,
): Promise<CheckResult | null> {
  const endpoint = new URL(`/rest/v1/${table}`, url);
  endpoint.searchParams.set('select', 'id');
  endpoint.searchParams.set('limit', '1');
  const where = endpoint.host;
  try {
    const res = await supabaseGet(endpoint, key, deps);
    if (res.ok) {
      return {
        name,
        status: 'fail',
        detail: `anon can read ${table} — check the table grants (security problem)`,
      };
    }
    const code = await readErrorCode(res);
    if ((res.status === 401 || res.status === 403) && code === '42501') return null;
    if (res.status === 404 || code === 'PGRST205') {
      return { name, status: 'fail', detail: `${table} missing — run \`npm run db:push\`` };
    }
    if (isRedirect(res)) {
      return { name, status: 'fail', detail: `${where}: unexpected redirect — check SUPABASE_URL` };
    }
    return {
      name,
      status: 'fail',
      detail: `${where}: unexpected HTTP ${res.status}${code ? ` (${code})` : ''} on ${table}`,
    };
  } catch (err) {
    return networkFailure(name, where, err, deps);
  }
}

/**
 * The anon role must be denied on every app table (42501). A missing table means a migration
 * wasn't applied; a successful read means the grants are wrong.
 */
async function checkDatabase(url: string, key: string, deps: DoctorDeps): Promise<CheckResult> {
  const name = 'database';
  // One after the other; the first failure (incl. a network one) ends the check, so a paused
  // project doesn't wait for the timeout once per table.
  for (const table of TABLES) {
    const failed = await probeTable(name, table, url, key, deps);
    if (failed !== null) return failed;
  }
  return { name, status: 'ok', detail: 'mail_accounts and audit_log present, anon blocked' };
}

/** The app is invite-only: public signups on the project are a configuration error. */
async function checkSignup(url: string, key: string, deps: DoctorDeps): Promise<CheckResult> {
  const name = 'signup';
  const endpoint = new URL('/auth/v1/settings', url);
  const where = endpoint.host;
  try {
    const res = await supabaseGet(endpoint, key, deps);
    if (isRedirect(res)) {
      return { name, status: 'fail', detail: `${where}: unexpected redirect — check SUPABASE_URL` };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        name,
        status: 'fail',
        detail: `${where}: key rejected (HTTP ${res.status}) — check SUPABASE_PUBLISHABLE_KEY`,
      };
    }
    if (!res.ok) return { name, status: 'fail', detail: `${where}: unexpected HTTP ${res.status}` };
    let disabled: unknown;
    try {
      disabled = ((await res.json()) as { disable_signup?: unknown }).disable_signup;
    } catch {
      disabled = undefined;
    }
    if (disabled === true) return { name, status: 'ok', detail: 'invite-only (signups disabled)' };
    if (disabled === false) {
      return {
        name,
        status: 'fail',
        detail:
          'public signups enabled — disable them in the Supabase dashboard (Authentication → Sign In / Providers)',
      };
    }
    return { name, status: 'fail', detail: `${where}: unexpected auth settings response` };
  } catch (err) {
    return networkFailure(name, where, err, deps);
  }
}

async function checkSession(deps: DoctorDeps): Promise<CheckResult> {
  const name = 'session';
  if (!deps.session) return { name, status: 'warn', detail: 'not checked' };
  try {
    const user = await deps.session();
    return user
      ? { name, status: 'ok', detail: `logged in as ${user.email}` }
      : { name, status: 'warn', detail: 'not logged in — run `mm login`' };
  } catch (err) {
    const unreachable = err instanceof AuthError && err.code === 'unreachable';
    return {
      name,
      status: 'warn',
      detail: unreachable ? 'could not check: Supabase unreachable' : 'could not check the session',
    };
  }
}

/** Runs all environment checks. Details never contain secret values. */
export async function runDoctor(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [checkNode(deps.nodeVersion)];

  const supabase = validateSupabaseEnv(deps.env);
  results.push(
    supabase.ok
      ? {
          name: 'supabase-env',
          status: 'ok',
          detail: 'SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY set',
        }
      : { name: 'supabase-env', status: 'fail', detail: formatIssues(supabase.issues) },
  );

  const masterKey = validateMasterKeyEnv(deps.env);
  if (!masterKey.ok) {
    results.push({ name: 'master-key', status: 'fail', detail: formatIssues(masterKey.issues) });
  } else if (masterKey.value.masterKey === undefined) {
    results.push({
      name: 'master-key',
      status: 'warn',
      detail: 'MM_MASTER_KEY not set (needed from M1) — run `mm keygen` and add it to .env.local',
    });
  } else {
    results.push({
      name: 'master-key',
      status: 'ok',
      detail: `valid (version ${masterKey.value.masterKeyVersion})`,
    });
  }

  results.push(
    supabase.ok
      ? await checkSupabaseApi(supabase.value.url, supabase.value.publishableKey, deps)
      : { name: 'supabase-api', status: 'fail', detail: 'skipped: Supabase config invalid' },
  );
  results.push(
    supabase.ok
      ? await checkDatabase(supabase.value.url, supabase.value.publishableKey, deps)
      : { name: 'database', status: 'fail', detail: 'skipped: Supabase config invalid' },
  );
  results.push(
    supabase.ok
      ? await checkSignup(supabase.value.url, supabase.value.publishableKey, deps)
      : { name: 'signup', status: 'fail', detail: 'skipped: Supabase config invalid' },
  );
  results.push(
    supabase.ok
      ? await checkSession(deps)
      : { name: 'session', status: 'warn', detail: 'skipped: Supabase config invalid' },
  );

  if (deps.logs) results.push(deps.logs());
  return results;
}

export function hasFailures(results: CheckResult[]): boolean {
  return results.some((r) => r.status === 'fail');
}
