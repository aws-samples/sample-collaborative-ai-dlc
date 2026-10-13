type SessionExpiredHandler = () => void;

const handlers = new Set<SessionExpiredHandler>();
const resetHandlers = new Set<() => void>();
const changeHandlers = new Set<() => void>();
let epoch = 0;
let notified = false;
let invalidated = false;

export function currentSessionEpoch(): number {
  return epoch;
}

/** Covers sign-out, expiry and replacement, including while auth I/O is pending. */
export function onSessionChanged(handler: () => void): () => void {
  changeHandlers.add(handler);
  return () => {
    changeHandlers.delete(handler);
  };
}

export function isSessionActive(): boolean {
  return !invalidated && !notified;
}

/** Detach the old identity before sign-out/redirect touches the credential store. */
export function invalidateSession(): void {
  invalidated = true;
  epoch += 1;
  changeHandlers.forEach((handler) => handler());
}

export function onSessionReset(handler: () => void): () => void {
  resetHandlers.add(handler);
  return () => {
    resetHandlers.delete(handler);
  };
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
  invalidateSession();
  for (const handler of handlers) {
    handler();
  }
}

export function armSessionExpiry(): void {
  notified = false;
  invalidated = false;
}

export function resetSessionExpiry(): void {
  epoch += 1;
  armSessionExpiry();
  resetHandlers.forEach((handler) => handler());
  changeHandlers.forEach((handler) => handler());
}
