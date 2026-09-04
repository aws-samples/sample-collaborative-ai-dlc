import { describe, expect, it, vi } from 'vitest';
import { ASKPASS_BODY, resolveGitCommitter, withGitCredential } from '../git-auth.js';

const context = {
  executionId: 'exec-1',
  projectId: 'project-1',
  provider: 'github',
  repository: 'owner/repo',
};

const fsHarness = () => {
  const calls = [];
  return {
    calls,
    fsOps: {
      mkdtemp: vi.fn(async (prefix) => {
        calls.push(['mkdtemp', prefix]);
        return '/tmp/askpass-test';
      }),
      writeFile: vi.fn(async (...args) => calls.push(['writeFile', ...args])),
      chmod: vi.fn(async (...args) => calls.push(['chmod', ...args])),
      rm: vi.fn(async (...args) => calls.push(['rm', ...args])),
    },
  };
};

describe('AgentCore git credential isolation', () => {
  it('uses a temporary askpass helper and destroys its environment and directory', async () => {
    const secret = ['temporary', 'broker', 'secret'].join('-');
    const broker = vi.fn(async () => ({
      ok: true,
      username: 'x-access-token',
      password: secret,
      committer: { name: 'Project App', email: 'app@example.com' },
    }));
    const { calls, fsOps } = fsHarness();
    let childEnv;

    const result = await withGitCredential(
      context,
      async ({ env, committer }) => {
        childEnv = env;
        expect(env).toMatchObject({
          GIT_ASKPASS: '/tmp/askpass-test/askpass.sh',
          GIT_TERMINAL_PROMPT: '0',
          AIDLC_GIT_USERNAME: 'x-access-token',
          AIDLC_GIT_PASSWORD: secret,
        });
        expect(committer).toEqual({ name: 'Project App', email: 'app@example.com' });
        return 'done';
      },
      { broker, fsOps, tempRoot: '/tmp' },
    );

    expect(result).toBe('done');
    expect(broker).toHaveBeenCalledWith({ ...context, requiredAccess: 'write' });
    expect(calls.find(([name]) => name === 'writeFile')).toEqual([
      'writeFile',
      '/tmp/askpass-test/askpass.sh',
      ASKPASS_BODY,
      { encoding: 'utf8', mode: 0o700 },
    ]);
    expect(calls.at(-1)).toEqual(['rm', '/tmp/askpass-test', { recursive: true, force: true }]);
    expect(childEnv).toEqual({});
    expect(ASKPASS_BODY).not.toContain(secret);
  });

  it('cleans up when the git operation fails', async () => {
    const { fsOps } = fsHarness();
    const broker = async () => ({ username: 'oauth2', password: 'ephemeral' });

    await expect(
      withGitCredential(
        { ...context, provider: 'gitlab', requiredAccess: 'read' },
        async () => {
          throw new Error('clone failed');
        },
        { broker, fsOps },
      ),
    ).rejects.toThrow('clone failed');
    expect(fsOps.rm).toHaveBeenCalledWith('/tmp/askpass-test', {
      recursive: true,
      force: true,
    });
  });

  it('does not create a helper or invoke git when the broker denies access', async () => {
    const { fsOps } = fsHarness();
    const operation = vi.fn();
    const broker = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { code: 'SOURCE_CONTROL_NOT_READY' });
    });

    await expect(withGitCredential(context, operation, { broker, fsOps })).rejects.toMatchObject({
      code: 'SOURCE_CONTROL_NOT_READY',
    });
    expect(operation).not.toHaveBeenCalled();
    expect(fsOps.mkdtemp).not.toHaveBeenCalled();
  });

  it('requests identity without minting a git credential', async () => {
    const broker = vi.fn(async () => ({
      ok: true,
      committer: { name: 'GitHub App', email: 'app@example.com' },
    }));
    await expect(resolveGitCommitter(context, { broker })).resolves.toEqual({
      name: 'GitHub App',
      email: 'app@example.com',
    });
    expect(broker).toHaveBeenCalledWith({ ...context, requiredAccess: 'identity' });
  });
});
