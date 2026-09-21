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
}

const MIN_NODE: readonly [number, number, number] = [22, 12, 0];

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

async function checkSupabaseApi(url: string, key: string, deps: DoctorDeps): Promise<CheckResult> {
  const name = 'supabase-api';
  // new URL() with an absolute path handles a trailing slash on the base.
  const endpoint = new URL('/auth/v1/health', url);
  const where = endpoint.host;
  try {
    // The publishable key is not a JWT: send it only as `apikey`, never as Bearer.
    const res = await deps.fetch(endpoint, {
      headers: { apikey: key },
      // Don't follow redirects: fetch would forward the apikey header to another origin.
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
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
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      return { name, status: 'fail', detail: `${where}: unexpected redirect — check SUPABASE_URL` };
    }
    return { name, status: 'fail', detail: `${where}: unexpected HTTP ${res.status}` };
  } catch (err) {
    // Never include err.message or cause details: they can carry request data.
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

  return results;
}

export function hasFailures(results: CheckResult[]): boolean {
  return results.some((r) => r.status === 'fail');
}
