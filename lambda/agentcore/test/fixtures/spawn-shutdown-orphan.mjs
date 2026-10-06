// The persona-session stand-in for the CLI shutdown test. It is the process-group
// LEADER, so the interesting case is its grandchild: a plain (non-detached) child
// that stays in the same group and would write SPAWN_SHUTDOWN_SENTINEL if the group
// were not killed whole. The file's absence is what proves the group died.
//
// Kept as a file rather than a `-e` string so no path value is ever spliced into
// executable source. Paths arrive through the environment and the grandchild is
// addressed by a checked-in module path.
import { spawn } from 'node:child_process';

const grandchild = spawn(
  process.execPath,
  [process.env.SPAWN_SHUTDOWN_GRANDCHILD, process.env.SPAWN_SHUTDOWN_SENTINEL],
  { stdio: 'ignore' },
);
grandchild.unref();
setInterval(() => {}, 1000);
