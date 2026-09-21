import type { Command } from 'commander';
import { generateMasterKey } from '../../core/master-key.js';

export function registerKeygen(program: Command): void {
  program
    .command('keygen')
    .description('Generate a new random MM_MASTER_KEY (credential encryption key)')
    .action(() => {
      // Only the key goes to stdout so it can be piped; the hint goes to stderr.
      process.stdout.write(`${generateMasterKey()}\n`);
      process.stderr.write(
        'Add it to .env.local as MM_MASTER_KEY=<value>. Keep it secret and backed up.\n',
      );
    });
}
