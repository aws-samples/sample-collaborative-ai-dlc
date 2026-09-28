import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getVal } from '../shared/trackers.js';
import { writeCredentialScope } from '../shared/agent-credentials.js';
import {
  readCredentialScopeStatusViaBroker,
  invokeMetadataBroker,
} from '../shared/agent-credential-metadata.js';
import { normalizeConnection } from '../shared/agent-auth-contracts.js';
import { AGENT_AUTH_MODES_CATALOG } from '../shared/agent-auth-providers.js';
import {
  createAgentConnectionRepository,
  legacyConnectionId,
} from '../shared/agent-connection-repository.js';
import { createAgentAuthChangeService } from '../shared/agent-auth-changes.js';
import { credentialUpdateCandidate } from '../shared/agent-auth-key-changes.js';

export const createAuthenticationSettingsService = ({
  ddb,
  ssm,
  withNeptune,
  env = process.env,
}) => {
  const authRepository = () =>
    createAgentConnectionRepository({
      ddb,
      tableName: env.V2_PROCESS_TABLE,
      base: env.AGENT_SETTINGS_SSM_PREFIX || '',
    });
  const loadAuthenticationInventory = async (candidate) => {
    const rows = await authRepository().loadInventory(candidate);
    if (candidate.source && candidate.source !== 'platform') {
      const { source, projectId, userId } = candidate;
      const status = await readCredentialScopeStatusViaBroker({ source, projectId, userId });
      rows.push({
        type: 'CredentialScope',
        id: source === 'space' ? projectId : userId,
        source,
        projectId,
        userId,
        credentialStatus: status,
      });
      return rows;
    }
    const scopeResult = await invokeMetadataBroker({ action: 'list-agent-credential-scopes' });
    rows.push(...(scopeResult.scopes ?? []));
    let offset = 0;
    for (;;) {
      const spaces = await withNeptune((g) =>
        g
          .V()
          .hasLabel('Project')
          .order()
          .by('id')
          .range(offset, offset + 100)
          .valueMap()
          .toList(),
      );
      rows.push(
        ...spaces.map((space) => ({
          type: 'Space',
          id: getVal(space, 'id'),
          projectId: getVal(space, 'id'),
          status: 'CONFIGURED',
        })),
      );
      if (spaces.length < 100) break;
      offset += spaces.length;
    }
    if (env.ENVIRONMENT_REGISTRY_TABLE) {
      let ExclusiveStartKey;
      do {
        const page = await ddb.send(
          new ScanCommand({
            TableName: env.ENVIRONMENT_REGISTRY_TABLE,
            ConsistentRead: true,
            ExclusiveStartKey,
          }),
        );
        rows.push(
          ...(page.Items ?? []).filter(
            (row) =>
              row.type === 'EnvironmentRevision' &&
              ['PUBLISHED', 'SUPERSEDED'].includes(row.status),
          ),
        );
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
    }
    return rows;
  };
  const authenticationChanges = () =>
    createAgentAuthChangeService({
      repository: authRepository(),
      loadInventory: loadAuthenticationInventory,
    });
  const authenticationView = async ({
    source = 'platform',
    projectId,
    userId,
    scopeStatus,
  } = {}) => {
    const repository = authRepository();
    const policy = await repository.getPolicy();
    const platformStatus =
      source === 'platform' && scopeStatus
        ? scopeStatus
        : await readCredentialScopeStatusViaBroker({ source: 'platform' });
    const hasOverride = source !== 'platform' && scopeStatus?.bedrockBearerTokenSet;
    const connection = await repository.getConnection(
      hasOverride
        ? legacyConnectionId({ provider: 'bedrock', source, projectId, userId })
        : policy.defaultConnectionId,
    );
    const ready = hasOverride
      ? scopeStatus.bedrockBearerTokenSet
      : platformStatus.bedrockBearerTokenSet;
    return {
      policy,
      modes: AGENT_AUTH_MODES_CATALOG,
      reviewRequired: Boolean(env.V2_PROCESS_TABLE),
      connection: connection
        ? {
            ...normalizeConnection(connection),
            ...(connection.id.startsWith('legacy-') && !ready ? { state: 'missing' } : {}),
          }
        : null,
      personalMechanisms: ['api-key'],
    };
  };
  const reviewedCredentialUpdate = async ({ input, source, projectId, userId, actorId }) => {
    const update = () =>
      writeCredentialScope(ssm, {
        base: env.AGENT_SETTINGS_SSM_PREFIX || '',
        source,
        projectId,
        userId,
        update: input,
      });
    if (!env.V2_PROCESS_TABLE) return update();
    const activePolicy = await authRepository().getPolicy();
    if (typeof input.bedrockBearerToken === 'string' && activePolicy.mode !== 'keys') {
      throw Object.assign(
        new Error('Bedrock key overrides are unavailable in the active platform mode'),
        { code: 'AGENT_AUTH_MODE_MISMATCH' },
      );
    }
    const candidate = credentialUpdateCandidate({ source, projectId, userId, update: input });
    const service = authenticationChanges();
    if (input.reviewAction === 'preview') return service.preview(candidate, actorId);
    if (!input.reviewId)
      throw Object.assign(new Error('Review the impact before applying this credential change'), {
        code: 'AGENT_AUTH_REVIEW_REQUIRED',
      });
    return service.apply(input.reviewId, actorId, { candidate, writeCredentials: update });
  };
  return {
    authenticationChanges,
    authenticationView,
    reviewedCredentialUpdate,
    loadAuthenticationInventory,
  };
};
