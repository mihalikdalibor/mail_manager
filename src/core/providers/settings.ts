import {
  DiscoveryInputError,
  hasUnsafeChars,
  hostFromUserInput,
  type ParsedEmail,
} from './email.js';
import type { Preset } from './presets.js';

/** IMAP connection settings. Implicit TLS on 993 only (no STARTTLS/143). */
export interface ImapSettings {
  host: string;
  port: 993;
  username: string;
}

/** Settings from a preset; null when the preset has a per-mailbox host (imap: null). */
export function settingsFromPreset(preset: Preset, email: ParsedEmail): ImapSettings | null {
  if (preset.imap === null) return null;
  return { host: preset.imap.host, port: 993, username: email.address };
}

/** Validates a host typed by the user. Throws DiscoveryInputError with a user-facing message. */
export function validateManualHost(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new DiscoveryInputError('IMAP host is empty');
  if (/[:/]/.test(trimmed)) {
    throw new DiscoveryInputError(
      'Enter the host name only (e.g. imap.example.com); port 993 is used',
    );
  }
  const host = hostFromUserInput(trimmed);
  if (host === null) {
    throw new DiscoveryInputError(
      'IMAP host is not a valid host name (IP addresses and localhost are not accepted)',
    );
  }
  return host;
}

/** Validates a username typed by the user; empty means the full email address. */
export function validateManualUsername(input: string | undefined, email: ParsedEmail): string {
  const trimmed = (input ?? '').trim();
  if (trimmed.length === 0) return email.address;
  if (trimmed.length > 254) throw new DiscoveryInputError('Username is too long');
  if (hasUnsafeChars(trimmed))
    throw new DiscoveryInputError('Username contains invalid characters');
  return trimmed;
}

/** Settings entered manually (or a host typed for a per-mailbox-host preset). */
export function manualSettings(
  input: { host: string; username?: string },
  email: ParsedEmail,
): ImapSettings {
  return {
    host: validateManualHost(input.host),
    port: 993,
    username: validateManualUsername(input.username, email),
  };
}
