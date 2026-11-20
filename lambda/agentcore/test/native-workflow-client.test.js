import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeEngineClient,
  nativeEngineContext,
  prepareNativeEngineClient,
} from '../native/workflow-client.js';
import { createNativeEngineObjects } from '../../shared/native-workflow-objects.js';
import {
  NATIVE_ENGINE_PROFILE,
  encodeNativeEngineFiles,
  nativeEngineArn,
  nativeEngineFileDigest,
  nativeEngineObjectPrefix,
} from '../../shared/native-workflow-protocol.js';

const bucket = 'native-publication-bucket';
const accountId = '123456789012';
const pin = Object.freeze({
  profileId: NATIVE_ENGINE_PROFILE.id,
  producerSha256: 'a'.repeat(64),
  functionArn: `arn:aws:lambda:us-east-1:${accountId}:function:native-workflow-engine`,
  version: '7',
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const patch = (path, before, after, target = path) => ({
  path,
  beforeSha256: before === null ? null : sha(before),
  after: encodeNativeEngineFiles([{ path: target, content: Buffer.from(after) }])[0],
});
const reply = (body) => ({
  StatusCode: 200,
  Payload: new TextEncoder().encode(JSON.stringify(body)),
});
const exists = (path) =>
  fs.lstat(path).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

let temp;
let project;
let directory;
let identity;
let s3;
let backend;

// A versioned bucket in memory. Receipts are produced and verified by the real
// object codec; only the transport is replaced.
const createS3 = () => {
  const versions = new Map();
  const puts = [];
  return {
    puts,
    send: vi.fn(async (command) => {
      const { Key, Body, VersionId, Bucket, ExpectedBucketOwner } = command.input;
      if (Bucket !== bucket || ExpectedBucketOwner !== accountId) throw new Error('AccessDenied');
      if (command.constructor.name === 'PutObjectCommand') {
        const stored = versions.get(Key) ?? [];
        stored.push(Buffer.from(Body));
        versions.set(Key, stored);
        puts.push(Key);
        return { VersionId: `version-${stored.length}` };
      }
      if (command.constructor.name === 'GetObjectCommand') {
        const stored = versions.get(Key) ?? [];
        const index = VersionId
          ? Number(VersionId.slice('version-'.length)) - 1
          : stored.length - 1;
        const bytes = stored[index];
        if (!bytes) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return {
          VersionId: `version-${index + 1}`,
          ContentLength: bytes.length,
          Body: Readable.from([bytes]),
        };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    }),
  };
};

// The protected service reduced to its request journal: one stored result per
// request, replayed on a repeated request and never executed twice.
const createBackend = () => {
  const objects = createNativeEngineObjects({ s3, bucket, accountId });
  const engine = {
    objects,
    version: 0,
    pending: null,
    running: new Set(),
    operations: new Map(),
    calls: [],
    executed: [],
    respond: async () => ({}),
    transport: async (request, handle) => reply(await handle(request)),
    async handle(request) {
      if (request.action === 'status')
        return { ok: true, version: engine.version, pending: engine.pending };
      if (engine.running.has(request.requestId))
        return { ok: true, status: 'pending', requestId: request.requestId };
      const stored = engine.operations.get(request.requestId);
      if (stored) return stored;
      const input = request.input
        ? await objects.read(request.identity, request.input, 'input')
        : null;
      engine.executed.push(request.requestId);
      const result = {
        schemaVersion: 1,
        identity: { ...request.identity, configurationSha256: 'c'.repeat(64) },
        requestId: request.requestId,
        exitCode: 0,
        stdout: '',
        stderr: '',
        patches: [],
        ...(await engine.respond(request, input)),
      };
      engine.version += 1;
      const response = {
        ok: true,
        status: 'completed',
        version: engine.version,
        result: await objects.write(
          request.identity,
          request.requestId,
          'result',
          result,
          'output',
        ),
      };
      engine.operations.set(request.requestId, response);
      return response;
    },
    lambda: {
      send: vi.fn(async (command, options) => {
        const request = JSON.parse(Buffer.from(command.input.Payload).toString('utf8'));
        engine.calls.push({
          name: command.constructor.name,
          input: command.input,
          options,
          request,
        });
        return engine.transport(request, engine.handle);
      }),
    },
    operationsSent: () =>
      engine.calls.map((call) => call.request).filter((request) => request.action !== 'status'),
    statusCalls: () => engine.calls.filter((call) => call.request.action === 'status').length,
  };
  return engine;
};
const context = (overrides = {}) => ({
  schemaVersion: 1,
  identity,
  directory,
  project,
  engine: { ...pin },
  accountId,
  bucket,
  ...overrides,
});
const client = (options = {}) =>
  createNativeEngineClient({ context: context(), lambda: backend.lambda, s3, ...options });
const write = async (path, content) => {
  await fs.mkdir(join(project, path, '..'), { recursive: true, mode: 0o700 });
  await fs.writeFile(join(project, path), content);
};
const read = (path) => fs.readFile(join(project, path), 'utf8');
const pendingPath = () => join(directory, 'pending.json');
// The acknowledgement is lost after the service durably finished the request.
const loseFirstAcknowledgement = () => {
  let lost = false;
  backend.transport = async (request, handle) => {
    const response = await handle(request);
    if (request.action !== 'status' && !lost) {
      lost = true;
      throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    }
    return reply(response);
  };
};

beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-workflow-client-')));
  project = join(temp, 'project');
  directory = join(temp, 'control/workflow-engine/writer-1/turn-1');
  await fs.mkdir(project, { mode: 0o700 });
  await write('src/app.js', 'old application\n');
  await write('README.md', '# Project\n');
  identity = {
    projectId: randomUUID(),
    executionId: randomUUID(),
    bindingId: randomUUID(),
    attemptId: randomUUID(),
    epoch: 1,
    writerGeneration: 1,
    sequence: 1,
  };
  s3 = createS3();
  backend = createBackend();
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

describe('native workflow engine client commands', () => {
  it('submits the workspace, invokes the binding alias and applies the returned patches', async () => {
    backend.respond = async () => ({
      exitCode: 3,
      stdout: 'directive\n',
      stderr: 'warning\n',
      patches: [
        patch('src/app.js', 'old application\n', 'new application\n'),
        patch('aidlc/spaces/default/state.md', null, '# State\n'),
      ],
    });
    const controller = new AbortController();
    const result = await client({ signal: controller.signal }).command(['next', '--json']);

    expect(result).toMatchObject({ exitCode: 3, stdout: 'directive\n', stderr: 'warning\n' });
    expect(backend.calls.map((call) => call.request.action)).toEqual(['status', 'execute']);
    for (const call of backend.calls) {
      expect(call.name).toBe('InvokeCommand');
      expect(call.input.FunctionName).toBe(nativeEngineArn(identity, pin));
      expect(call.input.FunctionName).toMatch(
        new RegExp(`^${pin.functionArn}:native_[a-f0-9]{32}$`),
      );
      expect(call.input.InvocationType).toBe('RequestResponse');
      expect(call.options).toEqual({ abortSignal: controller.signal });
    }
    const [request] = backend.operationsSent();
    expect(Object.keys(request).toSorted()).toEqual([
      'action',
      'args',
      'expectedVersion',
      'identity',
      'input',
      'requestId',
      'schemaVersion',
    ]);
    expect(request).toMatchObject({
      schemaVersion: 1,
      identity,
      action: 'execute',
      expectedVersion: 0,
      args: ['next', '--json'],
    });
    expect(request.input.key).toBe(
      `${nativeEngineObjectPrefix(identity, 'input')}${request.requestId}/files.json.gz`,
    );
    const submitted = await backend.objects.read(identity, request.input, 'input');
    const workspace = [
      { path: 'README.md', content: Buffer.from('# Project\n') },
      { path: 'src/app.js', content: Buffer.from('old application\n') },
    ];
    expect(submitted).toEqual({
      schemaVersion: 1,
      files: encodeNativeEngineFiles(workspace),
      filesSha256: nativeEngineFileDigest(encodeNativeEngineFiles(workspace)),
    });

    expect(await read('src/app.js')).toBe('new application\n');
    expect(await read('aidlc/spaces/default/state.md')).toBe('# State\n');
    expect(await read('README.md')).toBe('# Project\n');
    expect(await exists(pendingPath())).toBe(false);
    expect(await exists(join(directory, 'client.lock'))).toBe(false);
    // The accepted request and its observation stay retained beside the turn.
    expect(
      JSON.parse(await fs.readFile(join(directory, `${request.requestId}.json`), 'utf8')),
    ).toEqual({ request, observed: backend.operations.get(request.requestId) });
    expect((await fs.readdir(join(project, 'src'))).toSorted()).toEqual(['app.js']);
  });

  it('uses the version reported by the service for each new request', async () => {
    await client().command(['next']);
    await client().command(['engine', 'state', 'show']);
    const [first, second] = backend.operationsSent();
    expect(first.expectedVersion).toBe(0);
    expect(second.expectedVersion).toBe(1);
    expect(second.requestId).not.toBe(first.requestId);
    expect(backend.operations.size).toBe(2);
  });

  it('sends finalize with the publication and interaction and without workspace files', async () => {
    const snapshot = vi.fn();
    const publication = { id: 'c'.repeat(64), sequence: 1 };
    const interaction = { id: 'd'.repeat(64), publicationId: publication.id };
    const result = await client({ snapshot }).command([], {
      action: 'finalize',
      publication,
      interaction,
    });
    expect(result.exitCode).toBe(0);
    const [request] = backend.operationsSent();
    expect(Object.keys(request).toSorted()).toEqual([
      'action',
      'expectedVersion',
      'identity',
      'interaction',
      'publication',
      'requestId',
      'schemaVersion',
    ]);
    expect(request).toMatchObject({ action: 'finalize', publication, interaction });
    expect(snapshot).not.toHaveBeenCalled();
    expect(s3.puts.some((key) => key.startsWith('native-workflow-input/'))).toBe(false);
  });

  it('sends mirror with the workspace input and empty arguments', async () => {
    await client().command([], { action: 'mirror' });
    const [request] = backend.operationsSent();
    expect(request).toMatchObject({ action: 'mirror', args: [], expectedVersion: 0 });
    expect(request).not.toHaveProperty('publication');
    expect(request).not.toHaveProperty('interaction');
    const submitted = await backend.objects.read(identity, request.input, 'input');
    expect(submitted.files.map((file) => file.path)).toEqual(['README.md', 'src/app.js']);
  });

  it('refuses to finalize a form across a change to the mirrored engine head', async () => {
    const mirror = await client().command([], { action: 'mirror' });
    await client().command(['next']);
    await expect(
      client().command([], {
        action: 'finalize',
        publication: { id: 'a'.repeat(64) },
        interaction: { id: 'b'.repeat(64) },
        expectedVersion: mirror.version,
      }),
    ).rejects.toThrow('NATIVE_ENGINE_HEAD_CHANGED');
    expect(backend.executed).toHaveLength(2);
    expect(await exists(pendingPath())).toBe(false);
  });

  it.each([
    ['an unsupported context version', { schemaVersion: 2 }],
    ['a relative project', { project: 'project' }],
    ['a project that is not normalized', { project: '/tmp/project/../other' }],
    ['a relative control directory', { directory: 'control' }],
  ])('refuses %s', (_name, overrides) => {
    expect(() =>
      createNativeEngineClient({ context: context(overrides), lambda: backend.lambda, s3 }),
    ).toThrow(expect.objectContaining({ code: 'NATIVE_ENGINE_INVALID' }));
  });

  it('refuses a context whose engine pin is not the supported profile', () => {
    expect(() =>
      createNativeEngineClient({
        context: context({ engine: { ...pin, profileId: 'aidlc-0.0.0-other' } }),
        lambda: backend.lambda,
        s3,
      }),
    ).toThrow(expect.objectContaining({ code: 'NATIVE_ENGINE_PIN_INVALID' }));
  });
});

describe('native workflow engine client lost acknowledgements', () => {
  beforeEach(() => {
    backend.respond = async (request) => ({
      stdout: `${request.args.join(' ')}\n`,
      patches: request.args.includes('next')
        ? [patch('src/app.js', 'old application\n', 'new application\n')]
        : [],
    });
  });

  it('re-sends the retained request and applies its stored result once', async () => {
    loseFirstAcknowledgement();
    await expect(client().command(['next'])).rejects.toThrow();
    expect(backend.operations.size).toBe(1);
    expect(await read('src/app.js')).toBe('old application\n');
    const retained = JSON.parse(await fs.readFile(pendingPath(), 'utf8'));
    expect(await exists(join(directory, 'client.lock'))).toBe(false);

    // A new process, as the next aidlc invocation is.
    const result = await client().command(['next']);

    expect(result).toMatchObject({ exitCode: 0, stdout: 'next\n' });
    const sent = backend.operationsSent();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1]).toEqual(retained);
    expect(sent[1]).toMatchObject({ requestId: retained.requestId, expectedVersion: 0 });
    expect(sent[1].input).toEqual(sent[0].input);
    expect(backend.executed).toEqual([retained.requestId]);
    expect(backend.operations.size).toBe(1);
    expect(backend.version).toBe(1);
    // Neither a second status probe nor a second upload invents a new request.
    expect(backend.statusCalls()).toBe(1);
    expect(s3.puts.filter((key) => key.startsWith('native-workflow-input/'))).toHaveLength(1);
    expect(await read('src/app.js')).toBe('new application\n');
    expect(await exists(pendingPath())).toBe(false);
  });

  it('reconciles the retained request before running a different command as a new request', async () => {
    loseFirstAcknowledgement();
    await expect(client().command(['next'])).rejects.toThrow();

    const result = await client().command(['engine', 'state', 'show']);

    expect(result.stdout).toBe('engine state show\n');
    const sent = backend.operationsSent();
    expect(sent.map((request) => request.args)).toEqual([
      ['next'],
      ['next'],
      ['engine', 'state', 'show'],
    ]);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[2].requestId).not.toBe(sent[0].requestId);
    expect(sent[2].expectedVersion).toBe(1);
    expect(backend.executed).toEqual([sent[0].requestId, sent[2].requestId]);
    // The new request submits the bytes left by the reconciled one.
    const submitted = await backend.objects.read(identity, sent[2].input, 'input');
    expect(
      Buffer.from(
        submitted.files.find((file) => file.path === 'src/app.js').content,
        'base64',
      ).toString(),
    ).toBe('new application\n');
    expect(await exists(pendingPath())).toBe(false);
  });

  it('skips a patch that was applied before the local acknowledgement was removed', async () => {
    await client().command(['next']);
    const [request] = backend.operationsSent();
    expect(await read('src/app.js')).toBe('new application\n');
    // The process stopped after the rename and before pending.json was removed.
    await fs.writeFile(pendingPath(), JSON.stringify(request), { mode: 0o600 });

    const result = await client().command(['next']);

    expect(result.stdout).toBe('next\n');
    expect(backend.operationsSent()).toEqual([request, request]);
    expect(backend.executed).toEqual([request.requestId]);
    expect(await read('src/app.js')).toBe('new application\n');
    expect(await exists(pendingPath())).toBe(false);
  });

  it('replays a finalize for the same publication and starts a new one for another', async () => {
    backend.respond = async () => ({});
    loseFirstAcknowledgement();
    const publication = { id: 'c'.repeat(64) };
    const interaction = { id: 'd'.repeat(64) };
    const finalize = (receipt) =>
      client().command([], { action: 'finalize', publication: receipt, interaction });
    await expect(finalize(publication)).rejects.toThrow();
    await finalize(publication);
    expect(backend.operationsSent()).toHaveLength(2);
    expect(backend.executed).toHaveLength(1);

    await finalize({ id: 'e'.repeat(64) });
    expect(backend.executed).toHaveLength(2);
    expect(backend.operationsSent().at(-1).publication).toEqual({ id: 'e'.repeat(64) });
  });

  it('does not accept a lost finalize acknowledgement for another interaction of the same publication', async () => {
    backend.respond = async () => ({});
    loseFirstAcknowledgement();
    const publication = { id: 'c'.repeat(64) };
    const finalize = (id) =>
      client().command([], {
        action: 'finalize',
        publication,
        interaction: { id },
        expectedVersion: 0,
      });
    await expect(finalize('d'.repeat(64))).rejects.toThrow();
    await expect(finalize('e'.repeat(64))).rejects.toThrow('NATIVE_ENGINE_HEAD_CHANGED');
    expect(backend.executed).toHaveLength(1);
    expect(await exists(pendingPath())).toBe(false);
  });
});

