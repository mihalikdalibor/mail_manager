import { readFileSync } from 'node:fs';
import { loadEnvFiles } from '../../../src/core/config.js';
import { readLiveImapEnv, resolveLiveSettings } from './live-env.js';

// Value-blind leak check over saved outputs of live runs: none may contain the test mailbox's
// password (plain, JSON-escaped, base64, SASL PLAIN), address, domain or IMAP host. Prints only
// "clean" / "LEAK" / "marker missing" per file — never a value.
//
// Usage: npx tsx tests/support/test-ground/leak-check.ts <file>::<marker> [...]
//   <marker> is text that proves the run actually happened (e.g. 'mm-test:' in script output,
//   'test ground (live)' in a verbose integration log). Lines of the presets suite
//   ("built-in presets answer on 993") are skipped: it lists every public preset host
//   (src/core/providers/presets.json), which can include the test mailbox's provider.

loadEnvFiles();
const live = readLiveImapEnv();
if (live === null) {
  console.log('IMAP env not set');
  process.exit(3);
}
const { address, password } = live;
const domain = address.slice(address.lastIndexOf('@') + 1);
// Real DNS only (same as the runs themselves).
const settings = await resolveLiveSettings(address, live.fallbackHost);
const forms = [
  password,
  JSON.stringify(password).slice(1, -1),
  Buffer.from(password).toString('base64'),
  Buffer.from(`\0${address}\0${password}`).toString('base64'),
  address,
  domain,
  settings.host,
  settings.username,
  live.fallbackHost ?? '',
]
  .filter((form) => form.length >= 4)
  .map((form) => form.toLowerCase());
const PRESETS_SUITE = 'built-in presets answer on 993';

let failures = 0;
for (const arg of process.argv.slice(2)) {
  const separator = arg.indexOf('::');
  const file = separator === -1 ? arg : arg.slice(0, separator);
  const marker = separator === -1 ? '' : arg.slice(separator + 2);
  const log = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.includes(PRESETS_SUITE))
    .join('\n');
  const result =
    marker !== '' && !log.includes(marker)
      ? 'marker missing'
      : forms.some((form) => log.toLowerCase().includes(form))
        ? 'LEAK'
        : 'clean';
  if (result !== 'clean') failures++;
  console.log(`${file}: ${result}`);
}
process.exit(failures === 0 ? 0 : 1);
