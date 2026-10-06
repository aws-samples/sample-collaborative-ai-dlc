/**
 * Read the business revision BEFORE the checkpoint barrier, then take the
 * payload from the live CRDT. If a peer wins the business CAS, repeat both
 * steps. Never retry the captured payload against a newer revision.
 */
export async function saveCollaborativeProjection<T, V>({
  readVersion,
  flush,
  readData,
  write,
}: {
  readVersion: () => Promise<V>;
  flush: () => Promise<void>;
  readData: () => T;
  write: (data: T, version: V) => Promise<void>;
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const version = await readVersion();
    await flush();
    const data = readData();
    try {
      await write(data, version);
      return data;
    } catch (error) {
      const conflict = error as { status?: number; body?: { code?: string } };
      if (attempt >= 2 || conflict.status !== 409 || conflict.body?.code !== 'edit_conflict')
        throw error;
    }
  }
}
