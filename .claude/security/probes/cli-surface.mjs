// Black-box probe of the CLI as a user runs it (src/cli/bin.ts via tsx). Feeds hostile
// arguments and broken environments, then checks stdout+stderr for: stack traces, file paths,
// raw library/Node errors, terminal escape injection (ANSI/OSC echoed from input), and any
// secret VALUE from the gitignored env files (value-blind: values are never printed).
// Network: `doctor` and `whoami` call the user's own Supabase project read-only; `discover`
// cases fail validation first or use the reserved .invalid TLD (no third-party lookups).
// Never runs `login` (needs a TTY + real password).
// Uses a throwaway MM_CONFIG_DIR so the real session file is never touched.
// Usage (repo root): node .claude/security/probes/cli-surface.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.env.MM_REPO ?? process.cwd();
let findings = 0;
const find = (m) => {
  findings++;
  console.log(`FIND  ${m}`);
};

function loadEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const secrets = Object.entries({
  ...loadEnv(join(root, '.env')),
  ...loadEnv(join(root, '.env.local')),
}).filter(([k, v]) => v.length >= 8 && /KEY|PASS|SECRET|TOKEN/.test(k));

const cfg = mkdtempSync(join(tmpdir(), 'mm-cli-'));
const ESC = '\u001b';
const CASES = [
  ['help', ['--help']],
  ['unknown command', ['frobnicate']],
  [
    'discover: ANSI/OSC in email',
    ['discover', `${ESC}]8;;https://evil${ESC}\\x${ESC}[2J@evil.com`],
  ],
  ['discover: CRLF', ['discover', 'a\r\nb@evil.com']],
  ['discover: IP literal', ['discover', 'a@127.0.0.1']],
  ['discover: bidi', ['discover', 'a\u202e@evil.com']],
  ['discover: 10k chars', ['discover', 'a'.repeat(10_000) + '@x.com']],
  ['discover: format string', ['discover', '%s%s%n%x@example.invalid']],
  ['discover: prototype', ['discover', '__proto__@constructor.invalid']],
  ['whoami (no session)', ['whoami']],
  ['logout (no session)', ['logout']],
  ['doctor', ['doctor']],
  // Broken env: must be named, never echoed.
  ['doctor: bad master key', ['doctor'], { MM_MASTER_KEY: 'LEAKY-CANARY-KEY-value!!' }],
  ['doctor: bad supabase url', ['doctor'], { SUPABASE_URL: 'http://LEAKY-CANARY.invalid/' }],
  ['whoami: corrupt session', ['whoami'], {}, 'corrupt'],
];

for (const [label, args, extraEnv = {}, setup] of CASES) {
  if (setup === 'corrupt') {
    // A garbage session file must read as "logged out" and never be echoed.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(cfg, { recursive: true, mode: 0o700 });
    writeFileSync(join(cfg, 'session.json'), '{"LEAKY-CANARY-SESSION', { mode: 0o600 });
  }
  const r = spawnSync(join(root, 'node_modules/.bin/tsx'), ['src/cli/bin.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...extraEnv, MM_CONFIG_DIR: cfg, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const problems = [];
  if (/^\s+at .+\(?.+:\d+:\d+\)?$/m.test(out)) problems.push('stack trace');
  if (/node_modules|\/home\/|\/src\/core|file:\/\//.test(out)) problems.push('internal path');
  if (
    /TypeError|ReferenceError|SyntaxError|ERR_[A-Z_]+|fetch failed|AuthApiError|PostgrestError/.test(
      out,
    )
  )
    problems.push('raw library/Node error');
  // Any ESC/CSI that is not a plain SGR colour code (ESC[..m) = input-driven terminal control.
  if (/\u009b/.test(out) || /\u001b(?!\[[0-9;]*m)/.test(out))
    problems.push('terminal escape echoed');
  if (/[\u202a-\u202e\u2066-\u2069]/.test(out)) problems.push('bidi control echoed');
  if (out.includes('LEAKY-CANARY')) problems.push('bad env/session value echoed');
  for (const [name, value] of secrets)
    if (out.includes(value)) problems.push(`value of ${name} printed`);
  if (r.error) problems.push(`spawn error ${r.error.code}`);
  if (out.length > 20_000) problems.push(`huge output (${out.length} chars)`);
  const first = (r.stderr.trim() || r.stdout.trim()).split('\n')[0].slice(0, 90);
  if (problems.length) find(`${label}: ${problems.join(', ')}`);
  else console.log(`ok    ${label.padEnd(30)} exit ${r.status}  "${first}"`);
}

rmSync(cfg, { recursive: true, force: true });
console.log(findings === 0 ? 'clean' : `${findings} finding(s)`);
process.exitCode = findings === 0 ? 0 : 1;
