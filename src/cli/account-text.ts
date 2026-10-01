import { AccountError, shortId } from '../core/accounts.js';
import type { MailAccount } from '../core/db/repos.js';
import type { ServerFeatures } from '../core/imap/features.js';
import { PRESETS } from '../core/providers/presets.js';
import { errorText } from './error-text.js';
import { sanitize } from './log-text.js';

// Texts for `mm account …`. Saved rows come from the database and are untrusted when printed
// (anyone with the user's session can write them), so every stored string goes through sanitize.

/** Display name of a preset id, or `Custom`. */
export function providerName(id: string): string {
  return sanitize(PRESETS.find((p) => p.id === id)?.name ?? 'Custom');
}

/** The short id, sanitized (ids come from the database too). */
export function idOf(id: string): string {
  return sanitize(shortId(id));
}

/** `someone@example.com (Gmail, id 3f2a91c0)` */
export function accountLabel(account: MailAccount): string {
  return `${sanitize(account.email)} (${providerName(account.provider)}, id ${idOf(account.id)})`;
}

/** `imap.example.com (port 993), username someone@example.com` — what a login will use. */
export function serverLabel(account: MailAccount): string {
  return `${sanitize(account.host)} (port ${account.port}), username ${sanitize(account.username)}`;
}

/**
 * Text for an error from an account command. `account` is the mailbox the command works on,
 * when known (for the update-password hint).
 */
export function accountErrorText(err: unknown, account?: MailAccount): string {
  if (!(err instanceof AccountError)) return errorText(err);
  const id = account === undefined ? '<id>' : idOf(account.id);
  switch (err.code) {
    case 'duplicate':
      if (err.accountId === undefined) {
        return 'This mailbox is already saved. Find its id with `mm account list`; to change its password run `mm account update-password <id>`.';
      }
      return `This mailbox is already saved (id ${idOf(err.accountId)}). To change its password run \`mm account update-password ${idOf(err.accountId)}\`.`;
    case 'not-found':
      return 'That mailbox is no longer saved — see `mm account list`.';
    case 'secret-unreadable':
      return (
        "The saved password can't be decrypted — either MM_MASTER_KEY (or its version) changed, or " +
        "the mailbox's server details were changed in the database, so Mail Manager won't send a " +
        'password to it. If the key changed, set the original key again. Otherwise run ' +
        `\`mm account remove ${id}\` and \`mm account add <email>\`, which finds the server ` +
        'again from the address.'
      );
    case 'unsupported':
      return "This saved mailbox uses settings Mail Manager can't use (port or sign-in type). Remove it and add it again.";
  }
}

export function refMissingText(command: string): string {
  return `Which mailbox? Run \`mm account list\` and pass its id, e.g. \`mm account ${command} 3f2a91c0\`.`;
}

export const REF_INVALID_TEXT =
  'A mailbox id is 4–36 characters 0-9, a-f (from `mm account list`).';

export function refNoneText(ref: string): string {
  return `No mailbox with id ${sanitize(ref)} — see \`mm account list\`.`;
}

export function refAmbiguousText(ref: string, count: number): string {
  return `${sanitize(ref)} matches ${count} mailboxes — type more characters of the id.`;
}

export const NO_ACCOUNTS_TEXT = 'No mailboxes yet — run `mm account add <email>`.';

function lastChecked(date: Date | null, timeZone?: string): string {
  if (date === null || Number.isNaN(date.getTime())) return 'never';
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone !== undefined && { timeZone }),
  });
  for (const p of format.formatToParts(date)) parts[p.type] = p.value;
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}`;
}

/** The `mm account list` table: one header line, one line per mailbox. Never secrets. */
export function accountTable(accounts: readonly MailAccount[], timeZone?: string): string[] {
  const rows = accounts.map((a) => [
    idOf(a.id),
    sanitize(a.email),
    providerName(a.provider),
    sanitize(a.host),
    lastChecked(a.lastCheckedAt, timeZone),
  ]);
  const header = ['ID', 'EMAIL', 'PROVIDER', 'HOST', 'LAST CHECKED'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const format = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [format(header), ...rows.map(format)];
}

const FEATURE_NAMES: [keyof ServerFeatures, string][] = [
  ['move', 'MOVE'],
  ['uidplus', 'UIDPLUS'],
  ['specialUse', 'SPECIAL-USE'],
  ['quota', 'QUOTA'],
  ['statusSize', 'STATUS=SIZE'],
  ['condstore', 'CONDSTORE'],
  ['qresync', 'QRESYNC'],
  ['esearch', 'ESEARCH'],
  ['within', 'WITHIN'],
  ['listStatus', 'LIST-STATUS'],
  ['objectId', 'OBJECTID'],
  ['idle', 'IDLE'],
  ['compress', 'COMPRESS'],
  ['rev2', 'IMAP4rev2'],
  ['gmail', 'Gmail extensions'],
];

/** `Server supports: MOVE, UIDPLUS, …` from the measured booleans — never server text. */
export function featuresLine(features: ServerFeatures): string {
  const names = FEATURE_NAMES.filter(([key]) => features[key] === true).map(([, name]) => name);
  return names.length === 0
    ? 'Server supports: basic IMAP only'
    : `Server supports: ${names.join(', ')}`;
}
