#!/usr/bin/env node
import { loadEnvFiles } from '../core/config.js';
import { buildProgram, VERSION } from './index.js';
import { createRunLog, isInteractive, runCli } from './run.js';

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write('', () => resolve()));
}

const { log, ctx } = createRunLog({
  env: process.env,
  loadEnv: () => loadEnvFiles(),
  now: Date.now,
  ver: VERSION,
});

void runCli({
  argv: process.argv,
  build: buildProgram,
  log,
  ctx,
  proc: process,
  streams: [process.stdout, process.stderr],
  // In a terminal plain `mm` opens the app; piped or in a script it prints the help as before.
  interactive: isInteractive(process.stdin, process.stdout, process.env),
  flush: async () => {
    await flush(process.stdout);
    await flush(process.stderr);
  },
});
