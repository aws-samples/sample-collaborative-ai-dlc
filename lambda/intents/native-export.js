import { createHash, randomUUID } from 'node:crypto';
import archiver from 'archiver';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import yaml from 'js-yaml';
import {
  MAX_DISTRIBUTION_BYTES,
  MAX_DISTRIBUTION_FILES,
  buildDistributionArchive,
  extractDistributionArchive,
} from '../shared/distribution-archive.js';
import { projectNativeWorkspace } from '../shared/native-workspace-projector.js';
import { fetchRepoFiles } from '../shared/repo-fetch.js';

const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TTL_SECONDS = 15 * 60;
const HARNESS_DATA_DIRS = {
  claude: '.claude/tools/data',
  codex: '.codex/tools/data',
  kiro: '.kiro/tools/data',
  'kiro-ide': '.kiro/tools/data',
  opencode: '.aidlc/tools/data',
};
const HARNESS_SESSION_COMMANDS = {
  claude: { launchCommand: 'claude', continueCommand: '/aidlc' },
  codex: { launchCommand: 'codex', continueCommand: '$aidlc' },
  kiro: { launchCommand: 'kiro-cli chat', continueCommand: '/aidlc' },
  'kiro-ide': { launchCommand: null, continueCommand: '/aidlc' },
  opencode: { launchCommand: 'opencode', continueCommand: '/aidlc' },
};
const harnessRootDir = (harness) =>
  HARNESS_DATA_DIRS[harness]?.replace(/\/tools\/data$/, '') ?? null;
const workspaceSyncCommand = ({ distributionFiles, harness }) => {
  const harnessDir = harnessRootDir(harness);
  if (!harnessDir) return null;
  const tool = `${harnessDir}/tools/aidlc-workspace-sync.ts`;
  return distributionFiles.has(tool) ? `bun ${tool}` : null;
};
const sha256 = (body) => createHash('sha256').update(body).digest('hex');
const isCommitSha = (value) => /^[0-9a-f]{40}$/i.test(String(value ?? ''));
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const safeArchivePath = (value) => {
  const path = String(value ?? '').replaceAll('\\', '/');
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`native-export: unsafe distribution path ${value}`);
  }
  return path;
};

const bodyToBuffer = async (body) => {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const readObject = async ({ s3, bucket, key, versionId = null }) => {
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(versionId ? { VersionId: versionId } : {}),
    }),
  );
  return bodyToBuffer(result.Body);
};

const isNotFound = (error) =>
  error?.name === 'NoSuchKey' ||
  error?.name === 'NotFound' ||
  error?.$metadata?.httpStatusCode === 404;

