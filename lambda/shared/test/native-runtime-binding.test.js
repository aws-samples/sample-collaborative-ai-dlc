import { describe, expect, it, vi } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  nativeRuntimeBindingKey,
  nativeRuntimeResourceNames,
  resolveNativeRuntimeBinding,
} from '../native-runtime-binding.js';

const scope = { projectId: 'flappy-bird-id', executionId: 'intent-1' };
const key = nativeRuntimeBindingKey(scope);
const bindingId = '9167d414-e69a-444f-9f8f-2fd1cb8a6b08';
const names = nativeRuntimeResourceNames({ ...scope, bindingId });
const deployment = {
  accountId: '123456789012',
  region: 'us-east-1',
  partition: 'aws',
  fileSystemId: 'fs-0123456789abcdef0',
};
const ready = () => ({
  ...key,
  ...scope,
  schemaVersion: 1,
  bindingId,
  status: 'READY',
  isolation: 'execution',
  runtimeArn: `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${names.runtimeName}-aBc123`,
  runtimeVersion: '1',
  runtimeEndpoint: names.endpointName,
  imageDigest: `sha256:${'a'.repeat(64)}`,
  executionRoleArn: `arn:aws:iam::123456789012:role/native-runs/${names.roleName}`,
  accessPointArn:
    'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0',
  fileSystemId: 'fs-0123456789abcdef0',
  mountPath: '/mnt/native',
  rootDirectory: names.rootDirectory,
});

const setup = (item = ready()) => {
  const ddb = { send: vi.fn().mockResolvedValue({ Item: item }) };
  return {
    ddb,
    resolve: (overrides = {}) =>
      resolveNativeRuntimeBinding({
        ddb,
        tableName: 'protected-native-runtime-bindings',
        ...scope,
        deployment,
        ...overrides,
      }),
  };
};

