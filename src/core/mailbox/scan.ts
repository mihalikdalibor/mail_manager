import type { FetchedMessage, ImapSession, StatsQuery } from '../imap/session.js';
import { count } from './guards.js';

// One read-only pass over a folder (M2a's size fallback, M2c's stats): the folder is EXAMINEd
// (read-only lock) and fetched in sequence ranges of SIZE_BATCH, one range after another. Each
// message goes to the callback as it streams in; nothing here keeps a message or a batch, so
// memory stays flat on any folder size. The query never asks for a body or flags, so `\Seen` is
// never set. Sequence numbers can shift when another client expunges during the scan: the server
// may then answer a range with NO (e.g. Dovecot's EXPUNGEISSUED), which ends the scan with that
// error. A range can also end early without an error (imapflow gives up on a throttled FETCH
// after its retries and yields nothing): callers compare what they counted with `exists`.

export const SIZE_BATCH = 5000;

/** One fetched sequence range, both ends inclusive. */
export interface ScanRange {
  from: number;
  to: number;
}

export interface ScanOptions {
  /** Messages per FETCH; default SIZE_BATCH. */
  batchSize?: number;
  /** After each range: messages streamed so far, of the folder's message count. */
  onProgress?: (done: number, total: number) => void;
}

function scanRanges(exists: number, batchSize: number): ScanRange[] {
  const ranges: ScanRange[] = [];
  if (!Number.isSafeInteger(exists) || exists <= 0) return ranges;
  const step = Number.isSafeInteger(batchSize) && batchSize > 0 ? batchSize : SIZE_BATCH;
  for (let a = 1; a <= exists; a += step) {
    ranges.push({ from: a, to: Math.min(a + step - 1, exists) });
  }
  return ranges;
}

/** Sequence ranges `1:5000`, `5001:10000`, … up to `exists` (none for an empty folder). */
export function sizeRanges(exists: number, batchSize: number = SIZE_BATCH): string[] {
  return scanRanges(exists, batchSize).map((r) => `${r.from}:${r.to}`);
}

/**
 * Streams every message of `path` to `onMessage`, range by range, under the read-only lock
 * (released in every case). An error from FETCH or from `onMessage` propagates unchanged; a
 * throwing `onProgress` is ignored. Returns the folder's message count and how many were read.
 */
export async function scanFolder(
  session: Pick<ImapSession, 'client'>,
  path: string,
  query: { size: true } | StatsQuery,
  onMessage: (msg: FetchedMessage, range: ScanRange) => void,
  opts: ScanOptions = {},
): Promise<{ exists: number; read: number }> {
  const { client } = session;
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const mailbox = client.mailbox;
    const exists = mailbox === false ? 0 : (count(mailbox.exists) ?? 0);
    let read = 0;
    for (const range of scanRanges(exists, opts.batchSize ?? SIZE_BATCH)) {
      for await (const msg of client.fetch(`${range.from}:${range.to}`, query)) {
        onMessage(msg, range);
        read++;
      }
      try {
        opts.onProgress?.(read, exists);
      } catch {
        // Progress output never decides whether a folder could be read.
      }
    }
    return { exists, read };
  } finally {
    lock.release();
  }
}
