import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { buildResponse } from '../shared/response.js';
import { getProvider } from '../shared/git-providers.js';
import {
  ACTIVE,
  AUTH_TYPE_PROVIDER,
  canonicalRepo,
  deleteProjectBindings,
  getBinding,
  invalidationReasonForError,
  listProjectBindings,
  loggableErrorCode,
  markBindingInvalid,
  replaceProjectBindings,
  sanitizeBinding,
} from '../shared/source-control-bindings.js';
import {
  resolveBindingCredential,
  verifyBindingCredential,
} from '../shared/source-control-credentials.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;

const SOURCE_CONTROL_OPERATIONS = Object.freeze({
  branches: 'read',
  tree: 'read',
  contents: 'read',
  'default-branch': 'read',
  compare: 'read',
  'find-pr': 'read',
  'create-pr': 'write',
  'pr-status': 'read',
  'set-pr-draft': 'write',
  'reopen-pr': 'write',
  'is-ancestor': 'read',
  'list-review-comments': 'read',
  'add-review-comment': 'write',
  'list-issues': 'read',
  'get-issue': 'read',
  'list-issue-comments': 'read',
  'add-issue-comment': 'write',
  'merge-branch': 'write',
});

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(host, port, credentials, '/gremlin', protocol);
  return new gremlin.driver.DriverRemoteConnection(url, { headers });
};

const graphValue = (row, key) => {
  const value = row instanceof Map ? row.get(key) : row?.[key];
  return Array.isArray(value) ? value[0] : value;
};

const fetchProjectRepositories = async (g, projectId) => {
  const rows = await g
    .V()
    .has('Project', 'id', projectId)
    .out('HAS_REPO')
    .hasLabel('Repository')
    .project('repo', 'provider')
    .by('url')
    .by(__.coalesce(__.values('provider'), __.constant('github')))
    .toList();
  return rows.map((row) => ({
    repo: graphValue(row, 'repo'),
    provider: graphValue(row, 'provider') || 'github',
  }));
};

const fetchMembershipRole = async (g, projectId, userId) => {
  if (!userId) return null;
  const rows = await g
    .V()
    .has('Project', 'id', projectId)
    .outE('HAS_MEMBER')
    .as('membership')
    .inV()
    .has('User', 'id', userId)
    .select('membership')
    .by(__.values('role'))
    .toList();
  return rows[0] || null;
};

const sameRepository = (a, b) => {
  try {
    return (
      a.provider === b.provider &&
      canonicalRepo(a.provider, a.repo) === canonicalRepo(b.provider, b.repo)
    );
  } catch {
    return false;
  }
};

const normalizeProviderSelections = (data = {}) => {
  if (data.providers && typeof data.providers === 'object' && !Array.isArray(data.providers)) {
    return Object.fromEntries(
      Object.entries(data.providers).map(([provider, selection]) => [
        provider,
        typeof selection === 'string' ? { authType: selection } : selection,
      ]),
    );
  }
  if (Array.isArray(data.bindings)) {
    const selections = {};
    for (const item of data.bindings) {
      if (!item?.provider || !item?.authType) {
        throw new Error('Each binding selection requires provider and authType');
      }
      if (
        selections[item.provider]?.authType !== undefined &&
        selections[item.provider].authType !== item.authType
      ) {
        throw new Error(`A project may use only one ${item.provider} authentication type`);
      }
      selections[item.provider] = {
        authType: item.authType,
        confirmDelegation: item.confirmDelegation,
      };
    }
    return selections;
  }
  throw new Error('providers is required');
};

const bindingStatusForProject = (repos, bindings, { privileged = false } = {}) => {
  const rows = repos.map((repo) => {
    const binding = bindings.find((candidate) => sameRepository(candidate, repo));
    return binding
      ? sanitizeBinding(binding, { privileged })
      : {
          provider: repo.provider,
          repo: repo.repo,
          authType: null,
          status: 'unbound',
          invalidReason: 'binding_required',
          capabilities: {},
          verifiedAt: null,
          updatedAt: null,
        };
  });
  return {
    ready: rows.every((row) => row.status === ACTIVE && row.capabilities?.repositoryWrite),
    repositories: rows,
  };
};

