import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_ENGINE,
  NATIVE_UNSUPPORTED_INPUTS,
  isNativeExecution,
  nativeExecutionParameterName,
  nativeUnsupportedInputError,
  normalizeEngine,
  readNativeExecution,
} from '../native-execution.js';
import { buildExecutionMeta } from '../v2-process-keys.js';

const PREFIX = '/collab/dev';

const ssmReturning = (value) => ({
  send: vi.fn(async () => ({ Parameter: { Value: value } })),
});

describe('readNativeExecution', () => {
  it('reads the flag from the platform settings prefix', async () => {
    const ssm = ssmReturning('enabled');
    await expect(readNativeExecution(ssm, PREFIX)).resolves.toBe('enabled');
    expect(ssm.send).toHaveBeenCalledOnce();
    expect(ssm.send.mock.calls[0][0].input).toEqual({ Name: '/collab/dev/native-execution' });
    expect(nativeExecutionParameterName(PREFIX)).toBe('/collab/dev/native-execution');
  });

  it('counts a missing parameter as disabled', async () => {
    const ssm = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('Parameter not found'), { name: 'ParameterNotFound' });
      }),
    };
    await expect(readNativeExecution(ssm, PREFIX)).resolves.toBe('disabled');
  });

  it.each([
    ['an access denial', 'AccessDeniedException'],
    ['a throttle', 'ThrottlingException'],
    ['a network failure', 'TimeoutError'],
  ])('counts %s as disabled', async (_label, name) => {
    const ssm = {
      send: vi.fn(async () => {
        throw Object.assign(new Error(name), { name });
      }),
    };
    await expect(readNativeExecution(ssm, PREFIX)).resolves.toBe('disabled');
  });

  it.each([
    'disabled',
    'Enabled',
    'ENABLED',
    ' enabled',
    'enabled ',
    'true',
    'on',
    '1',
    '',
    undefined,
    null,
  ])('counts the value %j as disabled', async (value) => {
    await expect(readNativeExecution(ssmReturning(value), PREFIX)).resolves.toBe('disabled');
  });

  it('counts a response without a parameter as disabled', async () => {
    const ssm = { send: vi.fn(async () => ({})) };
    await expect(readNativeExecution(ssm, PREFIX)).resolves.toBe('disabled');
  });

  it('hands a failed read to onError, but not a missing parameter', async () => {
    const onError = vi.fn();
    const failing = (error) => ({
      send: async () => {
        throw error;
      },
    });
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    const missing = Object.assign(new Error('not found'), { name: 'ParameterNotFound' });

    await expect(readNativeExecution(failing(denied), PREFIX, { onError })).resolves.toBe(
      'disabled',
    );
    expect(onError).toHaveBeenCalledExactlyOnceWith(denied);

    onError.mockClear();
    await expect(readNativeExecution(failing(missing), PREFIX, { onError })).resolves.toBe(
      'disabled',
    );
    await expect(readNativeExecution(ssmReturning('enabled'), PREFIX, { onError })).resolves.toBe(
      'enabled',
    );
    await expect(readNativeExecution(ssmReturning('nonsense'), PREFIX, { onError })).resolves.toBe(
      'disabled',
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(['', undefined, null])('is disabled without reading when the prefix is %j', async (p) => {
    const ssm = ssmReturning('enabled');
    await expect(readNativeExecution(ssm, p)).resolves.toBe('disabled');
    expect(ssm.send).not.toHaveBeenCalled();
  });
});

describe('normalizeEngine', () => {
  it.each([undefined, null])('treats %j as a platform intent', (value) => {
    expect(normalizeEngine(value)).toEqual({ value: null });
  });

  it('accepts native', () => {
    expect(normalizeEngine('native')).toEqual({ value: NATIVE_ENGINE });
  });

  it.each(['platform', 'Native', 'NATIVE', '', 'aidlc', 0, false, true, {}, ['native']])(
    'refuses %j by name',
    (value) => {
      const { error, value: engine } = normalizeEngine(value);
      expect(engine).toBeUndefined();
      expect(error.code).toBe('engine_invalid');
    },
  );
});

describe('isNativeExecution', () => {
  it('is true only for a row whose engine is native', () => {
    expect(isNativeExecution({ engine: 'native' })).toBe(true);
    for (const meta of [null, undefined, {}, { engine: null }, { engine: 'platform' }]) {
      expect(isNativeExecution(meta)).toBe(false);
    }
  });
});

describe('nativeUnsupportedInputError', () => {
  it('accepts a body that carries none of the plan inputs', () => {
    expect(
      nativeUnsupportedInputError({
        engine: 'native',
        title: 'T',
        prompt: 'P',
        branch: 'aidlc/t',
        baseBranch: 'main',
        baseBranches: { 'owner/repo': 'develop' },
        primaryRepo: 'owner/repo',
        source: { bindingId: 'b', resourceId: '1' },
      }),
    ).toBeNull();
    expect(nativeUnsupportedInputError({})).toBeNull();
    expect(nativeUnsupportedInputError(undefined)).toBeNull();
  });

  it.each(NATIVE_UNSUPPORTED_INPUTS)('refuses %s, also when it is null', (field) => {
    for (const value of ['x', null, false, [], {}]) {
      expect(nativeUnsupportedInputError({ title: 'T', [field]: value })).toEqual({
        error: `Not supported for a native intent: ${field}`,
        code: 'native_input_not_supported',
        fields: [field],
      });
    }
  });

  it('names every refused field of one body', () => {
    const error = nativeUnsupportedInputError({
      scope: 'feature',
      skipStageIds: ['a'],
      methodologyReleaseId: 'r',
    });
    expect(error.fields).toEqual(['scope', 'skipStageIds', 'methodologyReleaseId']);
  });

  it('covers the workflow, scope, release and stage-skip inputs of a create', () => {
    expect([...NATIVE_UNSUPPORTED_INPUTS].toSorted()).toEqual(
      [
        'aidlcSettings',
        'composedGrid',
        'constructionGateAutonomy',
        'methodologyReleaseId',
        'methodologyReleaseTest',
        'policyScope',
        'scope',
        'skipStageIds',
        'sparseCheckout',
      ].toSorted(),
    );
  });
});

describe('execution META row', () => {
  const base = {
    executionId: 'e1',
    projectId: 'p1',
    intentId: 'e1',
    status: 'DRAFT',
    startedAt: '2026-11-26T00:00:00.000Z',
  };

  it('carries engine and primaryRepo for a native intent', () => {
    const row = buildExecutionMeta({
      ...base,
      engine: 'native',
      workflowId: null,
      workflowVersion: null,
      repos: ['owner/app', 'owner/lib'],
      primaryRepo: 'owner/app',
    });
    expect(row).toMatchObject({
      engine: 'native',
      primaryRepo: 'owner/app',
      repos: ['owner/app', 'owner/lib'],
      workflowId: null,
      workflowVersion: null,
      scope: null,
      stageSkipping: null,
    });
  });

  it('keeps a platform row free of both attributes', () => {
    const row = buildExecutionMeta({ ...base, workflowId: 'aidlc-v2', workflowVersion: 4 });
    expect(row).not.toHaveProperty('engine');
    expect(row).not.toHaveProperty('primaryRepo');
    expect(
      buildExecutionMeta({
        ...base,
        workflowId: 'aidlc-v2',
        workflowVersion: 4,
        engine: null,
        primaryRepo: null,
      }),
    ).toEqual(row);
  });
});
