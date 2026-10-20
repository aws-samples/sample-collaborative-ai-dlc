import {
  beginCredentialInvocation,
  heartbeatCredentialInvocation,
  finishCredentialInvocation,
} from '../shared/invocation-accounting.js';

export const brokerInvocationAccounting = (accounting, broker) => {
  if (
    typeof accounting?.invocationId !== 'string' ||
    !accounting.invocationId ||
    typeof accounting.ticket !== 'string' ||
    !accounting.ticket
  )
    throw Object.assign(new Error('Broker invocation accounting is required'), {
      code: 'INVOCATION_ACCOUNTING_INVALID',
    });
  // Final session disposal runs outside Gateway ALS and after dispatch expiry.
  const ticket = accounting.ticket;
  const invoke = async (action) => {
    const result = await broker({ action, ticket });
    if (result?.ok !== true)
      throw Object.assign(new Error('Broker invocation accounting failed'), {
        code: 'INVOCATION_ACCOUNTING_FAILED',
      });
  };
  let finishing;
  return {
    heartbeat: () => invoke('heartbeat-invocation'),
    finish: () => (finishing ??= invoke('finish-invocation')),
  };
};

// Stale heartbeats are uncertainty, not proof that detached work has stopped.
export const ownInvocationAccounting = async ({ session, heartbeat, finish }) => {
  let stopped = false;
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped) return;
    pending = pending.then(heartbeat).catch(() => {
      /* inventory reports stale evidence */
    });
  }, 30_000);
  timer.unref?.();
  const dispose = async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
    await finish();
  };
  try {
    session.own(dispose);
  } catch (error) {
    await dispose();
    throw error;
  }
};

export const accountCredentialInvocation = async ({ session, ...options }) => {
  const invocation = await beginCredentialInvocation(options);
  if (!invocation) return;
  await ownInvocationAccounting({
    session,
    heartbeat: () => heartbeatCredentialInvocation({ ...options, invocation }),
    finish: () => finishCredentialInvocation({ ...options, invocation }),
  });
};
