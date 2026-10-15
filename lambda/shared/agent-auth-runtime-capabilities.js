import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';
import { resolveRuntimeTarget, runtimeSdkInput } from './runtime-target.js';
import { authError } from './agent-auth-catalog.js';

const client = new BedrockAgentCoreClient({});
// Legacy/default snapshots have no authentication qualification. Probe the
// actual target before issuing a versioned grant; never assume image support.
export const qualifyAgentAuthRuntime = async (
  capabilities,
  { runtime = client, env = process.env, requiredModes = [] } = {},
) => {
  if (
    capabilities?.agentAuthProtocol &&
    requiredModes.every((mode) => capabilities.agentAuthModes?.includes(mode))
  )
    return capabilities;
  const resolved = resolveRuntimeTarget(
    { environment: capabilities },
    env.AGENTCORE_RUNTIME_ARN || '',
  );
  if (!resolved.agentRuntimeArn) return capabilities ?? {};
  // On the Instances compute type every probe session gets a persistent EBS
  // volume, and this shared helper has no cleanup owner for one. It does not
  // need a probe either: an Instances revision is published only after its
  // own validation, which recorded the image's authentication support on the
  // snapshot (checked above). Missing evidence means that image cannot be
  // qualified — republishing the environment re-validates it.
  if (resolved.capacityProviderArn) {
    throw authError(
      'AGENT_AUTH_RUNTIME_UNSUPPORTED',
      'The selected environment did not record authentication support; republish it to re-validate its runtime',
    );
  }
  const target = runtimeSdkInput(resolved);
  try {
    const result = await runtime.send(
      new InvokeAgentRuntimeCommand({
        ...target,
        // Reusing a session would qualify its old image after a deployment.
        runtimeSessionId: randomUUID(),
        contentType: 'application/json',
        accept: 'application/json',
        payload: Buffer.from(JSON.stringify({ command: 'capabilities' })),
      }),
    );
    const value = JSON.parse(await result.response.transformToString());
    if (!value.ok) throw new Error('Runtime did not report capabilities');
    return { agentAuthProtocol: value.agentAuthProtocol, agentAuthModes: value.agentAuthModes };
  } catch {
    throw authError(
      'AGENT_AUTH_RUNTIME_UNSUPPORTED',
      'Could not verify authentication support in the selected runtime',
    );
  }
};
