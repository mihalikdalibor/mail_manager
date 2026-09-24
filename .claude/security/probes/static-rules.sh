#!/usr/bin/env bash
# Static rule check: greps src/ for patterns that break this project's security rules
# (CLAUDE.md / docs/SECURITY.md). Read-only. Every hit is a LEAD, not a finding: open the
# file and confirm before reporting.
# Usage (repo root): bash .claude/security/probes/static-rules.sh
set -u
cd "${MM_REPO:-$(git rev-parse --show-toplevel)}" || exit 2

hits=0
rule() { # rule "<description>" <grep -E pattern> [path...]
  local desc=$1 pattern=$2
  shift 2
  local out
  out=$(grep -rnE --include='*.ts' --include='*.mts' --include='*.js' -e "$pattern" "${@:-src}" 2>/dev/null)
  if [ -n "$out" ]; then
    echo "LEAD  $desc"
    echo "$out" | sed 's/^/      /' | cut -c1-200
    hits=$((hits + 1))
  else
    echo "ok    $desc"
  fi
}

echo "== TLS / transport"
rule "TLS verification disabled" 'rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED'
rule "plaintext / STARTTLS IMAP (secure:false, port 143, doSTARTTLS)" 'secure:\s*false|port:\s*143\b|doSTARTTLS'
rule "old TLS version allowed" "minVersion:\s*'TLSv1(\.1)?'"

echo "== Login policy"
rule "retry/backoff around a login (no automatic retry allowed)" '(retry|retries|backoff|attempts?)\s*[:=].*(connect|login|openSession)'
rule "ImapFlow constructed outside openSession" 'new ImapFlow\(' src/cli src/server
rule "imapflow logger enabled" 'logger:\s*(true|console|pino)|logRaw:\s*true|emitLogs:\s*true'

echo "== Destructive IMAP (docs/IMAP.md §6)"
rule "folder-wide EXPUNGE / CLOSE paths (messageDelete, mailboxClose, bare expunge)" 'messageDelete\(|messageMove\(|mailboxClose\(|\.expunge\('
rule "hand-built IMAP command strings" "\.exec\(\s*['\`\"]|UID (SEARCH|FETCH|STORE|EXPUNGE)"

echo "== Injection sinks"
rule "PostgREST filter strings / RPC / raw SQL" '\.or\(|\.filter\(|\.rpc\(|\.textSearch\('
rule "shell / eval sinks" "child_process|execSync|spawnSync|\bexec\(|eval\(|new Function\("
rule "dynamic fs path from input (review for traversal)" '(readFile|writeFile|createWriteStream|mkdir|rm)(Sync)?\([^)]*\$\{'
rule "regex built from input (ReDoS / injection)" 'new RegExp\([^/"'"'"']'

echo "== Leaks"
rule "raw error text printed (err.message / stack / cause)" 'console\.(log|error|warn)\([^)]*(err|error|e)\.(message|stack|cause)'
rule "whole objects logged (config, env, options, session)" 'console\.(log|error|warn)\([^)]*(config|env|options|opts|session|process\.env)\b'
rule "JSON.stringify of error or env" 'JSON\.stringify\([^)]*(err|error|process\.env)'
rule "insecure randomness" 'Math\.random\('
rule "service-role / secret key referenced in CLI or core" 'SERVICE_ROLE|SUPABASE_SECRET_KEY|service_role' src/cli src/core

echo "== Files"
rule "file written without explicit mode (session, backups must be 600/700)" 'writeFileSync\([^)]*\)$|mkdirSync\([^)]*recursive:\s*true\s*\}\)'

echo
echo "$hits rule(s) with leads — verify each by reading the code before reporting."
