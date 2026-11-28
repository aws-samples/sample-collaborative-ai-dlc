// Vitest setup for frontend tests: jest-dom matchers + per-test cleanup.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { notifyManager } from '@tanstack/react-query';
import { boundQueryMemory, createQueryClient } from '@/lib/queryClient';
import { onUserCacheBound, onUserCacheEnded } from '@/lib/persistentCache';

const state = vi.hoisted(() => ({ client: null as QueryClient | null, open: true }));
notifyManager.setScheduler(queueMicrotask);
vi.mock('@/lib/queryClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queryClient')>();
  return {
    ...actual,
    get queryClient() {
      return state.client ?? actual.queryClient;
    },
    get querySessionOpen() {
      return state.open;
    },
  };
});
onUserCacheEnded(() => {
  state.open = false;
  state.client?.clear();
});
onUserCacheBound(() => {
  state.open = true;
});
let unbind: (() => void) | undefined;

beforeEach(() => {
  state.open = true;
  state.client = createQueryClient();
  state.client.setDefaultOptions({
    queries: { ...state.client.getDefaultOptions().queries, retry: false },
  });
  unbind = boundQueryMemory(state.client);
});

afterEach(async () => {
  cleanup();
  const scheduler = await vi.importActual<typeof import('@/lib/prefetch')>('@/lib/prefetch');
  scheduler.foregroundNavigation(undefined, 0);
  unbind?.();
  state.client?.clear();
});
