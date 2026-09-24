// Local machine hygiene — where secrets leak OUTSIDE the repo. Value-blind: secret values are
// loaded in-process and only variable names, file paths and counts are printed.
// Checks: secret file modes (600) and config dir (700), git remote without embedded
// credentials, npm tokens, secret values in shell histories, Claude Code transcripts/memory,
// and other non-ignored places in the working tree (logs, dist, coverage).
// Usage (repo root): node .claude/security/probes/local-hygiene.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root =
  process.env.MM_REPO ?? execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
let findings = 0;
const find = (m) => {
  findings++;
  console.log(`FIND  ${m}`);
};
const ok = (m) => console.log(`ok    ${m}`);
const home = homedir();
const short = (p) => p.replace(home, '~');

function loadEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// 1. File modes.
const SECRET_FILES = ['.env', '.env.local', 'supabase_pass', '.test.users.cred'];
for (const f of SECRET_FILES) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  const mode = statSync(p).mode & 0o777;
  mode & 0o077
    ? find(`${f} mode ${mode.toString(8)} — readable by other users (fix: chmod 600 ${f})`)
    : ok(`${f} mode ${mode.toString(8)}`);
}
const cfgDir = process.env.MM_CONFIG_DIR ?? join(home, '.config', 'mail-manager');
for (const p of [cfgDir, join(cfgDir, 'session.json')]) {
  if (!existsSync(p)) continue;
  const mode = statSync(p).mode & 0o777;
  mode & 0o077
    ? find(`${short(p)} mode ${mode.toString(8)}`)
    : ok(`${short(p)} mode ${mode.toString(8)}`);
}

// 2. Credentials embedded in git remotes / config, npm tokens.
const remotes = execFileSync('git', ['-C', root, 'remote', '-v']).toString();
/\/\/[^/@\s]+:[^/@\s]+@|\/\/[^/@\s]*(ghp_|gho_|github_pat_)/.test(remotes)
  ? find('a git remote URL embeds credentials')
  : ok('git remotes carry no credentials');
const gitConfig = readFileSync(join(root, '.git', 'config'), 'utf8');
if (/extraheader|ghp_|github_pat_|password\s*=/.test(gitConfig))
  find('.git/config holds a token/header');
for (const p of [join(root, '.npmrc'), join(home, '.npmrc')]) {
  if (existsSync(p) && /_authToken|_password|_auth\s*=/.test(readFileSync(p, 'utf8'))) {
    const mode = statSync(p).mode & 0o777;
    console.log(
      `info  ${short(p)} holds an npm auth token (mode ${mode.toString(8)}) — needs 2FA + granular token`,
    );
  }
}

// 3. Secret VALUES in places outside the repo's protection.
const secrets = new Map();
for (const [k, v] of Object.entries({
  ...loadEnv(join(root, '.env')),
  ...loadEnv(join(root, '.env.local')),
})) {
  if (v.length >= 8 && /KEY|PASS|SECRET|TOKEN/.test(k)) secrets.set(v, k);
}
for (const f of ['supabase_pass', '.test.users.cred']) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  for (const tok of readFileSync(p, 'utf8').split(/[\s=:,;"']+/)) {
    // Passwords only here (addresses are PII, not credentials): skip words and emails.
    if (tok.length >= 8 && !/^[A-Za-z_-]+$/.test(tok) && !tok.includes('@'))
      secrets.set(tok, `${f} value`);
  }
}
console.log(`info  ${secrets.size} secret value(s) loaded (not printed)`);

function scanFile(p, label = short(p)) {
  let text;
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > 200 * 1024 * 1024) return;
    text = readFileSync(p, 'utf8');
  } catch {
    return;
  }
  const hit = new Set();
  for (const [value, name] of secrets) if (text.includes(value)) hit.add(name);
  if (hit.size) find(`${label} contains the value of ${[...hit].join(', ')}`);
}
function walk(dir, filter, depth = 3) {
  if (!existsSync(dir) || depth < 0) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, filter, depth - 1));
    else if (filter(e.name)) out.push(p);
  }
  return out;
}

for (const h of [
  '.bash_history',
  '.zsh_history',
  '.python_history',
  '.node_repl_history',
  '.psql_history',
]) {
  scanFile(join(home, h));
}
// Claude Code transcripts + memory for THIS project: anything printed in a past session.
const projectKey = root.replace(/[/_.]/g, '-');
const claudeDir = join(home, '.claude', 'projects', projectKey);
const transcripts = walk(claudeDir, (n) => /\.(jsonl|md|txt|json)$/.test(n));
transcripts.forEach((p) => scanFile(p, `~/.claude/projects/…/${p.slice(claudeDir.length + 1)}`));
console.log(
  `info  scanned ${transcripts.length} Claude transcript/memory file(s) for this project`,
);
// Working-tree places that are gitignored but still end up in bug reports / uploads.
for (const d of ['dist', 'coverage', 'backups'])
  walk(join(root, d), () => true).forEach((p) => scanFile(p, p.slice(root.length + 1)));
walk(root, (n) => n.endsWith('.log'), 1).forEach((p) => scanFile(p, p.slice(root.length + 1)));

console.log(findings === 0 ? 'clean' : `${findings} finding(s)`);
process.exitCode = findings === 0 ? 0 : 1;
