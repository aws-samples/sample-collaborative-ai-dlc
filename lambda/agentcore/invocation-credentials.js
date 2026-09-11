import { AsyncLocalStorage } from 'node:async_hooks';

// Detached stage/discussion jobs inherit this invocation's signal through
// their async context. Concurrent invocations never share cancellation state.
const credentials = new AsyncLocalStorage();

export const withCredentialSignal = (signal, operation) => credentials.run(signal, operation);
export const currentCredentialSignal = () => credentials.getStore();

const FAILURES = Object.freeze({
  bedrock_credentials_expired:
    'Bedrock credentials expired before renewal succeeded. Check the credential broker, role permissions, and connectivity, then retry the stage.',
  bedrock_authorization_expired:
    'The active invocation reached its IAM authorization limit. Retry the stage to obtain fresh authorization.',
});

export const credentialFailureError = (code) => {
  if (!Object.hasOwn(FAILURES, code)) throw new Error('Unknown IAM failure code');
  return Object.assign(new Error(FAILURES[code]), { code });
};

export const credentialFailureResult = (signal = currentCredentialSignal()) => {
  const code = signal?.aborted ? signal.reason?.code : null;
  return code && Object.hasOwn(FAILURES, code)
    ? { ok: false, state: 'FAILED', reason: code, detail: FAILURES[code] }
    : null;
};
