import { afterEach, describe, it, expect, vi } from 'vitest';
import { cliChallenge, formatUntil, loginBlockedText } from '../../src/cli/login-guard-text.js';
import { LoginBlockedError } from '../../src/core/security/login-guard.js';

function zoneName(d: Date): string {
  const zone = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value;
  if (zone === undefined) throw new Error('no time zone name');
  return zone;
}

// Local-time dates (the output is in the local time zone). March avoids 'Sep'/'Sept' variants.
const NOW = new Date(2026, 2, 10, 8, 0, 0);
const SAME_DAY = new Date(2026, 2, 10, 14, 30, 0);
const SAME_DAY_EARLY = new Date(2026, 2, 10, 9, 5, 0);
const NEXT_DAY = new Date(2026, 2, 11, 14, 30, 0);

describe('formatUntil', () => {
  it('same local day → 24h HH:MM with the time zone, without the month', () => {
    const text = formatUntil(SAME_DAY, NOW);
    expect(text).toContain('14:30');
    expect(text).toContain(zoneName(SAME_DAY));
    expect(text).not.toContain('Mar');
    expect(text).not.toMatch(/am|pm/i);
  });

  it('keeps the leading zero of the hour', () => {
    expect(formatUntil(SAME_DAY_EARLY, NOW)).toContain('09:05');
  });

  it('another day → day, short month, time and zone', () => {
    const text = formatUntil(NEXT_DAY, NOW);
    expect(text).toContain('11');
    expect(text).toContain('Mar');
    expect(text).toContain('14:30');
    expect(text).toContain(zoneName(NEXT_DAY));
  });

  it('a date on the same clock time but a year later includes the month', () => {
    const text = formatUntil(new Date(2027, 2, 10, 14, 30, 0), NOW);
    expect(text).toContain('Mar');
  });
});

describe('loginBlockedText', () => {
  it('too-many-attempts: wrong password, app password hint, and the unlock time', () => {
    const err = new LoginBlockedError('too-many-attempts', SAME_DAY);
    const text = loginBlockedText(err, NOW);
    expect(text).toMatch(/wrong password/i);
    expect(text).toMatch(/app password/i);
    expect(text).toContain(formatUntil(SAME_DAY, NOW));
  });

  it('ip-blocked: says blocked, the time, and to try again', () => {
    const err = new LoginBlockedError('ip-blocked', NEXT_DAY);
    const text = loginBlockedText(err, NOW);
    expect(text).toMatch(/blocked/i);
    expect(text).toContain(formatUntil(NEXT_DAY, NOW));
    expect(text).toMatch(/try again/i);
  });

  it('permanent: exact text', () => {
    const err = new LoginBlockedError('permanent', null);
    expect(loginBlockedText(err, NOW)).toBe(
      "Couldn't connect — this connection is blocked. Contact Mail Manager support.",
    );
  });

  it.each([
    new LoginBlockedError('too-many-attempts', SAME_DAY),
    new LoginBlockedError('too-many-attempts', NEXT_DAY),
    new LoginBlockedError('ip-blocked', SAME_DAY),
    new LoginBlockedError('ip-blocked', NEXT_DAY),
    new LoginBlockedError('permanent', null),
  ])('no raw codes, undefined or null in the text (%#)', (err) => {
    const text = loginBlockedText(err, NOW);
    expect(text).not.toContain('[');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
    expect(text).not.toContain('LoginBlockedError');
  });
});

describe('cliChallenge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function settlesAt(
    delayMs: number | undefined,
    write: (line: string) => void,
  ): Promise<void> {
    vi.useFakeTimers();
    let done = false;
    const p = (delayMs === undefined ? cliChallenge(write) : cliChallenge(write, delayMs)).then(
      () => {
        done = true;
      },
    );
    const total = delayMs ?? 5000;
    await vi.advanceTimersByTimeAsync(total - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    await p;
  }

  it('default: writes one line about 5 seconds and resolves after 5000 ms', async () => {
    const write = vi.fn<(line: string) => void>();
    await settlesAt(undefined, write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toMatch(/\b5 seconds\b/);
    expect(write.mock.calls[0]?.[0]).not.toMatch(/\n./);
  });

  it('custom delay: mentions it in seconds and resolves after it', async () => {
    const write = vi.fn<(line: string) => void>();
    await settlesAt(3000, write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toMatch(/\b3 seconds\b/);
  });

  it('writes the line before waiting', async () => {
    vi.useFakeTimers();
    const write = vi.fn<(line: string) => void>();
    const p = cliChallenge(write, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await p;
  });
});
