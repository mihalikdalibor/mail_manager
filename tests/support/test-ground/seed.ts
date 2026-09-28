import { SeedRefusedError, SeedVerifyError, type UnexpectedCounts } from './errors.js';
import type { ServerMessage, TestFolder } from './folder.js';
import type { SeededMessage, TestGround } from './generator.js';

// Idempotent seeding of mm-test: upload only the messages whose seed id is missing, reset flags
// that tests changed, and refuse — before writing anything — when the folder holds mail that
// isn't exactly the seeded set. Seeding never deletes messages; `npm run test:unseed` does.

export interface SeedPlan {
  /** Index order. */
  missing: SeededMessage[];
  /** `flags` = the manifest flags plus the keywords the server already has. */
  flagDrift: { uid: number; seedId: string; flags: string[] }[];
  unexpected: UnexpectedCounts;
}

export interface SeedReport {
  created: boolean;
  appended: number;
  flagsReset: number;
  total: number;
}

const SEED_ID = /^v(\d+)-(\d{3})$/;

function sameFlags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((flag, i) => flag === b[i]);
}

function sortedFlags(flags: readonly string[]): string[] {
  return [...flags].sort();
}

/** Classifies what the server holds against the ground. Pure. */
export function planSeed(server: readonly ServerMessage[], ground: TestGround): SeedPlan {
  const bySeedId = new Map(ground.messages.map((m) => [m.facts.seedId, m]));
  const seen = new Set<string>();
  const unexpected: UnexpectedCounts = { foreign: 0, duplicate: 0, olderVersion: 0, changed: 0 };
  const flagDrift: SeedPlan['flagDrift'] = [];

  for (const message of server) {
    const id = message.seedId;
    const version = id === null ? null : SEED_ID.exec(id)?.[1];
    if (
      id !== null &&
      version !== undefined &&
      version !== null &&
      Number(version) !== ground.version
    ) {
      unexpected.olderVersion++;
      continue;
    }
    const expected = id === null ? undefined : bySeedId.get(id);
    if (id === null || expected === undefined) {
      unexpected.foreign++;
      continue;
    }
    if (seen.has(id)) {
      unexpected.duplicate++;
      continue;
    }
    seen.add(id);
    if (
      message.size !== expected.facts.size ||
      message.internalDate.getTime() !== Date.parse(expected.facts.internalDate)
    ) {
      unexpected.changed++;
      continue;
    }
    if (!sameFlags(message.flags, sortedFlags(expected.facts.flags))) {
      flagDrift.push({
        uid: message.uid,
        seedId: id,
        flags: [...expected.facts.flags, ...message.keywords],
      });
    }
  }

  return {
    missing: ground.messages.filter((m) => !seen.has(m.facts.seedId)),
    flagDrift,
    unexpected,
  };
}

/** Number of ways the server differs from the ground (0 = exact match). Pure. */
export function verifySeed(server: readonly ServerMessage[], ground: TestGround): number {
  let mismatches = server.length === ground.messages.length ? 0 : 1;
  const bySeedId = new Map<string, ServerMessage[]>();
  for (const message of server) {
    if (message.seedId === null) {
      mismatches++;
      continue;
    }
    bySeedId.set(message.seedId, [...(bySeedId.get(message.seedId) ?? []), message]);
  }
  const known = new Set(ground.messages.map((m) => m.facts.seedId));
  for (const [id, messages] of bySeedId) if (!known.has(id)) mismatches += messages.length;

  for (const { facts } of ground.messages) {
    const found = bySeedId.get(facts.seedId) ?? [];
    const message = found[0];
    if (found.length !== 1 || message === undefined) {
      mismatches++;
      continue;
    }
    if (
      message.size !== facts.size ||
      message.internalDate.getTime() !== Date.parse(facts.internalDate) ||
      !sameFlags(message.flags, sortedFlags(facts.flags))
    ) {
      mismatches++;
    }
  }
  return mismatches;
}

export async function seedTestGround(
  folder: TestFolder,
  ground: TestGround,
  onProgress?: (appended: number, missing: number) => void,
): Promise<SeedReport> {
  const created = (await folder.exists()) ? false : await folder.create();
  const open = await folder.open();
  try {
    const plan = planSeed(await open.fetchMessages(), ground);
    const u = plan.unexpected;
    if (u.foreign + u.duplicate + u.olderVersion + u.changed > 0) throw new SeedRefusedError(u);

    for (const drift of plan.flagDrift) await open.setFlags(drift.uid, drift.flags);

    let appended = 0;
    for (const { facts, raw } of plan.missing) {
      // Appended while mm-test is selected: its PERMANENTFLAGS decide which flags stick.
      await open.append(raw, [...facts.flags], new Date(facts.internalDate));
      appended++;
      onProgress?.(appended, plan.missing.length);
    }

    const mismatches = verifySeed(await open.fetchMessages(), ground);
    if (mismatches > 0) throw new SeedVerifyError(mismatches);
    return { created, appended, flagsReset: plan.flagDrift.length, total: ground.messages.length };
  } finally {
    open.release();
  }
}
