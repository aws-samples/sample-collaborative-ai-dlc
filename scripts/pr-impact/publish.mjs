import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  commentMarker,
  qualityArtifactNames,
  validCoverage,
  validateReport,
} from '../publish-complexity-comment.mjs';
import { renderReviewComment } from './comment.mjs';

export const COMMENT_MARKER = commentMarker;
const ASSET_BRANCH = 'pr-impact-assets';
const TOOL_REVISION = '2ec719904ac7dc30de08e152e4622fe8e02fa57a';
const SHA = /^[0-9a-f]{40}$/i;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BOT_LOGIN = 'github-actions[bot]';

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid PR impact artifact: ${message}`);
}

function isSha(value) {
  return typeof value === 'string' && SHA.test(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
}

function isText(value, length) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= length &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function validateReportArtifacts(reportBytes, pngBytes) {
  requireValue(Buffer.isBuffer(reportBytes) && reportBytes.length <= 1_000_000, 'report size');
  requireValue(Buffer.isBuffer(pngBytes) && pngBytes.length <= 5_000_000, 'PNG size');
  requireValue(
    pngBytes.length >= 24 && pngBytes.subarray(0, 8).equals(PNG_SIGNATURE),
    'PNG signature',
  );
  requireValue(
    pngBytes.readUInt32BE(8) === 13 && pngBytes.toString('ascii', 12, 16) === 'IHDR',
    'PNG header',
  );
  const width = pngBytes.readUInt32BE(16);
  const height = pngBytes.readUInt32BE(20);
  requireValue(width > 0 && width <= 8192 && height > 0 && height <= 8192, 'PNG dimensions');
  return validateImpactReport(reportBytes);
}

export function validateImpactReport(reportBytes) {
  requireValue(Buffer.isBuffer(reportBytes) && reportBytes.length <= 1_000_000, 'report size');
  let report;
  try {
    report = JSON.parse(reportBytes.toString('utf8'));
  } catch {
    throw new Error('Invalid PR impact artifact: report JSON');
  }
  requireValue(report && typeof report === 'object' && !Array.isArray(report), 'report shape');
  requireValue(report.schemaVersion === 1, 'schema version');
  requireValue(
    typeof report.repository === 'string' &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(report.repository),
    'repository',
  );
  requireValue(Number.isSafeInteger(report.prNumber) && report.prNumber > 0, 'PR number');
  for (const key of ['headSha', 'baseSha', 'mergeBaseSha']) {
    requireValue(isSha(report[key]), key);
  }
  requireValue(
    typeof report.generatedAt === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(report.generatedAt) &&
      !Number.isNaN(Date.parse(report.generatedAt)),
    'timestamp',
  );
  const summary = report.summary;
  requireValue(summary && typeof summary === 'object' && !Array.isArray(summary), 'summary');
  for (const key of ['files', 'added', 'deleted', 'testFiles']) {
    requireValue(isCount(summary[key]), `summary ${key}`);
  }
  requireValue(summary.testFiles <= summary.files, 'test file count');
  requireValue(
    report.tool?.name === 'isobar' && report.tool.revision === TOOL_REVISION,
    'tool revision',
  );
  {
    const e = report.evidence;
    requireValue(
      e?.version === 1 && e.analysis?.toolRevision === TOOL_REVISION,
      'evidence version',
    );
    requireValue(/^[a-f0-9]{64}$/.test(e.analysis.mapDigest), 'map digest');
    requireValue(
      Array.isArray(e.changes) && e.changes.length === summary.files,
      'evidence changes',
    );
    const selection = e.analysis.declarationSelection;
    requireValue(selection && typeof selection === 'object', 'declaration selection');
    for (const key of ['eligibleFiles', 'selectedFiles', 'omittedFiles']) {
      requireValue(
        isCount(selection[key]) && selection[key] <= summary.files,
        `declaration selection ${key}`,
      );
    }
    requireValue(
      selection.selectedFiles <= 40 &&
        selection.omittedFiles === selection.eligibleFiles - selection.selectedFiles,
      'declaration selection counts',
    );
    requireValue(Array.isArray(e.annotations) && e.annotations.length <= 2, 'annotations');
    const paths = new Set(e.changes.map((c) => c.path));
    requireValue(paths.size === e.changes.length, 'unique changed paths');
    const keys = new Set();
    const annotationPaths = new Set();
    for (const a of e.annotations) {
      requireValue(
        ['A', 'B'].includes(a.key) &&
          !keys.has(a.key) &&
          !annotationPaths.has(a.path) &&
          paths.has(a.path) &&
          e.changes.find((c) => c.path === a.path).leafId === a.leafId &&
          isText(a.path, 500) &&
          isText(a.detail, 700),
        'annotation',
      );
      keys.add(a.key);
      annotationPaths.add(a.path);
    }
    requireValue(e.summary && typeof e.summary === 'object', 'evidence summary');
    for (const key of [
      'productionChanges',
      'testChanges',
      'documentationChanges',
      'nameMatchTargets',
      'importFallbackTargets',
      'transitTargets',
      'productionReachFiles',
      'testReachFiles',
      'unavailableReachFiles',
    ]) {
      requireValue(isCount(e.summary[key]), `evidence ${key}`);
    }
    for (const c of e.changes) {
      requireValue(isText(c.path, 500) && isText(c.leafId, 80), 'changed file ownership');
      requireValue(
        ['source', 'runtime-input', 'infrastructure', 'test', 'documentation', 'unknown'].includes(
          c.role,
        ),
        'changed file role',
      );
    }
  }
  return report;
}

const QUALITY_LIMIT = 20 * 1024 * 1024;
const metadataPattern = /<!-- review-assets:([A-Za-z0-9_-]{1,2048}) -->/;
const botOwned = (comment) =>
  comment?.user?.login === BOT_LOGIN &&
  comment.user.type === 'Bot' &&
  comment.body?.startsWith(COMMENT_MARKER);
const validSourceRun = (run) =>
  run &&
  Number.isSafeInteger(run.id) &&
  run.id > 0 &&
  Number.isSafeInteger(run.attempt) &&
  run.attempt > 0;
const newerSourceRun = (previous, next) =>
  previous &&
  (!next || previous.id > next.id || (previous.id === next.id && previous.attempt > next.attempt));

export function validateQualitySnapshot(report) {
  validateReport(report);
  for (const file of report.files) {
    requireValue(
      file && typeof file.path === 'string' && file.path.length <= 10000,
      'quality file',
    );
    for (const functions of [file.before, file.after]) {
      if (functions === undefined) continue;
      requireValue(Array.isArray(functions) && functions.length <= 100000, 'quality functions');
      for (const fn of functions) {
        requireValue(fn && typeof fn === 'object', 'quality function');
        if (fn.coverage !== undefined) requireValue(validCoverage(fn.coverage), 'file coverage');
      }
    }
  }
  return report;
}

export function reviewMetadata(comment) {
  if (!botOwned(comment)) return null;
  const encoded = comment.body.match(metadataPattern)?.[1];
  if (!encoded) return null;
  try {
    const metadata = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      metadata.schemaVersion !== 1 ||
      ![metadata.assetSha, metadata.headSha, metadata.mergeBaseSha].every(isSha) ||
      !Number.isSafeInteger(metadata.prNumber) ||
      metadata.prNumber < 1 ||
      !isText(metadata.baseRef, 255) ||
      [metadata.qualityRun, metadata.staticRun].some(
        (run) => run !== undefined && !validSourceRun(run),
      )
    )
      return null;
    return metadata;
  } catch {
    return null;
  }
}

async function readJsonFile(directory, filename, limit) {
  if (filename.includes('/')) {
    const parent = await lstat(join(directory, filename.slice(0, filename.lastIndexOf('/'))));
    requireValue(parent.isDirectory(), `${filename} directory`);
  }
  const path = join(directory, filename);
  const info = await lstat(path);
  requireValue(info.isFile() && info.size <= limit, `${filename} file`);
  const bytes = await readFile(path);
  requireValue(bytes.length <= limit, `${filename} size`);
  return JSON.parse(bytes.toString('utf8'));
}

async function readPng(directory) {
  const parent = await lstat(join(directory, 'impact'));
  requireValue(parent.isDirectory(), 'impact directory');
  const path = join(directory, 'impact/map.png');
  const info = await lstat(path);
  requireValue(info.isFile() && info.size <= 5_000_000, 'map.png file');
  const bytes = await readFile(path);
  requireValue(bytes.length <= 5_000_000, 'map.png size');
  return bytes;
}

function identity(context) {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;
  requireValue(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
      context.payload.repository?.full_name === repository,
    'event repository',
  );
  return { owner, repo, repository };
}

// The read-only target producer may recover JSON from a legacy bot report.
// Comment Markdown never supplies measurements or a publication destination.
export async function legacyQualityArtifact({ github, context }) {
  if (context.eventName !== 'pull_request_target') return null;
  try {
    const repo = identity(context);
    const pr = context.payload.pull_request;
    if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || !isSha(pr.head?.sha)) return null;
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: pr.number,
      per_page: 100,
    });
    const existing = comments.find(
      (comment) => botOwned(comment) && !comment.body.includes('<!-- review-assets:'),
    );
    const stamp = existing?.body.match(/<!-- quality-run:(\d+):(\d+) -->/);
    if (!stamp) return null;
    const runId = Number(stamp[1]);
    const commentAttempt = Number(stamp[2]);
    if (![runId, commentAttempt].every((value) => Number.isSafeInteger(value) && value > 0))
      return null;
    const { data: run } = await github.rest.actions.getWorkflowRun({
      owner: repo.owner,
      repo: repo.repo,
      run_id: runId,
    });
    if (
      run.id !== runId ||
      run.event !== 'pull_request' ||
      run.name !== 'PR Quality' ||
      !/^\.github\/workflows\/pr-quality\.yml(?:@.+)?$/.test(run.path) ||
      run.repository?.id !== context.payload.repository.id ||
      run.head_sha !== pr.head.sha ||
      run.head_repository?.id !== pr.head.repo?.id ||
      run.status !== 'completed' ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < commentAttempt
    )
      return null;
    const names = await qualityArtifactNames({
      github,
      repo: { owner: repo.owner, repo: repo.repo },
      runId,
      attempt: run.run_attempt,
    });
    const selectedAttempt = Number(/^pr-quality-(\d+)$/.exec(names.report)?.[1]);
    if (!Number.isSafeInteger(selectedAttempt) || selectedAttempt < 1) return null;
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      owner: repo.owner,
      repo: repo.repo,
      run_id: runId,
      filter: 'all',
      per_page: 100,
    });
    const producer = jobs.find(
      (job) => job.name === 'report' && job.run_attempt === selectedAttempt,
    );
    if (producer?.conclusion !== 'success') return null;
    const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
      owner: repo.owner,
      repo: repo.repo,
      run_id: runId,
      per_page: 100,
    });
    if (!artifacts.some((artifact) => artifact.name === names.report && artifact.expired === false))
      return null;
    return {
      runId,
      artifactName: names.report,
      qualityRun: { id: runId, attempt: selectedAttempt },
    };
  } catch {
    return null;
  }
}

function validateProducer({ context, metadata, attempt, repo }) {
  requireValue(context.eventName === 'pull_request_target', 'publisher event');
  requireValue(
    metadata.schemaVersion === 1 &&
      metadata.repository === repo.repository &&
      Number.isSafeInteger(metadata.prNumber) &&
      metadata.prNumber > 0 &&
      [metadata.headSha, metadata.baseSha, metadata.mergeBaseSha, metadata.controllerSha].every(
        isSha,
      ) &&
      isText(metadata.baseRef, 255) &&
      Number.isSafeInteger(metadata.runId) &&
      metadata.runId > 0 &&
      Number.isSafeInteger(metadata.runAttempt) &&
      metadata.runAttempt > 0 &&
      Number.isSafeInteger(metadata.headRepositoryId) &&
      metadata.headRepositoryId > 0 &&
      (metadata.qualityRun === undefined ||
        (Number.isSafeInteger(metadata.qualityRun?.id) &&
          metadata.qualityRun.id > 0 &&
          Number.isSafeInteger(metadata.qualityRun.attempt) &&
          metadata.qualityRun.attempt > 0)),
    'producer context',
  );
  const pr = context.payload.pull_request;
  requireValue(
    pr?.number === metadata.prNumber &&
      pr.head.sha === metadata.headSha &&
      pr.head.repo?.id === metadata.headRepositoryId &&
      pr.base.sha === metadata.baseSha &&
      pr.base.ref === metadata.baseRef &&
      context.sha === metadata.controllerSha &&
      context.runId === metadata.runId &&
      attempt === metadata.runAttempt,
    'trusted PR event binding',
  );
}

async function currentPr(github, repo, expected) {
  const { data: pr } = await github.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: expected.prNumber,
  });
  if (
    pr.state !== 'open' ||
    pr.head.sha !== expected.headSha ||
    (expected.headRepositoryId !== undefined && pr.head.repo?.id !== expected.headRepositoryId) ||
    pr.base.ref !== expected.baseRef ||
    pr.base.repo?.full_name !== repo.repository
  )
    return null;
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    owner: repo.owner,
    repo: repo.repo,
    basehead: `${pr.base.ref}...${pr.head.sha}`,
    per_page: 1,
  });
  return comparison.merge_base_commit?.sha === expected.mergeBaseSha ? pr : null;
}

async function savedJson(github, repo, metadata, filename, limit) {
  const { data } = await github.rest.repos.getContent({
    owner: repo.owner,
    repo: repo.repo,
    path: `pr-${metadata.prNumber}/${filename}`,
    ref: metadata.assetSha,
  });
  requireValue(
    data?.type === 'file' && Number.isSafeInteger(data.size) && data.size <= limit,
    'saved file',
  );
  let content = data;
  if (data.encoding !== 'base64') {
    requireValue(isSha(data.sha), 'saved blob');
    ({ data: content } = await github.rest.git.getBlob({
      owner: repo.owner,
      repo: repo.repo,
      file_sha: data.sha,
    }));
  }
  requireValue(
    content.encoding === 'base64' &&
      typeof content.content === 'string' &&
      content.content.length <= Math.ceil(limit / 3) * 4 + Math.ceil(limit / 50),
    'saved content',
  );
  const bytes = Buffer.from(content.content, 'base64');
  requireValue(bytes.length <= limit, 'saved content size');
  return JSON.parse(bytes.toString('utf8'));
}

export async function loadReviewSnapshot({
  github,
  context,
  existing,
  expected,
  warn = console.warn,
}) {
  const metadata = reviewMetadata(existing);
  if (
    !metadata ||
    metadata.prNumber !== expected.prNumber ||
    metadata.headSha !== expected.headSha ||
    metadata.baseRef !== expected.baseRef ||
    metadata.mergeBaseSha !== expected.mergeBaseSha
  )
    return null;
  try {
    const repo = identity(context);
    const impact = validateImpactReport(
      Buffer.from(
        JSON.stringify(await savedJson(github, repo, metadata, 'impact.json', 1_000_000)),
      ),
    );
    requireValue(
      impact.repository === repo.repository &&
        impact.prNumber === expected.prNumber &&
        impact.headSha === expected.headSha &&
        impact.mergeBaseSha === expected.mergeBaseSha,
      'saved impact revision',
    );
    const quality = await savedJson(github, repo, metadata, 'quality.json', QUALITY_LIMIT);
    const { data: map } = await github.rest.repos.getContent({
      owner: repo.owner,
      repo: repo.repo,
      path: `pr-${metadata.prNumber}/map.png`,
      ref: metadata.assetSha,
    });
    requireValue(
      map?.type === 'file' &&
        isSha(map.sha) &&
        Number.isSafeInteger(map.size) &&
        map.size <= 5_000_000,
      'saved map',
    );
    if (quality !== null) {
      validateQualitySnapshot(quality);
      requireValue(
        quality.pr === expected.headSha &&
          quality.mergeBase === expected.mergeBaseSha &&
          quality.baseRef === expected.baseRef,
        'saved quality revision',
      );
    }
    return { metadata, impact, quality, mapSha: map.sha };
  } catch (error) {
    warn(`Saved review data unavailable: ${error.message}`);
    return null;
  }
}

export function coverageMeasurements(report) {
  if (!report) return 0;
  const functions = report.files.flatMap((file) => [...(file.before ?? []), ...(file.after ?? [])]);
  const values = functions.length
    ? functions.map((fn) => fn.coverage)
    : [...report.findings, ...report.improvements].flatMap((row) => [
        row.coverage.before,
        row.coverage.after,
      ]);
  return values.reduce(
    (total, value) => total + (value?.status === 'measured' ? (value.partial ? 1 : 2) : 0),
    0,
  );
}

async function storeAssets({ github, repo, prNumber, impact, quality, png, mapSha }) {
  const payloads = [
    ['impact.json', Buffer.from(JSON.stringify(impact))],
    ['quality.json', Buffer.from(JSON.stringify(quality))],
  ];
  if (png) payloads.push(['map.png', png]);
  const treeEntries = [];
  if (!png) {
    requireValue(isSha(mapSha), 'saved map blob');
    treeEntries.push({ path: `pr-${prNumber}/map.png`, mode: '100644', type: 'blob', sha: mapSha });
  }
  for (const [filename, bytes] of payloads) {
    requireValue(
      bytes.length <= (filename === 'impact.json' ? 1_000_000 : QUALITY_LIMIT),
      'asset size',
    );
    const { data: blob } = await github.rest.git.createBlob({
      owner: repo.owner,
      repo: repo.repo,
      encoding: 'base64',
      content: bytes.toString('base64'),
    });
    treeEntries.push({
      path: `pr-${prNumber}/${filename}`,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let ref;
    try {
      ({ data: ref } = await github.rest.git.getRef({
        owner: repo.owner,
        repo: repo.repo,
        ref: `heads/${ASSET_BRANCH}`,
      }));
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    const parentSha = ref?.object?.sha;
    const baseTree = parentSha
      ? (
          await github.rest.git.getCommit({
            owner: repo.owner,
            repo: repo.repo,
            commit_sha: parentSha,
          })
        ).data.tree.sha
      : undefined;
    const { data: tree } = await github.rest.git.createTree({
      owner: repo.owner,
      repo: repo.repo,
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: treeEntries,
    });
    const { data: commit } = await github.rest.git.createCommit({
      owner: repo.owner,
      repo: repo.repo,
      message: `chore(ci): update PR #${prNumber} review signals`,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
    });
    try {
      if (parentSha) {
        await github.rest.git.updateRef({
          owner: repo.owner,
          repo: repo.repo,
          ref: `heads/${ASSET_BRANCH}`,
          sha: commit.sha,
          force: false,
        });
      } else {
        await github.rest.git.createRef({
          owner: repo.owner,
          repo: repo.repo,
          ref: `refs/heads/${ASSET_BRANCH}`,
          sha: commit.sha,
        });
      }
      return commit.sha;
    } catch (error) {
      if (![409, 422].includes(error.status) || attempt === 2) throw error;
    }
  }
  throw new Error('Unable to publish review assets');
}

