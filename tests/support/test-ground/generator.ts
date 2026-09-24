import { createHash } from 'node:crypto';
import MailComposer, {
  type MailComposerAttachment,
  type MailComposerOptions,
} from 'nodemailer/lib/mail-composer';
import {
  ATTACHMENT_NAME_TEMPLATES,
  BODY_SENTENCES,
  SENDERS,
  SUBJECT_TEMPLATES,
} from './content.js';
import { buildManifest, type Manifest, type MessageFacts, type SeedFlag } from './manifest.js';
import { createPrng, subPrng, type Prng } from './prng.js';

// Deterministic synthetic mail for the mm-test folder (M1b-3). Same bytes and facts on every
// run, on every machine: all randomness comes from SEED, and nodemailer's own random or
// time-based parts (boundary, Message-ID, Date) are set explicitly.
//
// ANY change to the output or the facts (pools, sizes, flags, dates, the nodemailer version)
// must bump SEED_VERSION and add a PINNED_DIGESTS entry in tests/unit/test-ground-generator.test.ts.
// The seed id (X-MM-Test-Seed) contains the version, so seeding then refuses the old messages
// in mm-test until `npm run test:unseed` + `npm run test:seed` (M1b-3b).
//
// Never put a real address or domain here: this repo is public (reserved domains only).

export const SEED = 20260921;
export const SEED_VERSION = 1;
export const MESSAGE_COUNT = 150;
export const TEST_RECIPIENT = 'mm-test@mm-test.invalid';
export const SEED_HEADER = 'X-MM-Test-Seed';

export interface SeededMessage {
  facts: MessageFacts;
  raw: Buffer;
}

export interface TestGround {
  version: number;
  messages: SeededMessage[];
  manifest: Manifest;
}

const KIB = 1024;
const MIB = 1024 * KIB;
const DAY_MS = 86_400_000;
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] as const;
// 2026 only up to Jun 30 (day 180 of the year).
const LAST_DAY_2026 = 180;
const DATE_OFFSET_EVERY = 25;
const MIN_SIZE = 1024;
const TINY_MAX = 1100;
const MAX_SIZE = 4_900_000;
// Headers + body before the filler, for sizing binary attachments; the filler absorbs the rest.
const BASE_OVERHEAD = 2 * KIB;
const SIZE_PASSES = 4;
const FILLER_LINE = 64;

type SizeClass = 'tiny' | 'small' | 'medium' | 'large' | 'huge';
type AttachmentKind = 'txt' | 'csv' | 'bin';
type SenderKind = 'spam' | 'look-alike' | 'other';

interface Slot {
  sizeClass: SizeClass;
  target: number;
  attachments: AttachmentKind[];
  /** Share of the binary budget per attachment (sums to 1). */
  split: number[];
}

interface Spec extends Slot {
  index: number;
  seedId: string;
  sender: { name: string; address: string };
  subject: string;
  internalDate: Date;
  sentDate: Date;
  dateOffsetDays: number;
  flags: SeedFlag[];
  html: boolean;
  attachmentNames: string[];
}

function evenly(count: number, from: number, to: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    Math.round(count === 1 ? from : from + (i * (to - from)) / (count - 1)),
  );
}

function repeat<T>(item: T, count: number): T[] {
  return Array.from({ length: count }, () => item);
}

/** Size classes with fixed, evenly spaced targets: the total is a design constant (~26.7 MiB). */
function sizeSlots(): Slot[] {
  const tiny: Slot = { sizeClass: 'tiny', target: 1030, attachments: [], split: [] };
  const small = evenly(101, 1.5 * KIB, 30 * KIB).map((target, i): Slot => {
    // 31 of the 101 carry one small text attachment.
    const kind: AttachmentKind | null = [0, 3, 6].includes(i % 10)
      ? i % 20 < 10
        ? 'txt'
        : 'csv'
      : null;
    return {
      sizeClass: 'small',
      target,
      attachments: kind === null ? [] : [kind],
      split: kind === null ? [] : [1],
    };
  });
  const medium = evenly(38, 40 * KIB, 400 * KIB).map((target, i): Slot =>
    // The 4 largest mediums carry two attachments.
    i >= 34
      ? { sizeClass: 'medium', target, attachments: ['bin', 'bin'], split: [0.7, 0.3] }
      : { sizeClass: 'medium', target, attachments: ['bin'], split: [1] },
  );
  const large = evenly(8, 0.8 * MIB, 1.5 * MIB).map((target): Slot => ({
    sizeClass: 'large',
    target,
    attachments: ['bin'],
    split: [1],
  }));
  const huge = [Math.round(3.2 * MIB), 4_850_000].map((target): Slot => ({
    sizeClass: 'huge',
    target,
    attachments: ['bin', 'bin'],
    split: [0.7, 0.3],
  }));
  return [tiny, ...small, ...medium, ...large, ...huge];
}

function domainOf(address: string): string {
  return (address.split('@')[1] ?? '').toLowerCase();
}

