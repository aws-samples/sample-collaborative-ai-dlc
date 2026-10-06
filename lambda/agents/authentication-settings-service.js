import { randomUUID } from 'node:crypto';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getVal } from '../shared/trackers.js';
import { writeCredentialScope } from '../shared/agent-credentials.js';
import {
  readCredentialScopeStatusViaBroker,
  invokeMetadataBroker,
} from '../shared/agent-credential-metadata.js';
import {
  AUTH_MECHANISMS,
  assertIdentifier,
  authError,
  normalizeConnection,
} from '../shared/agent-auth-contracts.js';
import {
  AGENT_AUTH_MODES_CATALOG,
  KEY_PROVIDERS,
  authModeDescriptor,
} from '../shared/agent-auth-providers.js';
import {
  createAgentConnectionRepository,
  legacyConnectionId,
} from '../shared/agent-connection-repository.js';
import { spaceConnectionIdFor } from '../shared/agent-auth-selection-strategies.js';
import { createAgentAuthChangeService } from '../shared/agent-auth-changes.js';
import { credentialUpdateCandidate } from '../shared/agent-auth-key-changes.js';
import { runtimeTargetInput } from '../shared/runtime-target.js';
import { AUTHENTICATION_SETTINGS_PROVIDERS } from './authentication-settings-providers.js';
import { createConnectionVerifier } from './authentication-connection-verification.js';

const PROVIDER_KEYS = Object.freeze(['mode', 'draft', 'actions']);
const DRAFT_KEYS = Object.freeze(['mechanism', 'prepare']);
const response = (statusCode, body) => ({ statusCode, body });
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Unknown keys are refused so a misspelled `draft` cannot silently disable setup.
const composeSettingsProviders = (providers) => {
  if (!Array.isArray(providers))
    throw new TypeError('Authentication settings providers must be a list');
  const byMode = new Map();
  for (const provider of providers) {
    const descriptor = authModeDescriptor(provider?.mode);
    const invalid = (problem) =>
      new TypeError(`Authentication settings provider ${provider?.mode} ${problem}`);
    if (!isRecord(provider) || !descriptor || descriptor.planned)
      throw invalid('must name an available authentication mode');
    const unsupported = Object.keys(provider).filter((key) => !PROVIDER_KEYS.includes(key));
    if (unsupported.length) throw invalid(`declares unsupported fields: ${unsupported.join(', ')}`);
    if (byMode.has(provider.mode)) throw invalid('is registered twice');
    const { draft, actions = {} } = provider;
    if (draft !== undefined) {
      if (!isRecord(draft)) throw invalid('declares a draft that is not an object');
      const unknown = Object.keys(draft).filter((key) => !DRAFT_KEYS.includes(key));
      if (unknown.length) throw invalid(`declares unsupported draft fields: ${unknown.join(', ')}`);
      if (!descriptor.mechanisms.includes(draft.mechanism))
        throw invalid('declares a draft whose mechanism is not one of its mode');
      if (draft.prepare !== undefined && typeof draft.prepare !== 'function')
        throw invalid('declares a draft prepare that is not a function');
    }
    if (!isRecord(actions) || Object.values(actions).some((action) => typeof action !== 'function'))
      throw invalid('declares actions that are not functions');
    byMode.set(
      provider.mode,
      Object.freeze({
        mode: provider.mode,
        backend: descriptor.backend,
        draft: draft ? Object.freeze({ ...draft }) : null,
        actions: new Map(Object.entries(actions)),
      }),
    );
  }
  return byMode;
};
// Built at load from the root, so a misregistered provider fails the Lambda at init.
const SETTINGS_PROVIDERS = composeSettingsProviders(AUTHENTICATION_SETTINGS_PROVIDERS);