function commentBody({
  context,
  expected,
  assetSha,
  quality,
  impact,
  run,
  qualityRun,
  staticRun,
  updatedAt,
}) {
  const repo = identity(context);
  const metadata = {
    schemaVersion: 1,
    assetSha,
    headSha: expected.headSha,
    mergeBaseSha: expected.mergeBaseSha,
    baseRef: expected.baseRef,
    prNumber: expected.prNumber,
    ...(qualityRun ? { qualityRun } : {}),
    ...(staticRun ? { staticRun } : {}),
  };
  const content = renderReviewComment({
    qualityReport: quality,
    impactReport: impact,
    imageUrl: `https://raw.githubusercontent.com/${repo.repository}/${assetSha}/pr-${expected.prNumber}/map.png`,
    headSha: expected.headSha,
    updatedAt,
    artifactUrl: `https://github.com/${repo.repository}/actions/runs/${run.id}`,
    maxLength: 50000,
  });
  requireValue(content.length <= 50000, 'comment size');
  return `${COMMENT_MARKER}\n<!-- quality-run:${run.id}:${run.run_attempt} -->\n<!-- review-assets:${Buffer.from(JSON.stringify(metadata)).toString('base64url')} -->\n${content}`;
}

async function writeComment(github, repo, expected, existing, body) {
  if (existing) {
    await github.rest.issues.updateComment({
      owner: repo.owner,
      repo: repo.repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: expected.prNumber,
      body,
    });
  }
}