const readObjectIfPresent = async (options) => {
  try {
    return await readObject(options);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
};

const distributionPrefix = (upstreamRef) => `aidlc-distributions/${upstreamRef}`;
const distributionArchiveKey = (upstreamRef, harness) =>
  `${distributionPrefix(upstreamRef)}/${harness}.tar.gz`;
const distributionManifestKey = (upstreamRef, harness) =>
  `${distributionPrefix(upstreamRef)}/${harness}.manifest.json`;

const distributionFileManifest = (files) =>
  [...files]
    .map(([path, body]) => ({
      path: safeArchivePath(path),
      bytes: body.length,
      sha256: sha256(body),
    }))
    .toSorted((a, b) => a.path.localeCompare(b.path));

const detectWorkspaceLayout = ({ files, harness }) => {
  if ([...files.keys()].some((path) => path.startsWith('aidlc/'))) return 'spaces';

  const dataDir = HARNESS_DATA_DIRS[harness];
  const graphBody = dataDir ? files.get(`${dataDir}/stage-graph.json`) : null;
  if (!graphBody) {
    throw new Error(`native-export: ${harness} distribution has no stage graph`);
  }
  const graph = JSON.parse(graphBody.toString('utf8'));
  const scaffold = Array.isArray(graph)
    ? graph.find(
        (stage) => stage?.slug === 'workspace-scaffold' || stage?.name === 'Workspace Scaffold',
      )
    : null;
  if (String(scaffold?.outputs ?? '').includes('aidlc-docs/')) return 'flat';
  throw new Error(
    `native-export: ${harness} distribution does not declare a supported workspace layout`,
  );
};

const validateDistribution = async ({ archive, manifest, upstreamRef, harness }) => {
  if (
    manifest?.ref !== upstreamRef ||
    manifest?.harness !== harness ||
    !Array.isArray(manifest.files) ||
    !manifest.archiveSha256
  ) {
    throw new Error(`native-export: invalid ${harness} distribution manifest`);
  }
  if (
    archive.length !== Number(manifest.archiveBytes) ||
    sha256(archive) !== manifest.archiveSha256
  ) {
    throw new Error(`native-export: ${harness} distribution archive checksum mismatch`);
  }
  const files = await extractDistributionArchive(archive);
  if (files.size !== manifest.files.length) {
    throw new Error(`native-export: ${harness} distribution file count mismatch`);
  }
  for (const entry of manifest.files) {
    const path = safeArchivePath(entry.path);
    const body = files.get(path);
    if (
      !body ||
      body.length !== Number(entry.bytes) ||
      !entry.sha256 ||
      sha256(body) !== entry.sha256
    ) {
      throw new Error(`native-export: distribution checksum mismatch for ${path}`);
    }
  }
  const workspaceLayout = detectWorkspaceLayout({ files, harness });
  if (manifest.workspaceLayout && manifest.workspaceLayout !== workspaceLayout) {
    throw new Error(`native-export: ${harness} distribution workspace layout mismatch`);
  }
  return { files, workspaceLayout };
};

const loadCurrentCacheEntry = async ({ s3, bucket, upstreamRef, harness }) => {
  const manifestBody = await readObjectIfPresent({
    s3,
    bucket,
    key: distributionManifestKey(upstreamRef, harness),
  });
  if (!manifestBody) return null;
  const archive = await readObjectIfPresent({
    s3,
    bucket,
    key: distributionArchiveKey(upstreamRef, harness),
  });
  if (!archive) return null;
  return validateDistribution({
    archive,
    manifest: JSON.parse(manifestBody.toString('utf8')),
    upstreamRef,
    harness,
  });
};

// Compatibility with archives warmed by the initial seed-time implementation.
const loadLegacyCacheEntry = async ({ s3, bucket, upstreamRef, harness }) => {
  const prefix = `aidlc-distributions/${upstreamRef}`;
  const manifestBody = await readObjectIfPresent({
    s3,
    bucket,
    key: `${prefix}/manifest.json`,
  });
  if (!manifestBody) return null;
  const manifest = JSON.parse(manifestBody.toString('utf8'));
  const distribution = manifest?.harnesses?.[harness];
  if (manifest?.ref !== upstreamRef) {
    throw new Error(`native-export: invalid distribution manifest for ${upstreamRef}`);
  }
  if (!distribution?.available) return null;
  if (!Array.isArray(distribution.files) || !distribution.archive || !distribution.archiveSha256) {
    throw new Error(`native-export: invalid ${harness} distribution manifest`);
  }
  const archivePath = safeArchivePath(distribution.archive);
  const archive = await readObjectIfPresent({ s3, bucket, key: `${prefix}/${archivePath}` });
  if (!archive) return null;
  return validateDistribution({
    archive,
    manifest: {
      ...distribution,
      ref: upstreamRef,
      harness,
    },
    upstreamRef,
    harness,
  });
};

const fetchAndCacheDistribution = async ({ s3, bucket, upstreamRef, harness }) => {
  const repoPrefix = `dist/${harness}/`;
  let fetched;
  try {
    fetched = await fetchRepoFiles(upstreamRef, {
      prefixes: [repoPrefix],
      maxFiles: MAX_DISTRIBUTION_FILES,
      maxRetainedBytes: MAX_DISTRIBUTION_BYTES,
    });
  } catch (error) {
    throw new Error(
      `native-export: ${harness} distribution is unavailable for ${upstreamRef}: ${error.message}`,
      { cause: error },
    );
  }
  const files = new Map(
    [...fetched]
      .filter(([path]) => path.startsWith(repoPrefix))
      .map(([path, body]) => [safeArchivePath(path.slice(repoPrefix.length)), body]),
  );
  if (files.size === 0) {
    throw new Error(
      `native-export: ${harness} distribution is unavailable for ${upstreamRef}: dist/${harness}/ is missing`,
    );
  }
  const workspaceLayout = detectWorkspaceLayout({ files, harness });
  const archive = await buildDistributionArchive(files);
  const manifest = {
    schemaVersion: 1,
    ref: upstreamRef,
    harness,
    workspaceLayout,
    archive: `${harness}.tar.gz`,
    archiveBytes: archive.length,
    archiveSha256: sha256(archive),
    files: distributionFileManifest(files),
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: distributionArchiveKey(upstreamRef, harness),
      Body: archive,
      ContentType: 'application/gzip',
    }),
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: distributionManifestKey(upstreamRef, harness),
      Body: `${JSON.stringify(manifest, null, 2)}\n`,
      ContentType: 'application/json',
    }),
  );
  return { files, workspaceLayout };
};

