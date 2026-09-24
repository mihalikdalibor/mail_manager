// openSession (src/core/imap/session.ts) against a FAKE imapflow client — no network, no login.
// Checks: TLS options (993, verify on, TLS1.2+, SNI), logger off, exactly ONE connect (no
// retry), password dropped after success AND failure, bad input refused before a client is
// built, server text / password never reach error, String(), inspect, JSON or CLI text, and the
// generic login message is byte-identical for every probe-able failure (anti-enumeration).
// Usage (repo root): npx tsx .claude/security/probes/imap-session.mts
import { inspect } from 'node:util';
import { join } from 'node:path';

const root = process.env.MM_REPO ?? process.cwd();
const { openSession } = await import(join(root, 'src/core/imap/session.ts'));
const { imapErrorText } = await import(join(root, 'src/cli/imap-errors.ts'));
const { errorText } = await import(join(root, 'src/cli/error-text.ts'));

let findings = 0;
const find = (m: string): void => {
  findings++;
  console.log(`FIND  ${m}`);
};
const ok = (m: string): void => console.log(`ok    ${m}`);
const PASSWORD = 'Pw-CANARY-9b1e!';
const SERVER_TEXT = 'SERVER-CANARY-44d0 user@secret.example exists';
const settings = {
  host: 'imap.example-test-domain.eu',
  port: 993,
  username: 'test@example-test-domain.eu',
};

function fakeClient(behaviour: 'ok' | Record<string, unknown>) {
  const state = { connects: 0, options: undefined as any };
  const create = (options: any) => {
    state.options = options;
    return {
      options,
      capabilities: new Map<string, boolean | number>([
        ['IMAP4REV1', true],
        ['AUTH=PLAIN', true],
      ]),
      enabled: new Set<string>(),
      serverInfo: { name: SERVER_TEXT },
      usable: true,
      on: () => undefined,
      close: () => undefined,
      logout: async () => undefined,
      connect: async () => {
        state.connects++;
        if (behaviour !== 'ok') throw Object.assign(new Error(SERVER_TEXT), behaviour);
      },
    };
  };
  return { state, create };
}
const leaks = (label: string, ...values: unknown[]): void => {
  for (const v of values) {
    const text = [
      String(v),
      inspect(v, { depth: 10, showHidden: true }),
      JSON.stringify(v) ?? '',
    ].join('\n');
    if (text.includes(PASSWORD)) find(`${label}: password visible`);
    if (text.includes('SERVER-CANARY')) find(`${label}: server text visible`);
  }
};

// 1. Success path: options + password drop + no leak through the session object.
{
  const { state, create } = fakeClient('ok');
  const s = await openSession({
    settings,
    password: PASSWORD,
    clientVersion: '0.0.0',
    createClient: create,
  });
  const o = state.options;
  if (o.port !== 993 || o.secure !== true) find('not implicit TLS on 993');
  if (o.tls?.rejectUnauthorized !== true) find('certificate verification not forced on');
  if (!['TLSv1.2', 'TLSv1.3'].includes(o.tls?.minVersion)) find(`minVersion ${o.tls?.minVersion}`);
  if (o.servername !== settings.host) find('SNI not set to host');
  if (o.logger !== false || o.logRaw || o.emitLogs) find('imapflow logging not fully off');
  if (o.auth !== undefined) find('password still in client options after connect');
  if (
    JSON.stringify(o.clientInfo ?? {}).match(/vendor|support-url|os|address/i) &&
    o.clientInfo.vendor !== false
  )
    find('ID command sends extra fingerprint fields');
  if (state.connects !== 1) find(`connect() called ${state.connects}x`);
  leaks('session', s);
  await s.logout();
  ok('success path checked');
}

