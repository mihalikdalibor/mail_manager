#!/usr/bin/env bash
# Runs every probe and saves each output to OUT_DIR (default: a new temp dir — pass the
# session scratchpad). Offline probes always run; --live adds the ones that touch the network
# (DNS lookups, npm registry, the user's own Supabase project read-only, CLI doctor).
# Exit code = number of probes that reported findings (0 = all clean).
# Usage (repo root): bash .claude/security/probes/run-all.sh [OUT_DIR] [--live]
set -u
cd "${MM_REPO:-$(git rev-parse --show-toplevel)}" || exit 2
out=${1:-$(mktemp -d)}
[ "$out" = "--live" ] && out=$(mktemp -d)
live=0
for a in "$@"; do [ "$a" = "--live" ] && live=1; done
mkdir -p "$out"
dir=.claude/security/probes
tsx=node_modules/.bin/tsx
[ -x "$tsx" ] || { echo "run npm ci first (tsx missing)"; exit 2; }

failed=0
probe() { # probe <name> <command...>
  local name=$1
  shift
  printf '%-22s' "$name"
  if timeout 600 "$@" >"$out/$name.txt" 2>&1; then echo "clean"; else
    echo "FINDINGS/ERROR (exit $?) -> $out/$name.txt"
    failed=$((failed + 1))
  fi
}

probe static-rules      bash "$dir/static-rules.sh"
probe secrets-scan      node "$dir/secrets-scan.mjs"
probe input-fuzz        "$tsx" "$dir/input-fuzz.mts" --no-dns
probe discovery-ssrf    "$tsx" "$dir/discovery-ssrf.mts"
probe imap-session      "$tsx" "$dir/imap-session.mts"
probe crypto-local      "$tsx" "$dir/crypto-local-files.mts"
# Local machine only (secret file modes, histories, transcripts): skipped in CI.
[ -z "${CI:-}" ] && probe local-hygiene     node "$dir/local-hygiene.mjs"
if [ $live = 1 ]; then
  probe input-fuzz-dns  "$tsx" "$dir/input-fuzz.mts"
  probe supply-chain    bash "$dir/supply-chain.sh"
  probe cli-surface     node "$dir/cli-surface.mjs"
  probe supabase-live   node "$dir/supabase-live.mjs"
fi
echo "outputs: $out"
# static-rules always exits 0 (leads, not findings): read its output too.
exit $failed
