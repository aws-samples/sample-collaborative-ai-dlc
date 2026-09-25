#!/usr/bin/env node

// Generate compact, deterministic offline evidence for the five pinned
// awslabs/aidlc-workflows commits used by AI-DLC compatibility analysis.
//
// The fixture keeps frontmatter and import edges, but never stores upstream
// prose bodies. It is intentionally a snapshot tool, not a general-purpose
// upstream downloader: only the exact SHAs below may be fetched.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AIDLC_COMPATIBILITY_PROFILES } from '../lambda/shared/aidlc-compatibility-profiles.js';
import { fetchCoreFiles } from '../lambda/shared/repo-fetch.js';
import { canonicalJson } from '../lambda/shared/workflow-checkpoint.js';

const REPOSITORY = 'awslabs/aidlc-workflows';
const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'lambda/shared/test/fixtures/aidlc-compatibility',
);
const BODY_PLACEHOLDER = '[AI-DLC COMPATIBILITY FIXTURE BODY OMITTED]';
const RUNTIME_PLACEHOLDER = '[AI-DLC COMPATIBILITY RUNTIME CONTENT OMITTED]';
const SENSOR_PLACEHOLDER = '[AI-DLC COMPATIBILITY SENSOR BODY OMITTED]';

const SOURCES = Object.freeze(
  Object.values(AIDLC_COMPATIBILITY_PROFILES).map((profile) =>
    Object.freeze({
      id: profile.id,
      label: profile.label,
      releaseId: profile.releaseId,
      sha: profile.upstreamRef,
    }),
  ),
);

const FRONTMATTER_PATHS = [
  'core/aidlc-common/stages/',
  'core/agents/',
  'core/scopes/',
  'core/sensors/',
  'core/skills/',
  'core/templates/',
];

const isFrontmatterPath = (repoPath) =>
  FRONTMATTER_PATHS.some(
    (prefix) =>
      repoPath.startsWith(prefix) &&
      repoPath.endsWith('.md') &&
      (!repoPath.startsWith('core/skills/') || repoPath.endsWith('/SKILL.md')),
  );

const isPathOnlyPath = (repoPath) =>
  repoPath.startsWith('core/rules/') ||
  repoPath.startsWith('core/memory/') ||
  repoPath.startsWith('core/knowledge/');

const isSensorScriptPath = (repoPath) =>
  repoPath.startsWith('core/tools/aidlc-sensor-') && repoPath.endsWith('.ts');

const isRuntimePath = (repoPath) =>
  (repoPath.startsWith('core/tools/') && !repoPath.startsWith('core/tools/data/')) ||
  repoPath.startsWith('core/hooks/') ||
  repoPath.startsWith('core/aidlc-common/protocols/') ||
  repoPath === 'core/aidlc-common/conductor.md';

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

const sortedEntries = (map) =>
  [...map.entries()].toSorted(([left], [right]) => left.localeCompare(right));

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortKeys(item)]),
  );
};

const replaceFrontmatterBody = (content) => {
  const match = String(content).match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) throw new Error('expected frontmatter-bearing markdown file');
  return `${match[0]}${BODY_PLACEHOLDER}\n`;
};

const hasFrontmatter = (content) => /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(String(content));

const relativeImportStatements = (content) => {
  const source = String(content);
  const matches = [];
  const patterns = [
    /(^|\n)([ \t]*import\b[\s\S]*?\bfrom\s*['"](?:\.{1,2}\/)[^'"]+['"]\s*;?)/g,
    /(^|\n)([ \t]*import\s*['"](?:\.{1,2}\/)[^'"]+['"]\s*;?)/g,
    /(^|\n)([^\n]*\bimport\s*\(\s*['"](?:\.{1,2}\/)[^'"]+['"]\s*\)[^\n]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      matches.push({ index: match.index, statement: match[2] });
    }
  }
  return matches
    .toSorted((left, right) => left.index - right.index)
    .map(({ statement }) => statement);
};

const replaceSensorBody = (content) => {
  const imports = relativeImportStatements(content);
  return `${imports.length ? `${imports.join('\n')}\n` : ''}${SENSOR_PLACEHOLDER}\n`;
};

const isRuntimeCodePath = (repoPath) => /\.(?:js|mjs|cjs|ts)$/.test(repoPath);

