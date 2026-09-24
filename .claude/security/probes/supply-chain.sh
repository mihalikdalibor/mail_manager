#!/usr/bin/env bash
# Supply-chain check (OWASP A03:2025): known CVEs, registry signatures/provenance, lockfile
# integrity, install scripts, unpinned security-critical deps, CI workflow hygiene.
# Read-only (npm audit sends the dependency tree to the npm registry — standard, no secrets).
# Usage (repo root): bash .claude/security/probes/supply-chain.sh
set -u
cd "${MM_REPO:-$(git rev-parse --show-toplevel)}" || exit 2

echo "== npm audit (runtime deps only, then all)"
npm audit --omit=dev --audit-level=low 2>&1 | tail -n 15
npm audit --audit-level=high >/dev/null 2>&1 && echo "ok    no high/critical in dev+runtime" || echo "FIND  high/critical advisories (run: npm audit)"

echo "== registry signatures + provenance attestations"
npm audit signatures 2>&1 | tail -n 6

echo "== lockfile integrity / sources / install scripts"
node --input-type=module <<'EOF'
import { readFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let bad = 0;
const find = (m) => { bad++; console.log(`FIND  ${m}`); };
if (lock.lockfileVersion < 3) find(`lockfileVersion ${lock.lockfileVersion} (<3)`);
const scripts = [];
for (const [path, p] of Object.entries(lock.packages ?? {})) {
  if (path === '' || p.link) continue;
  if (!p.resolved?.startsWith('https://registry.npmjs.org/')) find(`${path} resolved from ${p.resolved ?? '(none)'}`);
  if (!p.integrity?.startsWith('sha512-')) find(`${path} integrity ${p.integrity ?? 'missing'}`);
  if (p.hasInstallScript) scripts.push(`${path.replace(/^node_modules\//, '')}${p.dev ? ' (dev)' : ''}`);
}
console.log(`info  ${Object.keys(lock.packages).length - 1} packages in lockfile`);
console.log(`info  install scripts (run on npm ci): ${scripts.join(', ') || 'none'} — each must be expected`);
// Security-critical runtime deps should be pinned or tightly ranged and reviewed on bump.
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  if (/^(\*|latest|x|>=)/.test(range) || range.includes('||')) find(`dependency ${name} has a loose range "${range}"`);
}
if (!/^\d/.test(pkg.dependencies?.imapflow ?? '')) find('imapflow is not pinned to an exact version (it handles credentials)');
// Dependency confusion: every dep name must exist on the public registry under that exact name;
// scoped internal names would need a scoped .npmrc registry.
console.log(bad === 0 ? 'ok    lockfile clean' : `${bad} lockfile finding(s)`);
EOF

echo "== .npmrc (registry overrides, ignore-scripts, tokens)"
for f in .npmrc "$HOME/.npmrc"; do
  [ -f "$f" ] && sed -E 's/(_authToken|_password|_auth)=.*/\1=<set>/' "$f" | sed "s|^|      $f: |"
done
[ -f .npmrc ] || echo "      (no project .npmrc)"

echo "== GitHub Actions"
node --input-type=module <<'EOF'
import { readdirSync, readFileSync, existsSync } from 'node:fs';
const dir = '.github/workflows';
if (!existsSync(dir)) { console.log('info  no workflows'); process.exit(0); }
for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
  const y = readFileSync(`${dir}/${f}`, 'utf8');
  const lines = y.split('\n');
  const find = (m) => console.log(`FIND  ${f}: ${m}`);
  if (!/^permissions:/m.test(y)) find('no top-level `permissions:` (defaults may be write-all)');
  if (/pull_request_target|workflow_run/.test(y)) find('pull_request_target/workflow_run: runs with secrets on fork code — review');
  lines.forEach((l, i) => {
    const uses = /uses:\s*([^\s#]+)/.exec(l);
    if (uses && !uses[1].startsWith('./') && !/@[0-9a-f]{40}$/.test(uses[1])) find(`line ${i + 1}: action not pinned to a commit SHA: ${uses[1]}`);
    if (/\$\{\{\s*github\.(event|head_ref)/.test(l) && /run:|^\s+[^:]+$/.test(l)) find(`line ${i + 1}: untrusted github context interpolated into a script (injection)`);
    if (/docker run|image:/.test(l) && /:[\w.-]+(\s|'|$)/.test(l) && !/@sha256:/.test(l)) console.log(`info  ${f}:${i + 1} container pinned by tag, not digest`);
    if (/secrets\./.test(l) && /echo/.test(l)) find(`line ${i + 1}: secret echoed`);
  });
  if (/actions\/checkout/.test(y) && !/persist-credentials:\s*false/.test(y)) console.log(`info  ${f}: checkout keeps the GITHUB_TOKEN in .git/config (set persist-credentials: false)`);
}
EOF
