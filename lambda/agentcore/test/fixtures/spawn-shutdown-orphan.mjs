// Orphan probe for the CLI shutdown test. Spawned as a detached grandchild, it
// writes SPAWN_SHUTDOWN_SENTINEL only if it outlives the runner — the file's
// absence is what proves the process group was killed.
//
// Kept as a file rather than a `-e` string so no path value is ever spliced into
// executable source.
import { writeFileSync } from 'node:fs';

setTimeout(() => writeFileSync(process.env.SPAWN_SHUTDOWN_SENTINEL, 'orphan'), 500);
