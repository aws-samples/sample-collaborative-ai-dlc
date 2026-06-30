import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  });

  it('isIntentDoc / isIntentChannel recognize the intent shapes', () => {
    expect(isIntentChannel(`intent:${UUID}`)).toBe(UUID);
    expect(isIntentChannel(`sprint:${UUID}`)).toBeNull();
    expect(isIntentDoc(`intent-discussion-${UUID}-d1`)).toBe(UUID);
    expect(isIntentDoc(`intent-sq-${UUID}-q1`)).toBe(UUID);
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
