import dns from 'node:dns';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  ATTACHMENT_NAME_TEMPLATES,
  BODY_SENTENCES,
  SENDERS,
  SUBJECT_TEMPLATES,
} from '../support/test-ground/content.js';
import {
  MESSAGE_COUNT,
  SEED,
  SEED_HEADER,
  SEED_VERSION,
  TEST_RECIPIENT,
  buildTestGround,
  groundDigest,
  type SeededMessage,
  type TestGround,
} from '../support/test-ground/generator.js';
import type { MessageFacts } from '../support/test-ground/manifest.js';
import { createPrng, subPrng } from '../support/test-ground/prng.js';

// One entry per SEED_VERSION. Never edit an existing entry: a changed digest means the
// generator output changed, which needs a new SEED_VERSION (the live test ground is keyed on it).
const PINNED_DIGESTS: Record<number, string> = {
  1: '4e691928b9d060d431e6806b64363f27ec16c1f946c5d89b7042736fb931481b',
};

const MIB = 1024 * 1024;
const DAY_MS = 86_400_000;
const SLOVAK_LETTERS = 'áäčďéíľĺňóôŕšťúýž';
const QP_SLOVAK =
  /=C3=A1|=C3=A4|=C4=8D|=C4=8F|=C3=A9|=C3=AD|=C4=BE|=C4=BA|=C5=88|=C3=B3|=C3=B4|=C5=95|=C5=A1|=C5=A5|=C3=BA|=C3=BD|=C5=BE/i;
const RESERVED_DOMAIN = [
  /^(?:[a-z0-9-]+\.)*(?:test|example|invalid)$/,
  /^(?:[a-z0-9-]+\.)*example\.(?:com|net|org)$/,
];

// ---------- small raw-message helpers (RFC 5322 / 2047 / 2231, just enough for the seed) ----------

function headerBlock(raw: Buffer): string {
  const end = raw.indexOf('\r\n\r\n');
  return raw.subarray(0, end === -1 ? raw.length : end).toString('latin1');
}

function unfold(text: string): string {
  return text.replace(/\r\n(?=[ \t])/g, '');
}

/** Unfolded header lines of a header block. */
function headerLines(block: string): string[] {
  return unfold(block).split('\r\n');
}

function headerValues(block: string, name: string): string[] {
  const lower = name.toLowerCase();
  const values: string[] = [];
  for (const line of headerLines(block)) {
    const colon = line.indexOf(':');
    if (colon > 0 && line.slice(0, colon).toLowerCase() === lower) {
      values.push(line.slice(colon + 1).trim());
    }
  }
  return values;
}

function singleHeader(block: string, name: string): string {
  const values = headerValues(block, name);
  expect(values, `exactly one ${name} header`).toHaveLength(1);
  return values[0] ?? '';
}

