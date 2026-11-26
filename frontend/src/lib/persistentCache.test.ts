import { describe, expect, it, vi } from 'vitest';

describe('authenticated document cache', () => {
  it('quarantines late writes and refuses to reuse the old document on a new login', async () => {
    vi.resetModules();
    const cache = await import('./persistentCache');
    const entry = { data: ['private space A'], fetchedAt: Date.now() };
    expect(cache.bindUserCache('A')).toBe('bound');
    cache.persist('projects', entry);
    expect(cache.loadPersisted('projects')).toEqual(entry);
    cache.endUserCache();
    cache.persist('projects', entry); // old in-flight request completes after logout
    expect(cache.loadPersisted('projects')).toBeNull();
    expect(cache.bindUserCache('B')).toBe('session-ended');
    expect(sessionStorage.getItem('aidlc-cache:v2:A:projects')).toBeNull();
  });

  it('never adopts another subject’s retained or legacy entries after a fresh page load', async () => {
    vi.resetModules();
    const cache = await import('./persistentCache');
    const entry = JSON.stringify({ data: ['previous user'], fetchedAt: Date.now() });
    sessionStorage.setItem('aidlc-cache:v1:projects', entry);
    sessionStorage.setItem('aidlc-cache:v2:A:projects', entry);
    expect(cache.loadPersisted('projects')).toBeNull();
    expect(cache.bindUserCache('B')).toBe('bound');
    expect(cache.loadPersisted('projects')).toBeNull();
    cache.endUserCache();
  });

  it('rejects an identity without a subject without ending the document session', async () => {
    vi.resetModules();
    const cache = await import('./persistentCache');
    expect(cache.bindUserCache(undefined)).toBe('missing-user');
    expect(cache.bindUserCache('B')).toBe('bound');
  });

  it('detects an account switch without binding the new user to old module state', async () => {
    vi.resetModules();
    const cache = await import('./persistentCache');
    expect(cache.bindUserCache('A')).toBe('bound');
    expect(cache.bindUserCache('B')).toBe('different-user');
    expect(cache.loadPersisted('projects')).toBeNull();
  });
});

describe('user cache end listeners', () => {
  it('tells registered in-memory caches why the user cache ended', async () => {
    vi.resetModules();
    const cache = await import('./persistentCache');
    const listener = vi.fn();
    const unsubscribe = cache.onUserCacheEnded(listener);
    cache.bindUserCache('A');
    cache.endUserCache();
    cache.endUserCache('user-switch');
    cache.endUserCache('session-expired');
    expect(listener.mock.calls).toEqual([['logout'], ['user-switch'], ['session-expired']]);
    unsubscribe();
    cache.endUserCache();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe('user cache bound listeners', () => {
  it('notifies only when a user is actually bound', async () => {
    vi.resetModules();
    const cache = await import('./persistentCache');
    const listener = vi.fn();
    cache.onUserCacheBound(listener);
    cache.bindUserCache(undefined);
    expect(listener).not.toHaveBeenCalled();
    cache.bindUserCache('A');
    cache.bindUserCache('B');
    expect(listener).toHaveBeenCalledTimes(1);
    cache.endUserCache();
    cache.bindUserCache('A');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