// A mode's ready platform default lets the policy switch without provider setup.
const AUTH_MODE_VIEWS = Object.freeze(
  AGENT_AUTH_MODES_CATALOG.map((mode) => {
    const { defaultConnectionId } = authModeDescriptor(mode.id);
    return defaultConnectionId ? Object.freeze({ ...mode, defaultConnectionId }) : mode;
  }),
);
// Personal and space key routes carry key fields only; connections change through review.
const KEY_ROUTE_FIELDS = Object.freeze([
  ...Object.values(KEY_PROVIDERS).map(({ inputField }) => inputField),
  'reviewAction',
  'reviewId',
]);

export const createAuthenticationSettingsService = ({
  ddb,
  ssm,
  withNeptune,
  agentcore,
  logger,
  resolveTarget,
  env = process.env,
  providers = AUTHENTICATION_SETTINGS_PROVIDERS,
}) => {
  const settingsProviders =
    providers === AUTHENTICATION_SETTINGS_PROVIDERS
      ? SETTINGS_PROVIDERS
      : composeSettingsProviders(providers);
  const repository = createAgentConnectionRepository({
    ddb,
    tableName: env.V2_PROCESS_TABLE,
    base: env.AGENT_SETTINGS_SSM_PREFIX || '',
  });
  const verifyConnection = createConnectionVerifier({ agentcore, ssm, repository, logger });
  const resolveSpace = async (projectId) => {
    const runtimeTarget = await resolveTarget(assertIdentifier(projectId, 'projectId'));
    if (!runtimeTarget) throw authError('AGENT_AUTH_INVALID', 'Space not found');
    return runtimeTarget;
  };
  const loadAuthenticationInventory = async (candidate) => {
    const rows = await repository.loadInventory(candidate);
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
      repository,
      loadInventory: loadAuthenticationInventory,
    });
  // Keys keep their legacy key overrides; other modes follow the default selection strategy,
  // so the view shows the connection new work in this scope would use.
  const effectiveConnection = async ({ policy, source, projectId, userId, scopeStatus }) => {
    if (policy.mode !== 'keys') {
      const selected =
        source === 'space'
          ? spaceConnectionIdFor({
              policy,
              spaceSelection: await repository.getSpaceSelection(projectId),
            })
          : null;
      return {
        connectionId: selected ?? policy.defaultConnectionId,
        hasOverride: Boolean(selected),
        ready: true,
      };
    }
    const platformStatus =
      source === 'platform' && scopeStatus
        ? scopeStatus
        : await readCredentialScopeStatusViaBroker({ source: 'platform' });
    const hasOverride = source !== 'platform' && scopeStatus?.bedrockBearerTokenSet;
    return {
      connectionId: hasOverride
        ? legacyConnectionId({ provider: 'bedrock', source, projectId, userId })
        : policy.defaultConnectionId,
      hasOverride: Boolean(hasOverride),
      ready: hasOverride ? scopeStatus.bedrockBearerTokenSet : platformStatus.bedrockBearerTokenSet,
    };
  };
  const authenticationView = async ({
    source = 'platform',
    projectId,
    userId,
    scopeStatus,
    actor,
  } = {}) => {
    const policy = await repository.getPolicy();
    const { connectionId, hasOverride, ready } = await effectiveConnection({
      policy,
      source,
      projectId,
      userId,
      scopeStatus,
    });
    const connection = await repository.getConnection(connectionId);
    return {
      policy,
      modes: AUTH_MODE_VIEWS,
      reviewRequired: Boolean(env.V2_PROCESS_TABLE),
      connection: connection
        ? {
            ...normalizeConnection(connection),
            ...(connection.id.startsWith('legacy-') && !ready ? { state: 'missing' } : {}),
          }
        : null,
      personalMechanisms: (authModeDescriptor(policy.mode)?.mechanisms ?? []).filter((mechanism) =>
        AUTH_MECHANISMS[mechanism].scopes.includes('user'),
      ),
      hasOverride,
      canManageConnections: Boolean(actor?.platformAdmin),
    };
  };
  // Turns a browser request into a reviewable candidate. Clients never submit connection-create
  // or credential-update themselves: ids, revisions and scope are chosen here.
  const changeCandidate = async (request) => {
    if (!isRecord(request))
      throw authError('AGENT_AUTH_INVALID', 'Unsupported configuration change');
    const { kind } = request;
    if (kind === undefined || kind === 'policy' || kind === 'policy-change')
      return {
        kind: 'policy-change',
        mode: request.mode,
        defaultConnectionId: request.defaultConnectionId,
      };
    if (kind === 'space-selection') {
      if (request.connectionId !== null)
        throw authError('AGENT_AUTH_INVALID', 'A space can only return to the platform connection');
      await resolveSpace(request.projectId);
      return { kind, projectId: request.projectId, connectionId: null };
    }
    if (kind === 'connection-draft') {
      const provider = settingsProviders.get(request.mode);
      if (!provider?.draft)
        throw authError(
          'AGENT_AUTH_MODE_UNAVAILABLE',
          'The selected authentication mode does not support connection setup',
        );
      const { projectId } = request;
      if (projectId !== undefined) {
        await resolveSpace(projectId);
        // A space connection only overrides the active mode; never store a dormant selection.
        if ((await repository.getPolicy()).mode !== provider.mode)
          throw authError(
            'AGENT_AUTH_MODE_MISMATCH',
            'Space connections must use the active platform authentication mode',
          );
      }
      const { configuration } = request;
      return {
        kind: 'connection-create',
        select: true,
        connection: {
          id: `${provider.mode}-${randomUUID()}`,
          revision: 1,
          mode: provider.mode,
          backend: provider.backend,
          mechanism: provider.draft.mechanism,
          source: projectId === undefined ? 'platform' : 'space',
          ...(projectId === undefined ? {} : { projectId }),
          configuration: provider.draft.prepare?.(configuration) ?? configuration,
        },
      };
    }
    throw authError('AGENT_AUTH_INVALID', 'Unsupported configuration change');
  };
  // Provider setup steps (defaults, generated documents, verification). Every step is
  // platform-admin-only; the route checks too, this keeps the service safe on its own.
  const providerAction = async (body, actor) => {
    if (!actor?.platformAdmin)
      return response(403, { error: 'Platform administrator access required' });
    const { mode, action, projectId = null, ...input } = body;
    const provider = settingsProviders.get(mode);
    if (!provider) return response(404, { error: 'Unsupported authentication mode' });
    const handle = provider.actions.get(action);
    if (!handle) return response(400, { error: 'Unsupported authentication setup action' });
    try {
      let runtimeTarget = runtimeTargetInput(null, env.AGENTCORE_RUNTIME_ARN || '');
      if (projectId !== null) {
        runtimeTarget = await resolveTarget(assertIdentifier(projectId, 'projectId'));
        if (!runtimeTarget) return response(404, { error: 'Space not found' });
      }
      return await handle(input, {
        env,
        logger,
        projectId,
        runtimeTarget,
        verifyConnection: ({ mechanism, configuration }) =>
          verifyConnection({ mode, mechanism, configuration, projectId, runtimeTarget }),
      });
    } catch (error) {
      if (error?.code === 'AGENT_AUTH_INVALID') return response(400, { error: error.message });
      logger.error(`[authentication setup] ${mode} ${action} failed`, error);
      return response(502, {
        error: 'The authentication setup step failed. Check the application logs and retry.',
      });
    }
  };
  const reviewedCredentialUpdate = async ({ input, source, projectId, userId, actorId }) => {
    // The platform body also carries model settings, so only the key routes are closed.
    if (
      ['user', 'space'].includes(source) &&
      Object.keys(input ?? {}).some((key) => !KEY_ROUTE_FIELDS.includes(key))
    )
      throw authError('AGENT_AUTH_INVALID', 'Credential updates accept key fields only');
    const update = () =>
      writeCredentialScope(ssm, {
        base: env.AGENT_SETTINGS_SSM_PREFIX || '',
        source,
        projectId,
        userId,
        update: input,
      });
    if (!env.V2_PROCESS_TABLE) return update();
    const activePolicy = await repository.getPolicy();
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
    changeCandidate,
    providerAction,
    reviewedCredentialUpdate,
    loadAuthenticationInventory,
  };
};