const loadDistribution = async ({ s3, bucket, upstreamRef, harness }) => {
  if (!isCommitSha(upstreamRef)) {
    throw new Error('native-export: upstream ref must be a full commit SHA');
  }
  if (!HARNESS_DATA_DIRS[harness]) {
    throw new Error(`native-export: unsupported harness ${harness}`);
  }
  const cached = await loadCurrentCacheEntry({ s3, bucket, upstreamRef, harness });
  if (cached) return cached;
  const legacy = await loadLegacyCacheEntry({ s3, bucket, upstreamRef, harness });
  if (legacy) return legacy;
  return fetchAndCacheDistribution({ s3, bucket, upstreamRef, harness });
};

const loadHarnessMetadata = ({ distributionFiles, harness }) => {
  const dataDir = HARNESS_DATA_DIRS[harness];
  const body = dataDir ? distributionFiles.get(`${dataDir}/harness.json`) : null;
  if (!body) throw new Error(`native-export: ${harness} distribution has no harness metadata`);
  const metadata = JSON.parse(body.toString('utf8'));
  return {
    ...metadata,
    harnessDir: safeArchivePath(metadata.harnessDir),
    rulesSubdir: safeArchivePath(metadata.rulesSubdir),
  };
};

const resolveRulesDir = ({ distributionFiles, harness }) => {
  const { harnessDir, rulesSubdir } = loadHarnessMetadata({ distributionFiles, harness });
  return `${harnessDir}/${rulesSubdir}`;
};

const detectConstructionCapabilities = ({ distributionFiles, harness }) => {
  const { harnessDir } = loadHarnessMetadata({ distributionFiles, harness });
  const orchestrator = distributionFiles.get(`${harnessDir}/tools/aidlc-orchestrate.ts`);
  const source = orchestrator?.toString('utf8') ?? '';
  return {
    perUnitIteration: source.includes('emitPerUnitRunStage'),
  };
};

const shouldShowWorkspaceSetup = (stages = []) => {
  const activeIndex = stages.findIndex((stage) => stage.marker === '-');
  if (activeIndex < 0) {
    return stages.some((stage) => stage.phase === 'construction' && stage.marker !== 'S');
  }
  const active = stages[activeIndex];
  if (['construction', 'operation'].includes(active.phase)) return true;
  if (active.phase !== 'inception') return false;
  const nextExecutable = stages
    .slice(activeIndex + 1)
    .find((stage) => !['x', 'S'].includes(stage.marker));
  return nextExecutable?.phase === 'construction';
};

const loadCustomRules = async ({ s3, bucket, harness, distributionFiles, customRules = [] }) => {
  const files = new Map();
  if (customRules.length === 0) return files;
  const rulesDir = resolveRulesDir({ distributionFiles, harness });
  for (const rule of customRules) {
    const key = String(rule?.s3Key ?? '');
    const filename = String(rule?.filename ?? key.split('/').at(-1) ?? '');
    if (!key.startsWith('custom-rules/') || !/^[A-Za-z0-9._-]+\.md$/i.test(filename)) {
      throw new Error(`native-export: invalid custom rule reference ${key || filename}`);
    }
    const body = await readObject({
      s3,
      bucket,
      key,
      versionId: rule.versionId ?? null,
    });
    if (body.length > 100 * 1024) {
      throw new Error(`native-export: custom rule ${filename} exceeds the 100 KB limit`);
    }
    files.set(`${rulesDir}/custom--${filename}`, body);
  }
  return files;
};

const assertNativeScopeName = (value) => {
  const scope = String(value ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope) || scope === '.' || scope === '..') {
    throw new Error(`native-export: scope "${scope}" is not a valid native scope identifier`);
  }
  return scope;
};

