import { describe, it, expect } from 'vitest';
import {
  basketTotals,
  emptyBasket,
  isMarked,
  marksOf,
  reconcileFolder,
  setMarks,
  toggleMark,
} from '../../src/core/mailbox/basket.js';
import type { Basket, Mark } from '../../src/core/mailbox/basket.js';

// M2b-1 basket (spec): an immutable set of marked mails, identity = path + uidValidity + uid.

function mark(uid: number, over: Partial<Mark> = {}): Mark {
  return { path: 'INBOX', uidValidity: '7', uid, bytes: 100, ...over };
}

/** The basket's map as plain data, to prove a call left it untouched. */
function dump(basket: Basket): [string, Mark][] {
  return [...basket.marks.entries()].map(([k, v]) => [k, { ...v }]);
}

function byKey(marks: Mark[]): Mark[] {
  return [...marks].sort(
    (a, b) =>
      a.path.localeCompare(b.path) || a.uidValidity.localeCompare(b.uidValidity) || a.uid - b.uid,
  );
}

function basketOf(marks: Mark[]): Basket {
  return setMarks(emptyBasket, marks, true);
}

describe('emptyBasket', () => {
  it('has no marks', () => {
    expect(emptyBasket.marks.size).toBe(0);
    expect(marksOf(emptyBasket)).toEqual([]);
    expect(basketTotals(emptyBasket)).toEqual({ count: 0, bytes: 0, unknownSizes: 0 });
  });
});

describe('toggleMark', () => {
  it('toggles on, then off', () => {
    const on = toggleMark(emptyBasket, mark(1));
    expect(isMarked(on, mark(1))).toBe(true);
    expect(basketTotals(on)).toEqual({ count: 1, bytes: 100, unknownSizes: 0 });
    const off = toggleMark(on, mark(1));
    expect(isMarked(off, mark(1))).toBe(false);
    expect(basketTotals(off)).toEqual(basketTotals(emptyBasket));
  });

  it('identity ignores bytes: toggling with other bytes removes the mark', () => {
    const on = toggleMark(emptyBasket, mark(1, { bytes: 100 }));
    const off = toggleMark(on, mark(1, { bytes: 999 }));
    expect(isMarked(off, mark(1))).toBe(false);
    expect(off.marks.size).toBe(0);
  });

  it('identity is path + uidValidity + uid', () => {
    let b = toggleMark(emptyBasket, mark(1));
    b = toggleMark(b, mark(1, { uidValidity: '8' }));
    b = toggleMark(b, mark(1, { path: 'Sent' }));
    b = toggleMark(b, mark(2));
    expect(b.marks.size).toBe(4);
    expect(isMarked(b, { path: 'INBOX', uidValidity: '7', uid: 1 })).toBe(true);
    expect(isMarked(b, { path: 'INBOX', uidValidity: '8', uid: 1 })).toBe(true);
    expect(isMarked(b, { path: 'Sent', uidValidity: '7', uid: 1 })).toBe(true);
    expect(isMarked(b, { path: 'Sent', uidValidity: '8', uid: 1 })).toBe(false);
    expect(isMarked(b, { path: 'INBOX', uidValidity: '7', uid: 3 })).toBe(false);
  });

  it('paths that could collide when joined naively stay distinct', () => {
    let b = toggleMark(emptyBasket, { path: 'a:1', uidValidity: '2', uid: 3, bytes: 1 });
    b = toggleMark(b, { path: 'a', uidValidity: '1:2', uid: 3, bytes: 1 });
    expect(b.marks.size).toBe(2);
  });

  it('never mutates the input basket', () => {
    const before = basketOf([mark(1), mark(2)]);
    const snapshot = dump(before);
    const after = toggleMark(before, mark(3));
    toggleMark(before, mark(1));
    expect(dump(before)).toEqual(snapshot);
    expect(after).not.toBe(before);
    expect(after.marks.size).toBe(3);
    expect(emptyBasket.marks.size).toBe(0);
  });
});

