// Grandchild of the process-tree tests. It writes the sentinel path
// given as its first argument after a delay; the file's absence proves the CLI
// process group was stopped before it could.
import { writeFileSync } from 'node:fs';

setTimeout(() => writeFileSync(process.argv[2], 'late'), 1800);