const validateProjectBindings = async ({
  projectId,
  repos,
  ddbClient = ddb,
  ssmClient = ssm,
  secretsClient = secrets,
  live = true,
}) => {
  if (repos.length === 0) return { ready: true, repositories: [] };
  const bindings = await listProjectBindings(ddbClient, projectId);
  const results = [];
  for (const repo of repos) {
    const binding = bindings.find((candidate) => sameRepository(candidate, repo));
    if (!binding) {
      results.push({
        provider: repo.provider,
        repo: repo.repo,
        authType: null,
        ready: false,
        code: 'UNBOUND',
        reason: 'Source control setup is required',
      });
      continue;
    }
    if (binding.status !== ACTIVE) {
      results.push({
        provider: repo.provider,
        repo: repo.repo,
        authType: binding.authType,
        ready: false,
        code: 'BINDING_INVALID',
        reason: binding.invalidReason || 'The project binding is invalid',
      });
      continue;
    }
    if (!binding.capabilities?.repositoryWrite) {
      results.push({
        provider: repo.provider,
        repo: repo.repo,
        authType: binding.authType,
        ready: false,
        code: 'WRITE_ACCESS_REQUIRED',
        reason: 'Repository write access is required',
      });
      continue;
    }
    if (!live) {
      results.push({
        provider: repo.provider,
        repo: repo.repo,
        authType: binding.authType,
        ready: true,
      });
      continue;
    }
    try {
      const credential = await resolveBindingCredential({
        ddb: ddbClient,
        ssm: ssmClient,
        secrets: secretsClient,
        binding,
        requiredAccess: 'write',
      });
      const access = await getProvider(repo.provider).getRepositoryAccess(
        {
          token: credential.token,
          ...(credential.refresh ? { onRefresh: credential.refresh } : {}),
        },
        repo.repo,
      );
      // App bindings: the probe reaching the repo is the whole check. GET
      // /repos `permissions` is user-authority shaped and unreliable for
      // installation tokens; write authority was proven when the repo-scoped
      // contents:write token minted (resolveBindingCredential above).
      if (binding.authType !== 'github-app' && !access.canWrite) {
        throw Object.assign(new Error('Repository write access is no longer available'), {
          code: 'INSUFFICIENT_REPOSITORY_ACCESS',
        });
      }
      results.push({
        provider: repo.provider,
        repo: repo.repo,
        authType: binding.authType,
        ready: true,
      });
    } catch (error) {
      const invalidReason = invalidationReasonForError(error);
      if (invalidReason) {
        await markBindingInvalid(ddbClient, binding, invalidReason).catch(() => {});
      }
      results.push({
        provider: repo.provider,
        repo: repo.repo,
        authType: binding.authType,
        ready: false,
        code: error.code || 'CREDENTIAL_UNAVAILABLE',
        reason:
          error.code === 'MISSING_SCOPES'
            ? 'The delegated connection is missing required scopes'
            : 'The project credential could not access this repository',
      });
    }
  }
  const ready = results.every((result) => result.ready);
  if (!ready) {
    console.error('[source-control] project validation failed', {
      projectId,
      reasonCodes: [
        ...new Set(results.filter((result) => !result.ready).map((result) => result.code)),
      ]
        .filter(Boolean)
        .join(','),
    });
  }
  return { ready, repositories: results };
};

const callProvider = async (provider, operation, ctx, repo, args = {}) => {
  switch (operation) {
    case 'branches':
      return Promise.all([
        provider.listBranches(ctx, repo),
        provider.getDefaultBranch(ctx, repo).catch(() => null),
      ]).then(([branches, defaultBranch]) => ({
        branches,
        ...(defaultBranch ? { defaultBranch } : {}),
      }));
    case 'tree':
      return provider.getTree(ctx, repo, args.branch);
    case 'contents':
      return provider.getFileContents(ctx, repo, args.path, args.branch);
    case 'default-branch':
      return provider.getDefaultBranch(ctx, repo);
    case 'compare':
      return provider.compareBranches(ctx, repo, { base: args.base, head: args.head });
    case 'find-pr':
      return provider.findPullRequest(ctx, repo, {
        sourceBranch: args.sourceBranch,
        targetBranch: args.targetBranch,
        state: args.state,
      });
    case 'create-pr':
      return provider.createPullRequest(ctx, repo, args);
    case 'pr-status':
      return provider.getPullRequestStatus(ctx, repo, args.number);
    case 'set-pr-draft':
      return provider.setPullRequestDraft(ctx, repo, args.number, Boolean(args.draft));
    case 'reopen-pr':
      return provider.reopenPullRequest(ctx, repo, args.number);
    case 'is-ancestor':
      return provider.isCommitAncestor(ctx, repo, args.ancestorSha, args.descendantRef);
    case 'list-review-comments':
      return provider.listPRComments(ctx, repo, args.number);
    case 'add-review-comment':
      return provider.addPRComment(ctx, repo, args.number, args.comment || { body: args.body });
    case 'list-issues':
      return provider.listIssues(ctx, repo, args);
    case 'get-issue':
      return provider.getIssue(ctx, repo, args.number);
    case 'list-issue-comments':
      return provider.listIssueComments(ctx, repo, args.number);
    case 'add-issue-comment':
      return provider.addIssueComment(ctx, repo, args.number, args.body);
    case 'merge-branch':
      return provider.mergeBranch(ctx, repo, args);
    default:
      throw Object.assign(new Error('Unsupported source-control operation'), {
        code: 'OPERATION_NOT_ALLOWED',
      });
  }
};

