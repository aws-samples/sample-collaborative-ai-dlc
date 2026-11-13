import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createExecutionRuntimeUpgrade,
  executionIdentity,
  executionRuntimeConfiguration,
  nativeExecutionPolicy,
} from '../execution-runtime.js';
import { nativeExecutionConfiguration } from '../execution-store.js';
import {
  NATIVE_ENGINE_PROFILE,
  nativeEngineAlias,
  nativeEngineArn,
  nativeEngineDeploymentPin,
  nativeEngineObjectPrefix,
  nativeEnginePin,
  nativeReviewerAlias,
  nativeWorkflowProfile,
} from '../../shared/native-workflow-protocol.js';
import { executionFixture } from './execution-fixtures.js';
import { DEPLOYMENT } from './fixtures.js';

const ACCOUNT = DEPLOYMENT.accountId;
const pinFor = (configuration) => ({
  profileId: NATIVE_ENGINE_PROFILE.id,
  producerSha256: configuration.image.digest.slice(7),
  functionArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:native-workflow`,
  version: '7',
});
const env = (configuration) => ({
  NATIVE_WORKFLOW_ENGINE_SHA256: configuration.image.digest.slice(7),
  NATIVE_WORKFLOW_ENGINE_ARN: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:native-workflow`,
  NATIVE_WORKFLOW_ENGINE_VERSION: '7',
  NATIVE_RUNTIME_ACCOUNT_ID: ACCOUNT,
});
const make = async ({ engine = true } = {}) => {
  const f = executionFixture();
  if (engine) {
    f.configuration.packageId = NATIVE_ENGINE_PROFILE.packageId;
    f.prepared.candidate.packagePin.packageId = NATIVE_ENGINE_PROFILE.packageId;
    f.configuration.workflowEngine = pinFor(f.configuration);
  }
  await f.start();
  const execution = f.row();
  const deployment = {
    ...DEPLOYMENT,
    imageUri: f.prepared.imageUri,
    imageDigest: f.prepared.imageDigest,
    ecrRepositoryArn: `arn:aws:ecr:us-east-1:${ACCOUNT}:repository/agentcore`,
    permissionsBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/native-boundary`,
    subnetIds: ['subnet-11111111'],
    securityGroupIds: ['sg-11111111'],
  };
  return { ...f, execution, deployment };
};

describe('captured workflow engine pin', () => {
  it('pins only the reviewed package on an enabled harness', () => {
    const f = executionFixture();
    for (const harness of ['claude', 'codex', 'opencode']) {
      expect(nativeWorkflowProfile(NATIVE_ENGINE_PROFILE.packageId, harness)).toBe(
        NATIVE_ENGINE_PROFILE.id,
      );
      expect(
        nativeEngineDeploymentPin(env(f.configuration), {
          packageId: NATIVE_ENGINE_PROFILE.packageId,
          harness,
        }),
      ).toEqual(pinFor(f.configuration));
    }
    // Kiro and every other package keep the unverified legacy behaviour.
    for (const pins of [
      { packageId: NATIVE_ENGINE_PROFILE.packageId, harness: 'kiro' },
      { packageId: f.configuration.packageId, harness: 'codex' },
    ])
      expect(nativeEngineDeploymentPin(env(f.configuration), pins)).toBeNull();
  });

  it.each([
    ['a missing deployment version', (value) => delete value.version],
    ['an alias-qualified function', (value) => (value.functionArn += ':live')],
    ['a version of zero', (value) => (value.version = '0')],
    ['a tagged digest', (value) => (value.producerSha256 = `sha256:${value.producerSha256}`)],
    ['another profile', (value) => (value.profileId = 'aidlc-2.11.0-native-1')],
    ['an extra field', (value) => (value.verified = true)],
    [
      'another account',
      (value) => (value.functionArn = value.functionArn.replace(ACCOUNT, '999999999999')),
    ],
  ])('rejects %s', (_label, alter) => {
    const f = executionFixture();
    const value = pinFor(f.configuration);
    alter(value);
    expect(() =>
      nativeEnginePin(value, {
        accountId: ACCOUNT,
        packageId: NATIVE_ENGINE_PROFILE.packageId,
        harness: 'codex',
      }),
    ).toThrow('NATIVE_ENGINE_PIN_INVALID');
  });

  it('keeps existing configurations valid and binds a pin to its image and package', () => {
    const f = executionFixture();
    expect(nativeExecutionConfiguration(f.configuration)).not.toHaveProperty('workflowEngine');
    const pinned = {
      ...structuredClone(f.configuration),
      packageId: NATIVE_ENGINE_PROFILE.packageId,
    };
    pinned.workflowEngine = pinFor(pinned);
    expect(nativeExecutionConfiguration(pinned).workflowEngine).toEqual(pinned.workflowEngine);
    for (const alter of [
      (value) => (value.workflowEngine.producerSha256 = '0'.repeat(64)),
      (value) => (value.packageId = f.configuration.packageId),
      (value) => (value.harness = 'kiro'),
      (value) => (value.workflowEngine = true),
    ]) {
      const value = structuredClone(pinned);
      alter(value);
      expect(() => nativeExecutionConfiguration(value)).toThrow();
    }
  });

  it('names per-binding aliases and per-attempt object prefixes', () => {
    const identity = {
      projectId: 'project-one',
      executionId: randomUUID(),
      bindingId: randomUUID(),
      attemptId: randomUUID(),
      epoch: 1,
    };
    const other = { ...identity, bindingId: randomUUID() };
    expect(nativeEngineAlias(identity)).toMatch(/^native_[a-f0-9]{32}$/);
    expect(nativeReviewerAlias(identity)).toBe(`review_${nativeEngineAlias(identity).slice(7)}`);
    expect(nativeEngineAlias(identity)).toBe(nativeEngineAlias({ ...identity }));
    expect(nativeEngineAlias(other)).not.toBe(nativeEngineAlias(identity));
    const prefixes = ['state', 'input', 'output', 'job'].map((purpose) =>
      nativeEngineObjectPrefix(identity, purpose),
    );
    expect(new Set(prefixes).size).toBe(4);
    for (const prefix of prefixes) {
      expect(prefix).toContain(`/${identity.bindingId}/${identity.attemptId}/1/`);
      expect(prefix.startsWith('native-workflow-')).toBe(true);
    }
    for (const changed of [
      other,
      { ...identity, attemptId: randomUUID() },
      { ...identity, epoch: 2 },
    ])
      expect(nativeEngineObjectPrefix(changed, 'state')).not.toBe(prefixes[0]);
    for (const invalid of [
      [identity, 'secret'],
      [{ ...identity, epoch: 0 }, 'state'],
      [{ ...identity, attemptId: '../other' }, 'state'],
    ])
      expect(() => nativeEngineObjectPrefix(...invalid)).toThrow('NATIVE_ENGINE_INVALID');
  });
});

describe('runtime authority for the protected engine', () => {
  const policyOf = (f) =>
    nativeExecutionPolicy({ draft: f.prepared, execution: f.execution, deployment: f.deployment })
      .permissionsPolicy;
  const actions = (policy) =>
    policy.Statement.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );

  it('adds nothing for an execution without a captured engine', async () => {
    const f = await make({ engine: false });
    const policy = policyOf(f);
    expect(actions(policy).some((action) => action.startsWith('lambda:'))).toBe(false);
    expect(JSON.stringify(policy)).not.toContain('native-workflow-');
    expect(executionRuntimeConfiguration(f.prepared, f.execution)).not.toHaveProperty(
      'workflowEngine',
    );
  });

  it('lets the runtime invoke only its own alias, submit inputs and read results', async () => {
    const f = await make();
    const policy = policyOf(f);
    const identity = executionIdentity(f.execution);
    const pin = f.execution.configuration.workflowEngine;
    const bucket = `arn:aws:s3:::${f.execution.configuration.publicationBucket}`;
    const added = policy.Statement.filter((statement) =>
      ['InvokeOwnWorkflowEngine', 'SubmitOwnWorkflowInputs', 'ReadOwnWorkflowOutput'].includes(
        statement.Sid,
      ),
    );
    expect(added).toEqual([
      {
        Sid: 'InvokeOwnWorkflowEngine',
        Effect: 'Allow',
        Action: 'lambda:InvokeFunction',
        Resource: nativeEngineArn(identity, pin),
      },
      {
        Sid: 'SubmitOwnWorkflowInputs',
        Effect: 'Allow',
        Action: ['s3:PutObject', 's3:GetObjectVersion'],
        Resource: `${bucket}/${nativeEngineObjectPrefix(identity, 'input')}*`,
      },
      {
        Sid: 'ReadOwnWorkflowOutput',
        Effect: 'Allow',
        Action: 's3:GetObjectVersion',
        Resource: `${bucket}/${nativeEngineObjectPrefix(identity, 'output')}*`,
      },
    ]);
    expect(added[0].Resource).toMatch(/:function:native-workflow:native_[a-f0-9]{32}$/);
    // No other Lambda, table or credential reach; no protected state or job objects.
    expect(actions(policy).filter((action) => action.startsWith('lambda:'))).toEqual([
      'lambda:InvokeFunction',
    ]);
    expect(
      actions(policy).some((action) =>
        /^(dynamodb|ssm|secretsmanager|neptune-db|iam):/.test(action),
      ),
    ).toBe(false);
    const text = JSON.stringify(policy);
    expect(text).not.toContain('native-workflow-state');
    expect(text).not.toContain('native-workflow-job');
    expect(text).not.toContain(`${pin.functionArn}"`);
    expect(executionRuntimeConfiguration(f.prepared, f.execution).workflowEngine).toEqual(pin);
  });

  const upgrade = (f, lambda) => {
    const reached = () => {
      throw new Error('reached runtime authority');
    };
    const authorize = vi.fn(async () => {});
    return {
      authorize,
      run: () =>
        createExecutionRuntimeUpgrade({
          iam: { send: vi.fn(reached) },
          control: { send: vi.fn(reached) },
          efs: { send: vi.fn(reached) },
          lambda,
          deployment: f.deployment,
          authorize,
        })({ draft: f.prepared, execution: f.execution }),
    };
  };
  const aliasClient = (f, initial) => {
    const pin = f.execution.configuration.workflowEngine;
    const state = { alias: initial, create: null };
    const client = {
      send: vi.fn(async (command) => {
        expect(command.input).toMatchObject({
          FunctionName: pin.functionArn,
          Name: nativeEngineAlias(executionIdentity(f.execution)),
        });
        if (command.constructor.name === 'CreateAliasCommand') {
          expect(command.input.FunctionVersion).toBe(pin.version);
          // A conflicting create means an earlier request already bound it.
          state.alias ??= {
            AliasArn: nativeEngineArn(executionIdentity(f.execution), pin),
            FunctionVersion: pin.version,
          };
          const result = state.create?.();
          return result ?? {};
        }
        expect(command.constructor.name).toBe('GetAliasCommand');
        if (!state.alias)
          throw Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' });
        return structuredClone(state.alias);
      }),
    };
    return { state, client, names: () => client.send.mock.calls.map(([c]) => c.constructor.name) };
  };
  const bound = (f) => ({
    AliasArn: nativeEngineArn(
      executionIdentity(f.execution),
      f.execution.configuration.workflowEngine,
    ),
    FunctionVersion: f.execution.configuration.workflowEngine.version,
  });

  it('creates the binding alias at the captured version before any runtime authority', async () => {
    const f = await make();
    const alias = aliasClient(f, null);
    const u = upgrade(f, alias.client);
    await expect(u.run()).rejects.toThrow('reached runtime authority');
    expect(alias.names()).toEqual(['GetAliasCommand', 'CreateAliasCommand', 'GetAliasCommand']);
    // An existing correct binding is only verified.
    alias.client.send.mockClear();
    await expect(u.run()).rejects.toThrow('reached runtime authority');
    expect(alias.names()).toEqual(['GetAliasCommand']);
    expect(u.authorize.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('resolves an ambiguous creation by reading the binding back', async () => {
    const f = await make();
    const alias = aliasClient(f, null);
    alias.state.create = () => {
      throw Object.assign(new Error('exists'), { name: 'ResourceConflictException' });
    };
    await expect(upgrade(f, alias.client).run()).rejects.toThrow('reached runtime authority');
    expect(alias.names()).toEqual(['GetAliasCommand', 'CreateAliasCommand', 'GetAliasCommand']);
  });

  it.each([
    ['another version', (value) => (value.FunctionVersion = '8')],
    ['another function', (value) => (value.AliasArn = value.AliasArn.replace('workflow', 'other'))],
    [
      'weighted routing',
      (value) => (value.RoutingConfig = { AdditionalVersionWeights: { 8: 0.5 } }),
    ],
  ])('never retargets an existing binding with %s', async (_label, alter) => {
    const f = await make();
    const existing = bound(f);
    alter(existing);
    const alias = aliasClient(f, existing);
    await expect(upgrade(f, alias.client).run()).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_RUNTIME_MISMATCH',
    });
    expect(alias.names()).toEqual(['GetAliasCommand']);
  });

  it('fails closed without a Lambda client or current authority, and skips binding without a pin', async () => {
    const pinned = await make();
    await expect(upgrade(pinned, undefined).run()).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_RUNTIME_MISMATCH',
    });
    const alias = aliasClient(pinned, null);
    const revoked = upgrade(pinned, alias.client);
    revoked.authorize.mockRejectedValue(
      Object.assign(new Error('revoked'), { code: 'WORKFLOW_SOURCE_FORBIDDEN' }),
    );
    await expect(revoked.run()).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_FORBIDDEN' });
    expect(alias.client.send).not.toHaveBeenCalled();
    const legacy = await make({ engine: false });
    const unused = { send: vi.fn() };
    await expect(upgrade(legacy, unused).run()).rejects.toThrow('reached runtime authority');
    expect(unused.send).not.toHaveBeenCalled();
  });
});
