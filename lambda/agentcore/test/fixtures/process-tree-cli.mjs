// Stand-in CLI for the one-shot process-tree tests. It starts a grandchild that
// writes the sentinel file only if it is still alive after the CLI is gone,
// signals readiness, then either exits or hangs depending on the mode.
//
// Kept as a file rather than a `-e` string so no path value is ever spliced into
// executable source. Paths arrive as arguments.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [mode, sentinelPath, readyPath] = process.argv.slice(2);
const lateWriter = fileURLToPath(new URL('./process-tree-late-writer.mjs', import.meta.url));

const child = spawn(process.execPath, [lateWriter, sentinelPath], { stdio: 'ignore' });
child.unref();
writeFileSync(readyPath, 'ready');
if (mode === 'hang') setInterval(() => {}, 1000);
