import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const context = new AsyncLocalStorage();
export const currentCredentialSession = () => context.getStore() ?? null;
const unavailable = (reason = 'credential_expired') =>
  Object.assign(new Error('Invocation credential is no longer available'), { code: reason });

// One invocation owns one session. Detached work retains it explicitly; no
// secrets, refresh promises or cancellation state are shared between sessions.
export const createCredentialSession = ({
  env = {},
  credentialEnvironment = {},
  expiresAt = null,
  authorizationExpiresAt = null,
  refresh = null,
  refreshBeforeMs = 60_000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  const controller = new AbortController();
  const resources = [];
  let preparedEnv = { ...env };
  let preparedCredentialEnvironment = { ...credentialEnvironment };
  let references = 1;
  let disposed = false;
  let timer = null;
  let expiryTimer = null;
  let renewing = null;
  let disposal = null;
  const cancel = (reason = unavailable()) => {
    if (!controller.signal.aborted) controller.abort(reason);
    if (timer) clearTimer(timer);
    if (expiryTimer) clearTimer(expiryTimer);
  };
  const schedule = () => {
    if (timer) clearTimer(timer);
    if (expiryTimer) clearTimer(expiryTimer);
    if (disposed || controller.signal.aborted) return;
    const deadline = Math.min(expiresAt ?? Infinity, authorizationExpiresAt ?? Infinity);
    if (!Number.isFinite(deadline)) return;
    // Refresh can hang or outlive the token it is replacing. Expiry remains an
    // independent cancellation boundary while that request is outstanding.
    expiryTimer = setTimer(() => cancel(), Math.max(1, deadline - now()));
    expiryTimer.unref?.();
    const canRefresh = refresh && (!authorizationExpiresAt || deadline < authorizationExpiresAt);
    const due = deadline - (canRefresh ? refreshBeforeMs : 0);
    timer = setTimer(
      () => {
        if (!canRefresh) {
          cancel();
          return;
        }
        void session.renew().catch(() => cancel(unavailable('credential_refresh_failed')));
      },
      Math.max(1, due - now()),
    );
    timer.unref?.();
  };
  const session = {
    id: randomUUID(),
    signal: controller.signal,
    get expiresAt() {
      return expiresAt;
    },
    get disposed() {
      return disposed;
    },
    get env() {
      session.assertAvailable();
      return { ...preparedEnv };
    },
    get credentialEnvironment() {
      session.assertAvailable();
      return { ...preparedCredentialEnvironment };
    },
    assertAvailable() {
      if (
        disposed ||
        controller.signal.aborted ||
        (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now())) ||
        (authorizationExpiresAt !== null &&
          (!Number.isFinite(authorizationExpiresAt) || authorizationExpiresAt <= now()))
      ) {
        cancel();
        throw controller.signal.reason;
      }
    },
    cancel,
    renew() {
      if (renewing) return renewing;
      renewing = (async () => {
        session.assertAvailable();
        if (!refresh) return;
        const next = await refresh();
        session.assertAvailable();
        if (
          !next ||
          !Number.isFinite(next.expiresAt) ||
          next.expiresAt <= now() + refreshBeforeMs
        ) {
          throw unavailable('credential_refresh_failed');
        }
        // The provider's initial authorization ceiling never slides on renewal.
        expiresAt = next.expiresAt;
        preparedEnv = { ...next.env };
        preparedCredentialEnvironment = { ...next.credentialEnvironment };
        schedule();
      })()
        .catch((error) => {
          cancel(unavailable('credential_refresh_failed'));
          throw error;
        })
        .finally(() => {
          renewing = null;
        });
      return renewing;
    },
    own(dispose) {
      session.assertAvailable();
      resources.push(dispose);
    },
    retain() {
      session.assertAvailable();
      references += 1;
      let released = false;
      return async () => {
        if (!released) {
          released = true;
          await session.release();
        }
      };
    },
    async release() {
      references -= 1;
      if (references > 0) return;
      if (disposal) return disposal;
      disposed = true;
      cancel(unavailable('credential_session_disposed'));
      preparedEnv = {};
      preparedCredentialEnvironment = {};
      disposal = (async () => {
        for (const dispose of resources.toReversed()) {
          try {
            await dispose();
          } catch {
            /* complete remaining cleanup */
          }
        }
      })();
      return disposal;
    },
    run(operation) {
      session.assertAvailable();
      return context.run(session, operation);
    },
  };
  schedule();
  return session;
};

export const runCredentialJob = async (operation) => {
  const release = currentCredentialSession()?.retain();
  try {
    return await operation();
  } finally {
    await release?.();
  }
};

// Standalone/local callers use the same ownership boundary as HTTP dispatch.
// Nested stages/reviewers reuse the invocation session already in context.
export const withCredentialSession = async (operation, options = {}) => {
  if (currentCredentialSession()) return operation();
  const session = createCredentialSession(options);
  try {
    return await session.run(operation);
  } finally {
    await session.release();
  }
};
