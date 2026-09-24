/**
 * Storage for login-attempt counters. Async because the hosted store (M6a: DB / Redis) is.
 * That store must make each read-modify-write atomic (transaction / script); in-process,
 * LoginGuard.withPairLock serialises attempts per pair.
 * `until` values are always finite — a permanent block is a flag (Infinity doesn't survive JSON).
 */
export interface AttemptStore {
  getTimes(key: string): Promise<number[]>;
  /** An empty list deletes the entry. */
  setTimes(key: string, times: number[]): Promise<void>;
  getUntil(key: string): Promise<number | null>;
  /** null deletes the entry. */
  setUntil(key: string, until: number | null): Promise<void>;
  getFlag(key: string): Promise<boolean>;
  /** false deletes the entry. */
  setFlag(key: string, on: boolean): Promise<void>;
}

/** Per-process store: in the CLI the counters live for one `mm` run. */
export class MemoryAttemptStore implements AttemptStore {
  private readonly times = new Map<string, number[]>();
  private readonly untils = new Map<string, number>();
  private readonly flags = new Set<string>();

  getTimes(key: string): Promise<number[]> {
    return Promise.resolve([...(this.times.get(key) ?? [])]);
  }

  setTimes(key: string, times: number[]): Promise<void> {
    if (times.length === 0) this.times.delete(key);
    else this.times.set(key, [...times]);
    return Promise.resolve();
  }

  getUntil(key: string): Promise<number | null> {
    return Promise.resolve(this.untils.get(key) ?? null);
  }

  setUntil(key: string, until: number | null): Promise<void> {
    if (until === null) this.untils.delete(key);
    else this.untils.set(key, until);
    return Promise.resolve();
  }

  getFlag(key: string): Promise<boolean> {
    return Promise.resolve(this.flags.has(key));
  }

  setFlag(key: string, on: boolean): Promise<void> {
    if (on) this.flags.add(key);
    else this.flags.delete(key);
    return Promise.resolve();
  }

  /** All stored keys (tests check that none contains a plain address). */
  keys(): string[] {
    return [...this.times.keys(), ...this.untils.keys(), ...this.flags];
  }
}
