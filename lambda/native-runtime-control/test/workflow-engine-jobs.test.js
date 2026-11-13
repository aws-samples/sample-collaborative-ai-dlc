import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createNativeEngineJobs } from '../workflow-engine/jobs.js';
import { createNativeEngineObjects } from '../../shared/native-workflow-objects.js';
import {
  NATIVE_ENGINE_PROFILE,
  encodeNativeEngineFiles,
  engineDigest,
  nativeEngineFileDigest,
  nativeEngineFiles,
  nativeEngineObjectPrefix,
  nativeReviewerAlias,
} from '../../shared/native-workflow-protocol.js';
import {
  NATIVE_ENGINE_JOB_BUILD_SPEC,
  NATIVE_ENGINE_JOB_ROOT,
  nativeEngineJob,
} from '../../shared/native-workflow-job.js';

const ACCOUNT = '123456789012';
const BUCKET = 'native-publications';
const JOB_PROJECT = 'native-workflow-jobs';
const CHECK_ROLE = `arn:aws:iam::${ACCOUNT}:role/native-runs/native-workflow-check`;
const IMAGE = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/agentcore@sha256:${'b'.repeat(64)}`;
const PROJECT = '/var/engine/workspace/project';
const GIT_SECRET = 'ghp_private-git-credential-canary';
const ENGINE_SECRET = 'private-engine-ledger-canary';
const code = (value) => ({ code: value });

const fixture = () => {
  const identity = {
    projectId: 'project',
    executionId: randomUUID(),
    bindingId: randomUUID(),
    attemptId: randomUUID(),
    epoch: 1,
  };
  const operation = { identity, requestId: randomUUID(), token: randomUUID() };
  const row = {
    scope: { projectId: identity.projectId, executionId: identity.executionId },
    attemptId: identity.attemptId,
    epoch: identity.epoch,
    credentials: { git: { token: GIT_SECRET } },
    configuration: {
      harness: 'codex',
      model: 'provider.model-v1:0',
      accountId: ACCOUNT,
      publicationBucket: BUCKET,
      image: { uri: IMAGE, digest: `sha256:${'b'.repeat(64)}` },
      workflowEngine: { producerSha256: 'b'.repeat(64) },
      repository: { credentialIdentity: 'd'.repeat(64), token: GIT_SECRET },
    },
  };
  const events = [];

  // Versioned bucket: an unversioned read observes the newest version of a key.
  const versions = new Map();
  const latest = new Map();
  const put = (key, body) => {
    const VersionId = randomUUID();
    versions.set(VersionId, { key, body });
    latest.set(key, VersionId);
    return VersionId;
  };
  const s3 = {
    send: vi.fn(async (command) => {
      const { Key, Body } = command.input;
      if (command.constructor.name === 'PutObjectCommand')
        return { VersionId: put(Key, Buffer.from(Body)) };
      if (command.constructor.name !== 'GetObjectCommand') throw new Error('Unexpected S3 call');
      const VersionId = command.input.VersionId ?? latest.get(Key);
      const version = versions.get(VersionId);
      if (!version || version.key !== Key)
        throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { VersionId, ContentLength: version.body.length, Body: Readable.from([version.body]) };
    }),
  };
  const jobPrefix = nativeEngineObjectPrefix(identity, 'job');
  const stored = (key) =>
    JSON.parse(gunzipSync(versions.get(latest.get(key)).body).toString('utf8'));
  const input = (jobId) => stored(`${jobPrefix}${jobId}/input.json.gz`);

  const jobs = new Map();
  const transitions = [];
  const journal = {
    recordJob: vi.fn(async (owner, jobId, value, previousStatus = null) => {
      expect(owner).toBe(operation);
      if ((jobs.get(jobId)?.status ?? null) !== previousStatus)
        throw Object.assign(new Error('conditional'), { name: 'TransactionCanceledException' });
      jobs.set(jobId, structuredClone(value));
      transitions.push(value.status);
      events.push(`journal:${value.status}`);
    }),
  };

  // The wrapper reads its one input and publishes one result. Tests replace
  // `result`/`build` to model a wrapper or CodeBuild that reports differently.
  const f = {
    start: null,
    poll: null,
    result: (job) => ({
      schemaVersion: 1,
      jobId: job.jobId,
      kind: job.kind,
      filesSha256: job.filesSha256,
      producerSha256: job.producerSha256,
      exitCode: 0,
      timedOut: false,
      cleanupComplete: true,
      stdout: 'checked\n',
      stderr: '',
      ...(job.kind === 'review'
        ? {
            review: '**Verdict:** READY\n',
            nativeSessionId: 'reviewer-session',
            reviewSha256: engineDigest('**Verdict:** READY\n'),
          }
        : {}),
    }),
    build: (value) => value,
  };
  const started = [];
  const codebuild = {
    send: vi.fn(async (command) => {
      const name = command.constructor.name.replace(/Command$/, '');
      events.push(name);
      if (name === 'StartBuild') {
        if (f.start) return f.start(command.input);
        const id = `${command.input.projectName}:${randomUUID()}`;
        started.push({ id, request: command.input });
        const result = f.result(input(command.input.idempotencyToken));
        if (result)
          put(
            `${jobPrefix}${command.input.idempotencyToken}/result.json.gz`,
            gzipSync(JSON.stringify(result)),
          );
        return { build: { id } };
      }
      if (name === 'BatchGetBuilds') {
        if (f.poll) return f.poll(command.input);
        const [id] = command.input.ids;
        const { request } = started.find((build) => build.id === id);
        return {
          builds: [
            f.build({
              id,
              projectName: request.projectName,
              serviceRole: request.serviceRoleOverride,
              environment: {
                image: request.imageOverride,
                type: request.environmentTypeOverride,
                privilegedMode: request.privilegedModeOverride,
              },
              source: { type: request.sourceTypeOverride, buildspec: request.buildspecOverride },
              artifacts: { location: '' },
              buildComplete: true,
              buildStatus: 'SUCCEEDED',
              phases: [
                { phaseType: 'PRE_BUILD', phaseStatus: 'SUCCEEDED', durationInSeconds: 2 },
                { phaseType: 'BUILD', phaseStatus: 'SUCCEEDED', durationInSeconds: 7 },
                { phaseType: 'POST_BUILD', phaseStatus: 'SUCCEEDED', durationInSeconds: 1 },
              ],
            }),
          ],
          buildsNotFound: [],
        };
      }
      if (name === 'StopBuild') return {};
      throw new Error('Unexpected CodeBuild call');
    }),
  };
  const sent = (name) =>
    codebuild.send.mock.calls
      .filter(([command]) => command.constructor.name === `${name}Command`)
      .map(([command]) => command.input);
  const files = nativeEngineFiles(
    encodeNativeEngineFiles([
      { path: 'src/main.js', content: Buffer.from('export const main = 1;\n') },
      { path: '.git/HEAD', content: Buffer.from('ref: refs/heads/main\n') },
    ]),
  );
  const controller = new AbortController();
  const authorize = vi.fn(async () => {
    events.push('authorize');
  });
  const sign = vi.fn(
    async (_client, command) =>
      `https://signed.invalid/${command.constructor.name === 'GetObjectCommand' ? 'input' : 'output'}`,
  );
  const wait = vi.fn(async () => {});
  const reviewAccess = {
    roleArn: `arn:aws:iam::${ACCOUNT}:role/native-review/native_${nativeReviewerAlias(identity)}`,
    credentialAlias: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:native-credentials:${nativeReviewerAlias(identity)}`,
  };
  const reviewRole = vi.fn(async () => reviewAccess);
  return Object.assign(f, {
    identity,
    operation,
    row,
    events,
    s3,
    codebuild,
    sent,
    started,
    journal,
    jobs,
    transitions,
    files,
    controller,
    authorize,
    sign,
    wait,
    reviewRole,
    reviewAccess,
    jobPrefix,
    input,
    resultReads: () =>
      s3.send.mock.calls.filter(
        ([command]) =>
          command.constructor.name === 'GetObjectCommand' &&
          command.input.Key.endsWith('/result.json.gz'),
      ),
    api: createNativeEngineJobs({
      codebuild,
      s3,
      objects: createNativeEngineObjects({ s3, bucket: BUCKET, accountId: ACCOUNT }),
      journal,
      operation,
      row,
      env: { NATIVE_WORKFLOW_JOB_PROJECT: JOB_PROJECT, NATIVE_WORKFLOW_CHECK_ROLE: CHECK_ROLE },
      authorize,
      reviewRole,
      archive: Buffer.from('pinned engine archive'),
      workspace: {
        project: PROJECT,
        state: { ledger: ENGINE_SECRET },
        inspectionFiles: async () => files,
      },
      signal: controller.signal,
      sign,
      wait,
    }),
  });
};
const check = (overrides = {}) => ({
  command: 'npm',
  args: ['test'],
  cwd: PROJECT,
  input: null,
  ...overrides,
});
const review = () => ({
  files: nativeEngineFiles(
    encodeNativeEngineFiles([{ path: 'src/main.js', content: Buffer.from('reviewed\n') }]),
  ),
  instructions: 'Independent reviewer persona',
  prompt: 'Stage: code-generation',
});

describe('isolated project check invocation', () => {
  it('starts one fixed, unprivileged build and returns what CodeBuild and the result object show', async () => {
    const f = fixture();
    const result = await f.api.check(check());
    expect(f.transitions).toEqual(['prepared', 'running', 'finished']);
    const [jobId] = [...f.jobs.keys()];
    const [start, ...others] = f.sent('StartBuild');
    expect(others).toEqual([]);
    expect(start).toMatchObject({
      projectName: JOB_PROJECT,
      idempotencyToken: jobId,
      sourceTypeOverride: 'NO_SOURCE',
      artifactsOverride: { type: 'NO_ARTIFACTS' },
      environmentTypeOverride: 'ARM_CONTAINER',
      privilegedModeOverride: false,
      imageOverride: IMAGE,
      serviceRoleOverride: CHECK_ROLE,
      buildspecOverride: NATIVE_ENGINE_JOB_BUILD_SPEC,
      logsConfigOverride: {
        cloudWatchLogs: { status: 'DISABLED' },
        s3Logs: { status: 'DISABLED' },
      },
    });
    for (const key of [
      'secondarySourcesOverride',
      'secondaryArtifactsOverride',
      'sourceLocationOverride',
      'cacheOverride',
    ])
      expect(start).not.toHaveProperty(key);

    // One input and one output capability, and nothing else, reach the job.
    const receipt = f.jobs.get(jobId).input;
    expect(receipt.key).toBe(`${f.jobPrefix}${jobId}/input.json.gz`);
    expect(start.environmentVariablesOverride).toEqual([
      {
        name: 'NATIVE_WORKFLOW_JOB_INPUT',
        value: 'https://signed.invalid/input',
        type: 'PLAINTEXT',
      },
      { name: 'NATIVE_WORKFLOW_JOB_INPUT_SHA256', value: receipt.sha256, type: 'PLAINTEXT' },
      {
        name: 'NATIVE_WORKFLOW_JOB_OUTPUT',
        value: 'https://signed.invalid/output',
        type: 'PLAINTEXT',
      },
    ]);
    expect(f.sign).toHaveBeenCalledTimes(2);
    const [[, read, readOptions], [, write, writeOptions]] = f.sign.mock.calls;
    expect(read.constructor.name).toBe('GetObjectCommand');
    expect(read.input).toEqual({
      Bucket: BUCKET,
      Key: receipt.key,
      VersionId: receipt.versionId,
      ExpectedBucketOwner: ACCOUNT,
    });
    expect(write.constructor.name).toBe('PutObjectCommand');
    expect(write.input).toMatchObject({
      Bucket: BUCKET,
      Key: `${f.jobPrefix}${jobId}/result.json.gz`,
    });
    expect([readOptions, writeOptions]).toEqual([{ expiresIn: 900 }, { expiresIn: 900 }]);

    const buildId = f.started[0].id;
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cleanupComplete: true });
    expect(result.stdout).toEqual(Buffer.from('checked\n'));
    expect(result.stderr).toEqual(Buffer.from(''));
    expect(result.nativeExecutionMs).toBe(7000);
    expect(result.observation).toEqual({
      kind: 'check',
      jobId,
      buildId,
      image: IMAGE,
      roleArn: CHECK_ROLE,
      input: receipt,
      result: {
        key: `${f.jobPrefix}${jobId}/result.json.gz`,
        versionId: expect.any(String),
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      filesSha256: nativeEngineFileDigest(f.files),
      buildStatus: 'SUCCEEDED',
      executionMs: 7000,
      stdoutSha256: engineDigest('checked\n'),
      stderrSha256: engineDigest(''),
    });
    expect(f.jobs.get(jobId)).toMatchObject({
      status: 'finished',
      kind: 'check',
      buildId,
      roleArn: CHECK_ROLE,
      image: IMAGE,
      observation: result.observation,
    });
    expect(f.sent('StopBuild')).toEqual([]);
  });

  it('writes a job the isolated wrapper accepts and binds it to the pinned producer', async () => {
    const f = fixture();
    await f.api.check(check());
    const [jobId] = [...f.jobs.keys()];
    const job = f.input(jobId);
    expect(nativeEngineJob(job)).toMatchObject({
      schemaVersion: 1,
      kind: 'check',
      jobId,
      profileId: NATIVE_ENGINE_PROFILE.id,
      producerSha256: 'b'.repeat(64),
      filesSha256: nativeEngineFileDigest(f.files),
    });
    expect(job.files.map((file) => file.path).toSorted()).toEqual(['.git/HEAD', 'src/main.js']);
    expect(job).not.toHaveProperty('archive');
    expect(job).not.toHaveProperty('credentialAlias');
  });

  it('authorizes immediately before the build starts and before its outcome is recorded', async () => {
    const f = fixture();
    await f.api.check(check());
    expect(f.events.at(f.events.indexOf('StartBuild') - 1)).toBe('authorize');
    expect(f.events.at(f.events.indexOf('journal:finished') - 1)).toBe('authorize');
    for (const [index, event] of f.events.entries())
      if (event === 'BatchGetBuilds') expect(f.events[index - 1]).toBe('authorize');

    const denied = fixture();
    denied.authorize.mockRejectedValue(Object.assign(new Error('revoked'), code('REVOKED')));
    await expect(denied.api.check(check())).rejects.toMatchObject(code('REVOKED'));
    expect(denied.sent('StartBuild')).toEqual([]);
    expect(denied.transitions).toEqual(['prepared']);

    const late = fixture();
    late.authorize
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockRejectedValue(Object.assign(new Error('revoked'), code('REVOKED')));
    await expect(late.api.check(check())).rejects.toMatchObject(code('REVOKED'));
    expect(late.transitions).toEqual(['prepared', 'running']);
  });

  it('polls the same build until it is complete without starting another', async () => {
    const f = fixture();
    let polls = 0;
    f.build = (build) =>
      ++polls < 3 ? { ...build, buildComplete: false, buildStatus: 'IN_PROGRESS' } : build;
    const result = await f.api.check(check());
    expect(result.observation.buildStatus).toBe('SUCCEEDED');
    expect(f.sent('BatchGetBuilds')).toEqual(
      Array.from({ length: 3 }, () => ({ ids: [f.started[0].id] })),
    );
    expect(f.wait).toHaveBeenCalledTimes(2);
    expect(f.wait.mock.calls[0][0]).toBe(2000);
    expect(f.sent('StartBuild')).toHaveLength(1);
    expect(f.sent('StopBuild')).toEqual([]);
  });
});

describe('check command relocation', () => {
  it('moves project paths to the job root and leaves other words alone', async () => {
    const f = fixture();
    await f.api.check(
      check({
        command: `${PROJECT}/node_modules/.bin/eslint`,
        args: ['--config', `${PROJECT}/eslint.config.js`, PROJECT, `${PROJECT}-other/x`, 'src'],
        cwd: `${PROJECT}/packages/app`,
        input: Buffer.from('stdin bytes'),
        timeoutMs: 900_000,
      }),
    );
    const root = `${NATIVE_ENGINE_JOB_ROOT}/project`;
    const job = f.input([...f.jobs.keys()][0]);
    expect(job.command).toEqual({
      command: `${root}/node_modules/.bin/eslint`,
      args: ['--config', `${root}/eslint.config.js`, root, `${PROJECT}-other/x`, 'src'],
      cwd: `${root}/packages/app`,
      input: Buffer.from('stdin bytes').toString('base64'),
      timeoutMs: 600_000,
      pinnedTool: null,
    });
    expect(() => nativeEngineJob(job)).not.toThrow();
  });

  it('defaults the timeout and ships the pinned archive only for a pinned sensor', async () => {
    const f = fixture();
    await f.api.check(check({ pinnedTool: 'tools/aidlc-sensor-linter.ts' }));
    const job = f.input([...f.jobs.keys()][0]);
    expect(job.command).toMatchObject({
      cwd: `${NATIVE_ENGINE_JOB_ROOT}/project`,
      input: null,
      timeoutMs: 120_000,
      pinnedTool: 'tools/aidlc-sensor-linter.ts',
    });
    expect(job.archive).toBe(Buffer.from('pinned engine archive').toString('base64'));
    expect(job.harness).toBe('codex');
    expect(() => nativeEngineJob(job)).not.toThrow();
  });

  it.each([
    ['another directory', '/etc'],
    ['the parent of the project', '/var/engine/workspace'],
    ['the job root that holds the job input', NATIVE_ENGINE_JOB_ROOT],
    ['a sibling sharing the project prefix', `${NATIVE_ENGINE_JOB_ROOT}/project-private`],
    ['an unrelocated sibling of the project', `${PROJECT}-private`],
  ])('refuses a working directory in %s', async (_label, cwd) => {
    const f = fixture();
    await expect(f.api.check(check({ cwd }))).rejects.toMatchObject(
      code('NATIVE_ENGINE_JOB_INVALID'),
    );
    expect(f.transitions).toEqual([]);
    expect(f.s3.send).not.toHaveBeenCalled();
    expect(f.codebuild.send).not.toHaveBeenCalled();
  });

  it.each([`${PROJECT}/../home`, `${PROJECT}/src/../../..`])(
    'refuses a working directory that leaves the project through %s',
    async (cwd) => {
      const f = fixture();
      await expect(f.api.check(check({ cwd }))).rejects.toMatchObject(
        code('NATIVE_ENGINE_JOB_INVALID'),
      );
      expect(f.codebuild.send).not.toHaveBeenCalled();
    },
  );
});

describe('lost StartBuild acknowledgement', () => {
  it.each([
    [
      'a failed request',
      () => {
        throw Object.assign(new Error('socket closed'), { name: 'TimeoutError' });
      },
    ],
    ['a response without a build', () => ({})],
    ['a build without an ID', () => ({ build: {} })],
    ['a build in another project', () => ({ build: { id: `other-project:${randomUUID()}` } })],
  ])('records %s as uncertain and never retries', async (_label, start) => {
    const f = fixture();
    f.start = start;
    await expect(f.api.check(check())).rejects.toMatchObject(code('NATIVE_ENGINE_JOB_UNCERTAIN'));
    expect(f.transitions).toEqual(['prepared', 'uncertain']);
    expect(f.sent('StartBuild')).toHaveLength(1);
    expect(f.sent('BatchGetBuilds')).toEqual([]);
    expect(f.resultReads()).toEqual([]);
    const [job] = [...f.jobs.values()];
    expect(job).not.toHaveProperty('observation');
    expect(job).not.toHaveProperty('buildId');
  });
});

describe('observed build identity', () => {
  it.each([
    ['build ID', (build) => ({ ...build, id: `${JOB_PROJECT}:${randomUUID()}` })],
    ['project', (build) => ({ ...build, projectName: 'another-project' })],
    ['role', (build) => ({ ...build, serviceRole: `${CHECK_ROLE}-admin` })],
    [
      'image',
      (build) => ({
        ...build,
        environment: { ...build.environment, image: IMAGE.replaceAll('b', 'c') },
      }),
    ],
    [
      'privileged mode',
      (build) => ({ ...build, environment: { ...build.environment, privilegedMode: true } }),
    ],
    [
      'environment type',
      (build) => ({ ...build, environment: { ...build.environment, type: 'LINUX_CONTAINER' } }),
    ],
    [
      'source type',
      (build) => ({ ...build, source: { ...build.source, type: 'GITHUB', location: 'x/y' } }),
    ],
    [
      'buildspec',
      (build) => ({ ...build, source: { ...build.source, buildspec: 'version: 0.2\n' } }),
    ],
    ['artifacts', (build) => ({ ...build, artifacts: { location: 'arn:aws:s3:::other/out' } })],
    [
      'secondary artifacts',
      (build) => ({ ...build, secondaryArtifacts: [{ location: 'arn:aws:s3:::other/out' }] }),
    ],
  ])('rejects a build with a different %s before reading any result', async (_label, change) => {
    const f = fixture();
    f.build = change;
    await expect(f.api.check(check())).rejects.toMatchObject(code('NATIVE_ENGINE_JOB_MISMATCH'));
    expect(f.transitions).toEqual(['prepared', 'running']);
    expect(f.resultReads()).toEqual([]);
    expect(f.sent('StartBuild')).toHaveLength(1);
  });

  it.each([
    ['no build', (id) => ({ builds: [], buildsNotFound: [id] })],
    ['no build list', () => ({})],
    ['an ambiguous build list', (id) => ({ builds: [{ id }, { id }], buildsNotFound: [] })],
  ])('treats %s as unavailable', async (_label, response) => {
    const f = fixture();
    f.poll = ({ ids }) => response(ids[0]);
    await expect(f.api.check(check())).rejects.toMatchObject(code('NATIVE_ENGINE_JOB_UNAVAILABLE'));
    expect(f.transitions).toEqual(['prepared', 'running']);
    expect(f.resultReads()).toEqual([]);
    expect(f.sent('StartBuild')).toHaveLength(1);
  });
});

describe('job result against the CodeBuild outcome', () => {
  const phases = (change) => (build) => ({
    ...build,
    phases: build.phases.flatMap((phase) => (phase.phaseType === 'BUILD' ? change(phase) : phase)),
  });
  it.each([
    ['the build failed', { build: (build) => ({ ...build, buildStatus: 'FAILED' }) }],
    ['the build timed out', { build: (build) => ({ ...build, buildStatus: 'TIMED_OUT' }) }],
    ['the build was stopped', { build: (build) => ({ ...build, buildStatus: 'STOPPED' }) }],
    ['the BUILD phase failed', { build: phases((phase) => ({ ...phase, phaseStatus: 'FAILED' })) }],
    ['the wrapper timed out', { result: { timedOut: true } }],
    ['cleanup did not complete', { result: { cleanupComplete: false } }],
  ])('never reports exit 0 as passing when %s', async (_label, { build, result }) => {
    const f = fixture();
    const produce = f.result;
    if (build) f.build = build;
    if (result) f.result = (job) => ({ ...produce(job), ...result });
    await expect(f.api.check(check())).rejects.toMatchObject(
      code('NATIVE_ENGINE_JOB_RESULT_INVALID'),
    );
    expect(f.transitions).toEqual(['prepared', 'running']);
    expect([...f.jobs.values()][0]).not.toHaveProperty('observation');
  });

  it.each([
    ['is absent', phases(() => [])],
    ['is duplicated', phases((phase) => [phase, phase])],
    ['has no duration', phases(({ durationInSeconds: _duration, ...phase }) => phase)],
    ['has a negative duration', phases((phase) => ({ ...phase, durationInSeconds: -1 }))],
  ])('requires one measured BUILD phase: rejected when it %s', async (_label, build) => {
    const f = fixture();
    f.build = build;
    await expect(f.api.check(check())).rejects.toMatchObject(
      code('NATIVE_ENGINE_JOB_RESULT_INVALID'),
    );
    expect(f.transitions).toEqual(['prepared', 'running']);
  });

  it('returns a genuinely failing check as a failing observation', async () => {
    const passing = fixture();
    const passed = await passing.api.check(check());

    const f = fixture();
    const produce = f.result;
    f.result = (job) => ({ ...produce(job), exitCode: 2, stdout: '', stderr: '1 problem\n' });
    f.build = (build) => ({
      ...build,
      buildStatus: 'FAILED',
      phases: [{ phaseType: 'BUILD', phaseStatus: 'FAILED', durationInSeconds: 3 }],
    });
    const failed = await f.api.check(check());
    expect(failed.exitCode).toBe(2);
    expect(failed.stderr).toEqual(Buffer.from('1 problem\n'));
    expect(failed.nativeExecutionMs).toBe(3000);
    expect(failed.observation).toMatchObject({
      kind: 'check',
      buildId: f.started[0].id,
      buildStatus: 'FAILED',
      stderrSha256: engineDigest('1 problem\n'),
    });
    expect(f.transitions).toEqual(['prepared', 'running', 'finished']);
    expect([passed.exitCode, passed.observation.buildStatus]).toEqual([0, 'SUCCEEDED']);
    expect(failed.observation.stderrSha256).not.toBe(passed.observation.stderrSha256);
    expect(f.sent('StopBuild')).toEqual([]);
  });

  it.each([
    ['another job', { jobId: randomUUID() }],
    ['other files', { filesSha256: 'e'.repeat(64) }],
    ['another producer', { producerSha256: 'f'.repeat(64) }],
    ['another kind of job', { kind: 'review' }],
    ['an older schema', { schemaVersion: 0 }],
    ['a non-integer exit code', { exitCode: '0' }],
    ['an unknown cleanup state', { cleanupComplete: undefined }],
  ])('rejects a result for %s', async (_label, change) => {
    const f = fixture();
    const produce = f.result;
    f.result = (job) => ({ ...produce(job), ...change });
    await expect(f.api.check(check())).rejects.toMatchObject(
      code('NATIVE_ENGINE_JOB_RESULT_INVALID'),
    );
    expect(f.transitions).toEqual(['prepared', 'running']);
    expect(f.sent('StartBuild')).toHaveLength(1);
  });

  it('does not accept a completed build that published no result', async () => {
    const f = fixture();
    f.result = () => null;
    await expect(f.api.check(check())).rejects.toBeDefined();
    expect(f.transitions).toEqual(['prepared', 'running']);
    expect(f.sent('StartBuild')).toHaveLength(1);
  });
});

describe('cancellation and limits', () => {
  const running = (build) => ({ ...build, buildComplete: false, buildStatus: 'IN_PROGRESS' });
  it.each([
    [
      'the operation is cancelled',
      (f) => {
        f.build = (build) => {
          f.controller.abort();
          return running(build);
        };
      },
      'NATIVE_ENGINE_CANCELLED',
    ],
    [
      'the wait is interrupted',
      (f) => {
        f.build = running;
        f.wait.mockRejectedValue(Object.assign(new Error('aborted'), code('ABORT_ERR')));
      },
      'ABORT_ERR',
    ],
    [
      'the build can no longer be observed',
      (f) => {
        f.poll = () => {
          throw Object.assign(new Error('throttled'), code('THROTTLED'));
        };
      },
      'THROTTLED',
    ],
    [
      'authority is revoked while it runs',
      (f) => {
        f.build = running;
        f.authorize
          .mockResolvedValueOnce()
          .mockResolvedValueOnce()
          .mockRejectedValue(Object.assign(new Error('revoked'), code('REVOKED')));
      },
      'REVOKED',
    ],
  ])('stops exactly its own build when %s', async (_label, arrange, expected) => {
    const f = fixture();
    arrange(f);
    await expect(f.api.check(check())).rejects.toMatchObject(code(expected));
    expect(f.sent('StopBuild')).toEqual([{ id: f.started[0].id }]);
    expect(f.sent('StartBuild')).toHaveLength(1);
    expect(f.transitions).toEqual(['prepared', 'running']);
    expect(f.resultReads()).toEqual([]);
  });

  it('keeps the original failure when the stop request itself fails', async () => {
    const f = fixture();
    f.build = (build) => {
      f.controller.abort();
      return running(build);
    };
    const send = f.codebuild.send.getMockImplementation();
    f.codebuild.send.mockImplementation(async (command, options) => {
      if (command.constructor.name === 'StopBuildCommand') throw new Error('stop unavailable');
      return send(command, options);
    });
    await expect(f.api.check(check())).rejects.toMatchObject(code('NATIVE_ENGINE_CANCELLED'));
    expect(f.sent('StartBuild')).toHaveLength(1);
  });

  it('launches nothing once the operation is already cancelled', async () => {
    const f = fixture();
    f.controller.abort();
    await expect(f.api.check(check())).rejects.toBeDefined();
    await expect(f.api.review(review())).rejects.toBeDefined();
    expect(f.codebuild.send).not.toHaveBeenCalled();
    expect(f.transitions).toEqual([]);
  });

  it('allows at most 16 jobs in one operation', async () => {
    const f = fixture();
    for (let index = 0; index < 16; index++) await f.api.check(check());
    await expect(f.api.check(check())).rejects.toMatchObject(code('NATIVE_ENGINE_JOB_LIMIT'));
    await expect(f.api.review(review())).rejects.toMatchObject(code('NATIVE_ENGINE_JOB_LIMIT'));
    expect(f.sent('StartBuild')).toHaveLength(16);
    expect(new Set(f.sent('StartBuild').map((start) => start.idempotencyToken)).size).toBe(16);
    expect(f.jobs.size).toBe(16);
  });
});

describe('isolated reviewer invocation', () => {
  it('runs under the reviewer role with a model credential boundary and nothing else', async () => {
    const f = fixture();
    const result = await f.api.review(review());
    expect(f.reviewRole).toHaveBeenCalledTimes(1);
    expect(f.reviewRole).toHaveBeenCalledWith(f.identity);
    const [start, ...others] = f.sent('StartBuild');
    expect(others).toEqual([]);
    expect(start.serviceRoleOverride).toBe(f.reviewAccess.roleArn);
    expect(start.serviceRoleOverride).not.toBe(CHECK_ROLE);
    expect(start).toMatchObject({
      sourceTypeOverride: 'NO_SOURCE',
      artifactsOverride: { type: 'NO_ARTIFACTS' },
      privilegedModeOverride: false,
      buildspecOverride: NATIVE_ENGINE_JOB_BUILD_SPEC,
      imageOverride: IMAGE,
    });
    expect(start.environmentVariablesOverride.map((variable) => variable.name)).toEqual([
      'NATIVE_WORKFLOW_JOB_INPUT',
      'NATIVE_WORKFLOW_JOB_INPUT_SHA256',
      'NATIVE_WORKFLOW_JOB_OUTPUT',
    ]);

    const [jobId] = [...f.jobs.keys()];
    const job = f.input(jobId);
    expect(Object.keys(job).toSorted()).toEqual(
      [
        'schemaVersion',
        'profileId',
        'producerSha256',
        'jobId',
        'kind',
        'files',
        'filesSha256',
        'instructions',
        'prompt',
        'harness',
        'model',
        'credentialAlias',
        'credentialScope',
      ].toSorted(),
    );
    expect(nativeEngineJob(job)).toMatchObject({
      kind: 'review',
      harness: 'codex',
      model: 'provider.model-v1:0',
      instructions: 'Independent reviewer persona',
      prompt: 'Stage: code-generation',
      credentialAlias: f.reviewAccess.credentialAlias,
      credentialScope: {
        projectId: f.identity.projectId,
        executionId: f.identity.executionId,
        attemptId: f.identity.attemptId,
        epoch: 1,
      },
    });
    expect(Object.keys(job.credentialScope).toSorted()).toEqual([
      'attemptId',
      'epoch',
      'executionId',
      'projectId',
    ]);
    expect(job.files.map((file) => file.path)).toEqual(['src/main.js']);
    const exposed = JSON.stringify([job, start]);
    expect(exposed).not.toContain(GIT_SECRET);
    expect(exposed).not.toContain(ENGINE_SECRET);
    expect(exposed).not.toContain('d'.repeat(64));

    expect(result).toMatchObject({
      exitCode: 0,
      review: '**Verdict:** READY\n',
      reviewSha256: engineDigest('**Verdict:** READY\n'),
      nativeSessionId: 'reviewer-session',
      observation: {
        kind: 'review',
        jobId,
        buildId: f.started[0].id,
        roleArn: f.reviewAccess.roleArn,
        buildStatus: 'SUCCEEDED',
      },
    });
    expect(f.jobs.get(jobId)).toMatchObject({
      status: 'finished',
      kind: 'review',
      roleArn: f.reviewAccess.roleArn,
    });
  });

  it('starts no job when the reviewer role cannot be verified', async () => {
    const f = fixture();
    f.reviewRole.mockRejectedValue(
      Object.assign(new Error('mismatch'), code('NATIVE_ENGINE_REVIEW_ROLE_MISMATCH')),
    );
    await expect(f.api.review(review())).rejects.toMatchObject(
      code('NATIVE_ENGINE_REVIEW_ROLE_MISMATCH'),
    );
    expect(f.codebuild.send).not.toHaveBeenCalled();
    expect(f.transitions).toEqual([]);
  });

  it.each([
    ['review text that does not match its digest', { reviewSha256: engineDigest('other') }],
    ['an empty review', { review: ' \n', reviewSha256: engineDigest(' \n') }],
    ['no reviewer session', { nativeSessionId: '' }],
  ])('rejects a successful review result with %s', async (_label, change) => {
    const f = fixture();
    const produce = f.result;
    f.result = (job) => ({ ...produce(job), ...change });
    await expect(f.api.review(review())).rejects.toMatchObject(
      code('NATIVE_ENGINE_JOB_RESULT_INVALID'),
    );
    expect(f.transitions).toEqual(['prepared', 'running']);
  });
});
