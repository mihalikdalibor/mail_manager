import { createRequire } from 'node:module';

// Same relative path from src/cli (tsx) and dist/cli (built).
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

export const VERSION = pkg.version;
