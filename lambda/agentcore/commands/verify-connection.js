// verify-connection — check an unsaved connection before anyone activates it. The agents
// Lambda signs a 'verify-connection' grant for exactly one binding, the broker redeems it
// through the owning provider without renewal, and the verifier registered for the binding's
// mode runs with the credentials this invocation prepared.
//
// Every outcome is HTTP 200 JSON, so AgentCore returns the body instead of an SDK exception.
import {
  CONNECTION_VERIFICATION_FAILURES,
  connectionVerifierFor,
} from '../credential-material-registry.js';

const VERIFICATION_FAILED = 'AGENT_AUTH_VERIFICATION_FAILED';
const RUNTIME_UNSUPPORTED = 'AGENT_AUTH_RUNTIME_UNSUPPORTED';

const failure = (code) => ({
  verified: false,
  code,
  error: CONNECTION_VERIFICATION_FAILURES[code],
});

// Replaces an error thrown before or by the verifier. The error's own text, the grant and any
// credential never reach the response; only a registered code chooses the message.
export const connectionVerificationFailure = (error) =>
  failure(
    Object.hasOwn(CONNECTION_VERIFICATION_FAILURES, error?.code) ? error.code : VERIFICATION_FAILED,
  );

export const verifyConnection = async (
  _payload,
  { bindings = [], resolvedProviders = [], env = {} } = {},
) => {
  const [binding] = bindings;
  // Only the one signed connection, and only once its material was prepared here.
  if (
    bindings.length !== 1 ||
    binding.version !== 2 ||
    !resolvedProviders.includes(binding.provider)
  )
    return failure(VERIFICATION_FAILED);
  const verify = connectionVerifierFor(binding.mode);
  if (!verify) return failure(RUNTIME_UNSUPPORTED);
  const result = await verify({ binding, env });
  return result && typeof result === 'object' && typeof result.verified === 'boolean'
    ? result
    : failure(VERIFICATION_FAILED);
};
