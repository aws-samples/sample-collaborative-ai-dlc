import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The production credential path, with only the broker Lambda call replaced:
// syncLaneWithIntent gets no test URLs and no withGitCredential, so git-engine
// uses git-auth.js withGitCredential, which asks the credential broker for each
// network operation and hands git an askpass environment.
const broker = vi.hoisted(() => ({ calls: [] }));
vi.mock('../clients.js', async (importOriginal) => ({
  ...(await importOriginal()),
  invokeCredentialBroker: vi.fn(async (request) => {
    broker.calls.push(request);
    return { ok: true, username: 'oauth2', password: 'broker-token', committer: null };
  }),
}));

const { runGit } = await import('../git-engine.js');
const { syncLaneWithIntent } = await import('../lane-sync.js');

vi.setConfig({ testTimeout: 30_000 });

const INTENT = 'aidlc/i1';
const UNIT = 'aidlc/i1--s1-unit-auth';
let root;
const git = (args, cwd) => runGit(args, { cwd });
const commitAs = ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m'];

const commitOnRemote = async (remote, branch, file, content, from = 'main') => {
  const dir = await mkdtemp(path.join(root, 'peer-'));
  await git(['clone', remote, dir], root);
  const co = await git(['checkout', branch], dir);
  if (co.exitCode !== 0) await git(['checkout', '-b', branch, `origin/${from}`], dir);
  await writeFile(path.join(dir, file), content);
  await git(['add', '-A'], dir);
  await git([...commitAs, `add ${file}`], dir);
  await git(['push', 'origin', `HEAD:refs/heads/${branch}`], dir);
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'lane-sync-broker-'));
  broker.calls.length = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('syncLaneWithIntent — default credential path', () => {
  it('asks the credential broker for each fetch and push', async () => {
    const remote = path.join(root, 'remote.git');
    const work = path.join(root, 'work');
    await git(['init', '--bare', '-b', 'main', remote], root);
    const seed = path.join(root, 'seed');
    await git(['init', '-b', 'main', seed], root);
    await writeFile(path.join(seed, 'README.md'), 'seed\n');
    await git(['add', '-A'], seed);
    await git([...commitAs, 'seed'], seed);
    await git(['push', remote, 'main'], seed);
    await commitOnRemote(remote, INTENT, 'base.txt', 'base\n');
    await commitOnRemote(remote, UNIT, 'auth.txt', 'auth\n', INTENT);
    await git(['clone', remote, work], root);
    await git(['fetch', 'origin'], work);
    await git(['checkout', '-B', UNIT, `refs/remotes/origin/${UNIT}`], work);
    await commitOnRemote(remote, INTENT, 'filestore.txt', 'ranged read\n');

    const res = await syncLaneWithIntent(
      {
        projectId: 'p1',
        executionId: 'e1',
        unitSlug: 'auth',
        repos: ['o/r'],
        unitBranch: UNIT,
        intentBranch: INTENT,
        gitProvider: 'gitlab',
        workspaceDir: work,
      },
      { env: {} },
    );

    expect(res.results).toEqual([
      { repo: 'o/r', outcome: 'merged', sha: expect.stringMatching(/^[0-9a-f]{40}$/) },
    ]);
    expect(await readFile(path.join(work, 'filestore.txt'), 'utf8')).toBe('ranged read\n');
    const access = broker.calls.map((call) => call.requiredAccess);
    expect(access).toContain('read');
    expect(access).toContain('write');
    for (const call of broker.calls) {
      expect(call).toMatchObject({
        executionId: 'e1',
        projectId: 'p1',
        provider: 'gitlab',
        repository: 'o/r',
      });
    }
  });
});
