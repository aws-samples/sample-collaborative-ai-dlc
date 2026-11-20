// The protected engine's operation journal shares the native authority table.
// Coding/runtime roles receive no table permissions. An unfinished operation
// is never stolen or rerun on an elapsed lease: it may have invoked a check.
import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  nativeExecutionKey,
  nativeTurnSequence,
  nativeWriterGeneration,
  nativeConfirmedWorkspaceResume,
} from '../execution-store.js';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';
import {
  engineDigest,
  engineFailure,
  nativeEngineObjectPrefix,
} from '../../shared/native-workflow-protocol.js';
import { retryTransactionConflicts } from '../../shared/dynamodb-transaction-conflicts.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const valid = (value, regex) => typeof value === 'string' && regex.test(value);
const identityKeys = [
  'projectId',
  'executionId',
  'bindingId',
  'attemptId',
  'epoch',
  'writerGeneration',
  'sequence',
  'configurationSha256',
];
export const nativeEngineIdentity = (row) => ({
  ...row.scope,
  bindingId: row.bindingId,
  attemptId: row.attemptId,
  epoch: row.epoch,
  writerGeneration: nativeWriterGeneration(row),
  sequence: nativeTurnSequence(row),
  configurationSha256: row.configurationSha256,
});
const checkedIdentity = (value) => {
  if (
    !value ||
    Object.keys(value).toSorted().join(',') !== identityKeys.toSorted().join(',') ||
    !valid(value.bindingId, UUID) ||
    !valid(value.attemptId, UUID) ||
    !valid(value.configurationSha256, SHA) ||
    !['epoch', 'writerGeneration', 'sequence'].every(
      (key) => Number.isSafeInteger(value[key]) && value[key] >= 1,
    )
  )
    throw engineFailure();
  const scope = { projectId: value.projectId, executionId: value.executionId };
  nativeExecutionKey(scope);
  return structuredClone(value);
};
const attemptPrefix = (attemptId, epoch) => `ENGINE#${attemptId}#${epoch}`;
export const nativeEngineKeys = (input, requestId) => {
  const identity = checkedIdentity(input);
  const { pk } = nativeExecutionKey({
    projectId: identity.projectId,
    executionId: identity.executionId,
  });
  const prefix = attemptPrefix(identity.attemptId, identity.epoch);
  if (requestId !== undefined && !valid(requestId, UUID)) throw engineFailure();
  return {
    head: { pk, sk: `${prefix}#HEAD` },
    ...(requestId ? { operation: { pk, sk: `${prefix}#OP#${requestId}` } } : {}),
  };
};
export const nativeEnginePublicationKey = (scope, attemptId, epoch, publicationId) => {
  if (
    !valid(attemptId, UUID) ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !valid(publicationId, SHA)
  )
    throw engineFailure();
  return {
    ...nativeExecutionKey(scope),
    sk: `${attemptPrefix(attemptId, epoch)}#PUBLICATION#${publicationId}`,
  };
};
const writerCondition = (tableName, identity, row) => ({
  ConditionCheck: {
    TableName: tableName,
    Key: nativeExecutionKey({ projectId: identity.projectId, executionId: identity.executionId }),
    ConditionExpression:
      'bindingId = :binding AND attemptId = :attempt AND epoch = :epoch AND ' +
      'configurationSha256 = :configuration AND cancelRequested = :no AND ' +
      'writerGeneration = :writer AND turnSequence = :sequence AND ' +
      (row.status === 'RECOVERING'
        ? '#status = :recovering AND recovery = :recovery AND workspaceResume = :resume AND stopConfirmation = :stop'
        : '#status IN (:dispatching, :running)'),
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':binding': identity.bindingId,
      ':attempt': identity.attemptId,
      ':epoch': identity.epoch,
      ':configuration': identity.configurationSha256,
      ':no': false,
      ':writer': identity.writerGeneration,
      ':sequence': identity.sequence,
      ...(row.status === 'RECOVERING'
        ? {
            ':recovering': 'RECOVERING',
            ':recovery': row.recovery,
            ':resume': row.workspaceResume,
            ':stop': row.stopConfirmation,
          }
        : { ':dispatching': 'DISPATCHING', ':running': 'RUNNING' }),
    },
  },
});
const transactionFailure = (error) => {
  const reasons = error?.name === 'TransactionCanceledException' ? error.CancellationReasons : [];
  if (reasons?.[0]?.Code === 'ConditionalCheckFailed')
    return engineFailure('NATIVE_ENGINE_WRITER_CHANGED');
  if (
    error?.name === 'ConditionalCheckFailedException' ||
    reasons?.some((reason) => reason?.Code === 'ConditionalCheckFailed')
  )
    return engineFailure('NATIVE_ENGINE_HEAD_CHANGED');
  return engineFailure('NATIVE_ENGINE_UNAVAILABLE');
};
const pendingHead = (head, operation) => {
  const pending = { requestId: operation.requestId, token: operation.token };
  if (
    !same(head?.pending, pending) ||
    head.version !== operation.expectedVersion ||
    head.producerSha256 !== operation.producerSha256
  )
    throw engineFailure('NATIVE_ENGINE_HEAD_CHANGED');
  return head;
};
const operationTarget = ({
  requestId,
  token,
  expectedVersion,
  identity,
  action,
  publicationId,
}) => ({
  requestId,
  token,
  expectedVersion,
  attemptId: identity.attemptId,
  epoch: identity.epoch,
  sequence: identity.sequence,
  writerGeneration: identity.writerGeneration,
  ...(action ? { action } : {}),
  ...(publicationId ? { publicationId } : {}),
});
const completeHead = (tableName, head, operation, changes = {}) => {
  const { pending, ...previous } = pendingHead(head, operation);
  return {
    Put: {
      TableName: tableName,
      Item: { ...previous, ...changes, version: operation.expectedVersion + 1 },
      ConditionExpression:
        'pending = :pending AND #version = :version AND producerSha256 = :producer',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: {
        ':pending': pending,
        ':version': operation.expectedVersion,
        ':producer': operation.producerSha256,
      },
    },
  };
};
// A second finalize request must not backfill an abandoned publication. Scope
// the refusal to its originating turn; existing proof remains independent.
const abandonedPublicationKey = (identity, publicationId) => {
  if (!valid(publicationId, SHA)) throw engineFailure();
  return {
    pk: nativeEngineKeys(identity).head.pk,
    sk: `${attemptPrefix(identity.attemptId, identity.epoch)}#ABANDONED_PUBLICATION#${identity.sequence}#${publicationId}`,
  };
};
const abandonmentReceipt = ({ requestId, status, version, abandonedAt }) => ({
  requestId,
  status,
  version,
  abandonedAt,
});
const receipt = (value) => {
  if (
    !value ||
    Object.keys(value).toSorted().join(',') !== 'bytes,key,sha256,versionId' ||
    typeof value.key !== 'string' ||
    value.key.length > 1024 ||
    typeof value.versionId !== 'string' ||
    !/^[A-Za-z0-9._~+/=-]{1,1024}$/.test(value.versionId) ||
    value.versionId === 'null' ||
    !valid(value.sha256, SHA) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 256 * 1024 * 1024
  )
    throw engineFailure();
  return structuredClone(value);
};