// 2. Every failure: exactly one attempt, password dropped, only ImapSessionError, no leaks.
const FAILURES: Record<string, Record<string, unknown>> = {
  'auth-failed': {
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
    responseText: SERVER_TEXT,
  },
  expired: { authenticationFailed: true, serverResponseCode: 'EXPIRED' },
  'app-password (ALERT)': {
    authenticationFailed: false,
    serverResponseCode: 'ALERT',
    responseText: 'Use an app password',
  },
  'host not found': { code: 'ENOTFOUND' },
  refused: { code: 'ECONNREFUSED' },
  reset: { code: 'ECONNRESET' },
  timeout: { code: 'CONNECT_TIMEOUT' },
  'bad cert': { code: 'CERT_HAS_EXPIRED' },
  'BYE drop': { code: 'NoConnection', reason: SERVER_TEXT },
  'weird object': {
    code: { toString: () => SERVER_TEXT },
    cause: { message: SERVER_TEXT, pass: PASSWORD },
  },
};
const genericSet = new Set<string>();
const GENERIC_REASONS = [
  'auth-failed',
  'password-expired',
  'app-password-required',
  'host-not-found',
  'refused',
  'reset',
  'timeout',
  'unreachable',
  'contact-admin',
  'server-rejected',
];
for (const [label, err] of Object.entries(FAILURES)) {
  const { state, create } = fakeClient(err);
  try {
    await openSession({
      settings,
      password: PASSWORD,
      clientVersion: '0.0.0',
      createClient: create,
      checkConnectivity: async () => true,
    });
    find(`${label}: resolved instead of rejecting`);
  } catch (e: any) {
    if (e?.name !== 'ImapSessionError') find(`${label}: rejected with ${e?.name}`);
    if (state.connects !== 1) find(`${label}: connect() called ${state.connects}x (retry!)`);
    if (state.options.auth !== undefined)
      find(`${label}: password left in client options after failure`);
    if ('cause' in e) find(`${label}: error keeps a cause`);
    const cli = errorText(e);
    leaks(label, e, cli);
    if (GENERIC_REASONS.includes(e.reason)) genericSet.add(cli);
    console.log(`info  ${label.padEnd(22)} -> ${e.reason}${e.code ? ` (${e.code})` : ''}`);
  }
}
genericSet.size === 1
  ? ok('all probe-able failures print the SAME generic text')
  : find(`generic failures produce ${genericSet.size} different texts (account/host enumeration)`);
// No code in the generic text: none of the codes the failures carried, no "[...]" / "(E...)".
const CODES =
  /AUTHENTICATIONFAILED|EXPIRED|ALERT|ENOTFOUND|ECONN\w+|CONNECT_TIMEOUT|NoConnection|\[[^\]]*\]|\(E[A-Z]+\)/;
for (const text of genericSet) if (CODES.test(text)) find('generic text contains an error code');
for (const r of GENERIC_REASONS)
  if (imapErrorText(r, { kind: 'this-computer' }) !== [...genericSet][0])
    find(`imapErrorText('${r}') differs from the generic text`);

// 3. Bad input must be refused BEFORE any client exists.
for (const [u, p, h] of [
  ['user', 'a\r\nb', settings.host],
  ['us\ner', 'pw', settings.host],
  ['user', 'pw\0', settings.host],
  ['user', 'pw', '127.0.0.1'],
  ['user', 'pw', 'localhost'],
  ['user', 'pw', 'evil.com:25'],
]) {
  let built = false;
  try {
    await openSession({
      settings: { host: h, port: 993, username: u },
      password: p,
      clientVersion: '0',
      createClient: () => {
        built = true;
        throw new Error('x');
      },
    });
  } catch {
    /* expected */
  }
  if (built) find(`client built for bad input user=${JSON.stringify(u)} host=${h}`);
}
for (const port of [143, 0, 587]) {
  let built = false;
  try {
    await openSession({
      settings: { ...settings, port },
      password: 'pw',
      clientVersion: '0',
      createClient: () => {
        built = true;
        throw new Error('x');
      },
    });
  } catch {
    /* */
  }
  if (built) find(`client built for port ${port}`);
}
ok('input guards checked');

console.log(findings === 0 ? 'clean' : `${findings} finding(s)`);
process.exitCode = findings === 0 ? 0 : 1;
