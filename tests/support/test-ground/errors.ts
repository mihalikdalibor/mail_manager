// Errors the test-ground scripts print as-is: fixed plain text plus counts, never a path, address,
// host or server text.

export class TestGroundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestGroundError';
  }
}

export class FolderGuardError extends TestGroundError {
  constructor() {
    super('Test tooling may only touch the mm-test folder.');
    this.name = 'FolderGuardError';
  }
}

export interface UnexpectedCounts {
  foreign: number;
  duplicate: number;
  olderVersion: number;
  changed: number;
}

export class SeedRefusedError extends TestGroundError {
  readonly counts: UnexpectedCounts;

  constructor(counts: UnexpectedCounts) {
    const total = counts.foreign + counts.duplicate + counts.olderVersion + counts.changed;
    super(
      `mm-test holds ${total} messages that don't match the seeded set (foreign ${counts.foreign}, ` +
        `duplicate ${counts.duplicate}, other version ${counts.olderVersion}, changed ${counts.changed}). ` +
        'Run npm run test:unseed, then npm run test:seed.',
    );
    this.name = 'SeedRefusedError';
    this.counts = { ...counts };
  }
}

export class SeedVerifyError extends TestGroundError {
  readonly mismatches: number;

  constructor(mismatches: number) {
    super(
      `mm-test doesn't match the manifest after seeding (${mismatches} mismatches). ` +
        'Run npm run test:unseed, then npm run test:seed.',
    );
    this.name = 'SeedVerifyError';
    this.mismatches = mismatches;
  }
}
