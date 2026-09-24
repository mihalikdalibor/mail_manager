// Credential crypto (src/core/crypto.ts, credentials.ts, master-key.ts) and the local session
// file (session-storage.ts). No network. Uses a throwaway temp dir, removed at the end.
// Checks: IV uniqueness, AAD binding (row/user swap), tamper detection, generic errors that
// never echo key/plaintext, strict master-key parsing, file/dir modes under a permissive
// umask, symlink and pre-existing-file handling, corrupt file = logged out.
// Usage (repo root): npx tsx .claude/security/probes/crypto-local-files.mts
import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.env.MM_REPO ?? process.cwd();
const c = await import(join(root, 'src/core/crypto.ts'));
const mk = await import(join(root, 'src/core/master-key.ts'));
const creds = await import(join(root, 'src/core/credentials.ts'));
const ss = await import(join(root, 'src/core/db/supabase/session-storage.ts'));

let findings = 0;
const find = (m: string): void => {
  findings++;
  console.log(`FIND  ${m}`);
};
const ok = (m: string): void => console.log(`ok    ${m}`);
const key = randomBytes(32);
const PLAIN = 'PLAIN-CANARY-31c2';
const aad = c.accountAad('user-a', 'acct-1');

// 1. AES-GCM properties.
const ivs = new Set<string>();
for (let i = 0; i < 20_000; i++) ivs.add(c.encryptSecret(PLAIN, key, 1, aad).iv);
ivs.size === 20_000
  ? ok('20k encryptions, no IV reuse')
  : find(`IV reused (${20_000 - ivs.size}x)`);

const enc = c.encryptSecret(PLAIN, key, 1, aad);
if (JSON.stringify(enc).includes(PLAIN)) find('plaintext in ciphertext object');
const mustFail: [string, () => unknown][] = [
  ['other account (row swap)', () => c.decryptSecret(enc, key, c.accountAad('user-a', 'acct-2'))],
  ['other user', () => c.decryptSecret(enc, key, c.accountAad('user-b', 'acct-1'))],
  [
    'flipped ciphertext bit',
    () => {
      const b = Buffer.from(enc.ciphertext, 'base64');
      b[0] ^= 1;
      return c.decryptSecret({ ...enc, ciphertext: b.toString('base64') }, key, aad);
    },
  ],
  [
    'truncated tag',
    () =>
      c.decryptSecret(
        { ...enc, tag: Buffer.from(enc.tag, 'base64').subarray(0, 4).toString('base64') },
        key,
        aad,
      ),
  ],
  ['wrong key', () => c.decryptSecret(enc, randomBytes(32), aad)],
  ['16-byte key', () => c.encryptSecret(PLAIN, randomBytes(16), 1, aad)],
];
for (const [label, fn] of mustFail) {
  try {
    fn();
    find(`${label}: accepted`);
  } catch (e: any) {
    if (e?.name !== 'CryptoError')
      find(`${label}: threw ${e?.name} (raw Node error reaches callers)`);
    if (String(e?.message).includes(PLAIN) || String(e?.message).includes(key.toString('base64')))
      find(`${label}: error echoes secret`);
  }
}
ok('AAD / tamper / key-length checks run');

// Key version mismatch must be refused, not silently decrypted with the wrong key.
const provider = new creds.LocalCredentialProvider({ masterKey: key, masterKeyVersion: 2 });
try {
  provider.decryptPassword({ id: 'acct-1', userId: 'user-a', secret: enc });
  find('key_version mismatch accepted');
} catch {
  ok('key_version mismatch refused');
}

// 2. Master key parsing: strict, and reasons never echo the value.
const weird = [
  '',
  '   ',
  'not base64!!',
  randomBytes(31).toString('base64'),
  randomBytes(33).toString('base64'),
  randomBytes(32).toString('base64url'),
  randomBytes(32).toString('base64').replace(/=$/, ''),
  `${randomBytes(32).toString('base64')}\nextra`,
];
for (const v of weird) {
  const r = mk.validateMasterKey(v);
  if (r.ok) find(`validateMasterKey accepted ${JSON.stringify(v.slice(0, 12))}…`);
  else if (v.trim().length > 4 && r.reason.includes(v.trim().slice(0, 8)))
    find('validateMasterKey reason echoes the value');
}
ok('master key parsing checked');

// 3. Session file under a permissive umask, symlinks, corrupt content.
const dir = mkdtempSync(join(tmpdir(), 'mm-sec-'));
const old = process.umask(0o000);
try {
  const cfg = join(dir, 'cfg');
  const store = new ss.FileSessionStorage(cfg);
  store.setItem('sb-token', 'REFRESH-CANARY');
  const dm = statSync(cfg).mode & 0o777,
    fm = statSync(store.file).mode & 0o777;
  dm === 0o700 ? ok('config dir 700') : find(`config dir mode ${dm.toString(8)}`);
  fm === 0o600 ? ok('session file 600') : find(`session file mode ${fm.toString(8)}`);

  // Pre-planted symlink at session.json -> a victim file: a write must replace the link, not
  // write through it (atomic rename does), and must not change the victim.
  const victim = join(dir, 'victim.txt');
  writeFileSync(victim, 'VICTIM');
  rmSync(store.file);
  symlinkSync(victim, store.file);
  store.setItem('sb-token', 'x');
  readFileSync(victim, 'utf8') === 'VICTIM'
    ? ok('write did not follow a planted symlink')
    : find('session write followed a symlink into another file');
  if (lstatSync(store.file).isSymbolicLink()) find('session.json is still a symlink after write');

  // Corrupt / hostile JSON = logged out, no throw, no echo; __proto__ key must not pollute.
  writeFileSync(store.file, '{"__proto__":{"polluted":"1"},"k":{"nested":1}', { mode: 0o600 });
  store.isEmpty() ? ok('corrupt file = logged out') : find('corrupt file treated as a session');
  writeFileSync(store.file, '{"__proto__":{"polluted":"1"},"k":"v"}', { mode: 0o600 });
  store.getItem('k');
  (({}) as any).polluted === undefined
    ? ok('no prototype pollution from session.json')
    : find('prototype polluted from session.json');

  // MM_CONFIG_DIR pointing at a shared dir gets chmod-ed 700 (documented) — just report it.
  console.log(
    'info  MM_CONFIG_DIR is chmod-ed to 700: pointing it at a shared dir (e.g. $HOME) would lock it — documented in .env.example',
  );
} finally {
  process.umask(old);
  rmSync(dir, { recursive: true, force: true });
}

console.log(findings === 0 ? 'clean' : `${findings} finding(s)`);
process.exitCode = findings === 0 ? 0 : 1;
