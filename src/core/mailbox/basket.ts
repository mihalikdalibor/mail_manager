// The basket (M2b): mails the user marked while browsing, across folders. A mark is folder +
// UIDVALIDITY + UID (+ size for the running total), never the mail's content. Immutable: every
// change returns a new basket. M4 turns it into a delete/move plan. In memory only.
//
// Gmail: the same mail marked in a label folder and in All Mail is two marks here (and counts
// twice in the totals); M4 de-duplicates by X-GM-MSGID before acting.

export interface MarkKey {
  path: string;
  uidValidity: string;
  uid: number;
}

export interface Mark extends MarkKey {
  bytes: number | null;
}

export interface Basket {
  readonly marks: ReadonlyMap<string, Mark>;
}

export interface BasketTotals {
  count: number;
  /** Sum of the known sizes. */
  bytes: number;
  /** Marks whose size the server didn't report. */
  unknownSizes: number;
}

export const emptyBasket: Basket = { marks: new Map() };

function keyOf(k: MarkKey): string {
  return `${k.path}\0${k.uidValidity}\0${String(k.uid)}`;
}

function copyMark(m: Mark): Mark {
  return { path: m.path, uidValidity: m.uidValidity, uid: m.uid, bytes: m.bytes };
}

export function isMarked(basket: Basket, key: MarkKey): boolean {
  return basket.marks.has(keyOf(key));
}

export function toggleMark(basket: Basket, mark: Mark): Basket {
  const marks = new Map(basket.marks);
  const key = keyOf(mark);
  if (marks.has(key)) marks.delete(key);
  else marks.set(key, copyMark(mark));
  return { marks };
}

/** Marks (`on`) or unmarks every one of `marks`. */
export function setMarks(basket: Basket, marks: readonly Mark[], on: boolean): Basket {
  const next = new Map(basket.marks);
  for (const m of marks) {
    const key = keyOf(m);
    if (on) {
      if (!next.has(key)) next.set(key, copyMark(m));
    } else {
      next.delete(key);
    }
  }
  return { marks: next };
}

/**
 * Drops the marks of `path` taken under another UIDVALIDITY (their UIDs may now name other
 * mails) and reports how many.
 */
export function reconcileFolder(
  basket: Basket,
  path: string,
  uidValidity: string,
): { basket: Basket; dropped: number } {
  let dropped = 0;
  const marks = new Map<string, Mark>();
  for (const [key, m] of basket.marks) {
    if (m.path === path && m.uidValidity !== uidValidity) dropped++;
    else marks.set(key, m);
  }
  return dropped === 0 ? { basket, dropped } : { basket: { marks }, dropped };
}

export function basketTotals(basket: Basket): BasketTotals {
  let bytes = 0;
  let unknownSizes = 0;
  for (const m of basket.marks.values()) {
    if (m.bytes === null) unknownSizes++;
    else bytes += m.bytes;
  }
  return { count: basket.marks.size, bytes, unknownSizes };
}

/** Every mark, in the order they were marked. */
export function marksOf(basket: Basket): Mark[] {
  return [...basket.marks.values()].map(copyMark);
}
