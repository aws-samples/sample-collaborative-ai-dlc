import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import {
  currentRuntimeEnv,
  loadRuntimeEnv,
  resetRuntimeEnv,
  toRuntimeEnv,
} from '../runtime-env.js';
import { captureChild, runChild } from '../cli/spawn.js';
import { dispatchInvocation } from '../http-server.js';

const PATH = '/p/env/runtime-env';
const param = (name, value) => ({ Name: `${PATH}/${name}`, Value: value });

// SSM stub: one page per entry in `pages`; `fail` rejects every call.
const ssmStub = ({ pages = [[]], fail = false } = {}) => {
  const send = vi.fn(async (command) => {
    if (fail) throw new Error('AccessDenied');
    const i = command.input.NextToken ? Number(command.input.NextToken) : 0;
    return { Parameters: pages[i], NextToken: i + 1 < pages.length ? String(i + 1) : undefined };
  });
  return { send };
};

const exitingChild = () => {
  const child = new EventEmitter();
  child.pid = 1;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => child.emit('close', 0));
  return child;
};

afterEach(() => resetRuntimeEnv());

describe('toRuntimeEnv', () => {
  it('maps parameter names to variables', () => {
    expect(toRuntimeEnv([param('FOO', 'a'), param('BAR_2', 'b')], PATH)).toEqual({
      FOO: 'a',
      BAR_2: 'b',
    });
  });

  it.each(['PATH', 'HOME', 'KIRO_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'LANG'])(
    'skips the reserved name %s',
    (name) => {
      expect(toRuntimeEnv([param(name, 'x')], PATH)).toEqual({});
    },
  );

  it('skips invalid names', () => {
    expect(
      toRuntimeEnv([param('1BAD', 'x'), param('has-dash', 'x'), param('', 'x')], PATH),
    ).toEqual({});
  });
});

describe('loadRuntimeEnv', () => {
  it('is empty without a path and never calls SSM', async () => {
    const ssm = ssmStub();
    expect(await loadRuntimeEnv({ path: '', ssm })).toEqual({});
    expect(ssm.send).not.toHaveBeenCalled();
  });

  it('reads every page, decrypted, non-recursive', async () => {
    const ssm = ssmStub({ pages: [[param('A', '1')], [param('B', '2')]] });
    expect(await loadRuntimeEnv({ path: `${PATH}/`, ssm })).toEqual({ A: '1', B: '2' });
    expect(ssm.send).toHaveBeenCalledTimes(2);
    expect(ssm.send.mock.calls[0][0].input).toMatchObject({
      Path: PATH,
      Recursive: false,
      WithDecryption: true,
    });
    expect(currentRuntimeEnv()).toEqual({ A: '1', B: '2' });
  });

  it('caches for the TTL, then refreshes', async () => {
    let t = 0;
    const now = () => t;
    const first = ssmStub({ pages: [[param('A', '1')]] });
    await loadRuntimeEnv({ path: PATH, ssm: first, now, ttlMs: 100 });
    t = 99;
    await loadRuntimeEnv({ path: PATH, ssm: first, now, ttlMs: 100 });
    expect(first.send).toHaveBeenCalledTimes(1);
    t = 100;
    const second = ssmStub({ pages: [[param('A', 'rotated')]] });
    expect(await loadRuntimeEnv({ path: PATH, ssm: second, now, ttlMs: 100 })).toEqual({
      A: 'rotated',
    });
  });

  it('keeps the last good values when SSM fails, and backs off before retrying', async () => {
    let t = 0;
    const now = () => t;
    const opts = { path: PATH, now, ttlMs: 10, retryMs: 5 };
    await loadRuntimeEnv({ ...opts, ssm: ssmStub({ pages: [[param('A', '1')]] }) });
    t = 20;
    const failing = ssmStub({ fail: true });
    expect(await loadRuntimeEnv({ ...opts, ssm: failing })).toEqual({ A: '1' });
    t = 24;
    await loadRuntimeEnv({ ...opts, ssm: failing });
    expect(failing.send).toHaveBeenCalledTimes(1);
    t = 25;
    await loadRuntimeEnv({ ...opts, ssm: failing });
    expect(failing.send).toHaveBeenCalledTimes(2);
  });

  it('shares one refresh between concurrent callers', async () => {
    const ssm = ssmStub({ pages: [[param('A', '1')]] });
    const results = await Promise.all([1, 2, 3].map(() => loadRuntimeEnv({ path: PATH, ssm })));
    expect(ssm.send).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ A: '1' }, { A: '1' }, { A: '1' }]);
  });
});

describe('CLI spawns', () => {
  it.each([
    ['runChild', runChild],
    ['captureChild', captureChild],
  ])('%s exports the runtime env below the invocation env', async (_name, launch) => {
    await loadRuntimeEnv({
      path: PATH,
      ssm: ssmStub({ pages: [[param('SHARED', 'platform'), param('ONLY_RUNTIME', 'r')]] }),
    });
    const spawnFn = vi.fn(exitingChild);
    await launch({ command: 'cli', args: [], env: { SHARED: 'invocation' }, spawnFn });
    const env = spawnFn.mock.calls[0][2].env;
    expect(env.ONLY_RUNTIME).toBe('r');
    expect(env.SHARED).toBe('invocation');
  });
});

describe('dispatchInvocation', () => {
  it('refreshes the runtime env before the handler runs', async () => {
    const order = [];
    await dispatchInvocation({
      payload: { command: 'run-stage' },
      handlers: {
        runStage: async () => {
          order.push('handler');
          return { ok: true };
        },
      },
      loadRuntimeEnvironment: async () => {
        order.push('load');
        return {};
      },
    });
    expect(order).toEqual(['load', 'handler']);
  });
});

describe('agentcore IAM role policy', () => {
  it('can list the runtime env path the runtime reads', async () => {
    const terraform = await readFile(
      new URL('../../../terraform/modules/compute/agentcore/main.tf', import.meta.url),
      'utf8',
    );
    expect(terraform).toContain(
      'runtime_env_ssm_path = "/${var.project_name}/${var.environment}/runtime-env"',
    );
    expect(terraform).toContain('RUNTIME_ENV_SSM_PATH          = local.runtime_env_ssm_path');
    expect(terraform).toMatch(
      /Action\s+= \["ssm:GetParametersByPath"\]\s+Resource = "arn:[^"]+:parameter\$\{local\.runtime_env_ssm_path\}"/,
    );
  });
});