function qBytes(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const hex = text.slice(i + 1, i + 3);
    if (ch === '_') {
      bytes.push(0x20);
    } else if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  return Buffer.from(bytes);
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Decodes RFC 2047 words. Each word must be valid UTF-8 on its own (RFC 2047 §5: a character
 * is never split across words), so a split character throws instead of being papered over. */
function decodeWords(value: string): string {
  const joined = value.replace(/\?=[ \t]+(?==\?)/g, '?=');
  let out = '';
  let last = 0;
  for (const m of joined.matchAll(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g)) {
    out += joined.slice(last, m.index);
    const encoding = (m[2] ?? 'Q').toUpperCase();
    const text = m[3] ?? '';
    out += strictUtf8.decode(encoding === 'B' ? Buffer.from(text, 'base64') : qBytes(text));
    last = m.index + m[0].length;
  }
  return out + joined.slice(last);
}

/** Encoded words (`=?charset?enc?…?=`) in a header block. */
function encodedWords(block: string): string[] {
  return [...unfold(block).matchAll(/=\?[^?]+\?[A-Za-z]\?[^?]*\?=/g)].map((m) => m[0]);
}

interface MimePart {
  /** Unfolded header block of the part. */
  headers: string;
  /** Body as latin1 text (still transfer-encoded). */
  body: string;
}

/** Every MIME part (containers included), split on the multipart delimiter lines. */
function mimeParts(raw: Buffer): MimePart[] {
  return raw
    .toString('latin1')
    .split(/(?:^|\r\n)--[^\r\n]*\r\n/)
    .map((segment) => {
      const end = segment.indexOf('\r\n\r\n');
      return end === -1
        ? { headers: '', body: segment }
        : { headers: unfold(segment.slice(0, end)), body: segment.slice(end + 4) };
    });
}

function partHeader(part: MimePart, name: string): string {
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im');
  return re.exec(part.headers.replace(/\r\n/g, '\n'))?.[1]?.trim() ?? '';
}

function qpDecode(body: string): Buffer {
  const text = body.replace(/=\r\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(part: MimePart): Buffer {
  const encoding = partHeader(part, 'Content-Transfer-Encoding').toLowerCase();
  if (encoding === 'base64') return Buffer.from(part.body.replace(/\r\n/g, ''), 'base64');
  if (encoding === 'quoted-printable') return qpDecode(part.body);
  return Buffer.from(part.body, 'latin1');
}

/** The decoded text/plain body (not an attachment). For a single-part message the whole
 * message is the part. */
function textBody(raw: Buffer): string {
  const part = mimeParts(raw).find(
    (p) =>
      /^text\/plain/i.test(partHeader(p, 'Content-Type')) &&
      !/^attachment/i.test(partHeader(p, 'Content-Disposition')),
  );
  expect(part, 'text/plain body part').toBeDefined();
  return part ? strictUtf8.decode(decodeBody(part)) : '';
}

function parseAddress(value: string): { name: string; address: string } {
  const m = /^(.*)<([^<>]*)>\s*$/.exec(value);
  if (!m) return { name: '', address: value.trim() };
  let name = (m[1] ?? '').trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return { name: decodeWords(name), address: (m[2] ?? '').trim() };
}

/** Unfolded `Content-Disposition: attachment...` fields of every part, in order. */
function attachmentDispositions(rawText: string): string[] {
  const fields: string[] = [];
  for (const m of rawText.matchAll(/^Content-Disposition:[ \t]*attachment\b/gim)) {
    const tail = rawText.slice(m.index, m.index + 8192);
    const end = /\r\n(?![ \t])/.exec(tail);
    fields.push(unfold(tail.slice(0, end ? end.index : tail.length)));
  }
  return fields;
}

function percentBytes(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  return Buffer.from(bytes);
}

/** Decodes the RFC 2231 `filename*N*` parameter (with a plain `filename=` fallback). */
function dispositionFilename(field: string): string | undefined {
  const parts: { index: number; bytes: Buffer }[] = [];
  const re = /;\s*filename(?:\*(\d+))?(\*)?=("(?:[^"\\]|\\.)*"|[^;]*)/gi;
  for (const m of field.matchAll(re)) {
    const index = m[1] === undefined ? 0 : Number(m[1]);
    const extended = m[2] === '*';
    let value = (m[3] ?? '').trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (extended) {
      if (index === 0) value = value.replace(/^[^']*'[^']*'/, '');
      parts.push({ index, bytes: percentBytes(value) });
    } else {
      parts.push({ index, bytes: Buffer.from(value, 'latin1') });
    }
  }
  if (parts.length === 0) return undefined;
  parts.sort((a, b) => a.index - b.index);
  return Buffer.concat(parts.map((p) => p.bytes)).toString('utf8');
}

function hasSlovakLetter(text: string): boolean {
  const lower = text.toLowerCase();
  return [...SLOVAK_LETTERS].some((letter) => lower.includes(letter));
}

function isNfc(text: string): boolean {
  return text === text.normalize('NFC');
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

function flagKey(flags: readonly string[]): string {
  return flags.join(',');
}

// ---------- tests ----------

describe('test ground generator', () => {
  let ground: TestGround;
  let facts: MessageFacts[];
  let messages: SeededMessage[];

  // Network guard for every build in this block (the determinism test builds a second time).
  let networkSpies: MockInstance[] = [];

  beforeAll(async () => {
    const networkUsed = (): never => {
      throw new Error('network used');
    };
    networkSpies = [
      vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(networkUsed),
      vi.spyOn(dns, 'lookup').mockImplementation(networkUsed),
      vi.spyOn(dns, 'resolve').mockImplementation(networkUsed),
      vi.spyOn(dns.promises, 'lookup').mockImplementation(networkUsed),
      vi.spyOn(dns.promises, 'resolve').mockImplementation(networkUsed),
      vi.spyOn(globalThis, 'fetch').mockImplementation(networkUsed),
    ];
    ground = await buildTestGround();
    messages = ground.messages;
    facts = messages.map((m) => m.facts);
  }, 30_000);

  afterAll(() => {
    try {
      for (const spy of networkSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of networkSpies) spy.mockRestore();
    }
  });

  describe('determinism', () => {
    it('builds exactly MESSAGE_COUNT (150) messages without touching the network', () => {
      expect(MESSAGE_COUNT).toBe(150);
      expect(messages).toHaveLength(MESSAGE_COUNT);
      expect(ground.version).toBe(SEED_VERSION);
    });

    it('a second build gives identical raw bytes and facts', async () => {
      const again = await buildTestGround();
      expect(again.messages).toHaveLength(messages.length);
      again.messages.forEach((m, i) => {
        const first = messages[i];
        expect(first).toBeDefined();
        if (!first) return;
        expect(m.raw.equals(first.raw), `raw of message ${i + 1} differs`).toBe(true);
        expect(m.facts).toEqual(first.facts);
      });
      expect(again.manifest).toEqual(ground.manifest);
    }, 30_000);

    it('matches the pinned digest for this SEED_VERSION', () => {
      expect(
        groundDigest(ground.messages),
        'generator output changed: bump SEED_VERSION and add a new PINNED_DIGESTS entry (never edit an existing one)',
      ).toBe(PINNED_DIGESTS[SEED_VERSION]);
    });
  });

  describe('sizes', () => {
    it('keeps every message between 1,024 and 4,900,000 bytes with size === raw.length', () => {
      for (const m of messages) {
        expect(m.facts.size).toBe(m.raw.length);
        expect(m.facts.size).toBeGreaterThanOrEqual(1024);
        expect(m.facts.size).toBeLessThanOrEqual(4_900_000);
      }
    });

    it('totals 20–28 MiB and includes a tiny (<1,100 B) and a large (>4.5 MiB) message', () => {
      const total = messages.reduce((sum, m) => sum + m.raw.length, 0);
      expect(total).toBeGreaterThanOrEqual(20 * MIB);
      expect(total).toBeLessThanOrEqual(28 * MIB);
      expect(ground.manifest.totalBytes).toBe(total);
      expect(messages.some((m) => m.raw.length < 1100)).toBe(true);
      expect(messages.some((m) => m.raw.length > 4.5 * MIB)).toBe(true);
    });
  });

  describe('dates', () => {
    it('keeps internalDate within 2019-01-01 … 2026-06-30 in whole seconds', () => {
      const min = Date.parse('2019-01-01T00:00:00Z');
      const max = Date.parse('2026-06-30T23:59:59Z');
      for (const f of facts) {
        const t = Date.parse(f.internalDate);
        expect(Number.isNaN(t), f.internalDate).toBe(false);
        expect(t).toBeGreaterThanOrEqual(min);
        expect(t).toBeLessThanOrEqual(max);
        expect(t % 1000).toBe(0);
      }
    });

    it('has at least 8 messages in every year 2019..2026', () => {
      for (let year = 2019; year <= 2026; year++) {
        const n = facts.filter((f) => new Date(f.internalDate).getUTCFullYear() === year).length;
        expect(n, `messages in ${year}`).toBeGreaterThanOrEqual(8);
      }
    });

    it('has exactly 6 messages whose Date header is 1..3 days before internalDate', () => {
      const offset = facts.filter((f) => f.dateOffsetDays !== 0);
      expect(offset).toHaveLength(6);
      for (const f of offset) {
        expect(Number.isInteger(f.dateOffsetDays)).toBe(true);
        expect(f.dateOffsetDays).toBeGreaterThanOrEqual(1);
        expect(f.dateOffsetDays).toBeLessThanOrEqual(3);
        expect(Date.parse(f.sentDate)).toBe(Date.parse(f.internalDate) - f.dateOffsetDays * DAY_MS);
      }
      for (const f of facts.filter((x) => x.dateOffsetDays === 0)) {
        expect(f.sentDate).toBe(f.internalDate);
      }
    });

    it('writes the Date header from sentDate', () => {
      for (const m of messages) {
        const expected = new Date(m.facts.sentDate).toUTCString().replace('GMT', '+0000');
        expect(singleHeader(headerBlock(m.raw), 'Date'), m.facts.seedId).toBe(expected);
      }
    });
  });

  describe('headers match the facts', () => {
    it('From, To, Subject and Message-ID decode to the facts', () => {
      for (const m of messages) {
        const block = headerBlock(m.raw);
        const from = parseAddress(singleHeader(block, 'From'));
        expect(from.address, m.facts.seedId).toBe(m.facts.from.address);
        expect(from.name, m.facts.seedId).toBe(m.facts.from.name);
        expect(parseAddress(singleHeader(block, 'To')).address).toBe(m.facts.to);
        expect(decodeWords(singleHeader(block, 'Subject')), m.facts.seedId).toBe(m.facts.subject);
        expect(singleHeader(block, 'Message-ID')).toBe(m.facts.messageId);
      }
    });

    it('has one attachment part per facts.attachments entry, file names in order', () => {
      for (const m of messages) {
        const dispositions = attachmentDispositions(m.raw.toString('latin1'));
        expect(dispositions, m.facts.seedId).toHaveLength(m.facts.attachments.length);
        expect(dispositions.map(dispositionFilename), m.facts.seedId).toEqual(
          m.facts.attachments.map((a) => a.filename),
        );
      }
    });

    it('decodes every attachment to its facts: content type and exact byte size', () => {
      for (const m of messages) {
        const parts = mimeParts(m.raw).filter((p) =>
          /^attachment/i.test(partHeader(p, 'Content-Disposition')),
        );
        expect(parts, m.facts.seedId).toHaveLength(m.facts.attachments.length);
        parts.forEach((part, i) => {
          const expected = m.facts.attachments[i];
          expect(expected, m.facts.seedId).toBeDefined();
          if (!expected) return;
          expect(
            partHeader(part, 'Content-Type').startsWith(expected.contentType),
            m.facts.seedId,
          ).toBe(true);
          expect(decodeBody(part).length, `${m.facts.seedId} ${expected.filename}`).toBe(
            expected.bytes,
          );
        });
      }
    });

    it('carries exactly one seed header whose value is facts.seedId', () => {
      const exact = new RegExp(`^${SEED_HEADER}: v${SEED_VERSION}-\\d{3}$`);
      for (const m of messages) {
        const lines = headerLines(headerBlock(m.raw));
        const seedLines = lines.filter((l) =>
          l.toLowerCase().startsWith(`${SEED_HEADER.toLowerCase()}:`),
        );
        expect(seedLines, m.facts.seedId).toHaveLength(1);
        const line = seedLines[0] ?? '';
        expect(line).toMatch(exact);
        expect(line).toBe(`${SEED_HEADER}: ${m.facts.seedId}`);
      }
    });

    it('numbers seed ids and Message-IDs by index, 1..150 in order, all unique', () => {
      facts.forEach((f, i) => {
        expect(f.index).toBe(i + 1);
        expect(f.seedId).toBe(`v${SEED_VERSION}-${String(f.index).padStart(3, '0')}`);
        expect(f.messageId).toBe(`<${f.seedId}@mm-test.invalid>`);
      });
      expect(new Set(facts.map((f) => f.messageId)).size).toBe(facts.length);
      for (const m of messages) {
        const text = headerBlock(m.raw);
        expect(text.split(m.facts.messageId).length - 1, m.facts.seedId).toBe(1);
        expect(text).not.toContain(`<${m.facts.messageId}`);
        expect(text).not.toContain(`${m.facts.messageId}>`);
        expect(singleHeader(text, 'Message-ID')).toMatch(/^<[^<>\s]+>$/);
      }
    });
  });

  describe('raw format', () => {
    it('uses CRLF line endings only', () => {
      for (const m of messages) {
        const text = m.raw.toString('latin1');
        expect(/(?<!\r)\n/.test(text), `bare LF in ${m.facts.seedId}`).toBe(false);
        expect(/\r(?!\n)/.test(text), `bare CR in ${m.facts.seedId}`).toBe(false);
      }
    });

    it('has no X-Mailer header', () => {
      for (const m of messages) {
        expect(/^x-mailer:/im.test(m.raw.toString('latin1')), m.facts.seedId).toBe(false);
      }
    });

    it('Q-encodes non-ASCII headers and RFC 2231-encodes attachment names', () => {
      for (const m of messages) {
        // Every message has a diacritic in From or Subject, so each has encoded words, all UTF-8 Q.
        const words = encodedWords(headerBlock(m.raw));
        expect(words.length, m.facts.seedId).toBeGreaterThan(0);
        for (const word of words) expect(word, m.facts.seedId).toMatch(/^=\?UTF-8\?Q\?/);
        for (const field of attachmentDispositions(m.raw.toString('latin1'))) {
          expect(field, m.facts.seedId).toMatch(/filename\*0\*=utf-8''/i);
        }
      }
    });
  });

  describe('diacritics and Unicode', () => {
    it('has Slovak letters in sender names, subjects and attachment names', () => {
      expect(facts.some((f) => hasSlovakLetter(f.from.name))).toBe(true);
      expect(facts.some((f) => hasSlovakLetter(f.subject))).toBe(true);
      expect(facts.some((f) => f.attachments.some((a) => hasSlovakLetter(a.filename)))).toBe(true);
    });

    it('covers the full Slovak letter set across names, subjects, file names and bodies', () => {
      const all = [
        ...facts.map((f) => f.from.name),
        ...facts.map((f) => f.subject),
        ...facts.flatMap((f) => f.attachments.map((a) => a.filename)),
        ...messages.map((m) => textBody(m.raw)),
      ]
        .join('\n')
        .toLowerCase();
      const missing = [...SLOVAK_LETTERS].filter((letter) => !all.includes(letter));
      expect(missing).toEqual([]);
    });

    it('has Slovak letters in every text body, QP-encoded in at least 90% of them', () => {
      // Only the text/plain part: the Q-encoded From/Subject headers must not count.
      let qpEncoded = 0;
      for (const m of messages) {
        expect(hasSlovakLetter(textBody(m.raw)), m.facts.seedId).toBe(true);
        const part = mimeParts(m.raw).find(
          (p) =>
            /^text\/plain/i.test(partHeader(p, 'Content-Type')) &&
            !/^attachment/i.test(partHeader(p, 'Content-Disposition')),
        );
        if (part && QP_SLOVAK.test(part.body.replace(/=\r\n/g, ''))) qpEncoded++;
      }
      expect(qpEncoded).toBeGreaterThanOrEqual(Math.ceil(messages.length * 0.9));
    });

    it('keeps every content pool string NFC', () => {
      const pool = [
        ...SENDERS.flatMap((s) => [s.name, s.address]),
        ...SUBJECT_TEMPLATES,
        ...BODY_SENTENCES,
        ...ATTACHMENT_NAME_TEMPLATES,
      ];
      expect(pool.length).toBeGreaterThan(0);
      expect(pool.filter((s) => !isNfc(s))).toEqual([]);
    });

    it('keeps every subject, sender name and file name in the facts NFC', () => {
      const texts = [
        ...facts.map((f) => f.subject),
        ...facts.map((f) => f.from.name),
        ...facts.flatMap((f) => f.attachments.map((a) => a.filename)),
      ];
      expect(texts.filter((s) => !isNfc(s))).toEqual([]);
    });
  });

  describe('addresses', () => {
    it('uses only reserved domains and the fixed test recipient', () => {
      expect(TEST_RECIPIENT).toBe('mm-test@mm-test.invalid');
      for (const f of facts) {
        const domain = domainOf(f.from.address);
        expect(
          RESERVED_DOMAIN.some((re) => re.test(domain)),
          `from domain ${domain}`,
        ).toBe(true);
        expect(f.from.domain).toBe(domain);
        expect(f.to).toBe(TEST_RECIPIENT);
        expect(RESERVED_DOMAIN.some((re) => re.test(domainOf(f.to)))).toBe(true);
      }
    });

    it('includes the spam.test and spam.test.evil.test senders', () => {
      expect(facts.filter((f) => f.from.domain === 'spam.test').length).toBeGreaterThanOrEqual(10);
      expect(
        facts.filter((f) => f.from.domain === 'spam.test.evil.test').length,
      ).toBeGreaterThanOrEqual(3);
    });
  });

  describe('mixes', () => {
    it('uses sorted \\Seen/\\Flagged flags with at least 5 of each combination', () => {
      const counts = new Map<string, number>();
      for (const f of facts) {
        expect([...f.flags].sort()).toEqual(f.flags);
        expect(new Set(f.flags).size).toBe(f.flags.length);
        for (const flag of f.flags) expect(['\\Seen', '\\Flagged']).toContain(flag);
        counts.set(flagKey(f.flags), (counts.get(flagKey(f.flags)) ?? 0) + 1);
      }
      for (const combo of [[], ['\\Seen'], ['\\Flagged'], ['\\Flagged', '\\Seen']]) {
        expect(
          counts.get(flagKey(combo)) ?? 0,
          `flags [${combo.join(', ')}]`,
        ).toBeGreaterThanOrEqual(5);
      }
    });

    it('mixes messages with and without attachments', () => {
      expect(facts.filter((f) => f.attachments.length > 0).length).toBeGreaterThanOrEqual(30);
      expect(facts.filter((f) => f.attachments.length === 0).length).toBeGreaterThanOrEqual(30);
      expect(facts.filter((f) => f.attachments.length === 2).length).toBeGreaterThanOrEqual(5);
    });

    it('matches the design constants documented in docs/milestones/M1-auth-accounts.md', () => {
      const count = (pred: (f: MessageFacts) => boolean): number => facts.filter(pred).length;
      expect(count((f) => f.flags.length === 0)).toBe(50);
      expect(count((f) => flagKey(f.flags) === '\\Seen')).toBe(60);
      expect(count((f) => flagKey(f.flags) === '\\Flagged')).toBe(20);
      expect(count((f) => flagKey(f.flags) === '\\Flagged,\\Seen')).toBe(20);
      expect(count((f) => f.from.domain === 'spam.test')).toBe(12);
      expect(count((f) => f.from.domain === 'spam.test.evil.test')).toBe(4);
      expect(count((f) => f.attachments.length > 0)).toBe(79);
      expect(count((f) => f.attachments.length === 2)).toBe(6);
      expect(count((f) => f.size < 1100)).toBe(1);
      for (let year = 2019; year <= 2026; year++) {
        expect(ground.manifest.byYear[String(year)] ?? 0, String(year)).toBeGreaterThanOrEqual(18);
      }
    });
  });

  describe('manifest', () => {
    it('lists exactly the generated facts', () => {
      expect(ground.manifest.version).toBe(SEED_VERSION);
      expect(ground.manifest.messages).toEqual(facts);
    });

    it('totals match sums recomputed from its messages', () => {
      const list = ground.manifest.messages;
      const byYear: Record<string, number> = {};
      const byDomain: Record<string, number> = {};
      for (const f of list) {
        const year = String(new Date(f.internalDate).getUTCFullYear());
        byYear[year] = (byYear[year] ?? 0) + 1;
        byDomain[f.from.domain] = (byDomain[f.from.domain] ?? 0) + 1;
      }
      expect(ground.manifest.count).toBe(list.length);
      expect(ground.manifest.totalBytes).toBe(list.reduce((sum, f) => sum + f.size, 0));
      expect(ground.manifest.byYear).toEqual(byYear);
      expect(ground.manifest.byDomain).toEqual(byDomain);
      expect(ground.manifest.seen).toBe(list.filter((f) => f.flags.includes('\\Seen')).length);
      expect(ground.manifest.flagged).toBe(
        list.filter((f) => f.flags.includes('\\Flagged')).length,
      );
      expect(ground.manifest.withAttachments).toBe(
        list.filter((f) => f.attachments.length > 0).length,
      );
      expect(ground.manifest.dateOffset).toBe(list.filter((f) => f.dateOffsetDays > 0).length);
    });
  });
});

describe('test ground PRNG', () => {
  it('repeats the same uint32 sequence and bytes for the same seed', () => {
    const a = createPrng(SEED);
    const b = createPrng(SEED);
    const seqA = Array.from({ length: 1000 }, () => a.uint32());
    const seqB = Array.from({ length: 1000 }, () => b.uint32());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffff_ffff);
    }
    const bytesA = a.bytes(1_000_003);
    const bytesB = b.bytes(1_000_003);
    expect(bytesA.length).toBe(1_000_003);
    expect(bytesB.length).toBe(1_000_003);
    expect(bytesA.equals(bytesB)).toBe(true);
  });

  it('gives different sequences for different seeds', () => {
    const a = createPrng(SEED);
    const b = createPrng(SEED + 1);
    const seqA = Array.from({ length: 1000 }, () => a.uint32());
    const seqB = Array.from({ length: 1000 }, () => b.uint32());
    expect(seqA).not.toEqual(seqB);
  });

  it('gives different sub-streams for different indexes', () => {
    expect(subPrng(SEED, 1).uint32()).not.toBe(subPrng(SEED, 2).uint32());
  });

  it('keeps next() in [0, 1)', () => {
    const p = createPrng(SEED);
    for (let i = 0; i < 10_000; i++) {
      const v = p.next();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });

  it('keeps int() within inclusive bounds and reaches both ends', () => {
    const p = createPrng(SEED);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      const v = p.int(-3, 7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }
    expect(seen.has(-3)).toBe(true);
    expect(seen.has(7)).toBe(true);
    expect(p.int(5, 5)).toBe(5);
  });

  it('pick() throws on an empty list', () => {
    expect(() => createPrng(SEED).pick([])).toThrow();
    expect(['only']).toContain(createPrng(SEED).pick(['only']));
  });

  it('shuffle() returns a permutation without mutating its input', () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    const copy = [...input];
    const out = createPrng(SEED).shuffle(input);
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort((x, y) => x - y)).toEqual(copy);
  });
});
