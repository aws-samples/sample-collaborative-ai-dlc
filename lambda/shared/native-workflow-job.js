import { isDeepStrictEqual } from 'node:util';
import { isValidRepoPath } from './repo-validation.js';
import { canonicalNativePath } from './native-project-files.js';
import { nativeGitExcludedRoot, nativeGitDeltaSha256 } from './native-git-change-set.js';
import { canonicalJson } from './workflow-checkpoint.js';
import {
  engineDigest,
  engineFailure,
  nativeEngineFiles,
  nativeEngineFileDigest,
  NATIVE_ENGINE_PROFILE,
} from './native-workflow-protocol.js';

// The same absolute paths have different filesystems in the Lambda and each
// isolated job. Keeping them stable preserves paths in pinned shell commands.
export const NATIVE_ENGINE_JOB_ROOT = '/tmp/native-workflow-engine';
export const NATIVE_ENGINE_JOB_ENTRY = '/opt/agentcore/native/workflow-job.mjs';
// This value is also compared with BatchGetBuilds. A request cannot replace the
// wrapper, add project-controlled pre-build commands, or choose a different job.
export const NATIVE_ENGINE_JOB_BUILD_SPEC = JSON.stringify({
  version: '0.2',
  'run-as': 'root',
  phases: {
    pre_build: { commands: [`/usr/local/bin/node ${NATIVE_ENGINE_JOB_ENTRY} prepare`] },
    build: { commands: [`/usr/local/bin/node ${NATIVE_ENGINE_JOB_ENTRY} run`] },
    post_build: { commands: [`/usr/local/bin/node ${NATIVE_ENGINE_JOB_ENTRY} publish`] },
  },
});
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, limit) =>
  typeof value === 'string' && value.length <= limit && !value.includes('\0');
const fileVersion = (file) =>
  file ? { mode: file.mode, sha256: file.sha256, bytes: file.bytes } : null;
const validGitSource = (delta) => {
  const source = delta?.sourceBaseline;
  const repo = delta?.repository;
  return (
    sha(source?.id) &&
    text(source.versionId, 1024) &&
    source.versionId.length > 0 &&
    source.versionId !== 'null' &&
    Number.isSafeInteger(source.epoch) &&
    source.epoch >= 1 &&
    ['github', 'bitbucket', 'gitlab'].includes(repo?.provider) &&
    isValidRepoPath(repo.repository) &&
    typeof repo.branch === 'string' &&
    repo.branch.length > 0 &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(repo.commit)
  );
};
export const nativeEngineJob = (value) => {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !['check', 'review'].includes(value.kind) ||
    !/^[a-f0-9-]{36}$/.test(value.jobId ?? '') ||
    !sha(value.producerSha256) ||
    !sha(value.filesSha256) ||
    value.profileId !== NATIVE_ENGINE_PROFILE.id
  )
    throw engineFailure('NATIVE_ENGINE_JOB_INVALID');
  const files = nativeEngineFiles(value.files);
  if (nativeEngineFileDigest(files) !== value.filesSha256)
    throw engineFailure('NATIVE_ENGINE_JOB_INVALID');
  if (value.kind === 'check') {
    const command = value.command;
    if (
      !command ||
      !text(command.command, 4096) ||
      !command.command ||
      !Array.isArray(command.args) ||
      command.args.length > 128 ||
      !command.args.every((arg) => text(arg, 65_536)) ||
      !text(command.cwd, 4096) ||
      !Number.isSafeInteger(command.timeoutMs) ||
      command.timeoutMs < 1 ||
      command.timeoutMs > 600_000 ||
      !(command.input === null || text(command.input, 2 * 1024 * 1024)) ||
      ![null, 'tools/aidlc-sensor-linter.ts', 'tools/aidlc-sensor-type-check.ts'].includes(
        command.pinnedTool,
      )
    )
      throw engineFailure('NATIVE_ENGINE_JOB_INVALID');
  } else if (
    !NATIVE_ENGINE_PROFILE.harnesses.includes(value.harness) ||
    !(value.model === null || text(value.model, 256)) ||
    !text(value.instructions, 64 * 1024) ||
    !value.instructions.trim() ||
    !text(value.prompt, 256 * 1024) ||
    !value.prompt.trim() ||
    !/^arn:(aws|aws-us-gov|aws-cn):lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]+:review_[a-f0-9]{32}$/.test(
      value.credentialAlias ?? '',
    )
  )
    throw engineFailure('NATIVE_ENGINE_JOB_INVALID');
  if (value.gitDelta || value.beforeFiles) {
    if (value.kind !== 'review') throw engineFailure('NATIVE_ENGINE_JOB_INVALID');
    const beforeFiles = nativeEngineFiles(value.beforeFiles);
    const before = new Map(beforeFiles.map((f) => [f.path, f]));
    const after = new Map(files.map((f) => [f.path, f]));
    const changes = value.gitDelta?.changes;
    if (
      !validGitSource(value.gitDelta) ||
      files.length + beforeFiles.length > 20_000 ||
      !Array.isArray(changes) ||
      changes.length > 20_000 ||
      files.reduce((n, f) => n + f.bytes, 0) + beforeFiles.reduce((n, f) => n + f.bytes, 0) >
        128 * 1024 * 1024 ||
      changes.filter((c) => c?.before).length !== before.size ||
      changes.some(
        (c, i) =>
          !canonicalNativePath(c?.path) ||
          nativeGitExcludedRoot(c.path) ||
          (i && c.path <= changes[i - 1].path) ||
          !(c.before || c.after) ||
          !isDeepStrictEqual(c.before, fileVersion(before.get(c.path))) ||
          !isDeepStrictEqual(c.after, fileVersion(after.get(c.path))) ||
          [c.before, c.after].some((v) => v && !['100644', '100755'].includes(v.mode)),
      )
    )
      throw engineFailure('NATIVE_ENGINE_JOB_INVALID');
    return { ...structuredClone(value), files, beforeFiles };
  }
  return { ...structuredClone(value), files };
};

export const nativeEngineJobSha = (value) => engineDigest(canonicalJson(value));
export const nativeEngineJobResult = (value, job) => {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.jobId !== job.jobId ||
    value.kind !== job.kind ||
    value.filesSha256 !== job.filesSha256 ||
    value.producerSha256 !== job.producerSha256 ||
    !Number.isInteger(value.exitCode) ||
    value.exitCode < 0 ||
    value.exitCode > 255 ||
    typeof value.timedOut !== 'boolean' ||
    typeof value.cleanupComplete !== 'boolean' ||
    !text(value.stdout, 3 * 1024 * 1024) ||
    !text(value.stderr, 1024 * 1024)
  )
    throw engineFailure('NATIVE_ENGINE_JOB_RESULT_INVALID');
  if (
    job.kind === 'review' &&
    value.exitCode === 0 &&
    ((job.gitDelta && value.gitSha256 !== nativeGitDeltaSha256(job.gitDelta)) ||
      !text(value.review, 1024 * 1024) ||
      !value.review.trim() ||
      !text(value.nativeSessionId, 512) ||
      !value.nativeSessionId ||
      !sha(value.reviewSha256) ||
      engineDigest(value.review) !== value.reviewSha256)
  )
    throw engineFailure('NATIVE_ENGINE_JOB_RESULT_INVALID');
  return structuredClone(value);
};
