#!/usr/bin/env node
import { buildProgram } from './index.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'Unexpected error');
    process.exitCode = 1;
  });
