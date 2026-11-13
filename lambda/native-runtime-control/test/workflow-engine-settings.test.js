import { describe, expect, it, vi } from 'vitest';
import { readNativeWorkflowSettings } from '../../shared/native-workflow-settings.js';
import {
  NATIVE_ENGINE_SETTINGS_PATHS,
  nativeEngineFiles,
} from '../../shared/native-workflow-protocol.js';

const commit = 'c'.repeat(40);
const repository = 'org/repository';
const token = 'fixture-provider-token';
const content = '# Repository policy\nGuard Policy: strict\n';
const fixture = (provider, alter = () => {}) => {
  let commits = 0;
  const requests = [];
  const fetchImpl = vi.fn(async (url, options) => {
    requests.push({ url, options });
    const parsed = new URL(url);
    let body;
    let status = 200;
    if (
      parsed.pathname.endsWith(`/commits/${commit}`) ||
      parsed.pathname.endsWith(`/commit/${commit}`)
    ) {
      commits++;
      body = JSON.stringify({ sha: commit, id: commit, hash: commit });
    } else {
      const path = NATIVE_ENGINE_SETTINGS_PATHS.find(
        (path) => url.includes(path) || url.includes(encodeURIComponent(path)),
      );
      expect(path).toBeDefined();
      if (path !== 'aidlc/spaces/default/memory/org.md') {
        status = 404;
        body = '';
      } else
        body =
          provider === 'bitbucket'
            ? content
            : JSON.stringify({
                path,
                file_path: path,
                encoding: 'base64',
                size: Buffer.byteLength(content),
                content: Buffer.from(content).toString('base64'),
              });
    }
    const value = { body, status, commits, url };
    alter(value);
    return new Response(value.body, { status: value.status });
  });
  return {
    requests,
    fetchImpl,
    read: () => readNativeWorkflowSettings({ provider, repository, commit, token, fetchImpl }),
  };
};
describe('workflow policy captured by the source owner', () => {
  it.each(['github', 'gitlab', 'bitbucket'])(
    'reads exact %s commit policy with credentials confined to that provider',
    async (provider) => {
      const f = fixture(provider);
      const result = await f.read();
      expect(result.commit).toBe(commit);
      expect(nativeEngineFiles(result.files)).toMatchObject([
        { path: 'aidlc/spaces/default/memory/org.md', content: Buffer.from(content) },
      ]);
      expect(f.requests).toHaveLength(NATIVE_ENGINE_SETTINGS_PATHS.length + 2);
      for (const { url, options } of f.requests) {
        expect(url).toContain(commit);
        expect(options).toMatchObject({
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
      expect(JSON.stringify(result)).not.toContain(token);
    },
  );
  it.each(['github', 'gitlab', 'bitbucket'])(
    'refuses missing or replaced %s commits instead of treating unreadable policy as absent',
    async (provider) => {
      await expect(
        fixture(provider, (value) => {
          if (value.commits === 2)
            value.body = JSON.stringify({
              sha: 'd'.repeat(40),
              id: 'd'.repeat(40),
              hash: 'd'.repeat(40),
            });
        }).read(),
      ).rejects.toThrow('NATIVE_ENGINE_SETTINGS_UNAVAILABLE');
      await expect(
        fixture(provider, (value) => {
          value.status = 403;
        }).read(),
      ).rejects.toThrow();
    },
  );
  it('rejects malformed encoding and oversized policy', async () => {
    await expect(
      fixture('github', (value) => {
        if (value.url.includes('/contents/') && value.status === 200)
          value.body = '{"encoding":"base64","size":8,"content":"eA=="}';
      }).read(),
    ).rejects.toThrow();
    await expect(
      fixture('bitbucket', (value) => {
        if (value.url.includes('/src/') && value.status === 200) value.body = 'x'.repeat(70 * 1024);
      }).read(),
    ).rejects.toThrow();
  });
});
