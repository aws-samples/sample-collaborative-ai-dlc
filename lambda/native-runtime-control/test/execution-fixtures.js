import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { createNativeExecutionStore, nativeExecutionKey } from '../execution-store.js';
import { nativeRuntimeBindingKey } from '../../shared/native-runtime-binding.js';
import { canonicalJson } from '../policies.js';
import {
  ACTOR,
  DEPLOYMENT,
  IDENTITY,
  IMAGE,
  MEMBERSHIP,
  OTHER,
  TABLE,
  candidate,
  receipt,
  request,
  resources,
} from './fixtures.js';

const clone = (v) => structuredClone(v);
const hash = (v) => createHash('sha256').update(v).digest('hex');
export const executionFixture = () => {
  const prepared = {
    ...nativeRuntimeBindingKey(IDENTITY),
    ...IDENTITY,
    projectIdentity: MEMBERSHIP.projectIdentity,
    createdBy: ACTOR,
    bindingId: OTHER,
    status: 'READY',
    version: 7,
    requestFingerprint: `sha256:${'d'.repeat(64)}`,
    request: request(),
    candidate: candidate(),
    archiveReceipt: receipt(),
    imageUri: IMAGE.uri,
    imageDigest: IMAGE.digest,
    ...resources({ ...IDENTITY, bindingId: OTHER }),
  };
  const configuration = {
    harness: 'codex',
    model: 'openai.example',
    promptSha256: hash(prepared.request.prompt),
    packageId: prepared.candidate.packagePin.packageId,
    materializationId: prepared.candidate.materializationId,
    source: {
      sourceId: prepared.request.sourceId,
      bindingRevision: prepared.request.bindingRevision,
      packageJobId: prepared.request.packageJobId,
    },
    repository: {
      provider: 'github',
      repository: 'JWThewes/flappy-bird',
      branch: null,
      bindingRevision: request().bindingRevision,
    },
    credentialBinding: { provider: 'bedrock', source: 'platform' },
    image: {
      uri: IMAGE.uri.replaceAll('a'.repeat(64), 'b'.repeat(64)),
      digest: `sha256:${'b'.repeat(64)}`,
    },
    publicationBucket: 'native-publications',
    packageBucket: 'native-packages',
    accountId: DEPLOYMENT.accountId,
  };
  const rows = new Map();
  const key = (v) => canonicalJson({ pk: v.pk, sk: v.sk });
  rows.set(key(prepared), clone(prepared));
  const hooks = {};
  const read = (k) => clone(rows.get(key(k)));
  const condition = (operation) => {
    const existing = read(operation.Key ?? operation.Item);
    return operation.ConditionExpression.split(' AND ').every((clause) => {
      const absent = /^attribute_not_exists\((#[A-Za-z0-9]+|pk|sk)\)$/.exec(clause);
      if (absent)
        return !Object.hasOwn(
          existing ?? {},
          operation.ExpressionAttributeNames?.[absent[1]] ?? absent[1],
        );
      const match = /^(#?[A-Za-z0-9]+) (=|>|<=) (:[A-Za-z0-9]+)$/.exec(clause);
      if (!match) throw new Error(`Unknown test condition ${clause}`);
      const left = existing?.[operation.ExpressionAttributeNames?.[match[1]] ?? match[1]];
      const right = operation.ExpressionAttributeValues[match[3]];
      return match[2] === '='
        ? isDeepStrictEqual(left, right)
        : match[2] === '>'
          ? left > right
          : left <= right;
    });
  };
  const ddb = {
    async send(command) {
      await hooks.before?.(command);
      if (command instanceof GetCommand) return { Item: read(command.input.Key) };
      if (command instanceof PutCommand) {
        if (!condition(command.input))
          throw Object.assign(new Error('Conditional write failed'), {
            name: 'ConditionalCheckFailedException',
          });
        rows.set(key(command.input.Item), clone(command.input.Item));
        await hooks.after?.(command);
        return {};
      }
      if (command instanceof ScanCommand) return { Items: [...rows.values()].map(clone) };
      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues;
        const matching = [...rows.values()]
          .filter(
            (r) => r.pk === values[':pk'] && r.sk >= values[':after'] && r.sk <= values[':end'],
          )
          .toSorted((a, b) =>
            command.input.ScanIndexForward === false
              ? b.sk.localeCompare(a.sk)
              : a.sk.localeCompare(b.sk),
          );
        const Items = matching.slice(0, command.input.Limit).map(clone);
        return {
          Items,
          ...(matching.length > Items.length
            ? {
                LastEvaluatedKey: { pk: Items.at(-1).pk, sk: Items.at(-1).sk },
              }
            : {}),
        };
      }
      if (!(command instanceof TransactWriteCommand))
        throw new Error('Unexpected authority operation');
      const operations = command.input.TransactItems.map((v) => v.Put ?? v.ConditionCheck);
      if (!operations.every(condition))
        throw Object.assign(new Error('conditional conflict'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        });
      for (const action of command.input.TransactItems)
        if (action.Put) rows.set(key(action.Put.Item), clone(action.Put.Item));
      await hooks.after?.(command);
      return {};
    },
  };
  let time = 1790676000000;
  const preparationStore = { get: async () => clone(prepared) };
  const store = createNativeExecutionStore({
    ddb,
    tableName: TABLE,
    preparationStore,
    now: () => time,
  });
  const start = () =>
    store.start({ ...IDENTITY, actorId: ACTOR, requestId: 'first-request', configuration });
  const target = (row) => {
    const endpoint = `exec_${hash(row.attemptId).slice(0, 32)}`;
    return {
      runtimeArn: prepared.runtimeArn,
      runtimeId: prepared.runtimeId,
      runtimeVersion: '2',
      endpoint,
      endpointArn: `${prepared.runtimeArn}/runtime-endpoint/${endpoint}`,
      imageDigest: configuration.image.digest,
      rolePolicySha256: 'a'.repeat(64),
    };
  };
  return {
    ddb,
    rows,
    store,
    preparationStore,
    prepared,
    configuration,
    start,
    target,
    hooks,
    identity: IDENTITY,
    bindingIdentity: { ...IDENTITY, bindingId: prepared.bindingId },
    tick: (ms = 121000) => {
      time += ms;
    },
    now: () => time,
    row: () => read(nativeExecutionKey(IDENTITY)),
  };
};
