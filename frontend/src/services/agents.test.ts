import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
vi.mock('./api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
  },
}));

import { agentsService } from './agents';
import { queryClient } from '@/lib/queryClient';
import { qk } from '@/lib/queryKeys';

describe('agentsService authentication wire', () => {
  beforeEach(() => {
    post.mockReset().mockResolvedValue({ ok: true });
    put.mockReset().mockResolvedValue({});
  });

  it('sends a change request as the preview candidate', async () => {
    const request = {
      kind: 'connection-draft',
      mode: 'test-connection',
      projectId: 'p1',
      configuration: { endpoint: 'https://gateway.example' },
    } as const;
    await agentsService.previewAuthenticationChange(request);
    expect(put).toHaveBeenCalledWith('/agents/settings', {
      authenticationChange: { action: 'preview', candidate: request },
    });
  });

  it('posts provider actions to the single setup route with mode and action winning', async () => {
    await expect(
      agentsService.authenticationProviderAction('test-connection', 'verify', {
        projectId: 'p1',
        mode: 'other',
        action: 'other',
      }),
    ).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith('/agents/authentication-setup', {
      projectId: 'p1',
      mode: 'test-connection',
      action: 'verify',
    });
    await agentsService.authenticationProviderAction('test-connection', 'defaults');
    expect(post).toHaveBeenLastCalledWith('/agents/authentication-setup', {
      mode: 'test-connection',
      action: 'defaults',
    });
  });
});

describe('agentsService credential writes', () => {
  const configured = { bedrockBearerTokenSet: true, kiroApiKeySet: false };
  const cleared = { bedrockBearerTokenSet: false, kiroApiKeySet: false };

  beforeEach(() => {
    get.mockReset();
    put.mockReset().mockResolvedValue({ saved: true });
  });

  it.each([
    [
      'personal',
      () => agentsService.getPersonalCredentials(),
      () => agentsService.updatePersonalCredentials({ bedrockBearerToken: '' }),
      qk.personalCredentials(),
    ],
    [
      'space',
      () => agentsService.getProjectCredentials('p1'),
      () => agentsService.updateProjectCredentials('p1', { bedrockBearerToken: '' }),
      qk.projectCredentials('p1'),
    ],
  ] as const)(
    '%s: a read started before Clear cannot bring the old status back',
    async (_scope, read, clear, key) => {
      let answerOldRead: (value: unknown) => void = () => {};
      get
        .mockImplementationOnce(
          (_path: string, { signal }: { signal: AbortSignal }) =>
            new Promise((resolve, reject) => {
              answerOldRead = resolve;
              signal.addEventListener('abort', () => reject(signal.reason));
            }),
        )
        .mockResolvedValue(cleared);

      const early = read();
      await clear();
      answerOldRead(configured);

      await expect(early).resolves.toEqual(cleared);
      await vi.waitFor(() => expect(queryClient.getQueryData(key)).toEqual(cleared));
      expect(get).toHaveBeenCalledTimes(2);
    },
  );
});
