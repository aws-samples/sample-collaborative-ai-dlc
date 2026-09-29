import { randomUUID } from 'node:crypto';
import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { normalizeConnection } from '../shared/agent-auth-contracts.js';
import { authModeDescriptor } from '../shared/agent-auth-providers.js';
import { connectionBinding } from '../shared/agent-auth-selection-strategies.js';
import { AGENT_AUTH_MODES } from '../shared/agent-command-registry.js';
import { prepareAgentInvocation } from '../shared/agent-credential-service.js';

// Responses carry no runtime, grant or provider text; operators correlate through the logs.
const STAGE_ERRORS = Object.freeze({
  configuration: 'Could not prepare the connection check. Check the application configuration.',
  authorization:
    'Could not authorize the connection check. Check the application’s credential grant configuration and retry.',
  runtime:
    'Could not invoke the runtime to check the connection. Check the runtime deployment and application invoke permission, then retry.',
  rejected:
    'The runtime rejected the connection check. Check its logs for credential or configuration errors.',
  response: 'The runtime returned an unreadable connection check result. Check the runtime logs.',
});

const response = (statusCode, body) => ({ statusCode, body });

// Checks an unsaved connection in the runtime that would use it. The probe, qualification and
// check share one fresh session, so they all inspect the image deployed right now.
export const createConnectionVerifier =
  ({ agentcore, ssm, repository, logger }) =>
  async ({ mode, mechanism, configuration, projectId = null, runtimeTarget }) => {
    if (!runtimeTarget?.agentRuntimeArn)
      return response(503, { error: 'Agent runtime is not configured' });
    let stage = 'configuration';
    try {
      const credentialBinding = connectionBinding(
        normalizeConnection({
          id: `${mode}-verification-${randomUUID()}`,
          revision: 1,
          mode,
          backend: authModeDescriptor(mode)?.backend,
          mechanism,
          source: projectId ? 'space' : 'platform',
          projectId,
          configuration,
        }),
        (await repository.getPolicy()).revision,
      );
      const runtimeSessionId = randomUUID();
      const invoke = async (payload) => {
        stage = 'runtime';
        const result = await agentcore.send(
          new InvokeAgentRuntimeCommand({
            ...runtimeTarget,
            runtimeSessionId,
            contentType: 'application/json',
            accept: 'application/json',
            payload: Buffer.from(JSON.stringify(payload)),
          }),
        );
        stage = 'response';
        const text = result.response ? await result.response.transformToString() : '';
        return text ? JSON.parse(text) : null;
      };
      const runtimeCapabilities = await invoke({ command: 'capabilities' });
      // Older images cannot check this mode; say so instead of failing on an unknown command.
      const verifiable = runtimeCapabilities?.agentAuthVerification;
      if (!Array.isArray(verifiable) || !verifiable.includes(mode))
        return response(200, {
          verified: false,
          code: 'AGENT_AUTH_RUNTIME_UNSUPPORTED',
          error:
            'Publish an environment whose runtime supports connection verification for this mode',
        });
      stage = 'authorization';
      const { agentCredentialGrant } = await prepareAgentInvocation(
        {
          purpose: AGENT_AUTH_MODES.VERIFY_CONNECTION,
          projectId,
          credentialBinding,
          runtimeCapabilities,
        },
        { ssm },
      );
      const result = await invoke({
        command: 'verify-connection',
        projectId,
        credentialBinding,
        agentCredentialGrant,
      });
      return response(200, result ?? { verified: false, error: 'Empty response from runtime' });
    } catch (error) {
      if (error?.code === 'AGENT_AUTH_INVALID') return response(400, { error: error.message });
      const rejected = stage === 'runtime' && error?.name === 'RuntimeClientError';
      logger.error('Connection verification request failed', {
        mode,
        stage,
        runtimeRejected: rejected,
        requestId: error?.$metadata?.requestId,
      });
      return response(502, { error: STAGE_ERRORS[rejected ? 'rejected' : stage] });
    }
  };
