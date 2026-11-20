import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { nativeGitDeltaSha256 } from '../../shared/native-git-change-set.js';
import { runNativeCommand } from '../native/command-runner.js';
import { createNativeEngineJobRunner } from '../native/workflow-job.mjs';
import {
  NATIVE_ENGINE_JOB_BUILD_SPEC,
  NATIVE_ENGINE_JOB_ENTRY,
  NATIVE_ENGINE_JOB_ROOT,
  nativeEngineJob,
  nativeEngineJobResult,
} from '../../shared/native-workflow-job.js';
import {
  NATIVE_ENGINE_PROFILE,
  encodeNativeEngineFiles,
  nativeEngineFileDigest,
  nativeReviewerAlias,
} from '../../shared/native-workflow-protocol.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const functionArn = 'arn:aws:lambda:us-east-1:123456789012:function:native-execution-credentials';
const files = encodeNativeEngineFiles([
  { path: 'src/app.ts', content: Buffer.from('export const value = 1;\n') },
  { path: 'package.json', content: Buffer.from('{}\n') },
]);
const base = () => ({
  schemaVersion: 1,
  jobId: randomUUID(),
  producerSha256: 'a'.repeat(64),
  filesSha256: nativeEngineFileDigest(files),
  profileId: NATIVE_ENGINE_PROFILE.id,
  files: structuredClone(files),
});
const checkJob = (command = {}, overrides = {}) => ({
  ...base(),
  kind: 'check',
  harness: 'codex',
  command: {
    command: '/usr/bin/npm',
    args: ['test'],
    cwd: `${NATIVE_ENGINE_JOB_ROOT}/project`,
    timeoutMs: 120_000,
    input: null,
    pinnedTool: null,
    ...command,
  },
  ...overrides,
});
const reviewJob = (overrides = {}) => ({
  ...base(),
  kind: 'review',
  harness: 'claude',
  model: null,
  instructions: 'Review the submitted artifact independently.',
  prompt: 'Review requirements.md and write review-output/review.md.',
  credentialAlias: `${functionArn}:review_${'b'.repeat(32)}`,
  credentialScope: {
    projectId: randomUUID(),
    executionId: randomUUID(),
    attemptId: randomUUID(),
    epoch: 1,
  },
  ...overrides,
});
const gitReviewJob = () => {
  const beforeFiles = encodeNativeEngineFiles([
    { path: 'run.sh', mode: '100644', content: Buffer.from('run') },
    { path: 'removed.bin', mode: '100755', content: Buffer.from([0, 255]) },
  ]);
  const afterFiles = [{ ...beforeFiles[0], mode: '100755' }];
  const version = ({ mode, bytes, sha256 }) => ({ mode, bytes, sha256 });
  const gitDelta = {
    repository: {
      provider: 'github',
      repository: 'owner/repo',
      branch: 'main',
      commit: 'c'.repeat(40),
    },
    sourceBaseline: { id: 'a'.repeat(64), epoch: 1, versionId: 'retained' },
    changes: [
      { path: 'removed.bin', before: version(beforeFiles[1]), after: null },
      { path: 'run.sh', before: version(beforeFiles[0]), after: version(afterFiles[0]) },
    ],
  };
  return reviewJob({
    harness: 'codex',
    files: afterFiles,
    filesSha256: nativeEngineFileDigest(afterFiles),
    beforeFiles,
    gitDelta,
  });
};
const invalidJob = (value) =>
  expect(() => nativeEngineJob(value)).toThrow(
    expect.objectContaining({ code: expect.stringMatching(/^NATIVE_ENGINE_/) }),
  );

// The observer path needs a Linux root process holding its capabilities. That
// path is qualified in the runtime image; every other host must fail closed.
const observerCapable = process.platform === 'linux' && process.getuid?.() === 0;

