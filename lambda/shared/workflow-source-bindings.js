// Workflow sources are deliberately separate from application repo
// bindings: replacing code repositories must not delete these rows, and native
// workers must not receive access to this table or its credential references.
import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { appCredentialRef, oauthCredentialRef } from './source-control-bindings.js';
import { isGitConnectionCreatedAt, isGitConnectionIdentity } from './git-connection-identity.js';

export class WorkflowSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkflowSourceError';
    this.code = code;
  }
}

const invalid = (message) => {
  throw new WorkflowSourceError('WORKFLOW_SOURCE_INVALID', message);
};
const boundedString = (value, max = 256) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => character.codePointAt(0) < 32 || character === '\x7f');
const graphIdentity = (value) => boundedString(value, 512) && value.trim() === value;
const assertAuthorization = (authorization) => {
  if (
    !authorization ||
    Object.getPrototypeOf(authorization) !== Object.prototype ||
    Reflect.ownKeys(authorization).length !== 3 ||
    !Object.hasOwn(authorization, 'role') ||
    !Object.hasOwn(authorization, 'membershipId') ||
    !Object.hasOwn(authorization, 'projectIdentity') ||
    !['owner', 'admin'].includes(authorization.role) ||
    !graphIdentity(authorization.membershipId) ||
    !graphIdentity(authorization.projectIdentity)
  ) {
    invalid('A current administrator membership snapshot is required');
  }
};
const hasPublicCredentialFields = (value) =>
  Object.keys(value).some((name) =>
    /^(?:credential|connection|installation)|token|^(?:parameterName|username|password|authorization|cookie|refresh)$/i.test(
      name,
    ),
  );

export const workflowSourceIdentity = (provider, repository) => {
  if (!['github', 'gitlab', 'bitbucket'].includes(provider)) {
    invalid('Unsupported workflow source provider');
  }
  if (!boundedString(repository, 512)) invalid('Invalid workflow source repository');
  const parts = repository.split('/');
  if (
    parts.length < 2 ||
    (provider !== 'gitlab' && parts.length !== 2) ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
  ) {
    invalid('Use a repository identity without a URL or credentials');
  }
  const canonical = repository.toLowerCase();
  return Object.freeze({
    provider,
    repository: canonical,
    sourceId: createHash('sha256').update(`${provider}\n${canonical}`).digest('hex'),
  });
};

const keyFor = (projectId, sourceId) => {
  if (!boundedString(projectId)) invalid('Invalid project identity');
  if (typeof sourceId !== 'string' || !/^[0-9a-f]{64}$/.test(sourceId)) {
    invalid('Invalid workflow source identity');
  }
  return { projectId, sourceId };
};

const tableName = () => {
  const name = process.env.WORKFLOW_SOURCE_BINDINGS_TABLE;
  if (!name) {
    throw new WorkflowSourceError(
      'WORKFLOW_SOURCE_UNAVAILABLE',
      'Workflow source bindings are not configured',
    );
  }
  return name;
};

const assertRevision = (revision, { allowCreate = false } = {}) => {
  if (allowCreate && revision === null) return;
  if (
    typeof revision !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(revision)
  ) {
    invalid('A workflow source revision is required');
  }
};

const conflict = (error) => {
  if (error?.name === 'ConditionalCheckFailedException') {
    throw new WorkflowSourceError(
      'WORKFLOW_SOURCE_CONFLICT',
      'Workflow source changed; reload before retrying',
    );
  }
  throw error;
};

