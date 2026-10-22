import { describe, expect, it, vi } from 'vitest';
import { createExecutionRuntimeUpgrade, nativeExecutionPolicy } from '../execution-runtime.js';
import { nativeRuntimeEnvironment } from '../provisioner.js';
import { runtimePolicyDocuments } from '../policies.js';
import { nativeRuntimeResourceNames } from '../../shared/native-runtime-binding.js';
import { nativeRecoveryScope } from '../../shared/native-recovery-checkpoint.js';
import { executionIdentity } from '../execution-runtime.js';
import { executionFixture } from './execution-fixtures.js';
import { DEPLOYMENT } from './fixtures.js';

const make = async () => {
  const f = executionFixture();
  await f.start();
  const execution = f.row(),
    draft = f.prepared;
  const deployment = {
    ...DEPLOYMENT,
    imageUri: draft.imageUri,
    imageDigest: draft.imageDigest,
    ecrRepositoryArn: `arn:aws:ecr:us-east-1:${DEPLOYMENT.accountId}:repository/agentcore`,
    permissionsBoundaryArn: `arn:aws:iam::${DEPLOYMENT.accountId}:policy/native-boundary`,
    subnetIds: ['subnet-22222222', 'subnet-11111111'],
    securityGroupIds: ['sg-11111111'],
  };
  const names = nativeRuntimeResourceNames(draft);
  const base = runtimePolicyDocuments({
    deployment,
    identity: draft,
    accessPointArn: draft.accessPointArn,
  });
  let policy = base.permissionsPolicy;
  let endpoint;
  const role = {
    Arn: draft.executionRoleArn,
    PermissionsBoundary: { PermissionsBoundaryArn: deployment.permissionsBoundaryArn },
    AssumeRolePolicyDocument: JSON.stringify(base.trustPolicy),
  };
  const ap = {
    AccessPointArn: draft.accessPointArn,
    FileSystemId: draft.fileSystemId,
    RootDirectory: { Path: draft.rootDirectory },
    PosixUser: { Uid: 1000, Gid: 1000 },
    LifeCycleState: 'available',
  };
  const runtime = {
    agentRuntimeId: draft.runtimeId,
    agentRuntimeArn: draft.runtimeArn,
    agentRuntimeName: names.runtimeName,
    agentRuntimeVersion: draft.runtimeVersion,
    status: 'READY',
    roleArn: draft.executionRoleArn,
    agentRuntimeArtifact: { containerConfiguration: { containerUri: draft.imageUri } },
    protocolConfiguration: { serverProtocol: 'HTTP' },
    lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
    networkConfiguration: {
      networkMode: 'VPC',
      networkModeConfig: {
        subnets: deployment.subnetIds,
        securityGroups: deployment.securityGroupIds,
        requireServiceS3Endpoint: false,
      },
    },
    filesystemConfigurations: [
      { efsAccessPoint: { accessPointArn: draft.accessPointArn, mountPath: draft.mountPath } },
    ],
    environmentVariables: nativeRuntimeEnvironment(draft),
  };
  const iam = {
    send: vi.fn(async (c) => {
      switch (c.constructor.name) {
        case 'GetRoleCommand':
          return { Role: role };
        case 'ListRolePoliciesCommand':
          return { PolicyNames: ['native-runtime'], IsTruncated: false };
        case 'ListAttachedRolePoliciesCommand':
          return { AttachedPolicies: [], IsTruncated: false };
        case 'GetRolePolicyCommand':
          return { PolicyDocument: JSON.stringify(policy) };
        case 'PutRolePolicyCommand':
          policy = JSON.parse(c.input.PolicyDocument);
          return {};
        default:
          throw new Error('Unexpected IAM operation');
      }
    }),
  };
  const efs = { send: vi.fn(async () => ({ AccessPoints: [ap] })) };
  const control = {
    send: vi.fn(async (c) => {
      switch (c.constructor.name) {
        case 'GetAgentRuntimeCommand':
          return structuredClone(runtime);
        case 'UpdateAgentRuntimeCommand': {
          const { clientToken: _token, ...configuration } = c.input;
          Object.assign(runtime, structuredClone(configuration), {
            agentRuntimeVersion: '2',
            status: 'UPDATING',
          });
          return { agentRuntimeArn: draft.runtimeArn, agentRuntimeVersion: '2' };
        }
        case 'GetAgentRuntimeEndpointCommand':
          if (!endpoint)
            throw Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' });
          return structuredClone(endpoint);
        case 'CreateAgentRuntimeEndpointCommand':
          endpoint = {
            name: c.input.name,
            agentRuntimeArn: draft.runtimeArn,
            agentRuntimeEndpointArn: `${draft.runtimeArn}/runtime-endpoint/${c.input.name}`,
            liveVersion: c.input.agentRuntimeVersion,
            status: 'READY',
          };
          return structuredClone(endpoint);
        default:
          throw new Error('Unexpected runtime mutation');
      }
    }),
  };
  const authorize = vi.fn(async () => {});
  const upgrade = createExecutionRuntimeUpgrade({ iam, control, efs, deployment, authorize });
  return {
    ...f,
    execution,
    draft,
    deployment,
    role,
    ap,
    runtime,
    iam,
    control,
    authorize,
    upgrade,
    run: () => upgrade({ draft, execution }),
    setPolicy: (p) => {
      policy = p;
    },
    getPolicy: () => policy,
  };
};

