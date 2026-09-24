// Seeded pseudo-random numbers for the test ground (mulberry32: 32-bit state, fast, good enough
// for test data — not for anything security-related). Never use Math.random or
// crypto.randomBytes in the test ground: every message must replay byte for byte from SEED.

export interface Prng {
  /** Float in [0, 1). */
  next(): number;
  /** Unsigned 32-bit integer. */
  uint32(): number;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** One item; throws on an empty list. */
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  /** Fisher–Yates; returns a shuffled copy. */
  shuffle<T>(items: readonly T[]): T[];
  /** n pseudo-random bytes, 4 per draw; the last draw is truncated when n % 4 !== 0. */
  bytes(n: number): Buffer;
}

function mulberry32Step(state: number): { state: number; value: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { state: next, value: (t ^ (t >>> 14)) >>> 0 };
}

export function createPrng(seed: number): Prng {
  let state = seed >>> 0;

  const uint32 = (): number => {
    const step = mulberry32Step(state);
    state = step.state;
    return step.value;
  };
  const next = (): number => uint32() / 0x1_0000_0000;
  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`int(${min}, ${max}): invalid range`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };

  return {
    next,
    uint32,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('pick() from an empty list');
      return items[int(0, items.length - 1)] as T;
    },
    chance: (p: number): boolean => next() < p,
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = int(0, i);
        [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
      }
      return copy;
    },
    bytes(n: number): Buffer {
      if (!Number.isInteger(n) || n < 0) throw new RangeError(`bytes(${n}): invalid length`);
      const out = Buffer.alloc(n);
      let i = 0;
      for (; i + 4 <= n; i += 4) out.writeUInt32LE(uint32(), i);
      if (i < n) {
        const last = uint32();
        for (let k = 0; i < n; i++, k++) out[i] = (last >>> (8 * k)) & 0xff;
      }
      return out;
    },
  };
}

/** Separate stream for one message's content, started from a mix of (seed, index): how many
 * values one message draws never shifts another message's sequence. (All mulberry32 seeds lie on
 * one 2^32 cycle, so streams of a different SEED could overlap; for SEED 20260921 they don't.) */
export function subPrng(seed: number, index: number): Prng {
  const mixed = Math.imul((seed ^ index) >>> 0, 0x9e3779b1) >>> 0;
  return createPrng(mulberry32Step(mixed).value);
}
