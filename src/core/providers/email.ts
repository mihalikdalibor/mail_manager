import { domainToASCII, domainToUnicode } from 'node:url';
import { z } from 'zod';

/** Invalid user input for discovery (email address, manual host/username). Message names the problem only. */
export class DiscoveryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryInputError';
  }
}

export interface ParsedEmail {
  /** Local part as typed + ASCII domain; what lookups and usernames use. */
  address: string;
  localPart: string;
  /** Lowercase ASCII (punycode) domain, no trailing dot. */
  domain: string;
  /** Unicode form of `domain`, for display — exactly the domain that is looked up. */
  displayDomain: string;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isStrictHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL.test(l))) return false;
  // A numeric last label (decimal, hex `0x1`, octal `017`) means an IPv4 literal in some
  // form — `0x7f.0x1` or `127.0.0.0x1` resolve to 127.0.0.1 — never a host name.
  if (/^(0x[0-9a-f]*|\d+)$/i.test(labels[labels.length - 1] ?? '')) return false;
  // Belt and braces: the WHATWG URL parser rewrites anything it treats as an IP address.
  try {
    return new URL(`https://${host}`).hostname === host;
  } catch {
    return false;
  }
}

/**
 * Strict DNS hostname: LDH labels of 1–63 chars, ≤ 253 total, at least two labels,
 * TLD not all digits. Rejects IP literals, `localhost`, ports, paths and schemes.
 * z.hostname() is not used: it accepts `1.2.3.4` and `localhost`.
 */
export const hostnameSchema = z.string().refine(isStrictHostname, 'is not a valid host name');

/**
 * Normalises an untrusted host (DNS answer, XML value, user input): lowercase,
 * one trailing dot stripped, then the strict check. Returns null when invalid.
 */
export function normalizeHost(untrusted: string): string | null {
  const host = untrusted.toLowerCase().replace(/\.$/, '');
  return isStrictHostname(host) ? host : null;
}

const DOMAIN_INPUT = /^[a-z0-9.\-\u0080-\uffff]+$/i;
// C0/C1 controls plus invisible and bidi-override characters (zero-width, soft hyphen,
// RLO/LRO, isolates, BOM): they could make printed text look different from what is used.
const UNSAFE_TEXT =
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
  /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/** True when the text contains control, invisible or bidi-override characters. */
export function hasUnsafeChars(text: string): boolean {
  return UNSAFE_TEXT.test(text);
}

/**
 * Host typed by a user or taken from an email address: letters/digits/dot/hyphen/IDN only
 * (checked BEFORE domainToASCII, which would silently truncate `evil.com/x` or decode
 * `%41.com`), no invisible characters, then IDN → ASCII and the strict check.
 */
export function hostFromUserInput(input: string): string | null {
  if (!DOMAIN_INPUT.test(input) || hasUnsafeChars(input)) return null;
  return normalizeHost(domainToASCII(input.toLowerCase().replace(/\.$/, '')));
}

export function parseEmail(input: string): ParsedEmail {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new DiscoveryInputError('Email address is empty');
  if (trimmed.length > 254) throw new DiscoveryInputError('Email address is too long');
  const at = trimmed.lastIndexOf('@');
  if (at === -1) throw new DiscoveryInputError('Email address must contain "@"');
  const localPart = trimmed.slice(0, at);
  const rawDomain = trimmed.slice(at + 1);
  if (localPart.length === 0) throw new DiscoveryInputError('Email address has no name before "@"');
  if (hasUnsafeChars(localPart) || /\s/.test(localPart)) {
    throw new DiscoveryInputError('Email address contains invalid characters');
  }
  if (rawDomain.length === 0)
    throw new DiscoveryInputError('Email address has no domain after "@"');
  if (!DOMAIN_INPUT.test(rawDomain) || hasUnsafeChars(rawDomain)) {
    throw new DiscoveryInputError('Email domain contains invalid characters');
  }
  const domain = hostFromUserInput(rawDomain);
  if (domain === null) throw new DiscoveryInputError('Email domain is not a valid domain name');
  // Derived from the ASCII domain, not the raw input: characters that IDN conversion drops
  // or maps (variation selectors, fullwidth dots) can't make the display differ from the lookup.
  // Typed as ASCII (incl. `xn--…` punycode) → shown as ASCII, so a look-alike Unicode name
  // (e.g. Cyrillic "аррӏе.com") never appears for something the user didn't type.
  const displayDomain = /^[\x21-\x7e]+$/.test(rawDomain)
    ? domain
    : domainToUnicode(domain) || domain;
  return { address: `${localPart}@${domain}`, localPart, domain, displayDomain };
}
