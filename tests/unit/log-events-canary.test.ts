import { describe, it, expect } from 'vitest';
import { AuthError } from '../../src/core/auth.js';
import {
  authFailureReason,
  authLogin,
  authLoginFailed,
  authLogout,
  discoverFinish,
  doctorCheck,
  guardBlock,
  guardChallenge,
  imapLogin,
  imapLoginFailed,
  renderEvent,
} from '../../src/core/log/index.js';
import type { LogEvent, RunContext } from '../../src/core/log/index.js';
import { authEmailTarget, authTargetKey } from '../../src/core/security/events.js';

// Canary (docs/LOGGING.md "Keeping it complete" #3): every M1b-4b builder is fed passwords,
// addresses, hosts and subjects wherever a string can be passed; none may reach a line.

const CTX: RunContext = {
  run: '0123456789abcdef',
  ver: '0.5.0',
  now: () => Date.UTC(2026, 8, 29, 8, 0, 0),
  level: 'debug',
};

const PASSWORD = 'hunter2-ÄŠť';
const ADDRESS = 'canary@secret-domain.example';
const DOMAIN = 'secret-domain.example';
const HOST = 'imap.secret-host.example';
const SUBJECT = 'Tajný predmet';
// People type the password into the address field.
const TYPED_PASSWORD = 'Hunter2@secret-pass';
const VALUES = [PASSWORD, ADDRESS, DOMAIN, HOST, SUBJECT, TYPED_PASSWORD];
const NEEDLES = [
  ...VALUES,
  'hunter2',
  'Hunter2',
  'secret-domain',
  'secret-host',
  'secret-pass',
  'canary',
  'Tajn',
  'predmet',
];
// JSON.stringify escapes nothing in these, but check the escaped form too.
const ESCAPED = VALUES.map((v) => JSON.stringify(v).slice(1, -1));

function expectClean(events: LogEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    const r = renderEvent(e, CTX);
    expect(r, `render ${e.event}`).not.toBeNull();
    const line = r?.line ?? '';
    for (const needle of [...NEEDLES, ...ESCAPED]) {
      expect(line, `${e.event} leaks ${needle}`).not.toContain(needle);
    }
  }
}

describe('canary: domain events', () => {
  it('doctorCheck check name', () => {
    expectClean(VALUES.map((v) => doctorCheck(v, 'fail')));
  });

  it('discoverFinish provider', () => {
    expectClean(
      VALUES.map((v) =>
        discoverFinish({
          outcome: 'found',
          source: 'ispdb',
          provider: v,
          domainProblem: 'not-exist',
          choice: 'manual',
        }),
      ),
    );
  });

  it('authLogin user id', () => {
    expectClean(VALUES.map((v) => authLogin(v)));
  });

  it('authFailureReason on errors carrying canaries → reason only', () => {
    const errors: unknown[] = [
      ...VALUES.map((v) => new AuthError('invalid_credentials', v)),
      ...VALUES.map((v) => new Error(v)),
      ...VALUES,
    ];
    expectClean(errors.map((err) => authLoginFailed(authFailureReason(err), 'invalid')));
  });

  it('authLoginFailed target', () => {
    expectClean(VALUES.map((v) => authLoginFailed('invalid-credentials', v)));
  });

  it('authLoginFailed with a real target of each canary typed as the e-mail', () => {
    const key = authTargetKey(Buffer.alloc(32, 0x11));
    expectClean(VALUES.map((v) => authLoginFailed('unknown', authEmailTarget(key, v))));
  });

  it('authLogout', () => {
    expectClean([authLogout('logged-out'), authLogout('not-logged-in')]);
  });
});

describe('canary: guard events — provider and acct', () => {
  const ok = { ip: '203.0.113.7', target: 'c3'.repeat(32) };

  it('imapLogin', () => {
    expectClean(VALUES.map((v) => imapLogin({ ...ok, provider: v, acct: v })));
  });

  it('imapLoginFailed', () => {
    expectClean(
      VALUES.map((v) => imapLoginFailed({ ...ok, provider: v, acct: v }, 'auth-failed', true)),
    );
  });
});

// ip / target / addr / until are string-typed and filled by the guard (normalised IP bucket,
// HMAC, ISO date); the spec does not say whether the builders validate them. The lead asked for
// canaries "wherever a string can be passed", so they are pinned here separately.
describe('canary: guard events — ip, target, addr, until', () => {
  it('imapLogin ip and target', () => {
    expectClean(VALUES.map((v) => imapLogin({ provider: 'custom', ip: v, target: v })));
  });

  it('imapLoginFailed ip and target', () => {
    expectClean(
      VALUES.map((v) =>
        imapLoginFailed({ provider: 'custom', ip: v, target: v }, 'timeout', false),
      ),
    );
  });

  it('guardChallenge ip and target', () => {
    expectClean(VALUES.map((v) => guardChallenge(v, 2, v)));
  });

  it('guardBlock ip, addr, until and target', () => {
    expectClean(
      VALUES.map((v) =>
        guardBlock({
          kind: 'ip-blocked',
          reason: 'auth-failed',
          ip: v,
          addr: v,
          attempts: 3,
          until: v,
          target: v,
        }),
      ),
    );
  });
});
