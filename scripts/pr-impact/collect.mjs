import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compareRevisions } from '../compare-complexity.mjs';
import { render } from './render.mjs';

const execute = promisify(execFile);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function requireMetadata(metadata) {
  if (
    metadata?.schemaVersion !== 1 ||
    !/^[\w.-]+\/[\w.-]+$/.test(metadata.repository ?? '') ||
    ![metadata.headSha, metadata.baseSha, metadata.controllerSha].every(sha) ||
    ![metadata.prNumber, metadata.runId, metadata.runAttempt, metadata.headRepositoryId].every(
      positive,
    ) ||
    typeof metadata.baseRef !== 'string' ||
    !metadata.baseRef ||
    metadata.baseRef.length > 255 ||
    Array.from(metadata.baseRef).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error('Invalid trusted PR event context');
  }
}

export function captureContext(event, environment) {
  const pr = event.pull_request;
  const metadata = {
    schemaVersion: 1,
    repository: environment.GITHUB_REPOSITORY,
    prNumber: event.number,
    headSha: pr?.head?.sha,
    baseSha: pr?.base?.sha,
    baseRef: pr?.base?.ref,
    controllerSha: environment.GITHUB_SHA,
    runId: Number(environment.GITHUB_RUN_ID),
    runAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
    headRepositoryId: pr?.head?.repo?.id,
  };
  if (
    environment.GITHUB_EVENT_NAME !== 'pull_request_target' ||
    event.repository?.full_name !== metadata.repository ||
    pr?.base?.repo?.full_name !== metadata.repository
  ) {
    throw new Error('Invalid trusted PR event context');
  }
  requireMetadata(metadata);
  return metadata;
}

// Install and execute only the controller's tooling. The contributor revision
// is fetched into its object database and read as immutable blobs, never checked out.
export async function collectReviewSignals({
  cwd,
  metadata,
  upstream,
  python,
  output,
  git = async (args) =>
    (
      await execute(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
        {
          cwd,
          env: gitEnvironment,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          timeout: 180_000,
        },
      )
    ).stdout,
  compare = compareRevisions,
  renderImpact = render,
}) {
  requireMetadata(metadata);
  const controller = (await git(['rev-parse', 'HEAD'])).trim();
  if (controller !== metadata.controllerSha) throw new Error('Controller checkout changed');
  await git([
    'fetch',
    '--no-tags',
    '--no-recurse-submodules',
    `https://github.com/${metadata.repository}.git`,
    metadata.baseSha,
    `+refs/pull/${metadata.prNumber}/head:refs/pr-review/head`,
  ]);
  const capturedHead = (await git(['rev-parse', 'refs/pr-review/head'])).trim();
  if (capturedHead !== metadata.headSha) throw new Error('PR advanced during static collection');
  if ((await git(['rev-parse', 'HEAD'])).trim() !== controller)
    throw new Error('Contributor source replaced the controller checkout');
  const mergeBaseSha = (await git(['merge-base', metadata.baseSha, metadata.headSha])).trim();
  if (!sha(mergeBaseSha)) throw new Error('No valid PR merge base');
  const quality = await compare({
    cwd,
    base: metadata.baseSha,
    pr: metadata.headSha,
    baseRef: metadata.baseRef,
  });
  if (quality.pr !== metadata.headSha || quality.mergeBase !== mergeBaseSha)
    throw new Error('Quality revision mismatch');
  await mkdir(resolve(output, 'quality'), { recursive: true });
  await writeFile(
    resolve(output, 'quality/comparison.json'),
    `${JSON.stringify(quality, null, 2)}\n`,
  );
  const impact = await renderImpact({
    repo: cwd,
    upstream,
    mapPath: resolve(cwd, '.isobar/map.json'),
    baseSha: metadata.baseSha,
    headSha: metadata.headSha,
    prNumber: metadata.prNumber,
    repository: metadata.repository,
    out: resolve(output, 'impact'),
    python,
  });
  if (impact.headSha !== metadata.headSha || impact.mergeBaseSha !== mergeBaseSha)
    throw new Error('Map revision mismatch');
  const context = { ...metadata, mergeBaseSha };
  await writeFile(resolve(output, 'context.json'), `${JSON.stringify(context, null, 2)}\n`);
  return { context, quality, impact };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const metadata = captureContext(event, process.env);
  await collectReviewSignals({
    cwd: process.cwd(),
    metadata,
    upstream: resolve(process.env.ISOBAR_UPSTREAM),
    python: resolve(process.env.ISOBAR_PYTHON),
    output: resolve(process.env.REVIEW_REPORT_DIRECTORY),
  });
}
