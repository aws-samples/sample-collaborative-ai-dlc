// Native dispatch authority is separate from the process META projection.
// Only the provisioner/supervisor may write this table. The runtime must have
// no access to it. This reader does not provision resources or qualify IAM:
// READY may be published only after the per-run boundary has been verified.
import { createHash } from 'node:crypto';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

const identifier = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 512 &&
  Array.from(value).every((character) => {
    const code = character.codePointAt(0);
    return code >= 32 && code !== 127;
  });

export const nativeRuntimeBindingKey = ({ projectId, executionId }) => {
  if (!identifier(projectId) || !identifier(executionId)) {
    fail('invalid_native_execution_identity', 'A project and execution identity are required');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([projectId, executionId]))
    .digest('hex');
  return { pk: `NATIVE#${digest}`, sk: 'RUNTIME' };
};

const bindingIdValid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export const nativeRuntimeResourceNames = ({ projectId, executionId, bindingId }) => {
  nativeRuntimeBindingKey({ projectId, executionId });
  if (!bindingIdValid(bindingId)) {
    fail('native_runtime_binding_invalid', 'A native runtime binding generation is required');
  }
  const generationHash = createHash('sha256')
    .update(JSON.stringify([projectId, executionId, bindingId]))
    .digest('hex');
  const nameHash = generationHash.slice(0, 32);
  return {
    runtimeName: `native_${nameHash}`,
    roleName: `native_${nameHash}`,
    endpointName: `run_${nameHash}`,
    // EFS access-point root paths have a 100-character maximum. The full
    // generation hash preserves all scope inputs while keeping this at 70.
    rootDirectory: `/runs/${generationHash}`,
  };
};

const runtimeIdentity = (arn) =>
  typeof arn === 'string'
    ? /^arn:(aws(?:-[a-z]+)*):bedrock-agentcore:([a-z0-9-]+):([0-9]{12}):runtime\/([A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+)$/.exec(
        arn,
      )
    : null;

const complete = (item, expected) => {
  const runtime = runtimeIdentity(item?.runtimeArn);
  if (!runtime || !bindingIdValid(item.bindingId)) return false;
  const [, partition, region, account] = runtime;
  const names = nativeRuntimeResourceNames({ ...expected, bindingId: item.bindingId });
  const efsPrefix = `arn:${partition}:elasticfilesystem:${region}:${account}:access-point/`;
  return (
    partition === expected.deployment.partition &&
    region === expected.deployment.region &&
    account === expected.deployment.accountId &&
    item.schemaVersion === 1 &&
    item.pk === expected.pk &&
    item.sk === expected.sk &&
    item.projectId === expected.projectId &&
    item.executionId === expected.executionId &&
    item.isolation === 'execution' &&
    runtime[4].startsWith(`${names.runtimeName}-`) &&
    typeof item.runtimeVersion === 'string' &&
    /^[1-9][0-9]*$/.test(item.runtimeVersion) &&
    item.runtimeEndpoint === names.endpointName &&
    typeof item.imageDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(item.imageDigest) &&
    item.executionRoleArn ===
      `arn:${partition}:iam::${account}:role/native-runs/${names.roleName}` &&
    typeof item.accessPointArn === 'string' &&
    item.accessPointArn.startsWith(efsPrefix) &&
    /^fsap-[0-9a-f]{17}$/.test(item.accessPointArn.slice(efsPrefix.length)) &&
    item.fileSystemId === expected.deployment.fileSystemId &&
    item.mountPath === '/mnt/native' &&
    item.rootDirectory === names.rootDirectory
  );
};

// Resolve afresh for each dispatch: cancellation/retirement must not be hidden
// by an invocation's cached READY binding. No caller-supplied snapshot, image,
// runtime ARN, environment fallback, or projected status participates.
export const resolveNativeRuntimeBinding = async ({
  ddb,
  tableName = process.env.NATIVE_RUNTIME_BINDINGS_TABLE,
  projectId,
  executionId,
  // Supplied by deployment configuration, never request JSON or process META.
  deployment = {
    accountId: process.env.NATIVE_RUNTIME_ACCOUNT_ID,
    region: process.env.AWS_REGION,
    partition: process.env.AWS_PARTITION || 'aws',
    fileSystemId: process.env.NATIVE_RUNTIME_FILE_SYSTEM_ID,
  },
}) => {
  const key = nativeRuntimeBindingKey({ projectId, executionId });
  if (
    !ddb ||
    typeof ddb.send !== 'function' ||
    !tableName ||
    typeof deployment?.accountId !== 'string' ||
    !/^[0-9]{12}$/.test(deployment.accountId) ||
    typeof deployment.region !== 'string' ||
    !/^[a-z0-9-]+$/.test(deployment.region) ||
    typeof deployment.partition !== 'string' ||
    !/^aws(?:-[a-z]+)*$/.test(deployment.partition) ||
    typeof deployment.fileSystemId !== 'string' ||
    !/^fs-[0-9a-f]{8}(?:[0-9a-f]{9})?$/.test(deployment.fileSystemId)
  ) {
    fail('native_runtime_bindings_unconfigured', 'Native runtime bindings are not configured');
  }
  const { Item: item } = await ddb.send(
    new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
  );
  if (!item) {
    fail('native_runtime_binding_missing', 'The native execution has no runtime binding');
  }
  if (!complete(item, { ...key, projectId, executionId, deployment })) {
    fail('native_runtime_binding_invalid', 'The native runtime binding is incomplete or invalid');
  }
  if (item.status !== 'READY') {
    fail('native_runtime_binding_not_ready', 'The native runtime binding is not ready');
  }
  // Project only contract fields, excluding unknown registry attributes.
  // Names/claimed roots cannot prove the AWS AP's real root or endpoint version:
  // independently checking that resource tuple is a prerequisite for READY.
  return Object.freeze({
    bindingId: item.bindingId,
    projectId,
    executionId,
    runtimeVersion: item.runtimeVersion,
    imageDigest: item.imageDigest,
    executionRoleArn: item.executionRoleArn,
    accessPointArn: item.accessPointArn,
    fileSystemId: item.fileSystemId,
    mountPath: item.mountPath,
    rootDirectory: item.rootDirectory,
    target: Object.freeze({
      agentRuntimeArn: item.runtimeArn,
      qualifier: item.runtimeEndpoint,
    }),
  });
};