const parseMarkdownFrontmatter = (body, path) => {
  const source = body.toString('utf8');
  const match = source.match(FRONTMATTER_RE);
  if (!match) throw new Error(`native-export: stage file has no frontmatter: ${path}`);
  const data = yaml.load(match[1]);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`native-export: stage file has invalid frontmatter: ${path}`);
  }
  return { data, frontmatter: match[1], markdown: match[2] ?? '' };
};

const renderStageScopes = ({ frontmatter, markdown }, scopes) => {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => /^scopes\s*:/.test(line));
  if (start < 0) {
    lines.push('scopes:', ...scopes.map((scope) => `  - ${scope}`));
    return `---\n${lines.join('\n')}\n---\n${markdown}`;
  }
  let end = start + 1;
  while (end < lines.length && !/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(lines[end])) end += 1;
  lines.splice(start, end - start, 'scopes:', ...scopes.map((scope) => `  - ${scope}`));
  return `---\n${lines.join('\n')}\n---\n${markdown}`;
};

const renderScopeDefinition = (scope) => `---
name: ${scope}
depth: Standard
keywords: []
description: Exported Collaborative AI-DLC workflow composition
---

# ${scope} scope

This scope was materialized from the workflow composition captured by the export.
Its stage membership is defined by the installed stage frontmatter and compiled
scope grid.
`;

