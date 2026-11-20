import { randomUUID } from 'node:crypto';
import {
  StartBuildCommand,
  BatchGetBuildsCommand,
  StopBuildCommand,
} from '@aws-sdk/client-codebuild';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { setTimeout as delay } from 'node:timers/promises';
import { posix } from 'node:path';
import {
  NATIVE_ENGINE_PROFILE,
  engineFailure,
  engineDigest,
  nativeEngineFileDigest,
  nativeEngineObjectPrefix,
  encodeNativeEngineFiles,
} from '../../shared/native-workflow-protocol.js';
import {
  NATIVE_ENGINE_JOB_BUILD_SPEC,
  NATIVE_ENGINE_JOB_ROOT,
  nativeEngineJobResult,
  nativeEngineJobSha,
} from '../../shared/native-workflow-job.js';

const terminal = new Set(['SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT']);
const relocation = (value, project) =>
  value === project
    ? `${NATIVE_ENGINE_JOB_ROOT}/project`
    : value.startsWith(`${project}/`)
      ? `${NATIVE_ENGINE_JOB_ROOT}/project/${value.slice(project.length + 1)}`
      : value;
const observedBuild = (build, expected) => {
  if (
    !build ||
    build.id !== expected.id ||
    build.projectName !== expected.projectName ||
    build.serviceRole !== expected.roleArn ||
    build.environment?.image !== expected.image ||
    build.environment?.type !== 'ARM_CONTAINER' ||
    build.environment?.privilegedMode !== false ||
    build.source?.type !== 'NO_SOURCE' ||
    build.source?.buildspec !== NATIVE_ENGINE_JOB_BUILD_SPEC ||
    build.artifacts?.location ||
    build.secondaryArtifacts?.length
  )
    throw engineFailure('NATIVE_ENGINE_JOB_MISMATCH');
  return build;
};