describe('native workflow engine client pending operations', () => {
  it('keeps the retained request while the service still reports it pending', async () => {
    backend.respond = async () => ({
      patches: [patch('src/app.js', 'old application\n', 'new application\n')],
    });
    backend.transport = async (request, handle) => {
      if (request.action === 'status') return reply(await handle(request));
      backend.running.add(request.requestId);
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    };
    await expect(client().command(['next'])).rejects.toThrow();
    const retained = await fs.readFile(pendingPath(), 'utf8');
    backend.transport = async (request, handle) => reply(await handle(request));

    for (const args of [['next'], ['engine', 'state', 'show']])
      await expect(client().command(args)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_PENDING',
      });

    expect(await fs.readFile(pendingPath(), 'utf8')).toBe(retained);
    const { requestId } = JSON.parse(retained);
    expect(backend.operationsSent().every((request) => request.requestId === requestId)).toBe(true);
    expect(backend.statusCalls()).toBe(1);
    expect(backend.executed).toEqual([]);
    expect(await read('src/app.js')).toBe('old application\n');
    expect(await exists(join(directory, 'client.lock'))).toBe(false);

    // Once the service finishes, the same request yields its one result.
    backend.running.clear();
    await expect(client().command(['next'])).resolves.toMatchObject({ exitCode: 0 });
    expect(backend.executed).toEqual([requestId]);
    expect(await read('src/app.js')).toBe('new application\n');
    expect(await exists(pendingPath())).toBe(false);
  });

  it('does not start a request while the service has another one pending', async () => {
    backend.pending = randomUUID();
    await expect(client().command(['next'])).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_PENDING',
    });
    expect(backend.operationsSent()).toEqual([]);
    expect(s3.puts).toEqual([]);
    expect(await exists(pendingPath())).toBe(false);
    expect(await exists(join(directory, 'client.lock'))).toBe(false);
  });

  it('refuses a retained request that belongs to another identity', async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      pendingPath(),
      JSON.stringify({
        schemaVersion: 1,
        identity: { ...identity, attemptId: randomUUID() },
        action: 'execute',
        requestId: randomUUID(),
        expectedVersion: 0,
        args: ['next'],
      }),
      { mode: 0o600 },
    );
    await expect(client().command(['next'])).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_RESULT_INVALID',
    });
    expect(backend.calls).toEqual([]);
    expect(await exists(pendingPath())).toBe(true);
  });
});

