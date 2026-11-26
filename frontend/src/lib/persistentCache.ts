// TODO(#276): fold into the Tanstack Query migration when it replaces the
// hand-rolled module caches — this sessionStorage layer is preview-era glue.
const PREFIX = 'aidlc-cache:v2:';
const MAX_AGE_MS = 10 * 60 * 1000;
// A document owns at most one authenticated session. Its module caches,
// subscriptions and in-flight requests must never be reused by another.
let subject: string | null = null;
let ended = false;

export type UserCacheBinding = 'bound' | 'missing-user' | 'session-ended' | 'different-user';

const boundListeners = new Set<() => void>();

/** The query client reopens when a user is bound. */
export function onUserCacheBound(listener: () => void): () => void {
  boundListeners.add(listener);
  return () => {
    boundListeners.delete(listener);
  };
}

export function bindUserCache(userId: string | null | undefined): UserCacheBinding {
  if (!userId) return 'missing-user';
  if (ended) return 'session-ended';
  if (subject !== null && subject !== userId) return 'different-user';
  subject = userId;
  for (const listener of Array.from(boundListeners)) listener();
  return 'bound';
}

export type UserCacheEndReason = 'logout' | 'user-switch' | 'session-expired';
const endListeners = new Set<(reason: UserCacheEndReason) => void>();

/** The query client registers here to be emptied with the session. */
export function onUserCacheEnded(listener: (reason: UserCacheEndReason) => void): () => void {
  endListeners.add(listener);
  return () => {
    endListeners.delete(listener);
  };
}

export function endUserCache(reason: UserCacheEndReason = 'logout'): void {
  if (subject !== null) ended = true;
  clearPersistedCache();
  for (const listener of Array.from(endListeners)) listener(reason);
}

function storageKey(key: string): string | null {
  return subject && !ended ? `${PREFIX}${encodeURIComponent(subject)}:${key}` : null;
}

interface PersistedEnvelope<T> {
  data: T;
  fetchedAt: number;
}

export function loadPersisted<T>(key: string): { data: T; fetchedAt: number } | null {
  const scopedKey = storageKey(key);
  if (!scopedKey) return null;
  try {
    const raw = sessionStorage.getItem(scopedKey);
    if (!raw) return null;
    const envelope: PersistedEnvelope<T> = JSON.parse(raw);
    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      typeof envelope.fetchedAt !== 'number' ||
      !('data' in envelope)
    ) {
      sessionStorage.removeItem(scopedKey);
      return null;
    }
    if (Date.now() - envelope.fetchedAt > MAX_AGE_MS) {
      sessionStorage.removeItem(scopedKey);
      return null;
    }
    return { data: envelope.data, fetchedAt: envelope.fetchedAt };
  } catch {
    try {
      sessionStorage.removeItem(scopedKey);
    } catch {
      /* noop */
    }
    return null;
  }
}

export function persist<T>(key: string, entry: { data: T; fetchedAt: number }): void {
  const scopedKey = storageKey(key);
  if (!scopedKey) return;
  try {
    const envelope: PersistedEnvelope<T> = { data: entry.data, fetchedAt: entry.fetchedAt };
    sessionStorage.setItem(scopedKey, JSON.stringify(envelope));
  } catch {
    /* noop */
  }
}

export function removePersisted(key: string): void {
  const scopedKey = storageKey(key);
  if (!scopedKey) return;
  try {
    sessionStorage.removeItem(scopedKey);
  } catch {
    /* storage is optional */
  }
}

/** Remove all `aidlc-cache:*` keys from sessionStorage. Call on logout. */
export function clearPersistedCache(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('aidlc-cache:')) toRemove.push(k);
    }
    for (const k of toRemove) sessionStorage.removeItem(k);
  } catch {
    /* noop */
  }
}
