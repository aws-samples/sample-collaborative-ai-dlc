import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { expect, vi } from 'vitest';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';
import { workflowSourceIdentity } from '../../shared/workflow-source-bindings.js';
import { describeNativePackagePin } from '../../shared/native-package-pin.js';
import {
  nativeRuntimeBindingKey,
  nativeRuntimeResourceNames,
} from '../../shared/native-runtime-binding.js';
import { createNativeRuntimeStore } from '../store.js';

export const PROJECT = '22371643-2db5-42a4-a571-e47fc35745f5';
export const INTENT = '10000000-0000-4000-8000-000000000001';
export const JOB = '20000000-0000-4000-8000-000000000001';
export const REVISION = '30000000-0000-4000-8000-000000000001';
export const OTHER = '40000000-0000-4000-8000-000000000001';
export const ACTOR = 'member-one';
export const TABLE = 'native-run-bindings';
export const IDENTITY = { projectId: PROJECT, executionId: INTENT };
export const SOURCE = workflowSourceIdentity('github', 'awslabs/aidlc-workflows');
export const MEMBERSHIP = {
  role: 'member',
  membershipId: 'edge-one',
  projectIdentity: 'vertex-one',
};
export const DEPLOYMENT = {
  accountId: '123456789012',
  region: 'us-east-1',
  partition: 'aws',
  fileSystemId: 'fs-1234567890abcdef0',
};
export const IMAGE = {
  uri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentcore@sha256:${'a'.repeat(64)}`,
  digest: `sha256:${'a'.repeat(64)}`,
};
export const request = (overrides = {}) => ({
  intentId: INTENT,
  title: 'Native draft',
  prompt: 'Build a small game.\nUse the agreed workflow.',
  harness: 'codex',
  sourceId: SOURCE.sourceId,
  packageJobId: JOB,
  bindingRevision: REVISION,
  ...overrides,
});
export const binding = (overrides = {}) => ({
  projectId: PROJECT,
  ...SOURCE,
  revision: REVISION,
  projectIdentity: MEMBERSHIP.projectIdentity,
  // The API must never spread source credentials or authority into its row/DTO.
  credentialBinding: { secretRef: 'private-source-secret' },
  ...overrides,
});
export const candidate = ({ version = '2.9.0', ...overrides } = {}) => {
  const identity = {
    schemaVersion: 1,
    source: {
      provider: SOURCE.provider,
      repository: SOURCE.repository,
      release: `v${version}`,
      commit: 'a'.repeat(40),
    },
    target: 'linux-arm64',
    version,
    manifestSha256: 'b'.repeat(64),
    checksumsSha256: 'c'.repeat(64),
    assets: {
      binary: { name: 'aidlc-linux-arm64', sha256: 'd'.repeat(64), bytes: 17 },
      runtime: { name: `aidlc-runtime-${version}.tar.gz`, sha256: 'e'.repeat(64), bytes: 55 },
    },
    harnesses: ['claude', 'codex', 'kiro', 'opencode'],
  };
  const packagePin = {
    ...identity,
    packageId: `sha256:${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`,
  };
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    sourceId: SOURCE.sourceId,
    bindingRevision: REVISION,
    requestedRelease: 'latest',
    packagePin,
    attestation: null,
    materializationId: describeNativePackagePin(packagePin, null).materializationId,
    ...overrides,
  };
};
export const receipt = (pin = candidate()) => ({
  schemaVersion: 1,
  materializationId: pin.materializationId,
  manifest: { versionId: 'immutable-version-one', sha256: 'f'.repeat(64), bytes: 1024 },
});
export const job = (overrides = {}) => ({
  projectId: PROJECT,
  jobId: JOB,
  sourceId: SOURCE.sourceId,
  bindingRevision: REVISION,
  requestedRelease: 'latest',
  state: 'SUCCEEDED',
  candidate: candidate(),
  archiveReceipt: receipt(),
  ...overrides,
});
export const createInput = (overrides = {}) => ({
  projectId: PROJECT,
  actorId: ACTOR,
  projectIdentity: MEMBERSHIP.projectIdentity,
  request: request(),
  candidate: candidate(),
  archiveReceipt: receipt(),
  image: IMAGE,
  ...overrides,
});
export const resources = (row) => {
  const names = nativeRuntimeResourceNames(row);
  const runtimeId = `${names.runtimeName}-abcdef1234`;
  const runtimeArn = `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${runtimeId}`;
  return {
    executionRoleArn: `arn:aws:iam::123456789012:role/native-runs/${names.roleName}`,
    accessPointArn:
      'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-1234567890abcdef0',
    fileSystemId: DEPLOYMENT.fileSystemId,
    rootDirectory: names.rootDirectory,
    mountPath: '/mnt/native',
    runtimeId,
    runtimeArn,
    runtimeVersion: '1',
    runtimeEndpoint: names.endpointName,
    runtimeEndpointArn: `${runtimeArn}/runtime-endpoint/${names.endpointName}`,
  };
};
export const owner = (row) => ({
  projectId: row.projectId,
  executionId: row.executionId,
  bindingId: row.bindingId,
  version: row.version,
  leaseToken: row.leaseToken,
  fence: row.fence,
});
export const awsError = (name = 'ConditionalCheckFailedException') =>
  Object.assign(new Error('private service details and credentials'), { name });

// Evaluate the store's actual CAS expressions against mutable rows, including
// races and acknowledgement loss; do not preprogram successful write results.
export const storage = () => {
  const rows = new Map();
  const hooks = {};
  const key = (row) => JSON.stringify([row.pk, row.sk]);
  const read = (identity = IDENTITY) =>
    structuredClone(rows.get(key(nativeRuntimeBindingKey(identity))));
  const write = (row) => rows.set(key(row), structuredClone(row));
  const condition = (input) => {
    expect(input.TableName).toBe(TABLE);
    const existing = rows.get(key(input.Key ?? input.Item));
    return input.ConditionExpression.split(' AND ').every((clause) => {
      const absent = /^attribute_not_exists\((pk|sk)\)$/.exec(clause);
      if (absent) return !existing || !Object.hasOwn(existing, absent[1]);
      const match = /^(#[A-Za-z]+) (=|>|<=) (:[A-Za-z]+)$/.exec(clause);
      if (!match) throw new Error(`Unsupported condition: ${clause}`);
      const left = existing?.[input.ExpressionAttributeNames[match[1]]];
      const right = input.ExpressionAttributeValues[match[3]];
      return match[2] === '='
        ? isDeepStrictEqual(left, right)
        : match[2] === '>'
          ? left > right
          : left <= right;
    });
  };
  const send = vi.fn(async (command) => {
    await hooks.before?.(command);
    const input = command.input;
    let result;
    if (command instanceof TransactWriteCommand) {
      const operations = input.TransactItems.map((item) => item.Put ?? item.ConditionCheck);
      if (!operations.every(condition))
        throw Object.assign(awsError('TransactionCanceledException'), {
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        });
      for (const item of input.TransactItems) if (item.Put) write(item.Put.Item);
      result = {};
    } else if (command instanceof GetCommand) {
      expect(input.TableName).toBe(TABLE);
      const existing = rows.get(key(input.Key));
      expect(input.ConsistentRead).toBe(true);
      result = existing === undefined ? {} : { Item: structuredClone(existing) };
    } else if (command instanceof PutCommand) {
      if (!condition(input)) throw awsError();
      write(input.Item);
      result = {};
    } else throw new Error('Unexpected command');
    await hooks.after?.(command, result);
    return result;
  });
  return { ddb: { send }, hooks, read, write, rows };
};
export const setup = (options = {}) => {
  const f = storage();
  let time = 1000;
  const store = createNativeRuntimeStore({
    ddb: f.ddb,
    tableName: TABLE,
    deployment: DEPLOYMENT,
    now: () => time,
    leaseMs: 100,
    ...options,
  });
  return {
    ...f,
    store,
    setTime: (value) => {
      time = value;
    },
    async claimed() {
      const { row } = await store.create(createInput());
      await store.prepare(IDENTITY);
      return (await store.claim({ ...IDENTITY, bindingId: row.bindingId })).row;
    },
  };
};
export const pauseOnce = (f, phase, predicate) => {
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  let entered = false;
  f.hooks[phase] = async (command) => {
    if (entered || !predicate(command)) return;
    entered = true;
    started.resolve();
    await released.promise;
  };
  return { started: started.promise, resume: released.resolve };
};
export const event = (operation = 'create', overrides = {}) => {
  const collection = ['create', 'capabilities'].includes(operation);
  const prepare = operation === 'prepare';
  return {
    resource: `/api/projects/{projectId}/native-intents${collection ? '' : '/{intentId}'}${prepare ? '/prepare' : ''}`,
    httpMethod: ['get', 'capabilities'].includes(operation) ? 'GET' : 'POST',
    path: `/api/projects/${PROJECT}/native-intents${collection ? '' : `/${INTENT}`}${prepare ? '/prepare' : ''}`,
    pathParameters: { projectId: PROJECT, ...(collection ? {} : { intentId: INTENT }) },
    requestContext: { authorizer: { claims: { sub: ACTOR } } },
    ...(operation === 'create' ? { body: JSON.stringify(request()) } : {}),
    ...overrides,
  };
};
