import gremlin from 'gremlin';
import { randomUUID } from 'node:crypto';
import { fetchMembershipRole } from '../shared/trackers.js';
import { getConnectionRow, verifyProject } from './providers/jira-cloud.js';
import { ProviderError } from './providers/errors.js';

const { cardinality } = gremlin.process;

// The route authorizes the space admin and resolves any existing binding.
// Jira owns consent and the provider identity that a reconnection must preserve.
export const prepareJiraDelegation = async ({ existing, data, userId, ddb, ssm, secrets }) => {
  if (existing && existing.provider !== 'jira-cloud') {
    throw new ProviderError(400, 'Reconnection must preserve the bound Jira project');
  }
  if (data.confirmDelegation !== true) {
    throw new ProviderError(400, 'Confirm that this space may use your Jira connection', {
      code: 'DELEGATION_REQUIRED',
    });
  }
  const delegation = await verifyProject(
    { ddb, ssm, secrets, userId },
    data.externalProjectKey,
    existing?.externalProjectId || existing?.externalProjectKey,
  );
  if (existing?.cloudId && existing.cloudId !== delegation.cloudId) {
    throw new ProviderError(
      409,
      'Reconnect to the original Jira site; use a new binding for a different site',
    );
  }
  return delegation;
};

// Persist only a verified delegation. Keep the original vertex and creation
// history on reconnect so existing intents continue referencing this binding.
export const writeJiraBinding = async (g, { projectId, existing, data, userId, delegation }) => {
  const id = existing?.id || randomUUID();
  const createdAt = existing?.createdAt || new Date().toISOString();
  const instance = data.instance || 'public';
  const externalProjectKey = data.externalProjectKey;
  const displayName = data.displayName || externalProjectKey;
  let write = existing
    ? g.V().has('Project', 'id', projectId).out('HAS_TRACKER').has('id', id)
    : g
        .V()
        .has('Project', 'id', projectId)
        .as('p')
        .addV('TrackerBinding')
        .property(cardinality.single, 'id', id)
        .property(cardinality.single, 'provider', 'jira-cloud')
        .property(cardinality.single, 'instance', instance)
        .property(cardinality.single, 'external_project_key', externalProjectKey)
        .property(cardinality.single, 'display_name', displayName)
        .property(cardinality.single, 'created_at', createdAt)
        .property(cardinality.single, 'created_by', userId);
  write = write
    .property(cardinality.single, 'connection_user_id', delegation.connectionUserId)
    .property(cardinality.single, 'cloud_id', delegation.cloudId)
    .property(cardinality.single, 'external_project_id', delegation.externalProjectId)
    .property(cardinality.single, 'external_project_key', externalProjectKey)
    .property(cardinality.single, 'status', 'active')
    .property(cardinality.single, 'invalid_reason', '')
    .property(cardinality.single, 'delegated_at', new Date().toISOString());
  if (!existing) write = write.as('b').addE('HAS_TRACKER').from_('p').to('b');
  await write.next();
  return {
    id,
    provider: 'jira-cloud',
    instance,
    externalProjectKey,
    displayName,
    createdAt,
    createdBy: existing?.createdBy || userId,
    ...delegation,
    status: 'active',
    invalidReason: null,
  };
};

const notReady = (reason) =>
  Object.assign(
    new ProviderError(409, 'Jira binding needs reconnection by a space owner or admin', {
      code: 'TRACKER_BINDING_NOT_READY',
      invalidReason: reason,
    }),
    { code: 'TRACKER_BINDING_NOT_READY' },
  );

// Both interactive requests and delivery use this boundary. The caller's
// membership is checked by the route; credential ownership is checked here.
export const jiraBindingContext = ({ g, ddb, projectId, binding }) => {
  const invalidate = async (reason) => {
    // A failed request must not invalidate a newer delegation installed meanwhile.
    await g
      .V()
      .has('Project', 'id', projectId)
      .out('HAS_TRACKER')
      .has('id', binding.id)
      .has('connection_user_id', binding.connectionUserId)
      .has('cloud_id', binding.cloudId)
      .has('delegated_at', binding.delegatedAt)
      .property(cardinality.single, 'status', 'invalid')
      .property(cardinality.single, 'invalid_reason', reason)
      .toList();
  };
  return {
    externalProjectId: binding.externalProjectId,
    resolveConnection: async () => {
      if (binding.status !== 'active' || !binding.connectionUserId || !binding.cloudId) {
        throw notReady(binding.invalidReason || 'delegation_required');
      }
      if (!(await fetchMembershipRole(g, projectId, binding.connectionUserId))) {
        await invalidate('delegator_removed');
        throw notReady('delegator_removed');
      }
      const row = await getConnectionRow(ddb, binding.connectionUserId);
      if (row.cloudId !== binding.cloudId) {
        await invalidate('site_changed');
        throw notReady('site_changed');
      }
      return row;
    },
    onConnectionError: async (error) => {
      if (
        ['JIRA_GRANT_REVOKED', 'OAUTH_CLIENT_CHANGED', 'NOT_CONNECTED'].includes(error.code) ||
        error.name === 'ParameterNotFound'
      ) {
        await invalidate('connection_unavailable');
        throw notReady('connection_unavailable');
      }
      throw error;
    },
  };
};
