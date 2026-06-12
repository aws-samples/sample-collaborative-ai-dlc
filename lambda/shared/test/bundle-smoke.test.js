import { describe, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Bundle smoke test (regression guard).
//
// Lambdas bundled with `--format=esm` that pull in CommonJS code (e.g.
// `lambda/shared/realtime-token.js`) need esbuild's `createRequire` banner —
// without it the bundle throws `Dynamic require of "node:crypto" is not
// supported` at Lambda INIT, which took down ws-connection ($connect → 500 →
// every app-WS handshake failed) while unit tests stayed green: vitest's own
// loader provides `require`, masking the failure. So each bundle is built and
// then imported in a bare `node` child process, exactly like the Lambda ESM
// loader does.

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// Workspace name → bundle produced by `npm run build -w <name>`. Keep in sync
// with the ESM lambdas that import CommonJS shared modules.
const bundles = [
  ['ws-connection', 'lambda/ws-connection/.build/index.mjs'],
  ['ws-message', 'lambda/ws-message/.build/index.mjs'],
  ['notify', 'lambda/notify/.build/notify.mjs'],
];

describe.each(bundles)('%s bundle', (name, bundlePath) => {
  it('builds and imports under the Lambda ESM loader', { timeout: 60_000 }, () => {
    execFileSync('npm', ['run', 'build', '-w', name], { cwd: repoRoot, stdio: 'pipe' });
    const entry = path.join(repoRoot, bundlePath);
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(entry)});`],
      { stdio: 'pipe' },
    );
  });
});
