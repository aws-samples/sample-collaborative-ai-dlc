import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const CREDENTIAL_REF_INDEX = 'CredentialRefIndex';
const ACTIVE = 'active';
const INVALID = 'invalid';
const AUTH_TYPES = Object.freeze(['github-oauth', 'github-app', 'gitlab-oauth']);
const AUTH_TYPE_PROVIDER = Object.freeze({
  'github-oauth': 'github',
  'github-app': 'github',
  'gitlab-oauth': 'gitlab',
});

const tableName = () => process.env.SOURCE_CONTROL_BINDINGS_TABLE;

const canonicalRepo = (provider, value) => {
  if (!['github', 'gitlab'].includes(provider)) {
    throw new Error(`Unsupported source-control provider: ${provider}`);
  }
  const raw = String(value || '')
    .trim()
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = raw.split('/');
  if (parts.length < 2 || parts.some((part) => !part)) {
    throw new Error(`Invalid ${provider} repository reference`);
  }
  return raw.toLowerCase();
};

const bindingKeyFor = (provider, repo) => `${provider}#${canonicalRepo(provider, repo)}`;

const credentialBindingKeyFor = (projectId, provider, repo) =>
  `${projectId}#${provider}#${canonicalRepo(provider, repo)}`;

const oauthCredentialRef = (provider, userId) => `oauth#${provider}#${userId}`;
const appCredentialRef = (installationId) => `github-app#${installationId}`;

const assertBinding = (binding) => {
  if (!binding?.projectId || !binding?.provider || !binding?.repo || !binding?.authType) {
    throw new Error('Binding requires projectId, provider, repo, and authType');
  }
  if (!AUTH_TYPES.includes(binding.authType)) {
    throw new Error(`Unsupported source-control authType: ${binding.authType}`);
  }
  if (AUTH_TYPE_PROVIDER[binding.authType] !== binding.provider) {
    throw new Error(`${binding.authType} cannot be used for ${binding.provider}`);
  }
  if (!binding.credentialRef) throw new Error('Binding requires credentialRef');
};

const prepareBinding = (binding, { actor, now = new Date().toISOString() } = {}) => {
  assertBinding(binding);
  const canonical = canonicalRepo(binding.provider, binding.repo);
  return {
    ...binding,
    repo: String(binding.repo).trim(),
    canonicalRepo: canonical,
    bindingKey: bindingKeyFor(binding.provider, canonical),
    credentialBindingKey: credentialBindingKeyFor(binding.projectId, binding.provider, canonical),
    status: binding.status || ACTIVE,
    invalidReason:
      binding.status === INVALID ? binding.invalidReason || 'credential_invalid' : null,
    createdAt: binding.createdAt || now,
    createdBy: binding.createdBy || actor || null,
    updatedAt: now,
    updatedBy: actor || binding.updatedBy || null,
    verifiedAt: binding.verifiedAt || now,
    verifiedBy: binding.verifiedBy || actor || null,
  };
};

const getBinding = async (ddb, projectId, provider, repo, { consistent = true } = {}) => {
  if (!projectId || !provider || !repo) return null;
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: { projectId, bindingKey: bindingKeyFor(provider, repo) },
      ConsistentRead: consistent,
    }),
  );
  return Item ?? null;
};

const listProjectBindings = async (ddb, projectId) => {
  if (!projectId) return [];
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'projectId = :projectId',
        ExpressionAttributeValues: { ':projectId': projectId },
        ExclusiveStartKey,
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

const listBindingsByCredentialRef = async (ddb, credentialRef) => {
  if (!credentialRef || !tableName()) return [];
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: CREDENTIAL_REF_INDEX,
        KeyConditionExpression: 'credentialRef = :credentialRef',
        ExpressionAttributeValues: { ':credentialRef': credentialRef },
        ExclusiveStartKey,
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

const putBinding = async (ddb, binding, options = {}) => {
  const item = prepareBinding(binding, options);
  await ddb.send(new PutCommand({ TableName: tableName(), Item: item }));
  return item;
};

// Verify every candidate before calling this helper. The replacement itself is
// all-or-nothing, including deletion of bindings for repositories removed from
// the project. DynamoDB transactions allow 100 actions; project repository
// limits are kept below that by the API.
const replaceProjectBindings = async (ddb, projectId, bindings, options = {}) => {
  if (!projectId) throw new Error('projectId is required');
  if (!Array.isArray(bindings)) throw new Error('bindings must be an array');
  const existing = await listProjectBindings(ddb, projectId);
  const prepared = bindings.map((binding) => prepareBinding({ ...binding, projectId }, options));
  const desired = new Set(prepared.map((binding) => binding.bindingKey));
  const removed = existing.filter((binding) => !desired.has(binding.bindingKey));
  const actions = [
    ...prepared.map((Item) => ({ Put: { TableName: tableName(), Item } })),
    ...removed.map((binding) => ({
      Delete: {
        TableName: tableName(),
        Key: { projectId, bindingKey: binding.bindingKey },
      },
    })),
  ];
  if (actions.length > 100) {
    throw new Error('A project may not replace more than 100 source-control bindings at once');
  }
  if (actions.length) {
    await ddb.send(new TransactWriteCommand({ TransactItems: actions }));
  }
  return prepared;
};

const deleteProjectBindings = async (ddb, projectId) => {
  const existing = await listProjectBindings(ddb, projectId);
  for (let i = 0; i < existing.length; i += 25) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName()]: existing.slice(i, i + 25).map((binding) => ({
            DeleteRequest: {
              Key: { projectId, bindingKey: binding.bindingKey },
            },
          })),
        },
      }),
    );
  }
  return existing.length;
};