const executeSourceControlOperation = async ({
  projectId,
  provider,
  repo,
  operation,
  args = {},
  repos,
  ddbClient = ddb,
  ssmClient = ssm,
  secretsClient = secrets,
}) => {
  if (!SOURCE_CONTROL_OPERATIONS[operation]) {
    throw Object.assign(new Error('Unsupported source-control operation'), {
      code: 'OPERATION_NOT_ALLOWED',
    });
  }
  if (!repos.some((projectRepo) => sameRepository(projectRepo, { provider, repo }))) {
    throw Object.assign(new Error('Repository is not attached to this project'), {
      code: 'REPOSITORY_NOT_ON_PROJECT',
    });
  }
  const binding = await getBinding(ddbClient, projectId, provider, repo);
  if (!binding || binding.status !== ACTIVE) {
    throw Object.assign(new Error('Source-control binding is not active'), {
      code: 'SOURCE_CONTROL_NOT_READY',
    });
  }
  try {
    const credential = await resolveBindingCredential({
      ddb: ddbClient,
      ssm: ssmClient,
      secrets: secretsClient,
      binding,
      requiredAccess: SOURCE_CONTROL_OPERATIONS[operation],
    });
    // onRefresh restores the personal git handler's 401 refresh-and-retry on
    // this project-bound path: without it a transiently-rejected GitLab token
    // (clock skew, near-expiry) invalidates the binding as provider_unauthorized.
    return await callProvider(
      getProvider(provider),
      operation,
      {
        token: credential.token,
        ...(credential.refresh ? { onRefresh: credential.refresh } : {}),
      },
      repo,
      args,
    );
  } catch (error) {
    const invalidReason = invalidationReasonForError(error);
    if (invalidReason) {
      await markBindingInvalid(ddbClient, binding, invalidReason).catch(() => {});
    }
    console.error('[source-control] provider operation failed', {
      provider,
      operation,
      code: loggableErrorCode(error),
      status: Number(error?.status ?? error?.statusCode ?? 0) || null,
    });
    throw error;
  }
};

const apiOperation = (path) => {
  if (path.endsWith('/source-control/branches')) return 'branches';
  if (path.endsWith('/source-control/tree')) return 'tree';
  if (path.endsWith('/source-control/contents')) return 'contents';
  if (/\/source-control\/reviews\/[^/]+\/comments$/.test(path)) return null;
  return undefined;
};

const reviewNumberFromPath = (path) =>
  path.match(/\/source-control\/reviews\/([^/]+)\/comments$/)?.[1] || null;

