import { nativeInputSnapshot } from '../../shared/native-inputs.js';
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
// Bundling may rename a local constructor. Separately installed production
// commands retain their AWS operation name but have a different prototype.
const isCommand = (command, Type, operation) =>
  command instanceof Type || command.constructor.name === operation;
export const executionFixture = ({
  harness = 'codex',
  model = 'openai.example',
  recoveryMode = 'efs-workspace-v1',
  packageVersion = '2.9.0',
  preparedDraft,
  prompt,
} = {}) => {
  const prepared = preparedDraft ?? {
    ...nativeRuntimeBindingKey(IDENTITY),
    ...IDENTITY,
    projectIdentity: MEMBERSHIP.projectIdentity,
    createdBy: ACTOR,
    bindingId: OTHER,
    status: 'READY',
    version: 7,
    requestFingerprint: `sha256:${'d'.repeat(64)}`,
    request: request({ harness, ...(prompt === undefined ? {} : { prompt }) }),
    candidate: candidate({ version: packageVersion }),
    archiveReceipt: receipt(),
    imageUri: IMAGE.uri,
    imageDigest: IMAGE.digest,
    ...resources({ ...IDENTITY, bindingId: OTHER }),
  };
  const identity = { projectId: prepared.projectId, executionId: prepared.executionId };
  const configuration = {
    harness: prepared.request.harness,
    model,
    inputs: nativeInputSnapshot(prepared, 'native-inputs'),
    ...(recoveryMode ? { recoveryMode } : {}),
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
      branch: 'main',
      commit: 'c'.repeat(40),
      credentialIdentity: 'd'.repeat(64),
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
  // Attribute paths may be nested (`pending.#token`), as the protected engine's
  // journal conditions are.
  const attribute = (operation, item, expression) =>
    expression
      .split('.')
      .map((part) => operation.ExpressionAttributeNames?.[part] ?? part)
      .reduce(
        (value, part) => (value === null || value === undefined ? undefined : value[part]),
        item,
      );
  const condition = (operation) => {
    const existing = read(operation.Key ?? operation.Item);
    return operation.ConditionExpression.split(' AND ').every((clause) => {
      const absent = /^attribute_not_exists\(([#A-Za-z0-9.]+)\)$/.exec(clause);
      if (absent) return attribute(operation, existing, absent[1]) === undefined;
      const member = /^([#A-Za-z0-9.]+) IN \(([:A-Za-z0-9, ]+)\)$/.exec(clause);
      if (member)
        return member[2]
          .split(', ')
          .some((name) =>
            isDeepStrictEqual(
              attribute(operation, existing, member[1]),
              operation.ExpressionAttributeValues[name],
            ),
          );
      const match = /^([#A-Za-z0-9.]+) (=|>|<=) (:[A-Za-z0-9]+)$/.exec(clause);
      if (!match) throw new Error(`Unknown test condition ${clause}`);
      const left = attribute(operation, existing, match[1]);
      const right = operation.ExpressionAttributeValues[match[3]];
      return match[2] === '='
        ? isDeepStrictEqual(left, right)
        : match[2] === '>'
          ? left > right
          : left <= right;
    });
  };
  const update = (operation) => {
    const item = read(operation.Key);
    for (const assignment of operation.UpdateExpression.replace(/^SET /, '').split(', ')) {
      const set = /^([#A-Za-z0-9.]+) = (:[A-Za-z0-9]+)$/.exec(assignment);
      if (!set) throw new Error(`Unknown test update ${operation.UpdateExpression}`);
      const parts = set[1]
        .split('.')
        .map((part) => operation.ExpressionAttributeNames?.[part] ?? part);
      const parent = parts.slice(0, -1).reduce((value, part) => value[part], item);
      parent[parts.at(-1)] = clone(operation.ExpressionAttributeValues[set[2]]);
    }
    rows.set(key(item), item);
  };
  const ddb = {
    async send(command) {
      await hooks.before?.(command);
      if (isCommand(command, GetCommand, 'GetCommand')) return { Item: read(command.input.Key) };
      if (isCommand(command, PutCommand, 'PutCommand')) {
        if (!condition(command.input))
          throw Object.assign(new Error('Conditional write failed'), {
            name: 'ConditionalCheckFailedException',
          });
        rows.set(key(command.input.Item), clone(command.input.Item));
        await hooks.after?.(command);
        return {};
      }
      if (isCommand(command, ScanCommand, 'ScanCommand'))
        return { Items: [...rows.values()].map(clone) };
      if (isCommand(command, QueryCommand, 'QueryCommand')) {
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
      if (!isCommand(command, TransactWriteCommand, 'TransactWriteCommand'))
        throw new Error('Unexpected authority operation');
      const operations = command.input.TransactItems.map(
        (v) => v.Put ?? v.ConditionCheck ?? v.Update,
      );
      const reasons = operations.map((operation) => ({
        Code: condition(operation) ? 'None' : 'ConditionalCheckFailed',
      }));
      if (reasons.some((reason) => reason.Code !== 'None'))
        throw Object.assign(new Error('conditional conflict'), {
          name: 'TransactionCanceledException',
          CancellationReasons: reasons,
        });
      for (const action of command.input.TransactItems) {
        if (action.Put) rows.set(key(action.Put.Item), clone(action.Put.Item));
        if (action.Update) update(action.Update);
      }
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
    store.start({
      ...identity,
      actorId: ACTOR,
      requestId: 'first-request',
      inputRevision: configuration.inputs.revision,
      configuration,
    });
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
    identity,
    bindingIdentity: { ...identity, bindingId: prepared.bindingId },
    tick: (ms = 121000) => {
      time += ms;
    },
    now: () => time,
    row: () => read(nativeExecutionKey(identity)),
  };
};
