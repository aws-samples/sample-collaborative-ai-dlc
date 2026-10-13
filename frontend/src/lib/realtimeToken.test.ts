import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clearPersistedCache } from './persistentCache';
import { resetSessionExpiry } from '../services/sessionExpiry';

// Mock the api module BEFORE importing the unit under test so getRealtimeToken's
// `api.post` is the spy. This asserts the token PATH the client builds — the
// contract the v2 intent realtime endpoint depends on.
const post = vi.fn();
vi.mock('../services/api', () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

import {
  scopeTargetForChannel,
  scopeTargetForYjsDoc,
  isIntentDoc,
  isIntentChannel,
  getRealtimeToken,
  invalidateRealtimeToken,
  msUntilRefresh,
} from './realtimeToken';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

it('does not reuse or resurrect another login’s pending realtime grant', async () => {
  const target = { intentId: UUID, projectId: PID, executionBackend: 'native' as const };
  let finishOld!: (value: unknown) => void;
  post.mockReset().mockReturnValueOnce(
    new Promise((resolve) => {
      finishOld = resolve;
    }),
  );
  const old = getRealtimeToken(target).catch((error) => error);
  clearPersistedCache();
  resetSessionExpiry();
  post.mockResolvedValue({ token: 'member-b', exp: Date.now() / 1000 + 600, scopes: [] });
  const current = getRealtimeToken(target);
  // The second login must issue its own request before the first has completed.
  expect(post).toHaveBeenCalledTimes(2);
  expect((await current).token).toBe('member-b');
  finishOld({ token: 'member-a', exp: Date.now() / 1000 + 600, scopes: [] });
  expect(await old).toBeInstanceOf(Error);
  expect((await getRealtimeToken(target)).token).toBe('member-b');
  invalidateRealtimeToken(target);
});

describe('scope extractors (client mirror of the backend)', () => {
  it('maps sprint channel + bare projectId; intent channel is caller-supplied (null)', () => {
    expect(scopeTargetForChannel(`sprint:${UUID}`)).toEqual({ sprintId: UUID });
    expect(scopeTargetForChannel(UUID)).toEqual({ projectId: UUID });
    // intent: channels can't yield projectId from the string alone → null here.
    expect(scopeTargetForChannel(`intent:${UUID}`)).toBeNull();
    expect(scopeTargetForChannel('garbage')).toBeNull();
  });

  it('maps sprint yjs docs; intent docs are caller-supplied (null)', () => {
    expect(scopeTargetForYjsDoc(`discussion-${UUID}-d1`)).toEqual({ sprintId: UUID });
    expect(scopeTargetForYjsDoc(`inception-${UUID}`)).toEqual({ projectId: UUID });
    expect(scopeTargetForYjsDoc(`intent-sq-${UUID}-q1`)).toBeNull();
    expect(scopeTargetForYjsDoc(`intent-review-${UUID}-h1`)).toBeNull();
  });

  it('isIntentDoc / isIntentChannel recognize the intent shapes', () => {
    expect(isIntentChannel(`intent:${UUID}`)).toBe(UUID);
    expect(isIntentChannel(`sprint:${UUID}`)).toBeNull();
    expect(isIntentDoc(`intent-discussion-${UUID}-d1`)).toBe(UUID);
    expect(isIntentDoc(`intent-sq-${UUID}-q1`)).toBe(UUID);
    expect(isIntentDoc(`intent-review-${UUID}-h1`)).toBe(UUID);
    expect(isIntentDoc(`discussion-${UUID}-d1`)).toBeNull();
  });
});

describe('getRealtimeToken builds the right token path per scope', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ token: 't', exp: Math.floor(Date.now() / 1000) + 600, scopes: [] });
  });

  it('intent scope → project-scoped intent realtime-token path', async () => {
    await getRealtimeToken({ intentId: UUID, projectId: PID });
    expect(post).toHaveBeenCalledWith(`/projects/${PID}/intents/${UUID}/realtime-token`, {});
    invalidateRealtimeToken({ intentId: UUID, projectId: PID });
  });

  it('isolates native token cache and in-flight requests across projects and platform targets', async () => {
    const native = { intentId: UUID, projectId: PID, executionBackend: 'native' as const };
    const other = { ...native, projectId: UUID };
    const platform = { intentId: UUID, projectId: PID };
    const channel = `native-intent:${PID}:${UUID}`;
    expect(scopeTargetForChannel(channel)).toEqual(native);
    let release!: (value: { token: string; exp: number; scopes: string[] }) => void;
    post
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      )
      .mockResolvedValueOnce({ token: 'other', exp: Date.now() / 1000 + 600, scopes: [] })
      .mockResolvedValueOnce({ token: 'platform', exp: Date.now() / 1000 + 600, scopes: [] });
    const first = getRealtimeToken(native);
    expect((await getRealtimeToken(other)).token).toBe('other');
    expect((await getRealtimeToken(platform)).token).toBe('platform');
    release({ token: 'native', exp: Date.now() / 1000 + 600, scopes: [channel] });
    expect((await first).token).toBe('native');
    expect((await getRealtimeToken(native)).token).toBe('native');
    expect(post).toHaveBeenCalledTimes(3);
    expect(post).toHaveBeenCalledWith(`/projects/${PID}/intents/${UUID}/realtime-token`, {
      executionBackend: 'native',
    });
    expect(post).toHaveBeenCalledWith(`/projects/${UUID}/intents/${UUID}/realtime-token`, {
      executionBackend: 'native',
    });
    [native, other, platform].forEach(invalidateRealtimeToken);
  });

  it('sprint + project scopes use their own paths', async () => {
    await getRealtimeToken({ sprintId: UUID });
    expect(post).toHaveBeenCalledWith(`/sprints/${UUID}/realtime-token`, {});
    await getRealtimeToken({ projectId: PID });
    expect(post).toHaveBeenCalledWith(`/projects/${PID}/realtime-token`, {});
    invalidateRealtimeToken({ sprintId: UUID });
    invalidateRealtimeToken({ projectId: PID });
  });
});

describe('msUntilRefresh', () => {
  it('never returns negative', () => {
    expect(msUntilRefresh(0)).toBe(0);
    expect(msUntilRefresh(Math.floor(Date.now() / 1000) + 600)).toBeGreaterThan(0);
  });
});

describe('revision-specific native reply draft tokens', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ token: 't', exp: Math.floor(Date.now() / 1000) + 600, scopes: [] });
  });
  it('requests exactly the interaction/turn and never shares a cache entry across revisions', async () => {
    const base = { intentId: UUID, projectId: PID, executionBackend: 'native' as const };
    const turn2 = {
      ...base,
      document: { kind: 'reply' as const, interactionId: 'a'.repeat(64), sequence: 2 },
    };
    const turn3 = {
      ...base,
      document: { kind: 'reply' as const, interactionId: 'b'.repeat(64), sequence: 3 },
    };
    await getRealtimeToken(turn2);
    await getRealtimeToken(turn3);
    await getRealtimeToken(base);
    await getRealtimeToken(turn2);
    expect(post).toHaveBeenCalledTimes(3);
    expect(post).toHaveBeenNthCalledWith(1, `/projects/${PID}/intents/${UUID}/realtime-token`, {
      executionBackend: 'native',
      document: { kind: 'reply', interactionId: 'a'.repeat(64), sequence: 2 },
    });
    expect(post).toHaveBeenNthCalledWith(3, `/projects/${PID}/intents/${UUID}/realtime-token`, {
      executionBackend: 'native',
    });
    [turn2, turn3, base].forEach(invalidateRealtimeToken);
  });
});
