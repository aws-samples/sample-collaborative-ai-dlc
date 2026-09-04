// TODO(#276): fold into the Tanstack Query migration when it replaces the
// hand-rolled module caches — this sessionStorage layer is preview-era glue.
const VERSION = 1;
const PREFIX = `aidlc-cache:v${VERSION}:`;
const MAX_AGE_MS = 10 * 60 * 1000;

interface PersistedEnvelope<T> {
  data: T;
  fetchedAt: number;
}

export function loadPersisted<T>(key: string): { data: T; fetchedAt: number } | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const envelope: PersistedEnvelope<T> = JSON.parse(raw);
    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      typeof envelope.fetchedAt !== 'number' ||
      !('data' in envelope)
    ) {
      sessionStorage.removeItem(PREFIX + key);
      return null;
    }
    if (Date.now() - envelope.fetchedAt > MAX_AGE_MS) {
      sessionStorage.removeItem(PREFIX + key);
      return null;
    }
    return { data: envelope.data, fetchedAt: envelope.fetchedAt };
  } catch {
    try {
      sessionStorage.removeItem(PREFIX + key);
    } catch {
      /* noop */
    }
    return null;
  }
}

export function persist<T>(key: string, entry: { data: T; fetchedAt: number }): void {
  try {
    const envelope: PersistedEnvelope<T> = { data: entry.data, fetchedAt: entry.fetchedAt };
    sessionStorage.setItem(PREFIX + key, JSON.stringify(envelope));
  } catch {
    /* noop */
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
