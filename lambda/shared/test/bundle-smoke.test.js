import { describe, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Bundle smoke test (regression guard).
//
// Each bundle is built and then imported in a bare `node` child process, exactly
// like the Lambda ESM loader does. This catches INIT-time module loading issues
// that unit tests can miss.

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// Workspace name → bundle produced by `npm run build -w <name>`.
const bundles = [
  ['agents', 'lambda/agents/.build/index.mjs'],
  ['code-files', 'lambda/code-files/.build/index.mjs'],
  ['general-info', 'lambda/general-info/.build/index.mjs'],
  ['requirements', 'lambda/requirements/.build/index.mjs'],
  ['reviews', 'lambda/reviews/.build/index.mjs'],
  ['ws-connection', 'lambda/ws-connection/.build/index.mjs'],
  ['ws-message', 'lambda/ws-message/.build/index.mjs'],
  ['seed-blocks', 'lambda/seed-blocks/.build/index.mjs'],
  ['github-lambda', 'lambda/github/.build/index.mjs'],
  ['gitlab-lambda', 'lambda/gitlab/.build/index.mjs'],
  ['user-stories', 'lambda/user-stories/.build/index.mjs'],
  ['users', 'lambda/users/.build/index.mjs'],
  ['v2-orchestrator', 'lambda/v2-orchestrator/.build/index.mjs'],
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
