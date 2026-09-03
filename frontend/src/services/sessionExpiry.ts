type SessionExpiredHandler = () => void;

const handlers = new Set<SessionExpiredHandler>();
let epoch = 0;
let notified = false;

export function currentSessionEpoch(): number {
  return epoch;
}

export function isSessionExpiryNotified(): boolean {
  return notified;
}

export function onSessionExpired(handler: SessionExpiredHandler): () => void {
  handlers.add(handler);
  if (notified) {
    handler();
  }
  return () => {
    handlers.delete(handler);
  };
}

export function notifySessionExpired(atEpoch: number = epoch): void {
  // Ignore a late failure from a session that has since been replaced.
  if (notified || atEpoch !== epoch) return;
  notified = true;
  for (const handler of handlers) {
    handler();
  }
}

export function armSessionExpiry(): void {
  notified = false;
}

export function resetSessionExpiry(): void {
  epoch += 1;
  armSessionExpiry();
}