function fill(template: string, n: number, year: number): string {
  return template.replaceAll('{n}', String(n)).replaceAll('{year}', String(year));
}

function daysInYear(year: number): number {
  return year === 2026 ? LAST_DAY_2026 + 1 : year % 4 === 0 ? 366 : 365;
}

/** Phase A: every message's spec from one stream, in index order. No content bytes here. */
function planSpecs(): Spec[] {
  const prng = createPrng(SEED);
  const slots = prng.shuffle(sizeSlots());
  const years = prng.shuffle(
    Array.from({ length: MESSAGE_COUNT }, (_, i) => YEARS[i % YEARS.length] ?? 2019),
  );
  const flagSets = prng.shuffle<SeedFlag[]>([
    ...repeat<SeedFlag[]>([], 50),
    ...repeat<SeedFlag[]>(['\\Seen'], 60),
    ...repeat<SeedFlag[]>(['\\Flagged'], 20),
    ...repeat<SeedFlag[]>(['\\Flagged', '\\Seen'], 20),
  ]);
  const senderKinds = prng.shuffle<SenderKind>([
    ...repeat<SenderKind>('spam', 12),
    ...repeat<SenderKind>('look-alike', 4),
    ...repeat<SenderKind>('other', MESSAGE_COUNT - 16),
  ]);
  const senderPools: Record<SenderKind, typeof SENDERS> = {
    spam: SENDERS.filter((s) => domainOf(s.address) === 'spam.test'),
    'look-alike': SENDERS.filter((s) => domainOf(s.address) === 'spam.test.evil.test'),
    other: SENDERS.filter((s) => !domainOf(s.address).startsWith('spam.test')),
  };
  const namesByKind = (kind: AttachmentKind): string[] =>
    ATTACHMENT_NAME_TEMPLATES.filter((t) => t.endsWith(`.${kind}`));

  return slots.map((slot, i): Spec => {
    const index = i + 1;
    const year = years[i] ?? 2019;
    const day = prng.int(0, daysInYear(year) - 1);
    const second = prng.int(0, 86_399);
    const internalDate = new Date(Date.UTC(year, 0, 1) + day * DAY_MS + second * 1000);
    const dateOffsetDays = index % DATE_OFFSET_EVERY === 0 ? prng.int(1, 3) : 0;
    const kind = senderKinds[i] ?? 'other';
    return {
      ...slot,
      index,
      seedId: `v${SEED_VERSION}-${String(index).padStart(3, '0')}`,
      sender: prng.pick(senderPools[kind]),
      subject: fill(prng.pick(SUBJECT_TEMPLATES), prng.int(1, 999), year),
      internalDate,
      sentDate: new Date(internalDate.getTime() - dateOffsetDays * DAY_MS),
      dateOffsetDays,
      flags: flagSets[i] ?? [],
      html: prng.chance(0.3),
      attachmentNames: slot.attachments.map((k) =>
        fill(prng.pick(namesByKind(k)), prng.int(1, 99), year),
      ),
    };
  });
}

function textOfLength(prng: Prng, minChars: number): string {
  const parts: string[] = [];
  let length = 0;
  while (length < minChars) {
    const sentence = prng.pick(BODY_SENTENCES);
    parts.push(sentence);
    length += sentence.length + 1;
  }
  return parts.join('\n');
}

function csvOfLength(prng: Prng, minChars: number): string {
  const rows = ['Položka;Suma;Poznámka'];
  let length = rows[0]?.length ?? 0;
  for (let row = 1; length < minChars; row++) {
    const line = `${row};${prng.int(1, 9999)},${prng.int(10, 99)} €;${prng.pick(BODY_SENTENCES)}`;
    rows.push(line);
    length += line.length + 1;
  }
  return rows.join('\n');
}

const CONTENT_TYPES: Record<AttachmentKind, string> = {
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  bin: 'application/octet-stream',
};

/** Phase B content: only from the message's own sub-stream. */
function buildAttachments(spec: Spec, prng: Prng): MailComposerAttachment[] {
  // base64 with 76-char lines + CRLF: 57 raw bytes → 78 bytes on the wire.
  const binaryBudget = Math.max(0, Math.floor(((spec.target - BASE_OVERHEAD) * 57) / 78));
  return spec.attachments.map((kind, i): MailComposerAttachment => {
    const filename = spec.attachmentNames[i];
    if (filename === undefined)
      throw new Error(`test ground: ${spec.seedId} has no name for attachment ${i}`);
    const contentType = CONTENT_TYPES[kind];
    if (kind === 'bin') {
      const share = spec.split[i] ?? 1;
      return { filename, contentType, content: prng.bytes(Math.floor(binaryBudget * share)) };
    }
    const size = prng.int(300, 2000);
    const content = kind === 'txt' ? textOfLength(prng, size) : csvOfLength(prng, size);
    return { filename, contentType, content };
  });
}

function fillerText(chars: number): string {
  const lines: string[] = [];
  for (let left = chars; left > 0; left -= FILLER_LINE + 1) {
    lines.push('.'.repeat(Math.min(FILLER_LINE, left)));
  }
  return lines.join('\n');
}

