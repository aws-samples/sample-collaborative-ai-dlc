import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { runtimeTargetInput } from './runtime-target.js';
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
  const target = runtimeTargetInput({ environment: capabilities }, env.AGENTCORE_RUNTIME_ARN || '');
  if (!target.agentRuntimeArn) return capabilities ?? {};
  try {
    const result = await runtime.send(
      new InvokeAgentRuntimeCommand({
        ...target,
        runtimeSessionId: 'aidlc-auth-qualification-0000000001',
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
