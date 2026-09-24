// Secret / PII scan over tracked files AND full git history. VALUE-BLIND: real values are
// loaded from the gitignored env files into memory only, searched for, and never printed —
// hits are reported as "<file>:<line> contains <VARIABLE NAME>".
// Also flags generic secret shapes (JWTs, sb_secret_, private keys, base64 32-byte keys
// assigned to *_KEY) and gitignore gaps for this project's secret files.
// Usage (repo root): node .claude/security/probes/secrets-scan.mjs [--no-history | --staged | --message <file>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root =
  process.env.MM_REPO ?? execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], { maxBuffer: 512 * 1024 * 1024 }).toString();
let findings = 0;
const report = (msg) => {
  findings++;
  console.log(`FIND  ${msg}`);
};

// 1. Load secret VALUES (never print them). Minimal dotenv parser: KEY=VALUE, optional quotes.
function loadEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const env = { ...loadEnv(join(root, '.env')), ...loadEnv(join(root, '.env.local')) };
const needles = new Map(); // value -> variable name
for (const [name, value] of Object.entries(env)) {
  // Short or boilerplate values would match everywhere; port numbers etc. are not secrets.
  if (value.length < 6 || /^(\d+|true|false|https?:\/\/localhost.*)$/i.test(value)) continue;
  needles.set(value, name);
  if (name.endsWith('_USER') || name.endsWith('_EMAIL')) {
    // The address also leaks through its domain (e.g. in docs or presets).
    const domain = value.split('@')[1];
    if (domain && domain.length >= 6) needles.set(domain, `${name} (domain)`);
  }
}
for (const f of ['supabase_pass', '.test.users.cred']) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  for (const tok of readFileSync(p, 'utf8').split(/[\s=:,;"']+/)) {
    // Skip labels/words (letters only); keep addresses, passwords, tokens.
    if (tok.length >= 8 && !/^[A-Za-z_-]+$/.test(tok)) needles.set(tok, `${f} value`);
  }
}
console.log(`info  ${needles.size} secret value(s) loaded from gitignored files (not printed)`);

// 2. Generic secret shapes.
const SHAPES = [
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{10,}/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['32-byte base64 key assigned to a *_KEY', /[A-Z_]*KEY\s*[=:]\s*['"]?[A-Za-z0-9+/]{43}=/],
  ['password assigned in code', /(pass(word)?|pwd)\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
];
// Test canaries and doc placeholders are fine.
const ALLOW = /canary|example|placeholder|fake|dummy|<set>|test-password|xxxx|hunter2/i;
// Hard-coded passwords in unit tests and commented-out config samples are expected.
const SHAPE_SKIP = (where, line) => /^tests\//.test(where) || /^\s*#/.test(line);

function scanText(where, text, offset = 0) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [value, name] of needles)
      if (line.includes(value)) report(`${where}:${i + 1 + offset} contains ${name}`);
    for (const [label, re] of SHAPES)
      if (re.test(line) && !ALLOW.test(line) && !SHAPE_SKIP(where, line))
        report(`${where}:${i + 1 + offset} looks like a ${label}`);
  });
}

// Hook modes (fast, used by .claude/security/hooks): only what is about to be committed.
//   --staged          added lines of `git diff --cached` + secret files being staged
//   --message <file>  the commit message
const done = () => {
  if (findings) console.log('BLOCKED: remove the value (use a placeholder) and try again.');
  process.exit(findings === 0 ? 0 : 1);
};
const msgIdx = process.argv.indexOf('--message');
if (msgIdx !== -1) {
  scanText('commit message', readFileSync(process.argv[msgIdx + 1] ?? '', 'utf8'));
  done();
}
if (process.argv.includes('--staged')) {
  const SECRET_NAME =
    /(^|\/)(\.env(\..*)?|supabase_pass|.*\.cred|session\.json|.*\.(pem|key|p12))$/;
  for (const f of git('diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR')
    .split('\0')
    .filter(Boolean)) {
    if (SECRET_NAME.test(f) && !f.endsWith('.env.example')) report(`${f} is a secret file`);
  }
  let file = '?';
  let line = 0;
  for (const l of git('diff', '--cached', '-U0', '--no-color').split('\n')) {
    if (l.startsWith('+++ b/')) file = l.slice(6);
    else if (l.startsWith('@@')) line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0) - 1;
    else if (l.startsWith('+') && !file.endsWith('package-lock.json')) {
      line++;
      scanText(file, l.slice(1), line - 1);
    }
  }
  done();
}

// 3. Tracked files (working tree).
for (const file of git('ls-files', '-z').split('\0').filter(Boolean)) {
  const p = join(root, file);
  if (!existsSync(p) || file.endsWith('package-lock.json')) continue;
  const buf = readFileSync(p);
  if (buf.includes(0)) continue; // binary
  scanText(file, buf.toString('utf8'));
}
// Untracked, not-ignored files would be committed by `git add .`.
for (const file of git('ls-files', '-z', '--others', '--exclude-standard')
  .split('\0')
  .filter(Boolean)) {
  const p = join(root, file);
  if (existsSync(p)) scanText(`${file} (untracked)`, readFileSync(p, 'utf8'));
}

// 4. History: every added line in every commit, plus commit messages.
if (!process.argv.includes('--no-history')) {
  const log = git('log', '--all', '-p', '--no-color', '--format=@@COMMIT %h%n%B');
  // Commits whose leaks were handled (credentials rotated, history rewrite declined) are
  // listed in .claude/security/accepted-history.txt ("<short-sha> # reason") → GAP, not FIND.
  const acceptedFile = join(root, '.claude/security/accepted-history.txt');
  const accepted = existsSync(acceptedFile)
    ? new Set(
        readFileSync(acceptedFile, 'utf8')
          .split('\n')
          .map((l) => l.split('#')[0].trim())
          .filter(Boolean),
      )
    : new Set();
  const seen = new Set();
  let commit = '?';
  let file = '?';
  for (const line of log.split('\n')) {
    if (line.startsWith('@@COMMIT ')) {
      commit = line.slice(9);
      continue;
    }
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      continue;
    }
    if (file.endsWith('package-lock.json')) continue;
    if (line.startsWith('+') || !line.startsWith('-')) {
      for (const [value, name] of needles) {
        const key = `${commit} ${file} ${name}`;
        if (line.includes(value) && !seen.has(key)) {
          seen.add(key);
          const msg = `history ${key.replace(/ (\S+) /, ' $1 contains ')}`;
          if (accepted.has(commit)) console.log(`GAP   ${msg} (accepted)`);
          else report(msg);
        }
      }
    }
  }
}

// 5. .gitignore must cover the secret files.
for (const f of ['.env', '.env.local', 'supabase_pass', '.test.users.cred', 'backups/x.eml']) {
  try {
    git('check-ignore', '-q', f);
  } catch {
    report(`${f} is NOT gitignored`);
  }
}
for (const f of ['.env', '.env.local', 'supabase_pass', '.test.users.cred']) {
  if (git('ls-files', f).trim()) report(`${f} is tracked by git`);
}

console.log(findings === 0 ? 'clean' : `${findings} finding(s)`);
process.exitCode = findings === 0 ? 0 : 1;