describe('native workflow engine client result validation', () => {
  const change = () => patch('src/app.js', 'old application\n', 'new application\n');
  const rejected = async (code) => {
    await expect(client().command(['next'])).rejects.toMatchObject({ code });
    expect(await read('src/app.js')).toBe('old application\n');
    expect((await fs.readdir(join(project, 'src'))).toSorted()).toEqual(['app.js']);
  };

  it.each([
    ['another request', () => ({ requestId: randomUUID() })],
    ['another identity', () => ({ identity: { ...identity, sequence: 2 } })],
    ['another attempt', () => ({ identity: { ...identity, attemptId: randomUUID() } })],
    ['no identity', () => ({ identity: null })],
    ['an unsupported schema', () => ({ schemaVersion: 2 })],
    ['a textual exit code', () => ({ exitCode: '0' })],
    ['a fractional exit code', () => ({ exitCode: 0.5 })],
    ['no exit code', () => ({ exitCode: null })],
    ['non-text standard output', () => ({ stdout: null })],
    ['non-text standard error', () => ({ stderr: 7 })],
  ])('rejects a stored result carrying %s', async (_name, overrides) => {
    backend.respond = async () => ({ patches: [change()], ...overrides() });
    await rejected('NATIVE_ENGINE_RESULT_INVALID');
  });

  it.each([
    ['a named service refusal', { ok: false, code: 'NATIVE_ENGINE_FORBIDDEN' }, 'FORBIDDEN'],
    ['a refusal without a public code', { ok: false, code: 'internal failure' }, 'UNAVAILABLE'],
    ['a refusal with no code', { ok: false }, 'UNAVAILABLE'],
    ['an unknown operation status', { ok: true, status: 'running', version: 1 }, 'UNAVAILABLE'],
  ])('rejects %s', async (_name, body, suffix) => {
    backend.transport = async (request, handle) =>
      request.action === 'status' ? reply(await handle(request)) : reply(body);
    await rejected(`NATIVE_ENGINE_${suffix}`);
  });

  it('rejects a completed response without an integer version', async () => {
    backend.respond = async () => ({ patches: [change()] });
    backend.transport = async (request, handle) => {
      const response = await handle(request);
      return reply(request.action === 'status' ? response : { ...response, version: '1' });
    };
    await rejected('NATIVE_ENGINE_UNAVAILABLE');
  });

  it.each([
    ['a function error', (body) => ({ ...reply(body), FunctionError: 'Unhandled' })],
    ['an empty response', () => ({ StatusCode: 200 })],
    ['an oversized response', (body) => reply({ ...body, padding: 'x'.repeat(1024 * 1024) })],
  ])('rejects %s from the service invocation', async (_name, respond) => {
    backend.respond = async () => ({ patches: [change()] });
    backend.transport = async (request, handle) => {
      const response = await handle(request);
      return request.action === 'status' ? reply(response) : respond(response);
    };
    await rejected('NATIVE_ENGINE_UNAVAILABLE');
  });

  it('rejects a status probe that fails before any request is created', async () => {
    backend.transport = async () => ({ ...reply({ ok: true }), FunctionError: 'Unhandled' });
    await rejected('NATIVE_ENGINE_UNAVAILABLE');
    expect(await exists(pendingPath())).toBe(false);
    expect(s3.puts).toEqual([]);
  });

  it('reads the result only from the protected output prefix of its own identity', async () => {
    backend.respond = async () => ({ patches: [change()] });
    backend.transport = async (request, handle) => {
      const response = await handle(request);
      // The runtime can write input objects; one must never be taken as a result.
      return reply(request.action === 'status' ? response : { ...response, result: request.input });
    };
    await rejected('NATIVE_ENGINE_OBJECT_INVALID');
  });

  it('rejects a result object whose stored bytes differ from its receipt', async () => {
    backend.respond = async () => ({ patches: [change()] });
    backend.transport = async (request, handle) => {
      const response = await handle(request);
      return reply(
        request.action === 'status'
          ? response
          : { ...response, result: { ...response.result, sha256: '0'.repeat(64) } },
      );
    };
    await rejected('NATIVE_ENGINE_OBJECT_INVALID');
  });
});

