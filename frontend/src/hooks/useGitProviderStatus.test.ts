import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { api } from '../services/api';
import type { GitProviderStatus } from '../services/gitProvider';
import { useGitProviderStatus } from './useGitProviderStatus';

it('keeps the instance choices while checking another host and ignores a late response', async () => {
  const host = 'git.example.org';
  let finishPrivate!: (value: GitProviderStatus) => void;
  const privateRequest = new Promise<GitProviderStatus>((resolve) => {
    finishPrivate = resolve;
  });
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValueOnce({ connected: true, instances: [host] })
    .mockReturnValueOnce(privateRequest)
    .mockResolvedValueOnce({ connected: false, instances: [host] });
  try {
    const initialProps: { instance?: string } = {};
    const { result, rerender } = renderHook(
      ({ instance }: { instance?: string }) => useGitProviderStatus('gitlab', instance),
      { initialProps },
    );
    await waitFor(() => expect(result.current.status?.connected).toBe(true));
    rerender({ instance: host });
    expect(result.current.instances).toEqual([host]);
    expect(result.current.status).toBeNull();
    expect(result.current.loading).toBe(true);
    rerender({ instance: undefined });
    await waitFor(() => expect(result.current.status?.connected).toBe(false));
    await act(async () => finishPrivate({ connected: true, instances: [host] }));
    expect(result.current.status?.connected).toBe(false);
  } finally {
    get.mockRestore();
  }
});