// Never spread provider verification output or API input into a persisted row.
// A credential reference is allowed; tokens, SSM paths and provider response
// bodies are not. Effective capabilities stay read-only even if OAuth grants
// broader scopes to the existing user connection.
// `authorization` is a trusted host lookup, never provider output or client JSON.
// Its omission supports legacy offline domain fixtures only; production service
// authorization requires the resulting graph identity pins.
export const prepareWorkflowSourceBinding = ({
  projectId,
  provider,
  repository,
  verified,
  actorId,
  authorization,
  revision = randomUUID(),
  now = new Date().toISOString(),
}) => {
  const identity = workflowSourceIdentity(provider, repository);
  keyFor(projectId, identity.sourceId);
  assertRevision(revision);
  if (!boundedString(actorId) || !boundedString(now)) invalid('Invalid binding audit identity');
  if (authorization !== undefined) assertAuthorization(authorization);
  if (
    verified?.purpose !== 'workflow-source' ||
    verified?.capabilities?.repositoryRead !== true ||
    verified?.capabilities?.repositoryWrite !== false
  ) {
    invalid('A verified read-only workflow source is required');
  }
  const out = {
    schemaVersion: 1,
    projectId,
    ...identity,
    // Credential helpers use `repo`, while the source API uses `repository`.
    repo: identity.repository,
    purpose: 'workflow-source',
    revision,
    status: 'active',
    access: 'read',
    capabilities: { repositoryRead: true, repositoryWrite: false, contents: 'read' },
    authType: verified.authType,
    verifiedAt: now,
    updatedAt: now,
    updatedBy: actorId,
  };
  if (authorization !== undefined) out.projectIdentity = authorization.projectIdentity;
  if (verified.authType === 'public') {
    if (hasPublicCredentialFields(verified)) {
      invalid('Public workflow sources must not contain credential fields');
    }
  } else if (verified.authType === `${provider}-oauth`) {
    if (
      verified.connectionUserId !== actorId ||
      verified.credentialRef !== oauthCredentialRef(provider, actorId) ||
      !isGitConnectionCreatedAt(verified.connectionCreatedAt) ||
      !isGitConnectionIdentity(verified.connectionIdentity)
    ) {
      invalid('Workflow source must use the configuring member’s connection');
    }
    out.credentialRef = verified.credentialRef;
    out.connectionUserId = actorId;
    out.connectionCreatedAt = verified.connectionCreatedAt;
    out.connectionIdentity = verified.connectionIdentity;
    if (authorization !== undefined) {
      out.delegatorMembershipIdentity = authorization.membershipId;
    }
  } else if (provider === 'github' && verified.authType === 'github-app') {
    const installationId = String(verified.installationId ?? '');
    if (
      !/^[1-9][0-9]{0,19}$/.test(installationId) ||
      verified.credentialRef !== appCredentialRef(installationId)
    ) {
      invalid('Invalid workflow source installation');
    }
    out.credentialRef = verified.credentialRef;
    out.installationId = installationId;
  } else {
    invalid('Invalid workflow source authentication type');
  }
  return out;
};

export const getWorkflowSourceBinding = async (ddb, projectId, sourceId) => {
  const Key = keyFor(projectId, sourceId);
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tableName(), Key, ConsistentRead: true }),
  );
  return Item ?? null;
};

export const listWorkflowSourceBindings = async (ddb, projectId) => {
  if (!boundedString(projectId)) invalid('Invalid project identity');
  const TableName = tableName();
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: 'projectId = :project',
        ExpressionAttributeValues: { ':project': projectId },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

export const saveWorkflowSourceBinding = async (ddb, input, { expectedRevision } = {}) => {
  assertRevision(expectedRevision, { allowCreate: true });
  const Item = prepareWorkflowSourceBinding(input);
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item,
        ConditionExpression:
          expectedRevision === null ? 'attribute_not_exists(sourceId)' : '#revision = :expected',
        ...(expectedRevision === null
          ? {}
          : {
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: { ':expected': expectedRevision },
            }),
      }),
    );
  } catch (error) {
    conflict(error);
  }
  return Item;
};

export const deleteWorkflowSourceBinding = async (
  ddb,
  projectId,
  sourceId,
  { expectedRevision, actorId, revision = randomUUID(), now = new Date().toISOString() } = {},
) => {
  assertRevision(expectedRevision);
  assertRevision(revision);
  if (!boundedString(actorId)) invalid('Invalid binding audit identity');
  // Keep a credential-free tombstone. A request that observed absence before a
  // concurrent create/delete must not recreate delegated authority afterward.
  // Reconfiguration can condition against this new revision after observing it.
  const Item = {
    ...keyFor(projectId, sourceId),
    schemaVersion: 1,
    purpose: 'workflow-source',
    status: 'deleted',
    revision,
    updatedAt: now,
    updatedBy: actorId,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item,
        ConditionExpression: '#revision = :expected',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expected': expectedRevision },
      }),
    );
  } catch (error) {
    conflict(error);
  }
};

export const workflowSourceView = (binding) => ({
  sourceId: binding.sourceId,
  provider: binding.provider,
  repository: binding.repository,
  revision: binding.revision,
  status: binding.status === 'active' ? 'active' : 'invalid',
  authType: binding.authType,
  access: 'read',
  verifiedAt: binding.verifiedAt,
  updatedAt: binding.updatedAt,
});

export const requireWorkflowSourceRevision = (binding, expectedRevision) => {
  assertRevision(expectedRevision);
  if (!binding) {
    throw new WorkflowSourceError('WORKFLOW_SOURCE_NOT_FOUND', 'Workflow source was not found');
  }
  if (binding.revision !== expectedRevision) {
    throw new WorkflowSourceError(
      'WORKFLOW_SOURCE_CONFLICT',
      'Workflow source changed; reload before retrying',
    );
  }
  if (
    binding.schemaVersion !== 1 ||
    binding.purpose !== 'workflow-source' ||
    binding.status !== 'active' ||
    binding.access !== 'read' ||
    binding.capabilities?.repositoryRead !== true ||
    binding.capabilities?.repositoryWrite !== false
  ) {
    throw new WorkflowSourceError('WORKFLOW_SOURCE_INVALID', 'Workflow source is not active');
  }
};
