import type { Command } from 'commander';
import { loadEnvFiles } from '../../core/config.js';
import { hasFailures, runDoctor, type CheckStatus } from '../../core/doctor.js';

const LABEL: Record<CheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Check environment, configuration and Supabase connectivity')
    .action(async () => {
      loadEnvFiles();
      const results = await runDoctor({
        env: process.env,
        fetch: globalThis.fetch,
        nodeVersion: process.versions.node,
        timeoutMs: 5000,
      });
      for (const r of results) console.log(`${LABEL[r.status]}  ${r.name.padEnd(13)} ${r.detail}`);
      if (hasFailures(results)) process.exitCode = 1;
    });
}
