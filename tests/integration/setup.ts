import { loadEnvFiles } from '../../src/core/config.js';

// The only place tests read real env: .env.local / .env from the repo root.
loadEnvFiles();
