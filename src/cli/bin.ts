#!/usr/bin/env node
import { buildProgram } from './index.js';

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write('', () => resolve()));
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Unexpected error');
    process.exitCode = 1;
  }
  // A finished command must not linger: library timers (e.g. auth-js token-refresh
  // retries, up to ~30 s) would otherwise keep the process alive and print late noise.
  await flush(process.stdout);
  await flush(process.stderr);
  process.exit();
}

void main();
