import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { executionMetaKey } from '../shared/v2-process-keys.js';
import { assertScopeAvailable } from '../shared/agent-auth-inventory.js';
import { redeemAgentBinding } from '../shared/agent-auth-redemption.js';
import { createAgentConnectionRepository } from '../shared/agent-connection-repository.js';
import {
  credentialChangeAffects,
  bindingIdentity,
  authError,
} from '../shared/agent-auth-contracts.js';
import { createAgentProviderContext } from './agent-provider-registry.js';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
export const authorizeAgentCredentialRequest = async (
  event = {},
  {
    ssmClient = ssm,
    ddbClient = ddb,
    secret = null,
    env = process.env,
    now = undefined,
    ...providerDependencies
  } = {},
) => {
  const context = await createAgentProviderContext(event, {
    ssmClient,
    secret,
    env,
    now,
    ...providerDependencies,
  });
  const { claims, adapters, verification } = context;
  const repository = createAgentConnectionRepository({
    ddb: ddbClient,
    tableName: env.V2_PROCESS_TABLE,
    base: env.AGENT_SETTINGS_SSM_PREFIX || '',
  });
  await assertScopeAvailable({
    repository,
    bindings: claims.bindings,
    projectId: claims.projectId,
  });
  const policy = await repository.getPolicy();
  if (policy.pendingReview) {
    const pending = await repository.getReview(policy.pendingReview);
    if (
      claims.bindings.some((binding) =>
        credentialChangeAffects(pending?.candidate, binding, claims.projectId),
      )
    ) {
      throw authError('AGENT_AUTH_CHANGE_IN_PROGRESS', 'The selected credential is being updated');
    }
  }
  if (claims.version === 2 && claims.executionId) {
    const { Item: execution } = await ddbClient.send(
      new GetCommand({
        TableName: env.V2_PROCESS_TABLE,
        Key: executionMetaKey(claims.executionId),
        ConsistentRead: true,
      }),
    );
    if (
      !execution ||
      execution.projectId !== claims.projectId ||
      (claims.purpose === 'execution' &&
        (claims.bindings.length !== 1 ||
          bindingIdentity(execution.credentialBinding) !== bindingIdentity(claims.bindings[0])))
    ) {
      throw authError(
        'AGENT_CREDENTIAL_GRANT_INVALID',
        'Grant does not match the execution binding',
      );
    }
  }
  const credentials = await Promise.all(
    claims.bindings.map(async (binding) => {
      try {
        // Verification is a separately signed, short-lived control-plane purpose.
        // It cannot select an execution connection or mint renewal authority.
        if (verification) return { binding, ...(await context.verify(binding)) };
        return await redeemAgentBinding({
          binding,
          projectId: claims.projectId,
          repository,
          ssm: ssmClient,
          base: env.AGENT_SETTINGS_SSM_PREFIX || '',
          adapters,
        });
      } catch (error) {
        if (!context.isolateDiscoveryFailure(binding)) throw error;
        return { binding, error: context.loggableErrorCode(error) };
      }
    }),
  );
  return {
    purpose: claims.purpose,
    projectId: claims.projectId,
    executionId: claims.executionId,
    credentials,
  };
};