describe('native workflow engine client patch safety', () => {
  const failsWith = (code) =>
    expect(client().command(['next'])).rejects.toMatchObject({
      code: typeof code === 'string' ? code : expect.stringMatching(code),
    });

  it('refuses a patch whose expected prior bytes differ from the current file', async () => {
    backend.respond = async () => ({
      patches: [patch('src/app.js', 'some earlier application\n', 'new application\n')],
    });
    await failsWith('NATIVE_ENGINE_WORKSPACE_CHANGED');
    expect(await read('src/app.js')).toBe('old application\n');
    expect((await fs.readdir(join(project, 'src'))).toSorted()).toEqual(['app.js']);
  });

  it('refuses to create a file that appeared while the service was working', async () => {
    backend.respond = async () => {
      await write('aidlc/state.md', 'written by the coding runtime\n');
      return { patches: [patch('aidlc/state.md', null, '# State\n')] };
    };
    await failsWith('NATIVE_ENGINE_WORKSPACE_CHANGED');
    expect(await read('aidlc/state.md')).toBe('written by the coding runtime\n');
  });

  it('refuses to replace a file that changed while the service was working', async () => {
    backend.respond = async () => {
      await write('src/app.js', 'concurrent edit\n');
      return { patches: [patch('src/app.js', 'old application\n', 'new application\n')] };
    };
    await failsWith('NATIVE_ENGINE_WORKSPACE_CHANGED');
    expect(await read('src/app.js')).toBe('concurrent edit\n');
  });

  it('skips a patch whose result is already the current file', async () => {
    backend.respond = async () => ({
      stdout: 'unchanged\n',
      patches: [patch('src/app.js', 'bytes from before a replay\n', 'old application\n')],
    });
    const before = await fs.lstat(join(project, 'src/app.js'), { bigint: true });
    await expect(client().command(['next'])).resolves.toMatchObject({ stdout: 'unchanged\n' });
    expect(await read('src/app.js')).toBe('old application\n');
    const after = await fs.lstat(join(project, 'src/app.js'), { bigint: true });
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs]);
  });

  it('refuses a parent directory that is a link out of the project', async () => {
    const outside = join(temp, 'outside');
    await fs.mkdir(outside, { mode: 0o700 });
    backend.respond = async () => {
      await fs.symlink(outside, join(project, 'linked'));
      return { patches: [patch('linked/escape.txt', null, 'escaped\n')] };
    };
    await failsWith('NATIVE_ENGINE_WORKSPACE_CHANGED');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses a target that is a link to a file outside the project', async () => {
    const outside = join(temp, 'outside.txt');
    await fs.writeFile(outside, 'outside\n');
    backend.respond = async () => {
      await fs.symlink(outside, join(project, 'src/link.js'));
      return { patches: [patch('src/link.js', 'outside\n', 'replaced\n')] };
    };
    await failsWith('NATIVE_ENGINE_WORKSPACE_CHANGED');
    expect(await fs.readFile(outside, 'utf8')).toBe('outside\n');
    expect((await fs.lstat(join(project, 'src/link.js'))).isSymbolicLink()).toBe(true);
  });

  it('refuses two patches for one path', async () => {
    backend.respond = async () => ({
      patches: [
        patch('src/app.js', 'old application\n', 'first\n'),
        patch('src/app.js', 'old application\n', 'second\n'),
      ],
    });
    await failsWith(/^NATIVE_ENGINE_/);
    expect(await read('src/app.js')).toBe('old application\n');
  });

  it('refuses a patch whose content is addressed to another path', async () => {
    backend.respond = async () => ({
      patches: [patch('src/app.js', 'old application\n', 'redirected\n', 'README.md')],
    });
    await failsWith(/^NATIVE_ENGINE_/);
    expect(await read('src/app.js')).toBe('old application\n');
    expect(await read('README.md')).toBe('# Project\n');
  });

  it.each([
    ['a parent traversal', () => '../escape.txt', () => join(temp, 'escape.txt')],
    ['an embedded traversal', () => 'src/../../escape.txt', () => join(temp, 'escape.txt')],
    ['an absolute path', () => join(temp, 'absolute.txt'), () => join(temp, 'absolute.txt')],
  ])('refuses %s', async (_name, target, escaped) => {
    backend.respond = async () => ({
      patches: [
        patch('src/app.js', 'old application\n', 'new application\n'),
        patch(target(), null, 'escaped\n'),
      ],
    });
    await failsWith(/^NATIVE_ENGINE_/);
    expect(await exists(escaped())).toBe(false);
    expect(await read('src/app.js')).toBe('old application\n');
  });

  it('refuses patches that are not a list', async () => {
    backend.respond = async () => ({ patches: { 0: patch('src/app.js', null, 'x') } });
    await failsWith('NATIVE_ENGINE_INVALID');
    expect(await read('src/app.js')).toBe('old application\n');
  });
});

