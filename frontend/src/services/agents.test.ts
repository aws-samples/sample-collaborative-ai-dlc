import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const put = vi.fn();
vi.mock('./api', () => ({
  api: { post: (...a: unknown[]) => post(...a), put: (...a: unknown[]) => put(...a) },
}));

import { agentsService } from './agents';

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
