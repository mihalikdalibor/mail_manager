import { pathToFileURL } from 'node:url';
import { imapErrorText } from '../../../src/cli/imap-errors.js';
import { loginBlockedText } from '../../../src/cli/login-guard-text.js';
import { loadEnvFiles } from '../../../src/core/config.js';
import { ImapSessionError } from '../../../src/core/imap/errors.js';
import type { ImapSession } from '../../../src/core/imap/session.js';
import { LoginBlockedError } from '../../../src/core/security/login-guard.js';
import { TestGroundError } from './errors.js';
import { TestFolder } from './folder.js';
import { buildTestGround } from './generator.js';
import { openTestSession, readLiveImapEnv, resolveLiveSettings } from './live-env.js';
import { seedTestGround } from './seed.js';
import { unseedTestGround } from './unseed.js';

// `npm run test:seed` / `npm run test:unseed`: one login to the dedicated test mailbox, then
// seed or delete the mm-test folder. Output is counts only — never the password, address,
// host, or raw server/library text.

export const MISSING_ENV_TEXT =
  'Set MM_TEST_IMAP_USER and MM_TEST_IMAP_PASS in .env.local (see .env.example).';

const OVERQUOTA_TEXT =
  'The test mailbox is full. Free space in it (e.g. empty Trash), then run npm run test:seed again.';
const USAGE_TEXT = 'Usage: tsx tests/support/test-ground/cli.ts seed|unseed';
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/** User-facing text for any failure; library/server messages never pass through. */
export function errorText(err: unknown): string {
  if (err instanceof ImapSessionError) return imapErrorText(err.reason, { kind: 'this-computer' });
  if (err instanceof LoginBlockedError) return loginBlockedText(err);
  if (err instanceof TestGroundError) return err.message;
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { serverResponseCode?: unknown }).serverResponseCode === 'OVERQUOTA'
  ) {
    return OVERQUOTA_TEXT;
  }
  if (err instanceof Error && SAFE_NAME.test(err.name)) return `Unexpected error (${err.name})`;
  return 'Unexpected error';
}

async function seed(folder: TestFolder): Promise<void> {
  const ground = await buildTestGround();
  const report = await seedTestGround(folder, ground, (appended, missing) => {
    if (appended % 10 === 0 || appended === missing) {
      console.log(`Uploading test messages: ${appended}/${missing}`);
    }
  });
  console.log(
    `mm-test: ${report.total} messages (created: ${report.created ? 'yes' : 'no'}, ` +
      `appended ${report.appended}, flags reset ${report.flagsReset}).`,
  );
}

async function unseed(folder: TestFolder): Promise<void> {
  const result = await unseedTestGround(folder);
  console.log(
    result.deleted
      ? `mm-test: deleted (${result.messages} messages).`
      : 'mm-test: does not exist, nothing to delete.',
  );
}

async function main(command: string | undefined): Promise<void> {
  if (command !== 'seed' && command !== 'unseed') {
    console.error(USAGE_TEXT);
    process.exitCode = 1;
    return;
  }
  loadEnvFiles();
  const live = readLiveImapEnv();
  if (live === null) {
    console.error(MISSING_ENV_TEXT);
    process.exitCode = 1;
    return;
  }
  const settings = await resolveLiveSettings(live.address, live.fallbackHost);
  let session: ImapSession | undefined;
  try {
    session = await openTestSession(settings, live.password);
    const folder = TestFolder.fromSession(session);
    await (command === 'seed' ? seed(folder) : unseed(folder));
  } finally {
    await session?.logout();
  }
}

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write('', () => resolve()));
}

async function finish(): Promise<never> {
  // Library timers must not keep the process alive (same as src/cli/bin.ts).
  await flush(process.stdout);
  await flush(process.stderr);
  process.exit();
}

function fatal(err: unknown): void {
  console.error(errorText(err));
  process.exitCode = 1;
  void finish();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.on('unhandledRejection', fatal);
  process.on('uncaughtException', fatal);
  void main(process.argv[2])
    .catch((err: unknown) => {
      console.error(errorText(err));
      process.exitCode = 1;
    })
    .finally(() => void finish());
}
