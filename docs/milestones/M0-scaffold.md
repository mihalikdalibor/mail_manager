# M0 — Scaffold & tooling

## Goal

A runnable TypeScript CLI with strict tooling so every later milestone starts from a clean, tested base. `mm --help` works and `mm doctor` proves the Supabase credentials are valid.

## In scope

- `package.json` (ESM, `"engines": { "node": ">=22.12" }`, `bin: { "mm": "dist/cli/bin.js" }`), committed lockfile. `src/cli/bin.ts` is the executable entry; `src/cli/index.ts` exports `buildProgram()` (importable by tests).
- **TypeScript pinned to 6.0.x** — typescript-eslint supports `<6.1`; TypeScript 7 is not yet supported by it.
- `tsconfig.json` strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, explicit `types: ["node"]`), `NodeNext`; `tsconfig.build.json` compiles `src` → `dist`.
- Dev tooling: `tsx` (dev run), `vitest` (unit + separate integration config), `eslint` flat config (typescript-eslint, type-checked), `prettier`.
- `src/core/config.ts` — zod-validated env loading from `.env.local` then `.env` (real env wins); empty values count as missing; errors name variables, never values.
- `src/core/master-key.ts` — generate / validate `MM_MASTER_KEY` (32 bytes, strict base64).
- `src/core/doctor.ts` + `mm doctor` — Node version, Supabase env, master key (WARN if missing), Supabase reachability via `GET /auth/v1/health` with the publishable key (5 s timeout).
- `mm keygen` — prints a new master key to stdout (hint on stderr).
- npm scripts: `dev`, `build`, `start`, `test`, `test:integration`, `lint`, `format`, `format:check`, `typecheck`.
- GitHub Actions CI (`.github/workflows/ci.yml`): lint, format check, typecheck, test, build, audit + pinned gitleaks job. Activates once pushed.
- Supabase cloud project (EU region) — user action, keys in `.env.local`.

## Out of scope

Any IMAP, DB (supabase-js), or credential-encryption logic.

## Design notes

- Runtime deps: `commander`, `zod`, `dotenv`. Dev: `typescript`, `@types/node`, `tsx`, `vitest`, `eslint`, `@eslint/js`, `typescript-eslint`, `prettier`.
- imapflow and mailparser licences checked: MIT.
- Config is loaded lazily, so `mm --help` / `mm keygen` work without any env file.
- Env files are resolved from the project root (module location), so `mm` works from any directory after `npm link`.
- Doctor uses plain `fetch` with redirects disabled (fetch would forward the `apikey` header to another origin); the publishable key is sent only as the `apikey` header (not a JWT). Verified 2026-09-21: `/auth/v1/health` returns 200 with the real key and 401 with a bogus or missing key.
- Local gitleaks is optional (`gitleaks git .` before pushing); CI always runs it.

## Resolved questions

- Build output: `tsc` → `dist/`, `npm link` for the `mm` binary; `tsx` for `npm run dev`.
- Env var names: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (Vite-style `VITE_*` names are not read; doctor hints at renaming).
- Git hosting: GitHub assumed for CI — still open until a remote exists.

## Acceptance criteria

- Fresh copy → `npm ci`, lint, format:check, typecheck, test, build green; `test:integration` passes with no tests.
- `mm --help` lists `doctor` and `keygen`; `--version` prints the package version.
- `mm keygen` prints exactly one valid 32-byte base64 key on stdout.
- `mm doctor` exits 0 against the real project; exits 1 with a clear reason for a bad key, unreachable URL, or missing variable; never prints secret values.

## Verification steps

1. Fresh copy → `npm ci` → all scripts green.
2. `mm --help`, `mm --version`, `mm keygen`.
3. `mm doctor` (real), then with `SUPABASE_PUBLISHABLE_KEY=bogus` and `SUPABASE_URL=https://invalid.invalid`.
4. `git check-ignore .env.local` confirms the env file is ignored.