function compose(
  spec: Spec,
  sentences: string[],
  attachments: MailComposerAttachment[],
  filler: number,
): Promise<Buffer> {
  const body = sentences.join(' ');
  const options: MailComposerOptions = {
    from: { name: spec.sender.name, address: spec.sender.address },
    to: TEST_RECIPIENT,
    subject: spec.subject,
    text: filler > 0 ? `${body}\n\n${fillerText(filler)}` : body,
    attachments,
    // A Date object: a string would be copied into the header verbatim (not RFC 5322).
    date: spec.sentDate,
    messageId: `<${spec.seedId}@mm-test.invalid>`,
    headers: { [SEED_HEADER]: spec.seedId },
    // nodemailer would rewrite the name as X-Mm-Test-Seed.
    normalizeHeaderKey: (key) =>
      key.toLowerCase() === SEED_HEADER.toLowerCase() ? SEED_HEADER : key,
    // Fixed boundary instead of crypto.randomBytes.
    baseBoundary: `mmtest${SEED_VERSION}x${spec.index}`,
    newline: '\r\n',
    // Q-encoded header words (readable, and simple to decode in tests).
    textEncoding: 'Q',
    // Content only ever comes from memory: no URL fetch, no file read.
    disableUrlAccess: true,
    disableFileAccess: true,
  };
  if (spec.html) options.html = `<p>${body}</p>`;
  return new MailComposer(options).compile().build();
}

async function buildMessage(spec: Spec): Promise<SeededMessage> {
  const prng = subPrng(SEED, spec.index);
  const sentences = Array.from({ length: spec.sizeClass === 'tiny' ? 1 : prng.int(1, 3) }, () =>
    prng.pick(BODY_SENTENCES),
  );
  const attachments = buildAttachments(spec, prng);

  // Compose → measure → adjust the text filler (QP soft breaks make growth not quite 1:1).
  let filler = 0;
  let raw = await compose(spec, sentences, attachments, filler);
  for (let pass = 0; pass < SIZE_PASSES; pass++) {
    const next = Math.max(0, filler + spec.target - raw.length);
    if (next === filler) break;
    filler = next;
    raw = await compose(spec, sentences, attachments, filler);
  }

  if (raw.length < MIN_SIZE || raw.length > MAX_SIZE) {
    throw new Error(`test ground: ${spec.seedId} is ${raw.length} bytes, outside the size range`);
  }
  if (spec.sizeClass === 'tiny' && raw.length >= TINY_MAX) {
    throw new Error(`test ground: tiny message ${spec.seedId} is ${raw.length} bytes`);
  }

  const facts: MessageFacts = {
    seedId: spec.seedId,
    index: spec.index,
    messageId: `<${spec.seedId}@mm-test.invalid>`,
    from: {
      name: spec.sender.name,
      address: spec.sender.address,
      domain: domainOf(spec.sender.address),
    },
    to: TEST_RECIPIENT,
    subject: spec.subject,
    sentDate: spec.sentDate.toISOString(),
    internalDate: spec.internalDate.toISOString(),
    dateOffsetDays: spec.dateOffsetDays,
    size: raw.length,
    flags: [...spec.flags].sort(),
    attachments: attachments.map((a) => ({
      filename: typeof a.filename === 'string' ? a.filename : '',
      contentType: a.contentType ?? '',
      bytes:
        typeof a.content === 'string'
          ? Buffer.byteLength(a.content, 'utf8')
          : Buffer.isBuffer(a.content)
            ? a.content.length
            : 0,
    })),
  };
  return { facts, raw };
}

/** Builds all messages in index order (sequentially: flat memory, obvious order). */
export async function buildTestGround(): Promise<TestGround> {
  const messages: SeededMessage[] = [];
  for (const spec of planSpecs()) messages.push(await buildMessage(spec));
  return {
    version: SEED_VERSION,
    messages,
    manifest: buildManifest(
      SEED_VERSION,
      messages.map((m) => m.facts),
    ),
  };
}

/** Facts in a fixed field order, so the digest can't depend on object key order. */
function canonicalFacts(f: MessageFacts): string {
  return JSON.stringify([
    f.seedId,
    f.index,
    f.messageId,
    [f.from.name, f.from.address, f.from.domain],
    f.to,
    f.subject,
    f.sentDate,
    f.internalDate,
    f.dateOffsetDays,
    f.size,
    f.flags,
    f.attachments.map((a) => [a.filename, a.contentType, a.bytes]),
  ]);
}

/** sha256 hex over, per message in index order: sha256(raw) + sha256(canonical facts). */
export function groundDigest(messages: readonly SeededMessage[]): string {
  const outer = createHash('sha256');
  for (const m of messages) {
    outer.update(createHash('sha256').update(m.raw).digest());
    outer.update(createHash('sha256').update(canonicalFacts(m.facts), 'utf8').digest());
  }
  return outer.digest('hex');
}
