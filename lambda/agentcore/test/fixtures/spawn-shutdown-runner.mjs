// Runner half of the CLI shutdown test: starts a process-group child through the real
// `runChild`, signals readiness, then waits. The test kills this process and
// asserts the grandchild died with it.
//
// Paths arrive through the environment and the module is imported by a static
// relative specifier, so nothing here is built from a value at runtime.
import { writeFileSync } from 'node:fs';
import { runChild } from '../../cli/spawn.js';

const child = runChild({
  command: process.execPath,
  args: [process.env.SPAWN_SHUTDOWN_ORPHAN],
  processGroup: true,
});
writeFileSync(process.env.SPAWN_SHUTDOWN_READY, 'ready');
await child;