describe('native runtime binding authority', () => {
  it('reads the exact execution binding consistently from its protected table', async () => {
    const { ddb, resolve } = setup();
    const binding = await resolve({
      environment: { runtimeArn: 'caller-runtime' },
      nativeRuntimeBinding: { ...ready(), runtimeArn: 'caller-runtime' },
    });
    expect(ddb.send).toHaveBeenCalledOnce();
    const command = ddb.send.mock.calls[0][0];
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toEqual({
      TableName: 'protected-native-runtime-bindings',
      Key: key,
      ConsistentRead: true,
    });
    expect(binding.target).toEqual({
      agentRuntimeArn: ready().runtimeArn,
      qualifier: names.endpointName,
    });
    expect(binding).toMatchObject({ ...scope, imageDigest: ready().imageDigest });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.target)).toBe(true);
  });

  it('does not forward unknown registry fields', async () => {
    const { resolve } = setup({ ...ready(), extra: { sensitive: 'do-not-forward' } });
    expect(await resolve()).not.toHaveProperty('extra');
  });

  it('keeps both parts of the identity in the key without separator ambiguity', () => {
    expect(nativeRuntimeBindingKey({ projectId: 'a:b', executionId: 'c' })).not.toEqual(
      nativeRuntimeBindingKey({ projectId: 'a', executionId: 'b:c' }),
    );
    expect(key).not.toEqual(nativeRuntimeBindingKey({ ...scope, projectId: 'other-project' }));
    expect(key).not.toEqual(nativeRuntimeBindingKey({ ...scope, executionId: 'other-run' }));
  });

  it('gives a replacement binding its own runtime, role, endpoint and root', () => {
    const replacement = nativeRuntimeResourceNames({
      ...scope,
      bindingId: 'fdc43241-257d-4ba8-af0a-edcb467981fc',
    });
    for (const field of Object.keys(names)) expect(replacement[field]).not.toBe(names[field]);
  });

  it('keeps the generated root within the EFS access-point API path limit', () => {
    const longScope = nativeRuntimeResourceNames({
      projectId: 'project'.repeat(50),
      executionId: 'execution'.repeat(50),
      bindingId,
    });
    expect(longScope.rootDirectory).toMatch(/^\/runs\/[0-9a-f]{64}$/);
    expect(Buffer.byteLength(longScope.rootDirectory)).toBeLessThanOrEqual(100);
    expect(longScope.rootDirectory.split('/').filter(Boolean)).toHaveLength(2);
  });

  it('requires deployment-owned account, region and filesystem configuration', async () => {
    const { ddb, resolve } = setup();
    await expect(resolve({ deployment: {} })).rejects.toMatchObject({
      code: 'native_runtime_bindings_unconfigured',
    });
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it('rejects a self-consistent resource tuple from another account', async () => {
    const other = Object.fromEntries(
      Object.entries(ready()).map(([k, v]) => [
        k,
        typeof v === 'string' ? v.replaceAll('123456789012', '999999999999') : v,
      ]),
    );
    const { resolve } = setup(other);
    await expect(resolve()).rejects.toMatchObject({ code: 'native_runtime_binding_invalid' });
  });

  it.each([{ projectId: '' }, { executionId: null }, { projectId: 'contains\u0000control' }])(
    'rejects invalid identity before storage access: %j',
    async (override) => {
      const { ddb, resolve } = setup();
      await expect(resolve(override)).rejects.toMatchObject({
        code: 'invalid_native_execution_identity',
      });
      expect(ddb.send).not.toHaveBeenCalled();
    },
  );

  it('does not use the process table or a fallback when unconfigured', async () => {
    const { ddb, resolve } = setup();
    await expect(resolve({ tableName: '' })).rejects.toMatchObject({
      code: 'native_runtime_bindings_unconfigured',
    });
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it('does not invent a binding for an unprovisioned execution', async () => {
    const { resolve } = setup(null);
    await expect(resolve()).rejects.toMatchObject({ code: 'native_runtime_binding_missing' });
  });

  it('propagates storage failure without fallback', async () => {
    const { ddb, resolve } = setup();
    ddb.send.mockRejectedValue(new Error('unavailable'));
    await expect(resolve()).rejects.toThrow('unavailable');
  });

  it.each(['PROVISIONING', 'FAILED', 'CANCELLING', 'RETIRED', undefined])(
    'does not dispatch while the binding is %s',
    async (status) => {
      const { resolve } = setup({ ...ready(), status });
      await expect(resolve()).rejects.toMatchObject({ code: 'native_runtime_binding_not_ready' });
    },
  );

  it('observes retirement on the next dispatch instead of caching READY', async () => {
    const { ddb, resolve } = setup();
    await resolve();
    ddb.send.mockResolvedValue({ Item: { ...ready(), status: 'RETIRED' } });
    await expect(resolve()).rejects.toMatchObject({ code: 'native_runtime_binding_not_ready' });
    expect(ddb.send).toHaveBeenCalledTimes(2);
  });

  it.each([
    { projectId: 'another-project' },
    { executionId: 'another-execution' },
    { pk: 'NATIVE#another-run' },
    { sk: 'META' },
    { schemaVersion: 2 },
    { isolation: 'project' },
    { bindingId: undefined },
    { bindingId: 'fdc43241-257d-4ba8-af0a-edcb467981fc' },
    { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/another_run-aBc123' },
    { runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/native_run-aBc123' },
    { runtimeVersion: 'latest' },
    { runtimeEndpoint: 'DEFAULT' },
    { runtimeEndpoint: '' },
    { imageDigest: 'latest' },
    { executionRoleArn: 'arn:aws:iam::123456789012:role/shared-platform-role' },
    { executionRoleArn: 'arn:aws:iam::999999999999:role/native-runs/native_run' },
    {
      accessPointArn:
        'arn:aws:elasticfilesystem:us-east-1:999999999999:access-point/fsap-0123456789abcdef0',
    },
    { accessPointArn: undefined },
    { fileSystemId: undefined },
    { fileSystemId: 'fs-99999999999999999' },
    { mountPath: '/mnt/workspace' },
    { rootDirectory: '/runs/another-run' },
  ])('rejects incomplete or mismatched binding %j', async (override) => {
    const { resolve } = setup({ ...ready(), ...override });
    await expect(resolve()).rejects.toMatchObject({ code: 'native_runtime_binding_invalid' });
  });
});