describe.skipIf(observerCapable)('native workflow job entry outside its observer', () => {
  it.each(['prepare', 'run', 'publish'])(
    '%s refuses to run before touching input, commands or output',
    async (phase) => {
      const run = vi.fn();
      const lambda = { send: vi.fn() };
      const fetcher = vi.fn();
      const runner = createNativeEngineJobRunner({ run, lambda, fetcher });
      await expect(
        runner[phase]({
          NATIVE_WORKFLOW_JOB_INPUT: 'https://example.invalid/input',
          NATIVE_WORKFLOW_JOB_INPUT_SHA256: 'a'.repeat(64),
          NATIVE_WORKFLOW_JOB_OUTPUT: 'https://example.invalid/output',
        }),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_JOB_OBSERVER_INVALID' });
      expect(run).not.toHaveBeenCalled();
      expect(lambda.send).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('exposes only the three fixed phases', () => {
    expect(Object.keys(createNativeEngineJobRunner({ lambda: { send: vi.fn() } }))).toEqual([
      'prepare',
      'run',
      'publish',
    ]);
  });
});

describe('native workflow job build specification', () => {
  it('is fixed JSON running exactly the three job phases as root', () => {
    expect(typeof NATIVE_ENGINE_JOB_BUILD_SPEC).toBe('string');
    expect(NATIVE_ENGINE_JOB_ENTRY).toBe('/opt/agentcore/native/workflow-job.mjs');
    expect(JSON.parse(NATIVE_ENGINE_JOB_BUILD_SPEC)).toStrictEqual({
      version: '0.2',
      'run-as': 'root',
      phases: {
        pre_build: {
          commands: ['/usr/local/bin/node /opt/agentcore/native/workflow-job.mjs prepare'],
        },
        build: { commands: ['/usr/local/bin/node /opt/agentcore/native/workflow-job.mjs run'] },
        post_build: {
          commands: ['/usr/local/bin/node /opt/agentcore/native/workflow-job.mjs publish'],
        },
      },
    });
    // Compared byte for byte with the build that CodeBuild reports.
    expect(NATIVE_ENGINE_JOB_BUILD_SPEC).toBe(
      JSON.stringify(JSON.parse(NATIVE_ENGINE_JOB_BUILD_SPEC)),
    );
  });
});

describe('native workflow job contract', () => {
  it('rejects a delta that describes different materialized files and a result for another delta', () => {
    const job = gitReviewJob();
    expect(nativeEngineJob(job).beforeFiles).toHaveLength(2);
    for (const mutate of [
      (candidate) => {
        candidate.files[0].mode = '100644';
      },
      (candidate) => {
        candidate.beforeFiles.pop();
      },
      (candidate) => {
        candidate.gitDelta.changes[0].after = candidate.gitDelta.changes[0].before;
      },
      (candidate) => {
        candidate.gitDelta.changes.reverse();
      },
      (candidate) => {
        candidate.gitDelta.repository.commit = 'main';
      },
    ]) {
      const value = structuredClone(job);
      mutate(value);
      invalidJob(value);
    }
    const review = '**Verdict:** READY';
    const result = {
      schemaVersion: 1,
      jobId: job.jobId,
      kind: 'review',
      filesSha256: job.filesSha256,
      producerSha256: job.producerSha256,
      exitCode: 0,
      timedOut: false,
      cleanupComplete: true,
      stdout: '',
      stderr: '',
      review,
      reviewSha256: sha(review),
      nativeSessionId: 'fixture',
    };
    expect(() => nativeEngineJobResult(result, job)).toThrow('NATIVE_ENGINE_JOB_RESULT_INVALID');
    expect(() => nativeEngineJobResult({ ...result, gitSha256: 'b'.repeat(64) }, job)).toThrow(
      'NATIVE_ENGINE_JOB_RESULT_INVALID',
    );
  });
  it('accepts a check job and returns its verified file bytes', () => {
    const value = checkJob();
    const job = nativeEngineJob(value);
    expect(job).toMatchObject({ kind: 'check', jobId: value.jobId, command: value.command });
    expect(job.files.map(({ path, content }) => [path, content.toString()])).toEqual([
      ['package.json', '{}\n'],
      ['src/app.ts', 'export const value = 1;\n'],
    ]);
    expect(Buffer.isBuffer(job.files[0].content)).toBe(true);
    // The caller's value is not shared with the accepted job.
    value.command.args.push('--changed');
    expect(job.command.args).toEqual(['test']);
  });

  it.each(['tools/aidlc-sensor-linter.ts', 'tools/aidlc-sensor-type-check.ts'])(
    'accepts the pinned sensor %s',
    (pinnedTool) => {
      expect(nativeEngineJob(checkJob({ pinnedTool })).command.pinnedTool).toBe(pinnedTool);
    },
  );

  it('accepts a review job addressed to the reviewer credential alias', () => {
    const identity = {
      projectId: randomUUID(),
      executionId: randomUUID(),
      bindingId: randomUUID(),
    };
    const alias = `${functionArn}:${nativeReviewerAlias(identity)}`;
    expect(alias).toMatch(/:review_[a-f0-9]{32}$/);
    const job = nativeEngineJob(reviewJob({ credentialAlias: alias, model: 'configured-model' }));
    expect(job).toMatchObject({
      kind: 'review',
      harness: 'claude',
      credentialAlias: alias,
      model: 'configured-model',
    });
    expect(nativeEngineJob(reviewJob()).model).toBeNull();
  });

  it.each([
    ['nothing', () => null],
    ['an unsupported schema', () => checkJob({}, { schemaVersion: 2 })],
    ['an unknown kind', () => checkJob({}, { kind: 'publish' })],
    ['a malformed job identity', () => checkJob({}, { jobId: 'job-1' })],
    ['a malformed producer digest', () => checkJob({}, { producerSha256: 'A'.repeat(64) })],
    ['another profile', () => checkJob({}, { profileId: 'aidlc-2.11.0-native-1' })],
    ['no profile', () => checkJob({}, { profileId: undefined })],
    ['a files digest for other files', () => checkJob({}, { filesSha256: sha('other files') })],
    [
      'files that differ from their digest',
      () =>
        checkJob(
          {},
          { files: encodeNativeEngineFiles([{ path: 'x', content: Buffer.from('x') }]) },
        ),
    ],
    [
      'a file whose bytes differ from its own digest',
      () => {
        const job = checkJob();
        job.files[0].content = Buffer.from('changed').toString('base64');
        return job;
      },
    ],
    [
      'a file outside the project',
      () => {
        const escaped = [{ ...files[0], path: '../escape.ts' }, files[1]];
        return checkJob({}, { files: escaped, filesSha256: nativeEngineFileDigest(escaped) });
      },
    ],
    ['no command', () => checkJob({}, { command: undefined })],
    ['an empty command', () => checkJob({ command: '' })],
    ['arguments that are not a list', () => checkJob({ args: 'test' })],
    ['a non-text argument', () => checkJob({ args: ['test', 1] })],
    ['an argument containing a NUL byte', () => checkJob({ args: ['te\0st'] })],
    ['no working directory', () => checkJob({ cwd: undefined })],
    ['a zero timeout', () => checkJob({ timeoutMs: 0 })],
    ['a negative timeout', () => checkJob({ timeoutMs: -1 })],
    ['a timeout above ten minutes', () => checkJob({ timeoutMs: 600_001 })],
    ['a fractional timeout', () => checkJob({ timeoutMs: 1.5 })],
    ['a textual timeout', () => checkJob({ timeoutMs: '1000' })],
    ['an unspecified input', () => checkJob({ input: undefined })],
    ['an unspecified pinned tool', () => checkJob({ pinnedTool: undefined })],
    ['another pinned tool', () => checkJob({ pinnedTool: 'tools/aidlc-sensor-other.ts' })],
    [
      'a pinned tool reached by traversal',
      () => checkJob({ pinnedTool: 'tools/../tools/aidlc-sensor-linter.ts' }),
    ],
    ['an absolute pinned tool', () => checkJob({ pinnedTool: '/tmp/aidlc-sensor-linter.ts' })],
  ])('rejects a check job with %s', (_name, value) => {
    invalidJob(value());
  });

  it.each([1, 600_000])('accepts the timeout bound %d', (timeoutMs) => {
    expect(nativeEngineJob(checkJob({ timeoutMs })).command.timeoutMs).toBe(timeoutMs);
  });

  it.each([
    ['the writer alias', `${functionArn}:native_${'b'.repeat(32)}`],
    ['an unqualified function', functionArn],
    ['the unpublished version', `${functionArn}:$LATEST`],
    ['a numbered version', `${functionArn}:7`],
    ['a short reviewer alias', `${functionArn}:review_${'b'.repeat(31)}`],
    ['a long reviewer alias', `${functionArn}:review_${'b'.repeat(33)}`],
    ['an uppercase reviewer alias', `${functionArn}:review_${'B'.repeat(32)}`],
    ['a bare alias name', `review_${'b'.repeat(32)}`],
    ['another service', `arn:aws:iam::123456789012:role/review_${'b'.repeat(32)}`],
    ['no alias', undefined],
  ])('rejects a review job addressed to %s', (_name, credentialAlias) => {
    invalidJob(reviewJob({ credentialAlias }));
  });

  it.each([
    ['empty instructions', { instructions: '' }],
    ['blank instructions', { instructions: ' \n\t' }],
    ['no instructions', { instructions: undefined }],
    ['oversized instructions', { instructions: 'x'.repeat(64 * 1024 + 1) }],
    ['an empty prompt', { prompt: '' }],
    ['a blank prompt', { prompt: '   ' }],
    ['a prompt containing a NUL byte', { prompt: 'review\0' }],
    ['the unqualified kiro harness', { harness: 'kiro' }],
    ['an unknown harness', { harness: 'shell' }],
    ['no harness', { harness: undefined }],
    ['a non-text model', { model: 7 }],
    ['an unspecified model', { model: undefined }],
    ['another profile', { profileId: 'other' }],
    ['a files digest for other files', { filesSha256: sha('other files') }],
  ])('rejects a review job with %s', (_name, overrides) => {
    invalidJob(reviewJob(overrides));
  });

  it.each(NATIVE_ENGINE_PROFILE.harnesses)('accepts the %s reviewer harness', (harness) => {
    expect(nativeEngineJob(reviewJob({ harness })).harness).toBe(harness);
  });
});

describe('native workflow job result contract', () => {
  const check = nativeEngineJob(checkJob());
  const review = nativeEngineJob(reviewJob());
  const result = (job, overrides = {}) => ({
    schemaVersion: 1,
    kind: job.kind,
    jobId: job.jobId,
    filesSha256: job.filesSha256,
    producerSha256: job.producerSha256,
    exitCode: 0,
    timedOut: false,
    cleanupComplete: true,
    stdout: 'passed\n',
    stderr: '',
    ...overrides,
  });
  const reviewed = (overrides = {}) =>
    result(review, {
      stdout: 'Review written.',
      review: '# Review\n\nNo blocking findings.\n',
      reviewSha256: sha('# Review\n\nNo blocking findings.\n'),
      nativeSessionId: 'reviewer-session',
      ...overrides,
    });
  const invalid = (value, job) =>
    expect(() => nativeEngineJobResult(value, job)).toThrow(
      expect.objectContaining({ code: 'NATIVE_ENGINE_JOB_RESULT_INVALID' }),
    );

  it('accepts a check observation, including a failed or timed out one', () => {
    expect(nativeEngineJobResult(result(check), check)).toEqual(result(check));
    const failed = result(check, { exitCode: 2, stderr: 'lint failed\n' });
    expect(nativeEngineJobResult(failed, check)).toEqual(failed);
    const timedOut = result(check, { exitCode: 125, timedOut: true, cleanupComplete: false });
    expect(nativeEngineJobResult(timedOut, check)).toEqual(timedOut);
  });

  it('accepts a review with its text, digest and reviewer session', () => {
    expect(nativeEngineJobResult(reviewed(), review)).toEqual(reviewed());
  });

  it('accepts a failed review that carries no review text', () => {
    const failed = result(review, { exitCode: 1, stdout: '', stderr: '' });
    expect(nativeEngineJobResult(failed, review)).toEqual(failed);
  });

  it.each([
    ['nothing', () => null],
    ['an unsupported schema', () => result(check, { schemaVersion: 2 })],
    ['another job', () => result(check, { jobId: randomUUID() })],
    ['another kind', () => result(check, { kind: 'review' })],
    ['another files digest', () => result(check, { filesSha256: sha('other files') })],
    ['another producer', () => result(check, { producerSha256: 'b'.repeat(64) })],
    ['a textual timeout flag', () => result(check, { timedOut: 'false' })],
    ['no timeout flag', () => result(check, { timedOut: undefined })],
    ['a numeric cleanup flag', () => result(check, { cleanupComplete: 1 })],
    ['no cleanup flag', () => result(check, { cleanupComplete: undefined })],
    ['a textual exit code', () => result(check, { exitCode: '0' })],
    ['no exit code', () => result(check, { exitCode: null })],
    ['a negative exit code', () => result(check, { exitCode: -1 })],
    ['an exit code above 255', () => result(check, { exitCode: 256 })],
    ['non-text standard output', () => result(check, { stdout: null })],
    ['non-text standard error', () => result(check, { stderr: undefined })],
    ['oversized standard error', () => result(check, { stderr: 'x'.repeat(1024 * 1024 + 1) })],
  ])('rejects a check result with %s', (_name, value) => {
    invalid(value(), check);
  });

  it('rejects the result of one job for another job', () => {
    invalid(result(check), nativeEngineJob(checkJob()));
    invalid(reviewed(), check);
    invalid(result(check), review);
  });

  it.each([
    ['no review text', { review: undefined }],
    ['blank review text', { review: ' \n', reviewSha256: sha(' \n') }],
    ['non-text review', { review: { verdict: 'approved' } }],
    ['a digest of other review text', { reviewSha256: sha('# Review\n\nApproved.\n') }],
    ['no review digest', { reviewSha256: undefined }],
    ['a malformed review digest', { reviewSha256: 'not-a-digest' }],
    ['no reviewer session', { nativeSessionId: undefined }],
    ['an empty reviewer session', { nativeSessionId: '' }],
  ])('rejects a successful review with %s', (_name, overrides) => {
    invalid(reviewed(overrides), review);
  });
});

// The remaining contract needs a real observer: Linux, root and the four
// capabilities the wrapper checks for. It runs wherever the suite is executed
// that way and is exercised in the built image by the installed qualification.
const observer = (() => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return false;
  const effective = /CapEff:\s*([a-f0-9]+)/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1];
  const required = 1n | (1n << 6n) | (1n << 7n) | (1n << 8n);
  return Boolean(effective) && (BigInt(`0x${effective}`) & required) === required;
})();

describe.runIf(observer)('isolated reviewer on a Linux observer', () => {
  it('lets a separate reviewer inspect the root-owned executable and deleted bytes and returns their observed delta', async () => {
    const job = gitReviewJob();
    const input = gzipSync(Buffer.from(JSON.stringify(job)));
    const inspect = `
      const fs = require('node:fs'); const assert = require('node:assert/strict');
      const root = ${JSON.stringify(NATIVE_ENGINE_JOB_ROOT)};
      assert.equal(process.getuid(),1000);
      const delta = JSON.parse(fs.readFileSync(root+'/git-changes.json'));
      assert.equal(delta.changes[0].after,null);
      assert.equal(fs.existsSync(root+'/project/removed.bin'),false);
      assert.deepEqual(fs.readFileSync(root+'/before/removed.bin'),Buffer.from([0,255]));
      assert.ok(fs.statSync(root+'/project/run.sh').mode & 0o100);
      assert.equal(fs.statSync(root+'/before/run.sh').mode & 0o100,0);
      assert.throws(()=>fs.writeFileSync(root+'/project/run.sh','replacement'),{code:'EACCES'});
      fs.writeFileSync(root+'/review-output/review.md','**Verdict:** READY');
      for (const event of [{type:'thread.started',thread_id:'offline-review'},{type:'turn.started'},
        {type:'item.completed',item:{id:'m',type:'agent_message',text:'Review written.'}},{type:'turn.completed',usage:{}}]) console.log(JSON.stringify(event));`;
    const runner = createNativeEngineJobRunner({
      fetcher: async () => new Response(input),
      lambda: {
        send: async () => ({
          Payload: Buffer.from(
            JSON.stringify({
              ok: true,
              ...job.credentialScope,
              model: { value: 'fixture-model-value' },
            }),
          ),
        }),
      },
      run: (invocation) =>
        runNativeCommand({
          ...invocation,
          args: [
            ...invocation.args.slice(0, invocation.args.indexOf('--') + 1),
            process.execPath,
            '-e',
            inspect,
          ],
        }),
    });
    await runner.prepare({
      NATIVE_WORKFLOW_JOB_INPUT: 'fixture',
      NATIVE_WORKFLOW_JOB_INPUT_SHA256: sha(input),
    });
    expect(await runner.run()).toMatchObject({
      exitCode: 0,
      gitSha256: nativeGitDeltaSha256(job.gitDelta),
      nativeSessionId: 'offline-review',
      review: '**Verdict:** READY',
    });
  });
  // Codex and OpenCode take their instructions from files in the reviewer's
  // home. Those files are written by the observer and require the home to be
  // observer-private at that moment; it is handed to the worker afterwards.
  it.each(['codex', 'opencode'])(
    'writes the %s instruction transport before handing the home to the worker',
    async (harness) => {
      const job = { ...reviewJob(), harness };
      const input = gzipSync(Buffer.from(JSON.stringify(job)));
      const fetcher = vi.fn(async () => new Response(input));
      const lambda = {
        send: vi.fn(async () => ({
          Payload: Buffer.from(
            JSON.stringify({
              ok: true,
              ...job.credentialScope,
              model: { provider: 'bedrock', value: 'unit-test-model-credential' },
            }),
          ),
        })),
      };
      const seen = {};
      const run = vi.fn(async (invocation) => {
        const home = `${NATIVE_ENGINE_JOB_ROOT}/home`;
        seen.home = statSync(home);
        seen.files = readdirSync(home, { recursive: true });
        seen.drop = invocation.command;
        return { exitCode: 1, timedOut: false, cleanupComplete: true, stdout: '', stderr: '' };
      });
      const runner = createNativeEngineJobRunner({ run, lambda, fetcher });
      await runner.prepare({
        NATIVE_WORKFLOW_JOB_INPUT: 'https://fixture.invalid/input',
        NATIVE_WORKFLOW_JOB_INPUT_SHA256: sha(input),
      });
      const prepared = statSync(`${NATIVE_ENGINE_JOB_ROOT}/home`);
      expect([prepared.uid, prepared.mode & 0o777]).toEqual([0, 0o700]);
      const result = await runner.run();
      expect(run).toHaveBeenCalledTimes(1);
      expect(seen.drop).toBe('/usr/bin/setpriv');
      expect(seen.home.uid).toBe(1000);
      expect(seen.files.length).toBeGreaterThan(0);
      expect(result).toMatchObject({ kind: 'review', exitCode: 1, stdout: '', stderr: '' });
    },
  );
});
