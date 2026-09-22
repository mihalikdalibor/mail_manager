import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { hasUnsafeChars, normalizeHost, type ParsedEmail } from './email.js';
import type { ImapSettings } from './settings.js';

export type AutoconfigResult =
  | { ok: true; settings: ImapSettings }
  | { ok: false; reason: 'no-imap' | 'insecure-only' | 'invalid' };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'emailProvider' || name === 'incomingServer',
});

// Only the fields we read; anything else in the document is ignored.
const serverSchema = z.looseObject({
  type: z.string().optional(),
  hostname: z.unknown().optional(),
  port: z.unknown().optional(),
  socketType: z.unknown().optional(),
  username: z.unknown().optional(),
});
const documentSchema = z.looseObject({
  clientConfig: z.looseObject({
    emailProvider: z.array(z.looseObject({ incomingServer: z.array(z.unknown()).optional() })),
  }),
});

function substitute(template: string, email: ParsedEmail): string | null {
  const values: Record<string, string> = {
    EMAILADDRESS: email.address,
    EMAILLOCALPART: email.localPart,
    EMAILDOMAIN: email.domain,
  };
  // Unknown placeholders (e.g. %REALNAME%) are checked on the template, and substitution is a
  // single pass, so a local part that itself contains `%EMAILDOMAIN%` is never expanded again.
  // Case-insensitive: `%emailaddress%` is not a placeholder we fill, so it must not survive.
  // Object.hasOwn, not `in`: `%constructor%` or `%toString%` must not count as known.
  if ([...template.matchAll(/%([A-Za-z]+)%/g)].some((m) => !Object.hasOwn(values, m[1] ?? ''))) {
    return null;
  }
  return template.replace(
    /%(EMAILADDRESS|EMAILLOCALPART|EMAILDOMAIN)%/g,
    (_, key: string) => values[key] ?? '',
  );
}

/**
 * A username template from the server must be one printable-ASCII token (no spaces, no
 * look-alike or blank Unicode). Placeholders are filled in afterwards with the user's own,
 * already validated address, so real templates like `%EMAILADDRESS%`, `recent:%EMAILADDRESS%`
 * or `domain\user` still work while free text from the server can't reach the output.
 */
const USERNAME_TEMPLATE = /^[!-~]+$/;

/** Final username (after substitution): bounded length, no whitespace or unsafe characters. */
function isSafeUsername(value: string): boolean {
  return value.length > 0 && value.length <= 254 && !/\s/.test(value) && !hasUnsafeChars(value);
}

/**
 * Parses a Thunderbird autoconfig / ISPDB document (config-v1.1.xml) and returns the
 * first IMAP server with implicit TLS (socketType SSL) on port 993.
 * The input is untrusted: validated before parsing, and every value checked.
 */
export function parseAutoconfigXml(xml: string, email: ParsedEmail): AutoconfigResult {
  let parsed: unknown;
  try {
    // The parser accepts malformed XML silently, so validate first.
    if (XMLValidator.validate(xml) !== true) return { ok: false, reason: 'invalid' };
    parsed = parser.parse(xml);
  } catch {
    // e.g. reserved tag names such as __proto__ are rejected with an exception.
    return { ok: false, reason: 'invalid' };
  }
  const doc = documentSchema.safeParse(parsed);
  if (!doc.success) return { ok: false, reason: 'invalid' };

  let sawImap = false;
  let sawBrokenSecure = false;
  for (const provider of doc.data.clientConfig.emailProvider) {
    for (const raw of provider.incomingServer ?? []) {
      const server = serverSchema.safeParse(raw);
      if (!server.success || server.data.type !== 'imap') continue;
      sawImap = true;
      const { hostname, port, socketType, username } = server.data;
      if (typeof socketType !== 'string' || socketType !== 'SSL') continue;
      if (typeof port !== 'string' || !/^\d+$/.test(port) || Number(port) !== 993) continue;
      // From here on the entry is implicit TLS on 993; a bad value makes it invalid, not insecure.
      const hostValue = typeof hostname === 'string' ? substitute(hostname.trim(), email) : null;
      const host = hostValue === null ? null : normalizeHost(hostValue);
      const userValue =
        username === undefined
          ? email.address
          : typeof username === 'string' && USERNAME_TEMPLATE.test(username.trim())
            ? substitute(username.trim(), email)
            : null;
      if (host === null || userValue === null || !isSafeUsername(userValue)) {
        sawBrokenSecure = true;
        continue;
      }
      return { ok: true, settings: { host, port: 993, username: userValue } };
    }
  }
  if (sawBrokenSecure) return { ok: false, reason: 'invalid' };
  return { ok: false, reason: sawImap ? 'insecure-only' : 'no-imap' };
}