const registerNativeScope = ({ distributionFiles, harness, stages, scope }) => {
  const nativeScope = assertNativeScopeName(scope);
  const dataDir = HARNESS_DATA_DIRS[harness];
  const graphPath = `${dataDir}/stage-graph.json`;
  const gridPath = `${dataDir}/scope-grid.json`;
  const graphBody = distributionFiles.get(graphPath);
  const gridBody = distributionFiles.get(gridPath);
  if (!graphBody) throw new Error(`native-export: ${harness} distribution has no stage graph`);
  if (!gridBody) throw new Error(`native-export: ${harness} distribution has no scope grid`);

  const graph = JSON.parse(graphBody.toString('utf8'));
  const grid = JSON.parse(gridBody.toString('utf8'));
  if (!Array.isArray(graph) || !grid || typeof grid !== 'object' || Array.isArray(grid)) {
    throw new Error(`native-export: ${harness} distribution has invalid scope data`);
  }

  const desiredByStage = new Map(stages.map((stage) => [stage.stageId, !stage.excluded]));
  const desiredGrid = {};
  for (const stage of graph) {
    if (!desiredByStage.has(stage.slug)) {
      throw new Error(`native-export: projected plan is missing native stage ${stage.slug}`);
    }
    desiredGrid[stage.slug] = desiredByStage.get(stage.slug) ? 'EXECUTE' : 'SKIP';
  }

  const { harnessDir } = loadHarnessMetadata({ distributionFiles, harness });
  const scopePath = `${harnessDir}/scopes/aidlc-${nativeScope}.md`;
  const existingGrid = grid[nativeScope]?.stages;
  const graphMatches = graph.every(
    (stage) =>
      (Array.isArray(stage.scopes) && stage.scopes.includes(nativeScope)) ===
      desiredByStage.get(stage.slug),
  );
  const gridMatches =
    existingGrid &&
    graph.every((stage) => existingGrid[stage.slug] === desiredGrid[stage.slug]) &&
    Object.keys(existingGrid).length === graph.length;
  if (distributionFiles.has(scopePath) && graphMatches && gridMatches) {
    return { files: distributionFiles, registered: false, scope: nativeScope };
  }

  const files = new Map(distributionFiles);
  const updatedGraph = graph.map((stage) => {
    const execute = desiredByStage.get(stage.slug);
    const currentScopes = Array.isArray(stage.scopes) ? stage.scopes : [];
    const scopes = execute
      ? [...new Set([...currentScopes, nativeScope])]
      : currentScopes.filter((name) => name !== nativeScope);
    if (
      scopes.length !== currentScopes.length ||
      scopes.some((name, index) => name !== currentScopes[index])
    ) {
      const phase = safeArchivePath(stage.phase);
      const slug = safeArchivePath(stage.slug);
      const stagePath = `${harnessDir}/aidlc-common/stages/${phase}/${slug}.md`;
      const stageBody = files.get(stagePath);
      if (!stageBody) throw new Error(`native-export: native stage file is missing: ${stagePath}`);
      const parsed = parseMarkdownFrontmatter(stageBody, stagePath);
      files.set(stagePath, Buffer.from(renderStageScopes(parsed, scopes)));
    }
    return { ...stage, scopes };
  });

  if (!files.has(scopePath)) {
    files.set(scopePath, Buffer.from(renderScopeDefinition(nativeScope)));
  }
  grid[nativeScope] = { stages: desiredGrid };
  const sortedGrid = Object.fromEntries(
    Object.entries(grid).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  files.set(graphPath, Buffer.from(`${JSON.stringify(updatedGraph, null, 2)}\n`));
  files.set(gridPath, Buffer.from(`${JSON.stringify(sortedGrid, null, 2)}\n`));
  return { files, registered: true, scope: nativeScope };
};

const alignProjectionToDistribution = ({ projection, distributionFiles, harness }) => {
  const dataDir = HARNESS_DATA_DIRS[harness];
  const graphBody = distributionFiles.get(`${dataDir}/stage-graph.json`);
  if (!graphBody) throw new Error(`native-export: ${harness} distribution has no stage graph`);
  const graph = JSON.parse(graphBody.toString('utf8'));
  if (!Array.isArray(graph) || graph.length === 0) {
    throw new Error(`native-export: ${harness} distribution stage graph is invalid`);
  }
  const requested = new Map(projection.stages.map((stage) => [stage.stageId, stage]));
  const nativeIds = new Set(graph.map((stage) => stage.slug));
  const unknown = [...requested.keys()].filter((stageId) => !nativeIds.has(stageId));
  if (unknown.length > 0) {
    throw new Error(
      `native-export: stages are not present in the native harness: ${unknown.join(', ')}`,
    );
  }
  const requestedOrder = projection.stages
    .filter((stage) => !stage.excluded)
    .map((stage) => stage.stageId);
  const nativeOrder = graph
    .map((stage) => stage.slug)
    .filter((stageId) => requested.has(stageId) && !requested.get(stageId).excluded);
  if (requestedOrder.join('\0') !== nativeOrder.join('\0')) {
    throw new Error('native-export: workflow stage order differs from the native harness');
  }
  const stages = graph.map((nativeStage) => {
    const cloudStage = requested.get(nativeStage.slug);
    return {
      stageId: nativeStage.slug,
      phase: nativeStage.phase,
      number: nativeStage.number,
      leadAgent: cloudStage?.agentRef ?? nativeStage.lead_agent,
      produces:
        cloudStage?.outputArtifacts?.map((artifact) => artifact.artifact) ??
        nativeStage.produces ??
        [],
      forEach: cloudStage?.forEach ?? nativeStage.for_each ?? null,
      ...cloudStage,
      excluded: cloudStage?.excluded ?? !cloudStage,
    };
  });
  const nativeScope = assertNativeScopeName(projection.intent?.scope);
  return { ...projection, stages, nativeScope };
};

const buildZip = async (files) => {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const chunks = [];
  let bytes = 0;
  const completed = new Promise((resolve, reject) => {
    archive.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_EXPORT_BYTES) {
        archive.abort();
        reject(new Error('native-export: archive exceeds the 100 MB limit'));
        return;
      }
      chunks.push(chunk);
    });
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const [path, body] of files) {
    archive.append(body, { name: safeArchivePath(path) });
  }
  await archive.finalize();
  return completed;
};

