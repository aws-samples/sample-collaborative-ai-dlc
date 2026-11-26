// A successful write that adds, removes or re-statuses an intent. Views that
// keep a space's intent list outside the query cache (the spaces cache behind
// the sidebar, dashboard and command palette) subscribe here to re-read it.
type IntentListWriteListener = (projectId: string) => void;

const listeners = new Set<IntentListWriteListener>();

export function onIntentListWrite(listener: IntentListWriteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyIntentListWrite(projectId: string): void {
  for (const listener of listeners) listener(projectId);
}