export async function publishReviewSignals({
  github,
  context,
  reportDirectory,
  attempt = Number(process.env.GITHUB_RUN_ATTEMPT),
  warn = console.warn,
  now = () => new Date().toISOString(),
  loadLegacyQuality,
}) {
  const repo = identity(context);
  const expected = await readJsonFile(reportDirectory, 'context.json', 10000);
  validateProducer({ context, metadata: expected, attempt, repo });
  let impact;
  let quality;
  let png;
  try {
    impact = await readJsonFile(reportDirectory, 'impact/report.json', 1_000_000);
    png = await readPng(reportDirectory);
    validateReportArtifacts(Buffer.from(JSON.stringify(impact)), png);
    requireValue(
      impact.evidence &&
        impact.repository === repo.repository &&
        impact.prNumber === expected.prNumber &&
        impact.headSha === expected.headSha &&
        impact.mergeBaseSha === expected.mergeBaseSha &&
        impact.baseSha === expected.baseSha,
      'impact context',
    );
    quality = validateQualitySnapshot(
      await readJsonFile(reportDirectory, 'quality/comparison.json', QUALITY_LIMIT),
    );
    requireValue(
      quality.pr === expected.headSha &&
        quality.mergeBase === expected.mergeBaseSha &&
        quality.baseRef === expected.baseRef,
      'quality context',
    );
  } catch (error) {
    warn(`Review report unavailable: ${error.message}`);
    return { published: false, reason: 'report unavailable' };
  }
  if (!(await currentPr(github, repo, expected))) return { published: false, reason: 'stale PR' };
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: repo.owner,
    repo: repo.repo,
    issue_number: expected.prNumber,
    per_page: 100,
  });
  const existing = comments.find(botOwned);
  const run = { id: expected.runId, run_attempt: expected.runAttempt };
  const staticRun = { id: run.id, attempt: run.run_attempt };
  const previousMetadata = reviewMetadata(existing);
  if (
    previousMetadata?.headSha === expected.headSha &&
    previousMetadata.mergeBaseSha === expected.mergeBaseSha &&
    previousMetadata.baseRef === expected.baseRef &&
    newerSourceRun(previousMetadata.staticRun, staticRun)
  )
    return { published: false, reason: 'older run' };
  const saved = await loadReviewSnapshot({ github, context, existing, expected, warn });
  let qualityRun = expected.qualityRun ?? saved?.metadata.qualityRun;
  if (
    saved &&
    (newerSourceRun(saved.metadata.qualityRun, expected.qualityRun) ||
      coverageMeasurements(saved.quality) > coverageMeasurements(quality))
  ) {
    if (saved.quality || coverageMeasurements(quality) > 0) quality = saved.quality;
    qualityRun = saved.metadata.qualityRun;
  }
  if (existing && !previousMetadata) {
    const stamp = existing.body.match(/<!-- quality-run:(\d+):(\d+) -->/);
    const legacyRun = stamp && { id: Number(stamp[1]), attempt: Number(stamp[2]) };
    if (validSourceRun(legacyRun) && newerSourceRun(legacyRun, expected.qualityRun)) {
      const selected = await legacyQualityArtifact({ github, context });
      if (!selected) return { published: false, reason: 'newer legacy quality requires recovery' };
      if (newerSourceRun(selected.qualityRun, expected.qualityRun)) {
        if (!loadLegacyQuality)
          return { published: false, reason: 'newer legacy quality requires recovery' };
        try {
          const recovered = validateQualitySnapshot(await loadLegacyQuality(selected));
          requireValue(
            recovered.pr === expected.headSha &&
              recovered.mergeBase === expected.mergeBaseSha &&
              recovered.baseRef === expected.baseRef,
            'latest legacy quality context',
          );
          quality = recovered;
          qualityRun = selected.qualityRun;
        } catch (error) {
          warn(`Latest legacy quality unavailable: ${error.message}`);
          return { published: false, reason: 'newer legacy quality requires recovery' };
        }
      }
    }
  }
  commentBody({
    context,
    expected,
    assetSha: '0'.repeat(40),
    quality,
    impact,
    run,
    qualityRun,
    staticRun,
    updatedAt: now(),
  });
  if (!(await currentPr(github, repo, expected))) return { published: false, reason: 'stale PR' };
  const assetSha = await storeAssets({
    github,
    repo,
    prNumber: expected.prNumber,
    impact,
    quality,
    png,
  });
  if (!(await currentPr(github, repo, expected)))
    return { published: false, reason: 'stale PR before comment write' };
  const body = commentBody({
    context,
    expected,
    assetSha,
    quality,
    impact,
    run,
    qualityRun,
    staticRun,
    updatedAt: now(),
  });
  await writeComment(github, repo, expected, existing, body);
  return { published: true, prNumber: expected.prNumber, assetSha };
}

