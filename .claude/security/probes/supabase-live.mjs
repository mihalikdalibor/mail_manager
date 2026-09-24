// Live, READ-ONLY probe of the user's own Supabase project with only the publishable key
// (what anyone holding the CLI/web bundle has). No login, no writes that could succeed.
// Checks: public signups disabled, which tables/RPCs PostgREST exposes to anon, anon cannot
// read/insert/update/delete mail_accounts, GraphQL introspection, Storage buckets, and that
// the key in use is not a service-role/secret key. Deeper two-user RLS checks live in
// tests/integration/supabase-rls.test.ts (run: npm run test:integration).
// Needs SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY in .env.local; skips otherwise.
// Usage (repo root): node .claude/security/probes/supabase-live.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.MM_REPO ?? process.cwd();
const env = {};
for (const f of ['.env', '.env.local']) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const url = process.env.SUPABASE_URL ?? env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) {
  console.log('skip  SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not set');
  process.exit(0);
}

let findings = 0;
const find = (m) => {
  findings++;
  console.log(`FIND  ${m}`);
};
const ok = (m) => console.log(`ok    ${m}`);
// Never print url/key; responses are summarised, not dumped.
const call = async (path, init = {}) => {
  const res = await fetch(new URL(path, url), {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
    headers: { apikey: key, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
};

// 0. The key must be a publishable/anon key, never secret/service-role.
if (key.startsWith('sb_secret_')) find('SUPABASE_PUBLISHABLE_KEY holds a SECRET key');
else if (key.startsWith('eyJ')) {
  const role = JSON.parse(
    Buffer.from(key.split('.')[1] ?? '', 'base64url').toString() || '{}',
  ).role;
  role === 'anon' ? ok('legacy JWT key has role anon') : find(`legacy JWT key has role ${role}`);
} else ok('publishable key format');

// 1. Signups.
const settings = await call('/auth/v1/settings');
settings.json?.disable_signup === true
  ? ok('public signup disabled')
  : find(`public signup NOT disabled (status ${settings.status})`);
if (settings.json?.external) {
  const on = Object.entries(settings.json.external)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  console.log(`info  enabled auth providers: ${on.join(', ') || 'none'}`);
}
if (settings.json?.mailer_autoconfirm === true)
  console.log('info  mailer_autoconfirm is on (emails not verified)');

// 2. What PostgREST exposes to anon (OpenAPI root lists every table/view/RPC anon can see).
const openapi = await call('/rest/v1/', { headers: { accept: 'application/openapi+json' } });
if (openapi.status === 200 && openapi.json?.paths) {
  const paths = Object.keys(openapi.json.paths).filter((p) => p !== '/');
  const rpcs = paths.filter((p) => p.startsWith('/rpc/'));
  console.log(`info  anon OpenAPI lists ${paths.length} path(s): ${paths.join(', ') || 'none'}`);
  if (rpcs.length)
    find(`RPC functions callable by anon: ${rpcs.join(', ')} (check SECURITY DEFINER / grants)`);
} else ok(`anon OpenAPI schema not readable (status ${openapi.status})`);

// 3. mail_accounts as anon: every verb must fail or return nothing.
const sel = await call('/rest/v1/mail_accounts?select=id&limit=1');
Array.isArray(sel.json) && sel.json.length > 0
  ? find('anon can READ mail_accounts rows')
  : ok(`anon select -> ${sel.status} ${Array.isArray(sel.json) ? '[]' : (sel.json?.code ?? '')}`);
const ins = await call('/rest/v1/mail_accounts', {
  method: 'POST',
  headers: { prefer: 'return=minimal' },
  body: JSON.stringify({
    email: 'probe@example.invalid',
    host: 'imap.example.invalid',
    username: 'x',
    secret_ciphertext: 'x',
    secret_iv: 'x',
    secret_tag: 'x',
    key_version: 1,
    user_id: '00000000-0000-0000-0000-000000000000',
  }),
});
ins.status >= 200 && ins.status < 300
  ? find('anon INSERT into mail_accounts succeeded — delete the probe row!')
  : ok(`anon insert -> ${ins.status} ${ins.json?.code ?? ''}`);
// Filter matches nothing even if the verb were allowed: can't damage data.
const upd = await call('/rest/v1/mail_accounts?id=eq.00000000-0000-0000-0000-000000000000', {
  method: 'PATCH',
  body: JSON.stringify({ label: 'x' }),
});
upd.status === 204 || upd.status === 200
  ? console.log(
      `info  anon update of a non-existent row -> ${upd.status} (RLS hides rows; privilege check: ${upd.json?.code ?? 'none'})`,
    )
  : ok(`anon update -> ${upd.status} ${upd.json?.code ?? ''}`);
const del = await call('/rest/v1/mail_accounts?id=eq.00000000-0000-0000-0000-000000000000', {
  method: 'DELETE',
});
del.status === 204 || del.status === 200
  ? console.log(`info  anon delete of a non-existent row -> ${del.status}`)
  : ok(`anon delete -> ${del.status} ${del.json?.code ?? ''}`);

// 4. GraphQL introspection (pg_graphql) and Storage.
const gql = await call('/graphql/v1', {
  method: 'POST',
  body: JSON.stringify({ query: '{ __schema { queryType { fields { name } } } }' }),
});
const gqlFields = gql.json?.data?.__schema?.queryType?.fields?.map((f) => f.name) ?? [];
gqlFields.some((n) => /mail/i.test(n))
  ? find(`GraphQL exposes to anon: ${gqlFields.join(', ')}`)
  : ok(
      `GraphQL -> ${gql.status}, anon-visible fields: ${gqlFields.filter((n) => n !== 'node').join(', ') || 'none'}`,
    );
const buckets = await call('/storage/v1/bucket');
Array.isArray(buckets.json) && buckets.json.length
  ? find(
      `anon can list storage buckets: ${buckets.json.map((b) => `${b.name}${b.public ? ' (PUBLIC)' : ''}`).join(', ')}`,
    )
  : ok(`storage bucket list -> ${buckets.status}`);

console.log(findings === 0 ? 'clean' : `${findings} finding(s)`);
process.exitCode = findings === 0 ? 0 : 1;
