// Runner half of the CLI shutdown test: installs the composition root's shutdown
// policy, starts one child through the real `runChild`, signals readiness, then
// waits. The test kills this process and asserts both what happened to the child's
// process group and how this process itself terminated.
//
// SPAWN_SHUTDOWN_INSTALL=0 omits the shutdown policy, which is the pre-persona
// baseline the non-persona case is compared against. SPAWN_SHUTDOWN_GROUP=0 starts
// the child the way every non-persona caller does.
//
// Paths arrive through the environment and the module is imported by a static
// relative specifier, so nothing here is built from a value at runtime.
import { writeFileSync } from 'node:fs';
import { installProcessGroupShutdown, runChild } from '../../cli/spawn.js';

if (process.env.SPAWN_SHUTDOWN_INSTALL !== '0') installProcessGroupShutdown();

const child = runChild({
  command: process.execPath,
  args: [process.env.SPAWN_SHUTDOWN_CHILD],
  processGroup: process.env.SPAWN_SHUTDOWN_GROUP !== '0',
});
writeFileSync(process.env.SPAWN_SHUTDOWN_READY, 'ready');
await child;