const markBindingInvalid = async (
  ddb,
  binding,
  reason,
  { actor = 'system', now = new Date().toISOString() } = {},
) => {
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { projectId: binding.projectId, bindingKey: binding.bindingKey },
      UpdateExpression:
        'SET #status = :invalid, invalidReason = :reason, invalidatedAt = :now, invalidatedBy = :actor, updatedAt = :now, updatedBy = :actor',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':invalid': INVALID,
        ':reason': reason || 'credential_invalid',
        ':now': now,
        ':actor': actor,
      },
    }),
  );
};

const invalidateBindingsByCredentialRef = async (ddb, credentialRef, reason, options = {}) => {
  const bindings = await listBindingsByCredentialRef(ddb, credentialRef);
  await Promise.all(bindings.map((binding) => markBindingInvalid(ddb, binding, reason, options)));
  return bindings.length;
};

const invalidateProjectBindingsByDelegator = async (
  ddb,
  projectId,
  connectionUserId,
  reason = 'delegator_removed',
  options = {},
) => {
  if (!projectId || !connectionUserId) return 0;
  const bindings = await listProjectBindings(ddb, projectId);
  const dependent = bindings.filter(
    (binding) =>
      binding.authType?.endsWith('-oauth') && binding.connectionUserId === connectionUserId,
  );
  await Promise.all(dependent.map((binding) => markBindingInvalid(ddb, binding, reason, options)));
  return dependent.length;
};

const invalidationReasonForError = (error) => {
  const code = error?.code;
  if (code === 'CONNECTION_REQUIRED') return 'oauth_connection_unavailable';
  if (code === 'MISSING_SCOPES') return 'oauth_scopes_missing';
  if (code === 'CREDENTIAL_REFRESH_FAILED') return 'oauth_refresh_failed';
  if (code === 'APP_INSTALLATION_UNAVAILABLE') return 'github_app_uninstalled';
  if (code === 'BINDING_INVALID') return 'credential_invalid';
  if (code === 'INSUFFICIENT_REPOSITORY_ACCESS') return 'repository_access_revoked';
  const status = Number(
    error?.status ?? error?.statusCode ?? error?.$metadata?.httpStatusCode ?? 0,
  );
  if (status === 401) return 'provider_unauthorized';
  if (status === 403) return 'provider_forbidden';
  return null;
};

const sanitizeBinding = (binding, { privileged = false } = {}) => {
  if (!binding) return null;
  const out = {
    provider: binding.provider,
    repo: binding.repo,
    authType: binding.authType,
    status: binding.status,
    invalidReason: binding.invalidReason || null,
    capabilities: binding.capabilities || {},
    verifiedAt: binding.verifiedAt || null,
    updatedAt: binding.updatedAt || null,
  };
  if (privileged) {
    if (binding.authType?.endsWith('-oauth')) {
      out.delegatedBy = binding.connectionDisplayName || binding.connectionUserId || null;
    }
    if (binding.authType === 'github-app') {
      out.installationId = binding.installationId || null;
      out.installationAccount = binding.installationAccount || null;
    }
    out.actor = binding.actorLogin || binding.actorName || null;
  }
  return out;
};

export {
  ACTIVE,
  INVALID,
  AUTH_TYPES,
  AUTH_TYPE_PROVIDER,
  CREDENTIAL_REF_INDEX,
  canonicalRepo,
  bindingKeyFor,
  credentialBindingKeyFor,
  oauthCredentialRef,
  appCredentialRef,
  prepareBinding,
  getBinding,
  listProjectBindings,
  listBindingsByCredentialRef,
  putBinding,
  replaceProjectBindings,
  deleteProjectBindings,
  markBindingInvalid,
  invalidateBindingsByCredentialRef,
  invalidateProjectBindingsByDelegator,
  invalidationReasonForError,
  sanitizeBinding,
};

export default {
  canonicalRepo,
  bindingKeyFor,
  oauthCredentialRef,
  appCredentialRef,
  prepareBinding,
  getBinding,
  listProjectBindings,
  replaceProjectBindings,
  deleteProjectBindings,
  invalidateBindingsByCredentialRef,
  invalidateProjectBindingsByDelegator,
  invalidationReasonForError,
  sanitizeBinding,
};