const replaceRuntimeBody = (content) => {
  const imports = relativeImportStatements(content);
  return `${imports.length ? `${imports.join('\n')}\n` : ''}${RUNTIME_PLACEHOLDER}\n`;
};

const projectedRecord = (kind, content, originalSha256) => ({
  kind,
  content,
  fixtureSha256: sha256(content),
  originalSha256,
});

const fileRecord = (repoPath, content) => {
  const originalSha256 = sha256(content);
  if (isFrontmatterPath(repoPath) && hasFrontmatter(content)) {
    return projectedRecord('frontmatter', replaceFrontmatterBody(content), originalSha256);
  }
  if (isPathOnlyPath(repoPath) || isFrontmatterPath(repoPath)) {
    return projectedRecord('path-only', `${BODY_PLACEHOLDER}\n`, originalSha256);
  }
  if (isSensorScriptPath(repoPath)) {
    return projectedRecord('sensor-script', replaceSensorBody(content), originalSha256);
  }
  return null;
};

const snapshotFor = async (source) => {
  const upstreamFiles = await fetchCoreFiles(source.sha);
  const files = {};
  const runtimeFiles = [];
  const originalFileHashes = {};

  for (const [repoPath, content] of sortedEntries(upstreamFiles)) {
    const originalSha256 = sha256(content);
    originalFileHashes[repoPath] = originalSha256;

    const record = fileRecord(repoPath, content);
    if (record) files[repoPath] = record;
    if (isRuntimePath(repoPath)) {
      if (!record) {
        const projectedContent = isRuntimeCodePath(repoPath)
          ? replaceRuntimeBody(content)
          : `${RUNTIME_PLACEHOLDER}\n`;
        files[repoPath] = projectedRecord(
          isRuntimeCodePath(repoPath) ? 'runtime-code' : 'runtime-path',
          projectedContent,
          originalSha256,
        );
      }
      runtimeFiles.push({
        path: repoPath,
        fixtureSha256: files[repoPath].fixtureSha256,
        originalSha256,
      });
    }
  }

  if (Object.keys(files).length === 0) {
    throw new Error(`no importer fixture files found at ${source.sha}`);
  }
  if (runtimeFiles.length === 0) {
    throw new Error(`no runtime files found at ${source.sha}`);
  }

  return {
    schemaVersion: 1,
    source: {
      id: source.id,
      repository: REPOSITORY,
      label: source.label,
      releaseId: source.releaseId,
      ref: source.sha,
      sha: source.sha,
    },
    redaction: {
      frontmatterBody: BODY_PLACEHOLDER,
      pathOnlyBody: BODY_PLACEHOLDER,
      sensorBody: SENSOR_PLACEHOLDER,
      runtimeBody: RUNTIME_PLACEHOLDER,
    },
    files,
    runtimeFiles,
    originalFileHashes,
  };
};

const sourceForArg = (argument) => {
  if (!argument) return SOURCES;
  const source = SOURCES.find(({ id, sha }) => id === argument || sha === argument);
  if (!source) {
    throw new Error(
      `unsupported source "${argument}"; use one of: ${SOURCES.map(({ id }) => id).join(', ')}`,
    );
  }
  return [source];
};

const main = async () => {
  const sources = sourceForArg(process.argv[2]);
  await mkdir(FIXTURE_DIR, { recursive: true });

  for (const source of sources) {
    const fixture = await snapshotFor(source);
    const outputPath = path.join(FIXTURE_DIR, `${source.id}.json`);
    await writeFile(outputPath, `${JSON.stringify(sortKeys(fixture), null, 2)}\n`, 'utf8');
    const fixtureDigest = sha256(canonicalJson(fixture));
    console.error(
      `wrote ${outputPath}: ${Object.keys(fixture.files).length} importer files, ${fixture.runtimeFiles.length} runtime files, fixture digest ${fixtureDigest}`,
    );
  }
};

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export {
  BODY_PLACEHOLDER,
  FIXTURE_DIR,
  RUNTIME_PLACEHOLDER,
  SENSOR_PLACEHOLDER,
  SOURCES,
  fileRecord,
  replaceFrontmatterBody,
  replaceSensorBody,
  relativeImportStatements,
  sortKeys,
  snapshotFor,
};