export const createNativeEngineJobs = ({
  codebuild,
  s3,
  objects,
  journal,
  operation,
  row,
  env,
  authorize,
  reviewRole,
  archive,
  workspace,
  signal,
  sign = getSignedUrl,
  wait = delay,
}) => {
  let count = 0;
  const identity = operation.identity;
  const run = async (input, roleArn) => {
    if (++count > 16 || signal.aborted) throw engineFailure('NATIVE_ENGINE_JOB_LIMIT');
    const jobId = randomUUID();
    const job = {
      schemaVersion: 1,
      profileId: NATIVE_ENGINE_PROFILE.id,
      producerSha256: row.configuration.workflowEngine.producerSha256,
      jobId,
      ...input,
      filesSha256: nativeEngineFileDigest(input.files),
      files: encodeNativeEngineFiles(input.files),
    };
    const inputReceipt = await objects.write(identity, jobId, 'input', job, 'job');
    const record = {
      status: 'prepared',
      input: inputReceipt,
      kind: job.kind,
      jobSha256: nativeEngineJobSha(job),
      filesSha256: job.filesSha256,
      roleArn,
      image: row.configuration.image.uri,
    };
    const inputUrl = await sign(
      s3,
      new GetObjectCommand({
        Bucket: row.configuration.publicationBucket,
        Key: inputReceipt.key,
        VersionId: inputReceipt.versionId,
        ExpectedBucketOwner: row.configuration.accountId,
      }),
      { expiresIn: 900 },
    );
    const outputUrl = await sign(
      s3,
      new PutObjectCommand({
        Bucket: row.configuration.publicationBucket,
        Key: `${nativeEngineObjectPrefix(identity, 'job')}${jobId}/result.json.gz`,
        ContentType: 'application/gzip',
        ServerSideEncryption: 'AES256',
      }),
      { expiresIn: 900 },
    );
    const projectName = env.NATIVE_WORKFLOW_JOB_PROJECT;
    const start = {
      projectName,
      idempotencyToken: jobId,
      sourceTypeOverride: 'NO_SOURCE',
      artifactsOverride: { type: 'NO_ARTIFACTS' },
      environmentTypeOverride: 'ARM_CONTAINER',
      imageOverride: record.image,
      imagePullCredentialsTypeOverride: 'SERVICE_ROLE',
      serviceRoleOverride: roleArn,
      computeTypeOverride: 'BUILD_GENERAL1_SMALL',
      privilegedModeOverride: false,
      timeoutInMinutesOverride: 10,
      queuedTimeoutInMinutesOverride: 5,
      buildspecOverride: NATIVE_ENGINE_JOB_BUILD_SPEC,
      environmentVariablesOverride: [
        ['NATIVE_WORKFLOW_JOB_INPUT', inputUrl],
        ['NATIVE_WORKFLOW_JOB_INPUT_SHA256', inputReceipt.sha256],
        ['NATIVE_WORKFLOW_JOB_OUTPUT', outputUrl],
      ].map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })),
      logsConfigOverride: {
        cloudWatchLogs: { status: 'DISABLED' },
        s3Logs: { status: 'DISABLED' },
      },
    };
    await authorize();
    // Admit this unique launch under the operation token immediately before
    // dispatch. Abandonment during capability preparation fences this write.
    await journal.recordJob(operation, jobId, record);
    let buildId;
    try {
      // One attempt only. A lost StartBuild acknowledgement is not retried
      // after AWS's short idempotency window or with a new token.
      const started = await codebuild.send(new StartBuildCommand(start), { abortSignal: signal });
      buildId = started.build?.id;
      if (typeof buildId !== 'string' || !buildId.startsWith(`${projectName}:`))
        throw engineFailure('NATIVE_ENGINE_JOB_UNCERTAIN');
    } catch {
      await journal.recordJob(operation, jobId, { ...record, status: 'uncertain' }, 'prepared');
      throw engineFailure('NATIVE_ENGINE_JOB_UNCERTAIN');
    }
    const running = { ...record, status: 'running', buildId };
    const expected = { id: buildId, projectName, roleArn, image: record.image };
    let build;
    try {
      await journal.recordJob(operation, jobId, running, 'prepared');
      while (true) {
        await authorize();
        const response = await codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }), {
          abortSignal: signal,
        });
        if (response.builds?.length !== 1 || response.buildsNotFound?.length)
          throw engineFailure('NATIVE_ENGINE_JOB_UNAVAILABLE');
        build = observedBuild(response.builds[0], expected);
        if (build.buildComplete === true && terminal.has(build.buildStatus)) break;
        if (signal.aborted) throw engineFailure('NATIVE_ENGINE_CANCELLED');
        await wait(2000, undefined, { signal });
      }
      const captured = await objects.observeJobResult(identity, jobId);
      const result = nativeEngineJobResult(captured.value, job);
      const phase = build.phases?.filter((item) => item.phaseType === 'BUILD');
      if (
        phase?.length !== 1 ||
        !Number.isFinite(phase[0].durationInSeconds) ||
        phase[0].durationInSeconds < 0
      )
        throw engineFailure('NATIVE_ENGINE_JOB_RESULT_INVALID');
      // A job cannot turn a failed wrapper into a passing observed invocation.
      if (
        result.exitCode === 0 &&
        (!result.cleanupComplete ||
          result.timedOut ||
          build.buildStatus !== 'SUCCEEDED' ||
          phase[0].phaseStatus !== 'SUCCEEDED')
      )
        throw engineFailure('NATIVE_ENGINE_JOB_RESULT_INVALID');
      const observation = {
        kind: job.kind,
        jobId,
        buildId,
        image: record.image,
        roleArn,
        input: inputReceipt,
        result: captured.receipt,
        filesSha256: job.filesSha256,
        buildStatus: build.buildStatus,
        executionMs: phase[0].durationInSeconds * 1000,
        stdoutSha256: engineDigest(result.stdout),
        stderrSha256: engineDigest(result.stderr),
      };
      await authorize();
      await journal.recordJob(
        operation,
        jobId,
        { ...running, status: 'finished', observation },
        'running',
      );
      return { ...result, observation, nativeExecutionMs: observation.executionMs };
    } catch (error) {
      // Stopping this exact owned job is safe on cancellation; no replacement
      // is launched. An unknown result remains unknown in the private journal.
      if (!build?.buildComplete) {
        try {
          await codebuild.send(new StopBuildCommand({ id: buildId }), {
            abortSignal: AbortSignal.timeout(5000),
          });
        } catch {
          /* The original ID remains available for operator inspection. */
        }
      }
      throw error;
    }
  };
  return {
    async check(request) {
      const files = await workspace.inspectionFiles();
      const command = {
        command: relocation(request.command, workspace.project),
        args: request.args.map((arg) => relocation(arg, workspace.project)),
        cwd: relocation(request.cwd, workspace.project),
        input: request.input === null ? null : request.input.toString('base64'),
        timeoutMs: Math.min(request.timeoutMs ?? 120_000, 600_000),
        pinnedTool: request.pinnedTool ?? null,
      };
      // Containment is decided on the canonical path. A prefix match alone would
      // admit `project/../home`; the job wrapper refuses that too, but the
      // producer must not start a build for it.
      const jobProject = `${NATIVE_ENGINE_JOB_ROOT}/project`;
      if (
        posix.resolve(command.cwd) !== command.cwd ||
        (command.cwd !== jobProject && !command.cwd.startsWith(`${jobProject}/`))
      )
        throw engineFailure('NATIVE_ENGINE_JOB_INVALID');
      const result = await run(
        {
          kind: 'check',
          files,
          command,
          ...(command.pinnedTool
            ? { archive: archive.toString('base64'), harness: row.configuration.harness }
            : {}),
        },
        env.NATIVE_WORKFLOW_CHECK_ROLE,
      );
      return { ...result, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr) };
    },
    async review({ files, instructions, prompt, gitDelta, beforeFiles }) {
      const access = await reviewRole(identity);
      return run(
        {
          kind: 'review',
          ...(gitDelta ? { gitDelta, beforeFiles } : {}),
          files,
          instructions,
          prompt,
          harness: row.configuration.harness,
          model: row.configuration.model,
          credentialAlias: access.credentialAlias,
          credentialScope: {
            ...row.scope,
            attemptId: row.attemptId,
            epoch: row.epoch,
          },
        },
        access.roleArn,
      );
    },
  };
};
