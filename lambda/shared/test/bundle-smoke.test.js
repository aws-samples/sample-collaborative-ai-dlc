import { describe, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
  ['intent-pin-lookup', 'lambda/intent-pin-lookup/.build/index.mjs'],
  ['user-stories', 'lambda/user-stories/.build/index.mjs'],
  ['users', 'lambda/users/.build/index.mjs'],
  ['projects', 'lambda/projects/.build/index.mjs'],
  ['intents', 'lambda/intents/.build/index.mjs'],
  ['discussions', 'lambda/discussions/.build/index.mjs'],
  ['source-control', 'lambda/source-control/.build/index.mjs'],
  ['trackers', 'lambda/trackers/.build/index.mjs'],
  ['migrate-memberships', 'lambda/migrate-memberships/.build/index.mjs'],
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
    if (
      ['users', 'projects', 'intents', 'discussions', 'source-control', 'trackers'].includes(name)
    ) {
      // Lambda must receive the WASM too; a development node_modules ancestor
      // must not hide a missing dependency in the deployment artifact.
      const isolated = mkdtempSync(path.join(tmpdir(), 'cedar-bundle-'));
      try {
        for (const dir of ['node_modules', 'policies'])
          cpSync(path.join(path.dirname(entry), dir), path.join(isolated, dir), {
            recursive: true,
          });
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `const { readFileSync } = await import('node:fs');
           const { isAuthorized } = await import('@cedar-policy/cedar-wasm/nodejs');
           const decide = (role, action) => isAuthorized({
             principal: { type: 'User', id: 'caller' },
             action: { type: 'Action', id: action },
             resource: { type: 'Space', id: 'space' },
             context: {},
             entities: [{ uid: { type: 'User', id: 'caller' }, attrs: { membershipRole: role }, parents: [] }],
             policies: { staticPolicies: readFileSync('policies/space.cedar', 'utf8') }
           });
           const read = decide('viewer', 'read');
           const write = decide('viewer', 'write');
           if (read.type !== 'success' || read.response.decision !== 'allow') process.exit(1);
           if (write.type !== 'success' || write.response.decision !== 'deny') process.exit(1);`,
          ],
          { cwd: isolated, stdio: 'pipe' },
        );
      } finally {
        rmSync(isolated, { recursive: true, force: true });
      }
    }
  });
});
