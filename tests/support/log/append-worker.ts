// Concurrency helper for tests/unit/log-file.test.ts: appends n command.start lines (cmd = tag)
// through a FileEventLog, like one `mm` run. Usage:
//   node --import tsx tests/support/log/append-worker.ts <dir> <n> <tag>
import { FileEventLog, newRunId } from '../../../src/core/log/index.js';

const [dir, count, tag] = process.argv.slice(2);
if (dir === undefined || count === undefined || tag === undefined) {
  console.error('usage: append-worker.ts <dir> <n> <tag>');
  process.exit(2);
}

const log = new FileEventLog(dir, {
  run: newRunId(),
  ver: 'test',
  now: () => Date.now(),
  level: 'info',
});
for (let i = 0; i < Number(count); i++) {
  log.emit({
    event: 'command.start',
    cmd: tag,
    opts: [],
    ver: 'test',
    node: process.versions.node,
    os: process.platform,
  });
}
// Logging swallows failures; surface them to the test through the exit code.
process.exit(log.failures > 0 || log.dropped > 0 ? 1 : 0);
