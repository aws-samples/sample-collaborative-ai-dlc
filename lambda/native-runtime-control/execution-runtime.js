import { createHash } from 'node:crypto';
import {
  GetAgentRuntimeCommand,
  UpdateAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
  CreateAgentRuntimeEndpointCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  GetRoleCommand,
  GetRolePolicyCommand,
  PutRolePolicyCommand,
  ListRolePoliciesCommand,
  ListAttachedRolePoliciesCommand,
} from '@aws-sdk/client-iam';
import { DescribeAccessPointsCommand } from '@aws-sdk/client-efs';
import { nativeRuntimeResourceNames } from '../shared/native-runtime-binding.js';
import { nativePublicationScope } from '../shared/native-publication.js';
import { nativeExecutionFenceKey } from '../shared/native-execution-fence.js';
import { nativeRecoveryScope } from '../shared/native-recovery-checkpoint.js';
import { nativeWorkspaceRecovery } from '../shared/native-recovery-mode.js';
import { nativeRuntimeEnvironment } from './provisioner.js';
import { canonicalJson, runtimePolicyDocuments, samePolicy } from './policies.js';
import { nativeDraftPrompt } from './draft-prompt.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const mismatch = () => {
  throw Object.assign(new Error('Native execution runtime configuration changed'), {
    code: 'NATIVE_EXECUTION_RUNTIME_MISMATCH',
  });
};
const absent = (error) => error?.name === 'ResourceNotFoundException';
const normalizeNetwork = (input) => {
  const v = structuredClone(input);
  if (v?.networkModeConfig?.requireServiceS3Endpoint === false)
    delete v.networkModeConfig.requireServiceS3Endpoint;
  if (v?.networkModeConfig?.subnets) v.networkModeConfig.subnets.sort();
  if (v?.networkModeConfig?.securityGroups) v.networkModeConfig.securityGroups.sort();
  return v;
};
export const executionIdentity = (row) => ({
  ...row.scope,
  bindingId: row.bindingId,
  attemptId: row.attemptId,
  epoch: row.epoch,
  runtimeSessionId: row.runtimeSessionId,
});
export const executionRuntimeConfiguration = (draft, row) => ({
  harness: row.configuration.harness,
  ...(row.configuration.recoveryMode ? { recoveryMode: row.configuration.recoveryMode } : {}),
  model: row.configuration.model,
  prompt: nativeDraftPrompt(draft).text,
  packageVersion: draft.candidate.packagePin.version,
  repository: {
    provider: row.configuration.repository.provider,
    repository: row.configuration.repository.repository,
    branch: row.sourceBranch,
    commit: row.sourceCommit,
  },
});

export const nativeExecutionPolicy = ({ draft, execution, deployment }) => {
  const config = execution.configuration;
  const d = { ...deployment, imageUri: config.image.uri, imageDigest: config.image.digest };
  const base = runtimePolicyDocuments({
    deployment: d,
    identity: draft,
    accessPointArn: draft.accessPointArn,
  });
  const scope = nativePublicationScope(executionIdentity(execution));
  const packageScope = hash(
    canonicalJson({
      schemaVersion: 1,
      projectId: draft.projectId,
      sourceId: config.source.sourceId,
    }),
  );
  const packagePrefix = `native-packages/v1/${packageScope}/${config.materializationId.slice(7)}/`;
  const prefix = `arn:${d.partition}:s3:::`;
  return {
    ...base,
    permissionsPolicy: {
      ...base.permissionsPolicy,
      Statement: [
        ...base.permissionsPolicy.Statement,
        {
          Sid: 'ReadPinnedWorkflowBytes',
          Effect: 'Allow',
          Action: 's3:GetObjectVersion',
          Resource: `${prefix}${config.packageBucket}/${packagePrefix}*`,
        },
        {
          Sid: 'PublishOwnAttemptBytes',
          Effect: 'Allow',
          Action: ['s3:PutObject', 's3:GetObjectVersion'],
          Resource: `${prefix}${config.publicationBucket}/${scope.prefix}*`,
        },
        {
          Sid: 'ReadOwnCancellationFence',
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: `${prefix}${config.publicationBucket}/${nativeExecutionFenceKey(executionIdentity(execution))}`,
        },
        ...(nativeWorkspaceRecovery(config)
          ? []
          : [
              {
                // Immutable private resume bytes are separate from member-visible
                // publications. Generations share this exact attempt/epoch scope;
                // only the protected controller can admit a checkpoint/generation.
                Sid: 'PreserveOwnRecoveryCheckpoint',
                Effect: 'Allow',
                Action: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
                Resource: `${prefix}${config.publicationBucket}/${nativeRecoveryScope(executionIdentity(execution)).prefix}*`,
              },
            ]),
      ],
    },
  };
};