export const handler = async (event) => {
  // Internal Lambda-only API. IAM is the authentication boundary.
  if (event?.action === 'validate-project' || event?.action === 'operate') {
    let conn;
    try {
      conn = await getConnection();
      const g = traversal().withRemote(conn);
      const repos = await fetchProjectRepositories(g, event.projectId);
      if (event.action === 'validate-project') {
        return await validateProjectBindings({ projectId: event.projectId, repos });
      }
      const result = await executeSourceControlOperation({ ...event, repos });
      return { ok: true, result };
    } catch (error) {
      const code = loggableErrorCode(error, 'SOURCE_CONTROL_OPERATION_FAILED');
      console.error('[source-control] internal operation failed', {
        action: event.action === 'validate-project' ? 'validate-project' : 'operate',
        code,
      });
      return { ok: false, code };
    } finally {
      await conn?.close().catch(() => {});
    }
  }

  const response = buildResponse(event, { methods: 'GET,PUT,POST,DELETE,OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return response(200, {});
  const userId = event.requestContext?.authorizer?.claims?.sub;
  const projectId = event.pathParameters?.projectId;
  const path = event.path || '';
  if (!userId) return response(401, { error: 'Unauthorized' });
  if (!projectId) {
    return response(400, { error: 'projectId is required' });
  }

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);
    const [role, repos] = await Promise.all([
      fetchMembershipRole(g, projectId, userId),
      fetchProjectRepositories(g, projectId),
    ]);
    if (!role) return response(403, { error: 'Access denied' });
    const privileged = role === 'owner' || role === 'admin';
    if (path.endsWith('/source-control')) {
      if (event.httpMethod === 'GET') {
        const bindings = await listProjectBindings(ddb, projectId);
        return response(200, bindingStatusForProject(repos, bindings, { privileged }));
      }
      if (!privileged) {
        return response(403, {
          error: 'Only project owners and admins can configure source control',
        });
      }
      if (event.httpMethod === 'DELETE') {
        await deleteProjectBindings(ddb, projectId);
        return response(204, null);
      }
      if (event.httpMethod !== 'PUT') return response(405, { error: 'Method not allowed' });

      const data = event.body ? JSON.parse(event.body) : {};
      let selections;
      try {
        selections = normalizeProviderSelections(data);
      } catch (error) {
        return response(400, { error: error.message });
      }
      if (repos.length > 50) {
        return response(400, { error: 'Projects may bind at most 50 repositories' });
      }
      for (const [provider, selection] of Object.entries(selections)) {
        if (!['github', 'gitlab'].includes(provider) || !selection?.authType) {
          return response(400, { error: `Invalid source-control selection for ${provider}` });
        }
        if (AUTH_TYPE_PROVIDER[selection.authType] !== provider) {
          return response(400, { error: `${selection.authType} cannot be used for ${provider}` });
        }
      }
      const missingProviders = [...new Set(repos.map((repo) => repo.provider))].filter(
        (provider) => !selections[provider],
      );
      if (missingProviders.length) {
        return response(400, {
          error: `Authentication type required for: ${missingProviders.join(', ')}`,
        });
      }

      const existing = await listProjectBindings(ddb, projectId);
      const verified = [];
      const failures = [];
      for (const repo of repos) {
        const selection = selections[repo.provider];
        try {
          const credential = await verifyBindingCredential({
            ddb,
            ssm,
            secrets,
            provider: repo.provider,
            repo: repo.repo,
            authType: selection.authType,
            userId,
            confirmDelegation:
              selection.confirmDelegation === true || data.confirmDelegation === true,
            actorName:
              event.requestContext?.authorizer?.claims?.name ||
              event.requestContext?.authorizer?.claims?.email ||
              null,
          });
          const prior = existing.find((binding) => sameRepository(binding, repo));
          verified.push({
            ...credential,
            projectId,
            provider: repo.provider,
            repo: repo.repo,
            status: ACTIVE,
            invalidReason: null,
            createdAt: prior?.createdAt,
            createdBy: prior?.createdBy,
          });
        } catch (error) {
          failures.push({
            provider: repo.provider,
            repo: repo.repo,
            code: error.code || 'VERIFICATION_FAILED',
            reason:
              error.code === 'MISSING_SCOPES' ? 'Required OAuth scopes are missing' : error.message,
          });
        }
      }
      if (failures.length) {
        console.error('[source-control] binding verification failed', {
          projectId,
          reasonCodes: [...new Set(failures.map((failure) => failure.code))]
            .filter(Boolean)
            .join(','),
        });
        return response(409, {
          error: 'Every repository must pass verification before bindings are changed',
          code: 'SOURCE_CONTROL_VERIFICATION_FAILED',
          repositories: failures,
        });
      }
      const saved = await replaceProjectBindings(ddb, projectId, verified, { actor: userId });
      return response(200, bindingStatusForProject(repos, saved, { privileged: true }));
    }

    const operation = apiOperation(path);
    const reviewNumber = reviewNumberFromPath(path);
    if (operation === undefined && !reviewNumber) return response(404, { error: 'Not found' });
    const provider = event.queryStringParameters?.provider;
    const repo = event.queryStringParameters?.repository;
    if (!provider || !repo) {
      return response(400, { error: 'provider and repository query parameters are required' });
    }
    let resolvedOperation = operation;
    const args = { ...event.queryStringParameters };
    if (reviewNumber) {
      args.number = reviewNumber;
      if (event.httpMethod === 'GET') resolvedOperation = 'list-review-comments';
      else if (event.httpMethod === 'POST') {
        resolvedOperation = 'add-review-comment';
        args.comment = event.body ? JSON.parse(event.body) : {};
      } else return response(405, { error: 'Method not allowed' });
    } else if (event.httpMethod !== 'GET') {
      return response(405, { error: 'Method not allowed' });
    }
    const result = await executeSourceControlOperation({
      projectId,
      provider,
      repo,
      operation: resolvedOperation,
      args,
      repos,
    });
    return response(200, result);
  } catch (error) {
    const code = loggableErrorCode(error, 'SOURCE_CONTROL_OPERATION_FAILED');
    console.error('[source-control] request failed', { code });
    const status =
      error.code === 'REPOSITORY_NOT_ON_PROJECT'
        ? 403
        : error.code === 'SOURCE_CONTROL_NOT_READY'
          ? 409
          : 502;
    return response(status, {
      error: status === 502 ? 'Source-control provider operation failed' : error.message,
      code,
    });
  } finally {
    await conn?.close().catch(() => {});
  }
};

export {
  SOURCE_CONTROL_OPERATIONS,
  fetchProjectRepositories,
  fetchMembershipRole,
  normalizeProviderSelections,
  bindingStatusForProject,
  validateProjectBindings,
  executeSourceControlOperation,
};
