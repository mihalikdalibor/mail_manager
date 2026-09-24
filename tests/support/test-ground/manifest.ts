// Known facts about every synthetic test message, and totals computed from them. Tests compare
// server results (count, sizes, internal dates, flags, search hits) against this manifest.

export interface AttachmentFacts {
  filename: string;
  contentType: string;
  /** Decoded size of the attachment content. */
  bytes: number;
}

export type SeedFlag = '\\Seen' | '\\Flagged';

export interface MessageFacts {
  /** `v<SEED_VERSION>-<NNN>`: the X-MM-Test-Seed header value. */
  seedId: string;
  /** 1..MESSAGE_COUNT */
  index: number;
  /** With angle brackets, e.g. `<v1-001@mm-test.invalid>`. */
  messageId: string;
  /** `domain` is lowercase. */
  from: { name: string; address: string; domain: string };
  to: string;
  /** Unicode (NFC), as the user would see it. */
  subject: string;
  /** ISO; the instant in the Date header. */
  sentDate: string;
  /** ISO, whole seconds, UTC; the IMAP INTERNALDATE set on APPEND. */
  internalDate: string;
  /** 0, or 1..3 when the Date header is that many days earlier than the internal date. */
  dateOffsetDays: number;
  /** Exact size of the raw message in bytes (= the server's RFC822.SIZE). */
  size: number;
  /** Sorted. */
  flags: SeedFlag[];
  attachments: AttachmentFacts[];
}

export interface Manifest {
  version: number;
  count: number;
  totalBytes: number;
  /** By the UTC year of the internal date. */
  byYear: Record<string, number>;
  byDomain: Record<string, number>;
  seen: number;
  flagged: number;
  withAttachments: number;
  dateOffset: number;
  messages: MessageFacts[];
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function buildManifest(version: number, facts: MessageFacts[]): Manifest {
  const byYear: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  let totalBytes = 0;
  let seen = 0;
  let flagged = 0;
  let withAttachments = 0;
  let dateOffset = 0;

  for (const f of facts) {
    totalBytes += f.size;
    increment(byYear, String(new Date(f.internalDate).getUTCFullYear()));
    increment(byDomain, f.from.domain);
    if (f.flags.includes('\\Seen')) seen++;
    if (f.flags.includes('\\Flagged')) flagged++;
    if (f.attachments.length > 0) withAttachments++;
    if (f.dateOffsetDays > 0) dateOffset++;
  }

  return {
    version,
    count: facts.length,
    totalBytes,
    byYear,
    byDomain,
    seen,
    flagged,
    withAttachments,
    dateOffset,
    messages: facts,
  };
}