const createNativeExport = async ({
  s3,
  bucket,
  upstreamRef,
  harness,
  projection,
  now = new Date().toISOString(),
  presign = getSignedUrl,
  warnings = [],
  sourceCheckpoint = null,
  validateSnapshot = null,
}) => {
  if (!bucket) throw new Error('native-export: artifacts bucket is not configured');
  if (!upstreamRef) throw new Error('native-export: upstream ref is not configured');

  const distribution = await loadDistribution({
    s3,
    bucket,
    upstreamRef,
    harness,
  });
  const alignedProjection = alignProjectionToDistribution({
    projection,
    distributionFiles: distribution.files,
    harness,
  });
  const registeredScope = registerNativeScope({
    distributionFiles: distribution.files,
    harness,
    stages: alignedProjection.stages,
    scope: alignedProjection.nativeScope,
  });
  const distributionFiles = registeredScope.files;
  const constructionCapabilities = detectConstructionCapabilities({
    distributionFiles,
    harness,
  });
  const customRuleFiles = await loadCustomRules({
    s3,
    bucket,
    harness,
    distributionFiles,
    customRules: projection.intent.customRules,
  });
  const projected = projectNativeWorkspace({
    ...alignedProjection,
    upstreamRef,
    harness,
    workspaceLayout: distribution.workspaceLayout,
    now,
  });
  const nextUnit = projected.manifest.construction?.nextUnit ?? null;
  const effectiveWarnings = [...warnings];
  if (nextUnit && !constructionCapabilities.perUnitIteration) {
    effectiveWarnings.push(
      `This pinned AI-DLC runtime predates deterministic per-unit Construction iteration. ` +
        `The complete Bolt DAG is included; explicitly ask AI-DLC to continue Construction ` +
        `with unit "${nextUnit}" when resuming.`,
    );
  }
  const files = new Map(distributionFiles);
  for (const [path, body] of customRuleFiles) files.set(path, body);
  for (const [path, body] of projected.files) files.set(path, Buffer.from(body));

  const manifest = {
    ...projected.manifest,
    ...(sourceCheckpoint ? { checkpoint: sourceCheckpoint } : {}),
    native: {
      ...projected.manifest.native,
      scopeRegistered: registeredScope.registered,
    },
    warnings: effectiveWarnings,
    files: [...files]
      .filter(([path]) => path !== 'export-manifest.json')
      .map(([path, body]) => ({
        path,
        bytes: body.length,
        sha256: sha256(body),
      }))
      .toSorted((a, b) => a.path.localeCompare(b.path)),
  };
  files.set('export-manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  const zip = await buildZip(files);
  if (validateSnapshot && !(await validateSnapshot())) {
    throw Object.assign(
      new Error('The intent changed while the workspace was being exported. Retry the export.'),
      { code: 'export_snapshot_changed' },
    );
  }
  const exportId = randomUUID();
  const key = `workflow-exports/${projection.intent.intentId}/${exportId}.zip`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: zip,
      ContentType: 'application/zip',
      ContentDisposition: `attachment; filename="${projected.recordDir}-${harness}.zip"`,
      Metadata: {
        intentId: projection.intent.intentId,
        upstreamRef,
        harness,
      },
    }),
  );
  const downloadUrl = await presign(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${projected.recordDir}-${harness}.zip"`,
    }),
    { expiresIn: DOWNLOAD_TTL_SECONDS },
  );
  const syncCommand = workspaceSyncCommand({ distributionFiles, harness });
  const setupMode =
    projected.manifest.repositories.length === 0
      ? 'extract-only'
      : syncCommand
        ? 'workspace-sync'
        : distribution.workspaceLayout === 'spaces'
          ? 'manual-workspace'
          : 'manual-clone';
  return {
    exportId,
    filename: `${projected.recordDir}-${harness}.zip`,
    downloadUrl,
    expiresAt: new Date(Date.parse(now) + DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
    warnings: effectiveWarnings,
    ...(sourceCheckpoint ? { checkpoint: sourceCheckpoint } : {}),
    setup: {
      workspaceLayout: distribution.workspaceLayout,
      mode: setupMode,
      harnessDir: harnessRootDir(harness),
      ...HARNESS_SESSION_COMMANDS[harness],
      showWorkspaceSetup: shouldShowWorkspaceSetup(projected.stages),
      repositories: projected.manifest.repositories,
      ...(projected.manifest.construction
        ? {
            construction: {
              nextUnit,
              completedUnits: projected.manifest.construction.completedUnits,
              readyUnits: projected.manifest.construction.readyUnits,
              perUnitIteration: constructionCapabilities.perUnitIteration,
            },
          }
        : {}),
      ...(syncCommand ? { syncCommand } : {}),
    },
  };
};

export {
  DOWNLOAD_TTL_SECONDS,
  MAX_EXPORT_BYTES,
  bodyToBuffer,
  alignProjectionToDistribution,
  buildZip,
  createNativeExport,
  detectConstructionCapabilities,
  detectWorkspaceLayout,
  fetchAndCacheDistribution,
  loadDistribution,
  loadCustomRules,
  registerNativeScope,
  resolveRulesDir,
  safeArchivePath,
  shouldShowWorkspaceSetup,
  workspaceSyncCommand,
};

export default { createNativeExport };
