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
import { engineDigest, engineFailure } from '../../shared/native-workflow-protocol.js';

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
export const nativeEngineKeys = (input, requestId) => {
  const identity = checkedIdentity(input);
  const { pk } = nativeExecutionKey({
    projectId: identity.projectId,
    executionId: identity.executionId,
  });
  const prefix = `ENGINE#${identity.attemptId}#${identity.epoch}`;
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
    sk: `ENGINE#${attemptId}#${epoch}#PUBLICATION#${publicationId}`,
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
const conditional = (error) =>
  ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error?.name);
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

export const createNativeEngineStore = ({ ddb, tableName, readExecution, now = Date.now }) => {
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
      !same(operation.identity, input.identity) ||
      operation.requestSha256 !== input.requestSha256 ||
      operation.producerSha256 !== input.producerSha256 ||
      operation.expectedVersion !== input.expectedVersion
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
      const previous = await read(keys.operation);
      if (previous) return { replay: true, operation: committed(previous, input) };
      const head = validateHead(await read(keys.head), identity);
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
        if (observed) return { replay: true, operation: committed(observed, input) };
        if (conditional(error)) throw engineFailure('NATIVE_ENGINE_HEAD_CHANGED');
        throw engineFailure('NATIVE_ENGINE_UNAVAILABLE');
      }
      return { replay: false, operation, snapshot: head?.snapshot ?? null };
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
      const existing = await read(keys.operation);
      if (
        !existing ||
        existing.token !== operation.token ||
        existing.requestSha256 !== operation.requestSha256 ||
        !same(existing.identity, identity)
      )
        throw engineFailure('NATIVE_ENGINE_REQUEST_CONFLICT');
      if (existing.status !== 'running') {
        if (
          !same(existing.snapshot, snapshot) ||
          !same(existing.result, result) ||
          existing.status !== status
        )
          throw engineFailure('NATIVE_ENGINE_REQUEST_CONFLICT');
        return existing;
      }
      const row = await authorize(identity);
      const head = validateHead(await read(keys.head), identity);
      if (head?.pending?.token !== operation.token)
        throw engineFailure('NATIVE_ENGINE_HEAD_CHANGED');
      const nextHead = { ...head, snapshot, version: operation.expectedVersion + 1 };
      delete nextHead.pending;
      const finished = {
        ...existing,
        status,
        snapshot,
        result,
        version: nextHead.version,
        finishedAt: now(),
      };
      let proof;
      if (publication) {
        if (
          publication.identity.configurationSha256 !== identity.configurationSha256 ||
          !same(publication.identity, identity) ||
          publication.producerSha256 !== operation.producerSha256
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
              {
                Put: {
                  TableName: tableName,
                  Item: nextHead,
                  ConditionExpression: 'pending.#token = :token AND #version = :version',
                  ExpressionAttributeNames: { '#token': 'token', '#version': 'version' },
                  ExpressionAttributeValues: {
                    ':token': operation.token,
                    ':version': operation.expectedVersion,
                  },
                },
              },
            ],
          }),
        );
      } catch (error) {
        const observed = await read(keys.operation);
        if (
          observed?.token === operation.token &&
          observed.status === status &&
          same(observed.snapshot, snapshot) &&
          same(observed.result, result)
        )
          return observed;
        if (conditional(error)) throw engineFailure('NATIVE_ENGINE_WRITER_CHANGED');
        throw engineFailure('NATIVE_ENGINE_UNAVAILABLE');
      }
      return finished;
    },
  };
};

export const nativeEngineRequestSha256 = (request) => engineDigest(canonicalJson(request));
