import type { Command } from 'commander';
import { loadEnvFiles, validateSupabaseEnv } from '../../core/config.js';
import {
  createSupabaseServices,
  FileSessionStorage,
  sessionDir,
} from '../../core/db/supabase/index.js';
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
        // Only build a client when the config is valid; doctor reports config problems itself.
        ...(validateSupabaseEnv(process.env).ok && {
          session: () =>
            createSupabaseServices(process.env, new FileSessionStorage(sessionDir(process.env)), {
              timeoutMs: 5000, // same budget as doctor's other checks
            }).auth.currentUser(),
        }),
      });
      for (const r of results) console.log(`${LABEL[r.status]}  ${r.name.padEnd(13)} ${r.detail}`);
      if (hasFailures(results)) process.exitCode = 1;
    });
}
