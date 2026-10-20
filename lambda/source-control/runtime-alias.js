import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GatewayGrantError, verifyGatewayGrant } from '../shared/gateway-grant.js';
import {
  assertEngineGrantFor,
  assertGatewayExecution,
  executionIncludesRepository,
} from '../shared/execution-repository-authority.js';
import { canonicalRepo } from '../shared/source-control-bindings.js';
import { executionMetaKey, executionPk } from '../shared/v2-process-keys.js';

export const RUNTIME_ALIAS = 'runtime';

const ACTIVE_EXECUTION_STATUSES = new Set(['CREATED', 'RUNNING']);
const ENVELOPE_KEYS = [
  'action',
  'args',
  'executionId',
  'gatewayGrant',
  'operation',
  'projectId',
  'provider',
  'repo',
];
// GitHub/GitLab/Bitbucket review numbers and CodeCommit pull-request ids are
// all positive decimal integers.
const REVIEW_ID = /^[1-9][0-9]{0,9}$/;

export const RUNTIME_ALIAS_ERROR_CODES = new Set([
  'INVALID_REQUEST',
  'OPERATION_NOT_ALLOWED',
  'EXECUTION_NOT_FOUND',
  'EXECUTION_NOT_ACTIVE',
  'REPOSITORY_NOT_ON_EXECUTION',
  'REVIEW_NOT_IN_EXECUTION',
  'GATEWAY_GRANT_INVALID',
  'GATEWAY_GRANT_EXPIRED',
  'GATEWAY_GRANT_NOT_CONFIGURED',
  'GATEWAY_GRANT_SCOPE_MISMATCH',
]);

// Only the trusted invocation context can select this branch; nothing in the
// event (action, requestContext) is consulted.
export const isRuntimeAliasInvocation = (context) => {
  const parts =
    typeof context?.invokedFunctionArn === 'string' ? context.invokedFunctionArn.split(':') : [];
  return parts.length === 8 && parts[7] === RUNTIME_ALIAS;
};

const denied = (code, message) => Object.assign(new Error(message), { code });

const isReviewId = (value) =>
  (Number.isSafeInteger(value) && REVIEW_ID.test(String(value))) ||
  (typeof value === 'string' && REVIEW_ID.test(value));

const hasExactKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const RUNTIME_OPERATIONS = Object.freeze({
  'default-branch': (args) => hasExactKeys(args, []),
  'pr-status': (args) => hasExactKeys(args, ['number']) && isReviewId(args.number),
  'set-pr-draft': (args) =>
    hasExactKeys(args, ['draft', 'number']) && isReviewId(args.number) && args.draft === true,
});

// Operations that name a review. The number must be one of the execution's own
// unit PR/MR rows (UNITPR#, written by the orchestrator when it opens the
// review) for the requested repository — the rows feedback revisions take
// their review targets from. Graph PR vertices are not an authority here.
const REVIEW_OPERATIONS = new Set(['pr-status', 'set-pr-draft']);

const sameRepository = (provider, left, right) => {
  try {
    return canonicalRepo(provider, left) === canonicalRepo(provider, right);
  } catch {
    return false;
  }
};

const listExecutionReviews = async (ddbClient, tableName, executionId) => {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const page = await ddbClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': executionPk(executionId), ':prefix': 'UNITPR#' },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    rows.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
};

const assertReviewInExecution = async (ddbClient, tableName, request) => {
  const number = String(request.args.number);
  const reviews = await listExecutionReviews(ddbClient, tableName, request.executionId);
  const owned = reviews.some(
    (row) =>
      row?.executionId === request.executionId &&
      row.number !== null &&
      row.number !== undefined &&
      String(row.number) === number &&
      (row.provider ?? request.provider) === request.provider &&
      sameRepository(request.provider, row.repository, request.repo),
  );
  if (!owned) throw denied('REVIEW_NOT_IN_EXECUTION', 'Review is not part of this execution');
};

const parseRuntimeRequest = (event) => {
  if (!hasExactKeys(event, ENVELOPE_KEYS) || event.action !== 'operate') {
    throw denied('INVALID_REQUEST', 'Runtime source-control request is malformed');
  }
  for (const key of ['executionId', 'gatewayGrant', 'projectId', 'provider', 'repo']) {
    if (typeof event[key] !== 'string' || !event[key]) {
      throw denied('INVALID_REQUEST', 'Runtime source-control request is malformed');
    }
  }
  const validArgs = Object.hasOwn(RUNTIME_OPERATIONS, event.operation)
    ? RUNTIME_OPERATIONS[event.operation]
    : null;
  if (!validArgs) {
    throw denied('OPERATION_NOT_ALLOWED', 'Operation is not available to the runtime');
  }
  if (!validArgs(event.args)) {
    throw denied('INVALID_REQUEST', 'Runtime source-control arguments are malformed');
  }
  return event;
};

export const runtimeAliasEnabled = (env) =>
  env.ENGINE_DATA_ENABLED === 'true' &&
  (env.GATEWAY_GRANT_KEY_IDS ?? '').split(',').some((id) => id.trim());

export const gatewayGrantVerifier = (publicKeyFor) => (token) =>
  verifyGatewayGrant(token, { publicKeyFor });

// The runtime alias reaches the same provider operation as the control-plane
// entry point, but only for an execution the signed Gateway grant names and
// only on a repository attached to that execution, and only for reviews that
// execution opened.
export const handleRuntimeOperation = async (
  event,
  { ddbClient, verifyGrant, execute, env = process.env },
) => {
  if (!runtimeAliasEnabled(env)) {
    throw new GatewayGrantError(
      'GATEWAY_GRANT_NOT_CONFIGURED',
      'Gateway grant verification is not configured',
    );
  }
  const request = parseRuntimeRequest(event);
  const grant = assertEngineGrantFor(await verifyGrant(request.gatewayGrant), request);
  const { Item: execution } = await ddbClient.send(
    new GetCommand({
      TableName: env.V2_PROCESS_TABLE,
      Key: executionMetaKey(request.executionId),
      ConsistentRead: true,
    }),
  );
  assertGatewayExecution(grant, execution);
  if (!ACTIVE_EXECUTION_STATUSES.has(execution.status)) {
    throw denied('EXECUTION_NOT_ACTIVE', 'Execution is not active');
  }
  if (!executionIncludesRepository(execution, request.provider, request.repo)) {
    throw denied('REPOSITORY_NOT_ON_EXECUTION', 'Repository is not part of this execution');
  }
  if (REVIEW_OPERATIONS.has(request.operation)) {
    await assertReviewInExecution(ddbClient, env.V2_PROCESS_TABLE, request);
  }
  return execute({
    projectId: request.projectId,
    provider: request.provider,
    repo: request.repo,
    operation: request.operation,
    args: request.args,
    repos: [{ provider: request.provider, repo: request.repo }],
    ddbClient,
  });
};