describe('native workflow engine client local lock', () => {
  const lockPath = () => join(directory, 'client.lock');
  const lock = async (value) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(lockPath(), JSON.stringify(value), { mode: 0o600 });
  };

  it('is busy while another live local client holds the lock', async () => {
    await lock({ pid: process.pid });
    await expect(client().command(['next'])).rejects.toMatchObject({ code: 'NATIVE_ENGINE_BUSY' });
    expect(backend.calls).toEqual([]);
    expect(JSON.parse(await fs.readFile(lockPath(), 'utf8'))).toEqual({ pid: process.pid });
  });

  it.each([{ pid: 'unknown' }, { pid: 0 }, { pid: -1 }, {}])(
    'is busy for a lock without a usable owner: %j',
    async (value) => {
      await lock(value);
      await expect(client().command(['next'])).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_BUSY',
      });
      expect(backend.calls).toEqual([]);
    },
  );

  it('takes over the lock of a local client that no longer exists', async () => {
    const ended = spawnSync(process.execPath, ['-e', '']);
    expect(ended.status).toBe(0);
    await lock({ pid: ended.pid });
    await expect(client().command(['next'])).resolves.toMatchObject({ exitCode: 0 });
    expect(backend.executed).toHaveLength(1);
    expect(await exists(lockPath())).toBe(false);
  });

  it('releases the lock after a failed command', async () => {
    backend.transport = async () => reply({ ok: false, code: 'NATIVE_ENGINE_FORBIDDEN' });
    await expect(client().command(['next'])).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_FORBIDDEN',
    });
    expect(await exists(lockPath())).toBe(false);
  });

  it('refuses a control directory reached through a link', async () => {
    const real = join(temp, 'elsewhere');
    await fs.mkdir(real, { mode: 0o700 });
    await fs.mkdir(join(directory, '..'), { recursive: true, mode: 0o700 });
    await fs.symlink(real, directory);
    await expect(client().command(['next'])).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_WORKSPACE_CHANGED',
    });
    expect(backend.calls).toEqual([]);
    expect(await fs.readdir(real)).toEqual([]);
  });
});