describe('explicit native runtime upgrade', () => {
  it('upgrades once, waits for readiness, creates a separate endpoint and preserves preparation pins', async () => {
    const f = await make();
    const original = structuredClone(f.draft);
    expect(await f.run()).toEqual({ ready: false });
    expect(await f.run()).toEqual({ ready: false });
    f.runtime.status = 'READY';
    expect(await f.run()).toEqual({ ready: false });
    const result = await f.run();
    expect(result).toMatchObject({
      ready: true,
      target: { runtimeVersion: '2', imageDigest: f.configuration.image.digest },
    });
    expect(result.target.endpoint).toMatch(/^exec_[a-f0-9]{32}$/);
    expect(
      f.control.send.mock.calls.filter(([c]) => c.constructor.name === 'UpdateAgentRuntimeCommand'),
    ).toHaveLength(1);
    expect(f.draft).toEqual(original);
    expect(f.runtime.environmentVariables).toMatchObject({
      NATIVE_EXECUTION_ENABLED: 'true',
      NATIVE_EXECUTION_ATTEMPT_ID: f.execution.attemptId,
      NATIVE_EXECUTION_RUNTIME_SESSION_ID: f.execution.runtimeSessionId,
    });
  });

  it.each(['role', 'accessPoint', 'runtime', 'image', 'environment', 'policy'])(
    'refuses changed %s authority without updating the runtime',
    async (change) => {
      const f = await make();
      if (change === 'role') f.role.PermissionsBoundary.PermissionsBoundaryArn += '-other';
      if (change === 'accessPoint') f.ap.RootDirectory.Path += '/another';
      if (change === 'runtime') f.runtime.agentRuntimeId += '-other';
      if (change === 'image')
        f.runtime.agentRuntimeArtifact.containerConfiguration.containerUri += '0';
      if (change === 'environment') f.runtime.environmentVariables.EXTRA = 'unapproved';
      if (change === 'policy')
        f.setPolicy({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
        });
      await expect(f.run()).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_RUNTIME_MISMATCH' });
      expect(
        f.control.send.mock.calls.some(([c]) => c.constructor.name === 'UpdateAgentRuntimeCommand'),
      ).toBe(false);
    },
  );

  it('grants only workflow-version reads and publication writes scoped to this attempt', async () => {
    const f = await make();
    const policy = nativeExecutionPolicy({
      draft: f.draft,
      execution: f.execution,
      deployment: f.deployment,
    }).permissionsPolicy;
    const statements = policy.Statement.filter((s) =>
      ['ReadPinnedWorkflowBytes', 'PublishOwnAttemptBytes'].includes(s.Sid),
    );
    expect(statements).toHaveLength(2);
    expect(statements[0].Action).toBe('s3:GetObjectVersion');
    expect(statements[1].Resource).toContain(`/${f.execution.attemptId}/1/`);
    const actions = policy.Statement.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(actions.some((s) => /^(lambda|dynamodb|ssm|secretsmanager|neptune-db):/.test(s))).toBe(
      false,
    );
    const recovery = policy.Statement.find((s) => s.Sid === 'PreserveOwnRecoveryCheckpoint');
    expect(recovery).toEqual({
      Sid: 'PreserveOwnRecoveryCheckpoint',
      Effect: 'Allow',
      Action: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
      Resource: `arn:aws:s3:::${f.configuration.publicationBucket}/${nativeRecoveryScope(executionIdentity(f.execution)).prefix}*`,
    });
    expect(recovery.Resource).not.toContain('native-executions/');
    expect(recovery.Resource).not.toContain('native-execution-control/');
    const workspace = nativeExecutionPolicy({
      draft: f.draft,
      execution: {
        ...f.execution,
        configuration: { ...f.execution.configuration, recoveryMode: 'efs-workspace-v1' },
      },
      deployment: f.deployment,
    }).permissionsPolicy;
    expect(workspace.Statement).toEqual(
      policy.Statement.filter((s) => s.Sid !== 'PreserveOwnRecoveryCheckpoint'),
    );
  });

  it('does not mutate after authority is revoked', async () => {
    const f = await make();
    f.authorize.mockRejectedValue(
      Object.assign(new Error('revoked'), { code: 'WORKFLOW_SOURCE_FORBIDDEN' }),
    );
    await expect(f.run()).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_FORBIDDEN' });
    expect(f.iam.send).not.toHaveBeenCalled();
    expect(f.control.send).not.toHaveBeenCalled();
  });
});
