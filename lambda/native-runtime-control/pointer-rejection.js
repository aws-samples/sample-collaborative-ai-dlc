import { createHash } from 'node:crypto';

// A queue pointer carries no authority: its consumer first reloads the
// protected execution. NATIVE_EXECUTION_INVALID from that read means the
// pointer names no valid identity or the stored execution fails the current
// contract. The store validates before every write, so no current writer can
// change that answer and redelivery only repeats it. The consumer therefore
// acknowledges such a pointer instead of retrying it for the queue's retention.
// The periodic repair sweep keeps sending a pointer for every active or
// published execution, so a record that a later release can read again is
// picked up without the acknowledged pointer.
//
// Only that first read is marked. The same code from a later call refuses one
// request or patch, not the execution, and keeps its ordinary retry.
const rejected = new WeakSet();
export const rejectNativePointer = (error) => {
  if (error?.code === 'NATIVE_EXECUTION_INVALID') rejected.add(error);
  throw error;
};
export const nativePointerRejected = (error) =>
  error !== null && typeof error === 'object' && rejected.has(error);

// One line per acknowledged pointer: no body, identity, token or message text.
// The hash is the one native_execution_reconciled and the diagnostics log.
export const logNativePointerRejected = (logger, event, code, pointer) => {
  const { projectId, executionId } = pointer ?? {};
  logger.info(
    JSON.stringify({
      event,
      code,
      ...(typeof projectId === 'string' && typeof executionId === 'string'
        ? {
            scopeHash: createHash('sha256')
              .update(JSON.stringify({ projectId, executionId }))
              .digest('hex'),
          }
        : {}),
    }),
  );
};