describe('native workflow engine client preparation', () => {
  const env = { NATIVE_RUNTIME_ACCOUNT_ID: accountId, NATIVE_PUBLICATION_BUCKET: bucket };
  const payload = (overrides = {}, configuration = { workflowEngine: { ...pin } }) => ({
    command: 'native-start',
    projectId: identity.projectId,
    executionId: identity.executionId,
    bindingId: identity.bindingId,
    attemptId: identity.attemptId,
    runtimeSessionId: randomUUID(),
    epoch: 1,
    writerGeneration: 1,
    sequence: 1,
    configuration: { harness: 'codex', ...configuration },
    ...overrides,
  });
  const prepare = (value, options = {}) =>
    prepareNativeEngineClient({
      payload: value,
      env,
      project,
      control: join(temp, 'control'),
      forbiddenBytes: ['known-model-credential'],
      s3,
      lambda: backend.lambda,
      ...options,
    });
  beforeEach(async () => {
    await fs.mkdir(join(temp, 'control'), { mode: 0o700 });
  });

  it('returns nothing and creates nothing without a workflow engine configuration', async () => {
    expect(await prepare(payload({}, {}))).toBeNull();
    expect(await fs.readdir(join(temp, 'control'))).toEqual([]);
    expect(backend.calls).toEqual([]);
  });

  it('binds the first turn to sequence 1 and writes a private context', async () => {
    const prepared = await prepare(payload({ sequence: 9 }));
    const turn = join(temp, 'control/workflow-engine/writer-1/turn-1');
    expect(prepared.contextPath).toBe(join(turn, 'context.json'));
    expect(typeof prepared.client.command).toBe('function');
    const stored = await nativeEngineContext(prepared.contextPath);
    expect(stored).toEqual({
      schemaVersion: 1,
      identity: { ...identity, sequence: 1 },
      directory: turn,
      project,
      engine: { ...pin },
      accountId,
      bucket,
    });
    expect(Object.keys(stored.identity).toSorted()).toEqual([
      'attemptId',
      'bindingId',
      'epoch',
      'executionId',
      'projectId',
      'sequence',
      'writerGeneration',
    ]);
    expect((await fs.lstat(prepared.contextPath)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(turn)).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(stored)).not.toContain('known-model-credential');
  });

  it('uses the dispatched sequence and writer generation for later turns', async () => {
    const first = await prepare(payload());
    const second = await prepare(payload({ command: 'native-continue', sequence: 2 }));
    const recovered = await prepare(
      payload({ command: 'native-resume', sequence: 3, writerGeneration: 2 }),
    );
    expect(second.contextPath).toBe(
      join(temp, 'control/workflow-engine/writer-1/turn-2/context.json'),
    );
    expect(recovered.contextPath).toBe(
      join(temp, 'control/workflow-engine/writer-2/turn-3/context.json'),
    );
    expect(new Set([first, second, recovered].map((entry) => entry.contextPath)).size).toBe(3);
    expect((await nativeEngineContext(second.contextPath)).identity).toEqual({
      ...identity,
      sequence: 2,
    });
    expect((await nativeEngineContext(recovered.contextPath)).identity).toEqual({
      ...identity,
      sequence: 3,
      writerGeneration: 2,
    });
  });

  it('accepts the same context again and refuses a changed one', async () => {
    const first = await prepare(payload());
    const before = await fs.readFile(first.contextPath, 'utf8');
    expect((await prepare(payload())).contextPath).toBe(first.contextPath);
    expect(await fs.readFile(first.contextPath, 'utf8')).toBe(before);

    for (const changed of [
      payload({}, { workflowEngine: { ...pin, version: '8' } }),
      payload({ attemptId: randomUUID() }),
    ])
      await expect(prepare(changed)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_CONFIGURATION_CHANGED',
      });
    await expect(
      prepare(payload(), { env: { ...env, NATIVE_PUBLICATION_BUCKET: 'another-bucket' } }),
    ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_CONFIGURATION_CHANGED' });
    expect(await fs.readFile(first.contextPath, 'utf8')).toBe(before);
    expect(backend.calls).toEqual([]);
  });

  it('refuses an engine pin that is not the supported profile', async () => {
    await expect(
      prepare(payload({}, { workflowEngine: { ...pin, functionArn: 'arn:aws:lambda:invalid' } })),
    ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_PIN_INVALID' });
  });

  it('gives the executor and the aidlc command the same request state', async () => {
    backend.respond = async (request) => ({ stdout: `${request.action}\n` });
    const prepared = await prepare(payload());
    await expect(prepared.client.command(['next'])).resolves.toMatchObject({
      stdout: 'execute\n',
    });
    // The launcher's process only has the context file.
    const launched = createNativeEngineClient({
      context: await nativeEngineContext(prepared.contextPath),
      lambda: backend.lambda,
      s3,
    });
    await expect(launched.command([], { action: 'mirror' })).resolves.toMatchObject({
      stdout: 'mirror\n',
    });
    const sent = backend.operationsSent();
    expect(sent.map((request) => request.expectedVersion)).toEqual([0, 1]);
    expect(sent.every((request) => request.identity.sequence === 1)).toBe(true);
    expect(new Set(backend.calls.map((call) => call.input.FunctionName))).toEqual(
      new Set([nativeEngineArn(identity, pin)]),
    );
  });

  it('does not read a context through a link', async () => {
    const prepared = await prepare(payload());
    const link = join(temp, 'context-link.json');
    await fs.symlink(prepared.contextPath, link);
    await expect(nativeEngineContext(link)).rejects.toThrow();
  });
});
