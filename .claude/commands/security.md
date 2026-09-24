---
description: 'Active security audit of your OWN app: spawns the security-auditor agent to read the code AND probe the running app (injection, auth bypass, secret/PII & API-key leaks, exposed routes) with custom project-specific scripts. Reports findings only unless asked to fix.'
argument-hint: '[what to audit, default: current changes]'
---

Security audit: $ARGUMENTS

This is an **authorized, report-only** audit of the user's **own** application
(their repo, a local instance, their designated test resources). Default to
report-only — only fix if explicitly asked. This command doesn't just read code:
it drives a `security-auditor` subagent that also probes the running app. Steps:

1. **Scope.** If `$ARGUMENTS` is a plan/spec file (e.g. `.claude/plans/*.md`, a
   milestone doc), run the agent in **design review** mode: threat model +
   security requirements for the plan, before any code exists. If it says "did
   X leak?", use **incident check** mode. If `$ARGUMENTS` names specific
   code/areas, focus there. Otherwise
   default to the current changes (`git diff` staged + unstaged, and untracked
   files); if there are none, audit the app as a whole. Confirm what counts as
   the local/test instance and test resources (from CLAUDE.md / `.env.example`) —
   never touch production or real user data.

2. **Orient (main agent).** Read CLAUDE.md, `.claude/security/playbook.md` (if
   present) and any security/architecture docs and note the project's **own**
   security & safety rules and known accepted gaps, so findings can be judged
   against them. Read the changed files in full for context — auth/validation
   bugs are often only visible with surrounding code.

3. **Spawn the `security-auditor` agent** to do the real work. Pass it: the scope
   from step 1, the file/area list, the paths to CLAUDE.md, the playbook and the
   security docs, the session scratchpad path, whether `--live` probes (network
   against the project's own services) are OK, and how to run a local instance +
   which test resources are safe to use. It will:
   - run the playbook probes (`.claude/security/probes/run-all.sh`) first, if any;
   - map this app's input surfaces, sinks, auth, secret handling, and API routes;
   - do a static pass across the OWASP Top 10:2025 (access control/SSRF,
     misconfiguration, supply chain, crypto, injection, insecure design, auth,
     integrity, logging, exceptional conditions) plus CLI/local-file, BaaS/RLS,
     CI/CD and git-history checks, and any violation of the project's own rules;
   - **write and run custom, project-specific probe scripts** (in the scratchpad,
     never the repo) against a local instance/test resources — injection & input
     abuse, auth/access-control bypass, exposed API routes, leaked API keys, and
     secret/PII leakage in responses & logs — non-destructively;
   - run the dependency audit (`npm audit` / lockfile);
   - drive the web UI via the Chrome extension where one exists (localhost only);
   - verify each issue with a concrete reproduction before reporting.

   For a large or multi-surface app you may spawn more than one `security-auditor`
   agent over disjoint areas (e.g. CLI vs server vs DB) in parallel.

4. **Triage yourself — don't forward agent output blindly.** For each reported
   finding, check the evidence (open the file, re-run the probe). Keep real,
   reproduced issues; drop unverifiable ones with a one-line reason.

5. **Assign severity:** CRITICAL (exploitable now, block merge), HIGH (real risk,
   should fix), MEDIUM (defense-in-depth), LOW (hardening) — with OWASP 2025
   category and CWE. Known accepted gaps from the playbook are listed separately,
   not as new findings, unless they got worse.

6. **Report.** For each finding: file/route/input location, what's wrong, how it
   was demonstrated (the probe/request, sanitized — never print secret values),
   and the fix. Group by severity, most severe first. Also state what was tested
   and found clean, and what couldn't be reached (needs prod / a real account / a
   design decision). If genuinely nothing is found, say so rather than inventing
   nits.

7. **Only fix if explicitly asked.** Then apply the minimal change that closes
   each vulnerability — no unrelated refactoring — and re-state which findings
   were fixed vs. left for the user (e.g. anything needing a design decision such
   as key rotation).

**Guardrails (also enforced by the agent):** never edit app source unless step 7
applies; the agent may invoke no skill except `claude-in-chrome`; never touch production or third-party systems; never print/exfiltrate
secrets or message bodies (read env var _names_ only); keep all probes local and
non-destructive and respect the project's safety rules; clean up any test records
created.