// Explicit pre-start transition. The preparation record/endpoint retains its
// old image/version; this creates and verifies a separate executable version.
export const createExecutionRuntimeUpgrade = ({ iam, control, efs, deployment, authorize }) => {
  const send = async (client, command) => {
    await authorize();
    return client.send(command, { abortSignal: AbortSignal.timeout(10000) });
  };
  return async ({ draft, execution }) => {
    const names = nativeRuntimeResourceNames(draft);
    const config = execution.configuration;
    const documents = nativeExecutionPolicy({ draft, execution, deployment });
    const original = runtimePolicyDocuments({
      deployment: { ...deployment, imageUri: draft.imageUri, imageDigest: draft.imageDigest },
      identity: draft,
      accessPointArn: draft.accessPointArn,
    });
    const role = (await send(iam, new GetRoleCommand({ RoleName: names.roleName }))).Role;
    const [inline, attached, accessPoints] = await Promise.all([
      send(iam, new ListRolePoliciesCommand({ RoleName: names.roleName })),
      send(iam, new ListAttachedRolePoliciesCommand({ RoleName: names.roleName })),
      send(
        efs,
        new DescribeAccessPointsCommand({ AccessPointId: draft.accessPointArn.split('/').at(-1) }),
      ),
    ]);
    const ap = accessPoints.AccessPoints?.[0];
    if (
      role?.Arn !== draft.executionRoleArn ||
      role?.PermissionsBoundary?.PermissionsBoundaryArn !== deployment.permissionsBoundaryArn ||
      !samePolicy(role?.AssumeRolePolicyDocument, original.trustPolicy) ||
      inline.IsTruncated ||
      inline.PolicyNames?.length !== 1 ||
      inline.PolicyNames[0] !== 'native-runtime' ||
      attached.IsTruncated ||
      attached.AttachedPolicies?.length !== 0 ||
      accessPoints.NextToken ||
      accessPoints.AccessPoints?.length !== 1 ||
      ap?.AccessPointArn !== draft.accessPointArn ||
      ap.FileSystemId !== draft.fileSystemId ||
      ap.RootDirectory?.Path !== draft.rootDirectory ||
      ap.PosixUser?.Uid !== 1000 ||
      ap.PosixUser?.Gid !== 1000 ||
      ap.LifeCycleState !== 'available'
    )
      mismatch();
    const installed = await send(
      iam,
      new GetRolePolicyCommand({ RoleName: names.roleName, PolicyName: 'native-runtime' }),
    );
    if (!samePolicy(installed.PolicyDocument, documents.permissionsPolicy)) {
      if (!samePolicy(installed.PolicyDocument, original.permissionsPolicy)) mismatch();
      await send(
        iam,
        new PutRolePolicyCommand({
          RoleName: names.roleName,
          PolicyName: 'native-runtime',
          PolicyDocument: JSON.stringify(documents.permissionsPolicy),
        }),
      );
      const verified = await send(
        iam,
        new GetRolePolicyCommand({ RoleName: names.roleName, PolicyName: 'native-runtime' }),
      );
      if (!samePolicy(verified.PolicyDocument, documents.permissionsPolicy)) mismatch();
    }
    const environmentVariables = {
      ...nativeRuntimeEnvironment(draft),
      NATIVE_EXECUTION_ENABLED: 'true',
      NATIVE_EXECUTION_ATTEMPT_ID: execution.attemptId,
      NATIVE_EXECUTION_EPOCH: String(execution.epoch),
      NATIVE_EXECUTION_RUNTIME_SESSION_ID: execution.runtimeSessionId,
      NATIVE_EXECUTION_IMAGE_DIGEST: config.image.digest,
      NATIVE_RUNTIME_ACCOUNT_ID: config.accountId,
      NATIVE_PACKAGE_BUCKET: config.packageBucket,
      NATIVE_PUBLICATION_BUCKET: config.publicationBucket,
    };
    const expected = {
      agentRuntimeArtifact: { containerConfiguration: { containerUri: config.image.uri } },
      roleArn: draft.executionRoleArn,
      networkConfiguration: {
        networkMode: 'VPC',
        networkModeConfig: {
          subnets: deployment.subnetIds.toSorted(),
          securityGroups: deployment.securityGroupIds.toSorted(),
        },
      },
      protocolConfiguration: { serverProtocol: 'HTTP' },
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
      environmentVariables,
      filesystemConfigurations: [
        { efsAccessPoint: { accessPointArn: draft.accessPointArn, mountPath: draft.mountPath } },
      ],
    };
    let runtime = await send(
      control,
      new GetAgentRuntimeCommand({ agentRuntimeId: draft.runtimeId }),
    );
    if (
      runtime.agentRuntimeId !== draft.runtimeId ||
      runtime.agentRuntimeArn !== draft.runtimeArn ||
      runtime.agentRuntimeName !== names.runtimeName ||
      runtime.authorizerConfiguration ||
      runtime.capacityProviderConfiguration ||
      runtime.requestHeaderConfiguration
    )
      mismatch();
    for (const key of [
      'roleArn',
      'protocolConfiguration',
      'lifecycleConfiguration',
      'filesystemConfigurations',
    ]) {
      if (canonicalJson(runtime[key]) !== canonicalJson(expected[key])) mismatch();
    }
    if (
      canonicalJson(normalizeNetwork(runtime.networkConfiguration)) !==
      canonicalJson(expected.networkConfiguration)
    )
      mismatch();
    const desired =
      canonicalJson(runtime.environmentVariables) ===
        canonicalJson(expected.environmentVariables) &&
      canonicalJson(runtime.agentRuntimeArtifact) === canonicalJson(expected.agentRuntimeArtifact);
    if (!desired) {
      if (
        runtime.agentRuntimeVersion !== draft.runtimeVersion ||
        canonicalJson(runtime.environmentVariables) !==
          canonicalJson(nativeRuntimeEnvironment(draft)) ||
        runtime.agentRuntimeArtifact?.containerConfiguration?.containerUri !== draft.imageUri ||
        runtime.status !== 'READY'
      )
        mismatch();
      const updated = await send(
        control,
        new UpdateAgentRuntimeCommand({
          ...expected,
          agentRuntimeId: draft.runtimeId,
          clientToken: hash(`native-execution:${execution.attemptId}:${config.image.digest}`),
        }),
      );
      if (
        updated.agentRuntimeArn !== draft.runtimeArn ||
        !/^[1-9]\d*$/.test(updated.agentRuntimeVersion ?? '')
      )
        mismatch();
      return { ready: false };
    }
    if (['CREATING', 'UPDATING'].includes(runtime.status)) return { ready: false };
    if (runtime.status !== 'READY' || !/^[1-9]\d*$/.test(runtime.agentRuntimeVersion ?? ''))
      mismatch();
    const endpointName = `exec_${hash(execution.attemptId).slice(0, 32)}`;
    let endpoint;
    try {
      endpoint = await send(
        control,
        new GetAgentRuntimeEndpointCommand({ agentRuntimeId: draft.runtimeId, endpointName }),
      );
    } catch (error) {
      if (!absent(error)) throw error;
      await send(
        control,
        new CreateAgentRuntimeEndpointCommand({
          agentRuntimeId: draft.runtimeId,
          name: endpointName,
          agentRuntimeVersion: runtime.agentRuntimeVersion,
          clientToken: hash(`native-endpoint:${execution.attemptId}`),
        }),
      );
      return { ready: false };
    }
    if (
      endpoint.name !== endpointName ||
      endpoint.agentRuntimeArn !== draft.runtimeArn ||
      endpoint.agentRuntimeEndpointArn !== `${draft.runtimeArn}/runtime-endpoint/${endpointName}` ||
      (endpoint.targetVersion != null && endpoint.targetVersion !== runtime.agentRuntimeVersion)
    )
      mismatch();
    if (['CREATING', 'UPDATING'].includes(endpoint.status)) return { ready: false };
    if (endpoint.status !== 'READY' || endpoint.liveVersion !== runtime.agentRuntimeVersion)
      mismatch();
    await authorize();
    return {
      ready: true,
      target: {
        runtimeArn: draft.runtimeArn,
        runtimeId: draft.runtimeId,
        runtimeVersion: runtime.agentRuntimeVersion,
        endpoint: endpointName,
        endpointArn: endpoint.agentRuntimeEndpointArn,
        imageDigest: config.image.digest,
        rolePolicySha256: hash(canonicalJson(documents.permissionsPolicy)),
      },
    };
  };
};