export async function enrichReviewSignals({
  github,
  context,
  pr,
  run,
  report,
  existing,
  warn = console.warn,
  now = () => new Date().toISOString(),
}) {
  const metadata = reviewMetadata(existing);
  if (!metadata) return false;
  const repo = identity(context);
  const expected = {
    prNumber: pr.number,
    headSha: pr.head.sha,
    headRepositoryId: pr.head.repo.id,
    baseRef: pr.base.ref,
    mergeBaseSha: metadata.mergeBaseSha,
  };
  if (!(await currentPr(github, repo, expected))) return false;
  const saved = await loadReviewSnapshot({ github, context, existing, expected, warn });
  if (!saved) return false;
  if (report) {
    validateQualitySnapshot(report);
    if (
      report.pr !== expected.headSha ||
      report.baseRef !== expected.baseRef ||
      report.mergeBase !== expected.mergeBaseSha
    )
      return false;
  }
  const previousQualityRun = saved.metadata.qualityRun;
  if (
    previousQualityRun &&
    (previousQualityRun.id > run.id ||
      (previousQualityRun.id === run.id && previousQualityRun.attempt > run.run_attempt))
  )
    return true;
  const qualityRun = { id: run.id, attempt: run.run_attempt };
  commentBody({
    context,
    expected,
    assetSha: '0'.repeat(40),
    quality: report ?? null,
    impact: saved.impact,
    run,
    qualityRun,
    staticRun: saved.metadata.staticRun,
    updatedAt: now(),
  });
  if (!(await currentPr(github, repo, expected))) return true;
  const assetSha = await storeAssets({
    github,
    repo,
    prNumber: pr.number,
    impact: saved.impact,
    quality: report ?? null,
    mapSha: saved.mapSha,
  });
  if (!(await currentPr(github, repo, expected))) return true;
  const body = commentBody({
    context,
    expected,
    assetSha,
    quality: report ?? null,
    impact: saved.impact,
    run,
    qualityRun,
    staticRun: saved.metadata.staticRun,
    updatedAt: now(),
  });
  await writeComment(github, repo, expected, existing, body);
  return true;
}