describe('setMarks', () => {
  it('on: adds every mark; already marked ones stay once', () => {
    const b1 = basketOf([mark(1)]);
    const b2 = setMarks(b1, [mark(1), mark(2), mark(3)], true);
    expect(b2.marks.size).toBe(3);
    expect(byKey(marksOf(b2))).toEqual([mark(1), mark(2), mark(3)]);
  });

  it('on is idempotent', () => {
    const marks = [mark(1), mark(2)];
    const b1 = setMarks(emptyBasket, marks, true);
    const b2 = setMarks(b1, marks, true);
    expect(b2.marks.size).toBe(2);
    expect(basketTotals(b2)).toEqual(basketTotals(b1));
  });

  it('off: removes the given marks, leaves the rest; unmarked ones are a no-op', () => {
    const b1 = basketOf([mark(1), mark(2), mark(3)]);
    const b2 = setMarks(b1, [mark(1), mark(3), mark(9)], false);
    expect(byKey(marksOf(b2))).toEqual([mark(2)]);
    const b3 = setMarks(b2, [mark(1), mark(3)], false);
    expect(byKey(marksOf(b3))).toEqual([mark(2)]);
  });

  it('empty list → same marks', () => {
    const b1 = basketOf([mark(1)]);
    expect(marksOf(setMarks(b1, [], true))).toEqual(marksOf(b1));
    expect(marksOf(setMarks(b1, [], false))).toEqual(marksOf(b1));
  });

  it('never mutates the input basket', () => {
    const before = basketOf([mark(1), mark(2)]);
    const snapshot = dump(before);
    setMarks(before, [mark(3), mark(4)], true);
    setMarks(before, [mark(1)], false);
    expect(dump(before)).toEqual(snapshot);
  });
});

describe('basketTotals', () => {
  it('count, sum of known sizes, unknown sizes', () => {
    const b = basketOf([
      mark(1, { bytes: 1000 }),
      mark(2, { bytes: 536 }),
      mark(3, { bytes: null }),
      mark(4, { bytes: 0 }),
      mark(5, { bytes: null, path: 'Sent' }),
    ]);
    expect(basketTotals(b)).toEqual({ count: 5, bytes: 1536, unknownSizes: 2 });
  });
});

describe('marksOf', () => {
  it('returns every mark with its bytes', () => {
    const marks = [
      mark(1, { bytes: null }),
      mark(2, { path: 'Sent' }),
      mark(3, { uidValidity: '9' }),
    ];
    expect(byKey(marksOf(basketOf(marks)))).toEqual(byKey(marks));
  });

  it('changing the returned array does not change the basket', () => {
    const b = basketOf([mark(1)]);
    const list = marksOf(b);
    list.pop();
    expect(b.marks.size).toBe(1);
    expect(marksOf(b)).toHaveLength(1);
  });
});

describe('reconcileFolder', () => {
  const marks = [
    mark(1, { uidValidity: '6' }),
    mark(2, { uidValidity: '6' }),
    mark(3, { uidValidity: '7' }),
    mark(1, { path: 'Sent', uidValidity: '6' }),
    mark(2, { path: 'Archive', uidValidity: '1' }),
  ];

  it('drops marks of the folder with another UIDVALIDITY, reports how many', () => {
    const before = basketOf(marks);
    const { basket, dropped } = reconcileFolder(before, 'INBOX', '7');
    expect(dropped).toBe(2);
    expect(byKey(marksOf(basket))).toEqual(
      byKey([
        mark(3, { uidValidity: '7' }),
        mark(1, { path: 'Sent', uidValidity: '6' }),
        mark(2, { path: 'Archive', uidValidity: '1' }),
      ]),
    );
  });

  it('a new UIDVALIDITY drops every mark of that folder', () => {
    const { basket, dropped } = reconcileFolder(basketOf(marks), 'INBOX', '99');
    expect(dropped).toBe(3);
    expect(marksOf(basket).filter((m) => m.path === 'INBOX')).toEqual([]);
    expect(basket.marks.size).toBe(2);
  });

  it('same UIDVALIDITY → dropped 0, same marks', () => {
    const before = basketOf([mark(1), mark(2), mark(1, { path: 'Sent', uidValidity: '3' })]);
    const { basket, dropped } = reconcileFolder(before, 'INBOX', '7');
    expect(dropped).toBe(0);
    expect(byKey(marksOf(basket))).toEqual(byKey(marksOf(before)));
  });

  it('other folders untouched, also when they have the stale UIDVALIDITY', () => {
    const { basket, dropped } = reconcileFolder(basketOf(marks), 'Sent', '7');
    expect(dropped).toBe(1);
    expect(byKey(marksOf(basket))).toEqual(
      byKey(marks.filter((m) => !(m.path === 'Sent' && m.uidValidity === '6'))),
    );
  });

  it('a folder with no marks → dropped 0', () => {
    const { basket, dropped } = reconcileFolder(basketOf(marks), 'Nowhere', '1');
    expect(dropped).toBe(0);
    expect(basket.marks.size).toBe(marks.length);
  });

  it('never mutates the input basket', () => {
    const before = basketOf(marks);
    const snapshot = dump(before);
    reconcileFolder(before, 'INBOX', '99');
    expect(dump(before)).toEqual(snapshot);
  });
});