export const createNativeEngineStore = ({
  ddb: client,
  tableName,
  readExecution,
  now = Date.now,
}) => {
  const ddb = retryTransactionConflicts(client);
  const read = async (key) =>
    (await ddb.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item;
  const authorize = async (identity) => {
    const row = await readExecution({
      projectId: identity.projectId,
      executionId: identity.executionId,
    });
    if (
      !row ||
      !same(nativeEngineIdentity(row), identity) ||
      row.cancelRequested !== false ||
      !(['DISPATCHING', 'RUNNING'].includes(row.status) || nativeConfirmedWorkspaceResume(row))
    )
      throw engineFailure('NATIVE_ENGINE_WRITER_CHANGED');
    return row;
  };
  const committed = (operation, input) => {
    if (
      !operation ||
      operation.schemaVersion !== 1 ||
      !valid(operation.token, UUID) ||
      !['running', 'completed', 'failed', 'abandoned'].includes(operation.status) ||
      operation.requestId !== input.requestId ||
      !same(operation.identity, input.identity) ||
      operation.requestSha256 !== input.requestSha256 ||
      operation.producerSha256 !== input.producerSha256 ||
      operation.expectedVersion !== input.expectedVersion
    )
      throw engineFailure('NATIVE_ENGINE_REQUEST_CONFLICT');
    if (operation.status === 'abandoned') throw engineFailure('NATIVE_ENGINE_ABANDONED');
    return operation;
  };
  const readTarget = async (identity, requestId, producerSha256) => {
    const operation = await read(nativeEngineKeys(identity, requestId).operation);
    if (!operation) throw engineFailure('NATIVE_ENGINE_REQUEST_CONFLICT');
    const owner = checkedIdentity(operation.identity);
    if (
      operation.schemaVersion !== 1 ||
      operation.requestId !== requestId ||
      operation.producerSha256 !== producerSha256 ||
      !valid(operation.token, UUID) ||
      !valid(operation.requestSha256, SHA) ||
      !Number.isSafeInteger(operation.expectedVersion) ||
      operation.expectedVersion < 0 ||
      owner.writerGeneration > identity.writerGeneration ||
      (owner.writerGeneration === identity.writerGeneration &&
        owner.sequence > identity.sequence) ||
      !same(
        { ...owner, writerGeneration: identity.writerGeneration, sequence: identity.sequence },
        identity,
      )
    )
      throw engineFailure('NATIVE_ENGINE_REQUEST_CONFLICT');
    return operation;
  };
  const validateHead = (head, identity) => {
    if (
      head &&
      (!same(head.scope, {
        projectId: identity.projectId,
        executionId: identity.executionId,
        bindingId: identity.bindingId,
        attemptId: identity.attemptId,
        epoch: identity.epoch,
        configurationSha256: identity.configurationSha256,
      }) ||
        head.schemaVersion !== 1 ||
        !Number.isSafeInteger(head.version) ||
        head.version < 0 ||
        !valid(head.producerSha256, SHA))
    )
      throw engineFailure('NATIVE_ENGINE_STATE_INVALID');
    return head;
  };
  return {
    async get(identity) {
      identity = checkedIdentity(identity);
      await authorize(identity);
      const head = validateHead(await read(nativeEngineKeys(identity).head), identity);
      return head ?? null;
    },
    async pending(identity, producerSha256) {
      identity = checkedIdentity(identity);
      await authorize(identity);
      const head = validateHead(await read(nativeEngineKeys(identity).head), identity);
      if (!head?.pending) return null;
      const operation = await readTarget(identity, head.pending.requestId, producerSha256);
      if (operation.status !== 'running') throw engineFailure('NATIVE_ENGINE_HEAD_CHANGED');
      pendingHead(head, operation);
      return operationTarget(operation);
    },
    async abandon({ identity, target, producerSha256, beforeAbandon }) {
      identity = checkedIdentity(identity);
      await authorize(identity);
      if (!valid(target?.requestId, UUID)) throw engineFailure();
      const keys = nativeEngineKeys(identity, target.requestId);
      // Read the head first. If another abandonment commits between reads,
      // the immutable operation below supplies its original acknowledgement.
      const head = validateHead(await read(keys.head), identity);
      const operation = await readTarget(identity, target.requestId, producerSha256);
      if (!same(operationTarget(operation), target))
        throw engineFailure('NATIVE_ENGINE_REQUEST_CONFLICT');
      const duplicate = (stored) =>
        stored?.status === 'abandoned' &&
        stored.token === target.token &&
        same(stored.abandonedBy, identity);
      if (duplicate(operation)) return abandonmentReceipt(operation);
      if (operation.status !== 'running') throw engineFailure('NATIVE_ENGINE_OPERATION_FINISHED');
      const nextHead = completeHead(tableName, head, operation);
      await beforeAbandon(operation);
      const row = await authorize(identity);
      const acknowledgement = abandonmentReceipt({
        requestId: operation.requestId,
        status: 'abandoned',
        version: nextHead.Put.Item.version,
        abandonedAt: now(),
      });
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              writerCondition(tableName, identity, row),
              {
                Update: {
                  TableName: tableName,
                  Key: keys.operation,
                  // Keep every recorded job, including one updated after our read.
                  UpdateExpression:
                    'SET #status = :abandoned, abandonedBy = :writer, abandonedAt = :at, #version = :next',
                  ConditionExpression:
                    '#status = :running AND #token = :token AND expectedVersion = :version AND #identity = :owner',
                  ExpressionAttributeNames: {
                    '#status': 'status',
                    '#token': 'token',
                    '#version': 'version',
                    '#identity': 'identity',
                  },
                  ExpressionAttributeValues: {
                    ':abandoned': 'abandoned',
                    ':writer': identity,
                    ':at': acknowledgement.abandonedAt,
                    ':next': acknowledgement.version,
                    ':running': 'running',
                    ':token': target.token,
                    ':version': target.expectedVersion,
                    ':owner': operation.identity,
                  },
                },
              },
              ...(operation.publicationId
                ? [
                    {
                      Put: {
                        TableName: tableName,
                        Item: {
                          ...abandonedPublicationKey(operation.identity, operation.publicationId),
                          requestId: operation.requestId,
                        },
                        ConditionExpression: 'attribute_not_exists(pk)',
                      },
                    },
                  ]
                : []),
              nextHead,
            ],
          }),
        );
      } catch (error) {
        const observed = await read(keys.operation);
        if (duplicate(observed)) {
          await authorize(identity);
          return abandonmentReceipt(observed);
        }
        throw transactionFailure(error);
      }
      return acknowledgement;
    },
    async begin(input) {
      const identity = checkedIdentity(input.identity);
      if (
        !valid(input.requestId, UUID) ||
        !valid(input.requestSha256, SHA) ||
        !valid(input.producerSha256, SHA) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 0
      )
        throw engineFailure();
      const row = await authorize(identity);
      const keys = nativeEngineKeys(identity, input.requestId);
      // An invocation may dispatch only under the token it minted during
      // this begin. A different invocation can only reconcile saved output.
      const opened = async (observed, ownedToken = null) => {
        committed(observed, input);
        if (observed.status !== 'running') return { replay: true, operation: observed };
        await authorize(identity);
        const head = validateHead(await read(keys.head), identity);
        // A competing finisher can have cleared the pending head since the
        // operation read. Its immutable terminal record wins in that case.
        if (head?.pending?.token !== observed.token) {
          const latest = committed(await read(keys.operation), input);
          if (latest.token === observed.token && latest.status !== 'running')
            return { replay: true, operation: latest };
        }
        const pending = pendingHead(head, observed);
        return {
          replay: observed.token !== ownedToken,
          operation: observed,
          snapshot: pending.snapshot ?? null,
        };
      };
      const head = validateHead(await read(keys.head), identity);
      const previous = await read(keys.operation);
      if (previous) return opened(previous);
      if (
        (head?.version ?? 0) !== input.expectedVersion ||
        (head && head.producerSha256 !== input.producerSha256)
      )
        throw engineFailure('NATIVE_ENGINE_HEAD_CHANGED');
      if (head?.pending) throw engineFailure('NATIVE_ENGINE_BUSY');
      const operation = {
        ...keys.operation,
        schemaVersion: 1,
        identity,
        requestId: input.requestId,
        requestSha256: input.requestSha256,
        expectedVersion: input.expectedVersion,
        producerSha256: input.producerSha256,
        ...(input.action ? { action: input.action } : {}),
        ...(input.publicationId ? { publicationId: input.publicationId } : {}),
        token: randomUUID(),
        status: 'running',
        jobs: {},
        startedAt: now(),
      };
      const nextHead = {
        ...keys.head,
        schemaVersion: 1,
        scope: {
          projectId: identity.projectId,
          executionId: identity.executionId,
          bindingId: identity.bindingId,
          attemptId: identity.attemptId,
          epoch: identity.epoch,
          configurationSha256: identity.configurationSha256,
        },
        version: input.expectedVersion,
        producerSha256: input.producerSha256,
        ...(head?.snapshot ? { snapshot: head.snapshot } : {}),
        pending: { requestId: input.requestId, token: operation.token },
      };
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              writerCondition(tableName, identity, row),
              ...(input.publicationId
                ? [
                    {
                      ConditionCheck: {
                        TableName: tableName,
                        Key: abandonedPublicationKey(identity, input.publicationId),
                        ConditionExpression: 'attribute_not_exists(pk)',
                      },
                    },
                  ]
                : []),
              {
                Put: {
                  TableName: tableName,
                  Item: operation,
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: nextHead,
                  ConditionExpression: head
                    ? '#version = :version AND attribute_not_exists(pending) AND producerSha256 = :producer'
                    : 'attribute_not_exists(pk)',
                  ...(head
                    ? {
                        ExpressionAttributeNames: { '#version': 'version' },
                        ExpressionAttributeValues: {
                          ':version': input.expectedVersion,
                          ':producer': input.producerSha256,
                        },
                      }
                    : {}),
                },
              },
            ],
          }),
        );
      } catch (error) {
        // A lost transaction response is resolved by its immutable request ID.
        const observed = await read(keys.operation);
        if (observed) return opened(observed, operation.token);
        if (
          input.publicationId &&
          error?.CancellationReasons?.[0]?.Code === 'None' &&
          error.CancellationReasons[1]?.Code === 'ConditionalCheckFailed'
        )
          throw engineFailure('NATIVE_ENGINE_PUBLICATION_ABANDONED');
        throw transactionFailure(error);
      }
      return { replay: false, operation, snapshot: head?.snapshot ?? null };
    },
    async requireRunning(operation) {
      const key = nativeEngineKeys(operation.identity, operation.requestId).operation;
      const stored = committed(await read(key), operation);
      if (stored.status !== 'running' || stored.token !== operation.token)
        throw engineFailure('NATIVE_ENGINE_HEAD_CHANGED');
    },
    async recordJob(operation, jobId, value, previousStatus = null) {
      const identity = checkedIdentity(operation.identity);
      if (
        !valid(jobId, UUID) ||
        !value ||
        !['prepared', 'running', 'finished', 'uncertain'].includes(value.status)
      )
        throw engineFailure();
      const row = await authorize(identity);
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            writerCondition(tableName, identity, row),
            {
              Update: {
                TableName: tableName,
                Key: nativeEngineKeys(identity, operation.requestId).operation,
                UpdateExpression: 'SET jobs.#job = :job',
                ConditionExpression:
                  '#status = :running AND #token = :token AND ' +
                  (previousStatus
                    ? 'jobs.#job.#status = :previous'
                    : 'attribute_not_exists(jobs.#job)'),
                ExpressionAttributeNames: { '#job': jobId, '#status': 'status', '#token': 'token' },
                ExpressionAttributeValues: {
                  ':job': structuredClone(value),
                  ':running': 'running',
                  ':token': operation.token,
                  ...(previousStatus ? { ':previous': previousStatus } : {}),
                },
              },
            },
          ],
        }),
      );
    },
    async finish({
      operation,
      snapshot: proposed,
      result: proposedResult,
      status = 'completed',
      publication = null,
    }) {
      const identity = checkedIdentity(operation.identity);
      if (!['completed', 'failed'].includes(status)) throw engineFailure();
      const snapshot = proposed === null && status === 'failed' ? null : receipt(proposed);
      const result = receipt(proposedResult);
      const keys = nativeEngineKeys(identity, operation.requestId);
      const row = await authorize(identity);
      const head = validateHead(await read(keys.head), identity);
      const existing = committed(await read(keys.operation), operation);
      if (existing.token !== operation.token) throw engineFailure('NATIVE_ENGINE_REQUEST_CONFLICT');
      if (existing.status !== 'running') {
        if (
          !same(existing.snapshot, snapshot) ||
          !same(existing.result, result) ||
          existing.status !== status
        )
          throw engineFailure('NATIVE_ENGINE_REQUEST_CONFLICT');
        return existing;
      }
      const nextHead = completeHead(tableName, head, operation, { snapshot });
      const finished = {
        ...existing,
        status,
        snapshot,
        result,
        version: nextHead.Put.Item.version,
        finishedAt: now(),
      };
      let proof;
      if (publication) {
        if (
          publication.identity.configurationSha256 !== identity.configurationSha256 ||
          !same(publication.identity, identity) ||
          publication.producerSha256 !== operation.producerSha256 ||
          (existing.publicationId && publication.publicationId !== existing.publicationId) ||
          publication.evidence?.key !==
            `${nativeEngineObjectPrefix(identity, 'output')}${operation.requestId}/evidence.json.gz`
        )
          throw engineFailure('NATIVE_ENGINE_PUBLICATION_INVALID');
        proof = {
          ...nativeEnginePublicationKey(
            { projectId: identity.projectId, executionId: identity.executionId },
            identity.attemptId,
            identity.epoch,
            publication.publicationId,
          ),
          schemaVersion: 1,
          identity,
          requestId: operation.requestId,
          producerSha256: operation.producerSha256,
          publicationId: publication.publicationId,
          evidence: receipt(publication.evidence),
        };
      }
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              writerCondition(tableName, identity, row),
              {
                Put: {
                  TableName: tableName,
                  Item: finished,
                  ConditionExpression: '#status = :running AND #token = :token',
                  ExpressionAttributeNames: { '#status': 'status', '#token': 'token' },
                  ExpressionAttributeValues: { ':running': 'running', ':token': operation.token },
                },
              },
              ...(proof
                ? [
                    {
                      Put: {
                        TableName: tableName,
                        Item: proof,
                        ConditionExpression: 'attribute_not_exists(pk)',
                      },
                    },
                  ]
                : []),
              nextHead,
            ],
          }),
        );
      } catch (error) {
        const observed = await read(keys.operation);
        if (observed?.token === operation.token && observed.status === 'abandoned')
          throw engineFailure('NATIVE_ENGINE_ABANDONED');
        if (
          observed?.token === operation.token &&
          observed.status === status &&
          same(observed.snapshot, snapshot) &&
          same(observed.result, result)
        )
          return committed(observed, operation);
        throw transactionFailure(error);
      }
      return finished;
    },
  };
};

export const nativeEngineRequestSha256 = (request) => engineDigest(canonicalJson(request));
