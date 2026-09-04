// Stage-exit CodeFile projection. Git remains the universal source of changed
// files; a valid, stage-produced traceability.json adds precise evidence edges.
// Missing/malformed traceability is an expected legacy mode and never blocks a
// stage — callers still ingest the Git topology.

import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { createGraphWriter, closeGraphSource, traceabilitySlug } from './mcp/graph-writer.js';

// Re-exported from the persistence module so collection and persistence share
// ONE slug implementation (they must agree to match evidence to vertices).
export { traceabilitySlug };

const TRACEABILITY_FILE = 'traceability.json';

// Agent-produced traceability.json is untrusted input. Cap the size before
// readFile+JSON.parse so a pathological artifact degrades (treated as invalid)
// instead of risking OOM. 5 MiB is far above any legitimate coverage manifest.
const MAX_TRACEABILITY_BYTES = 5 * 1024 * 1024;

// Neptune serializes concurrent vertex/edge writes optimistically; parallel unit
// lanes committing at once can collide with a ConcurrentModificationException.
// Reuse the codebase's attempt-loop-with-linear-backoff shape (cli/codex-store.js)
// so a transient collision is retried before the projection degrades.
const CME_RETRY_DELAYS_MS = [100, 250, 500];
export const isConcurrentModification = (error) =>
  /ConcurrentModification|ConcurrentModificationException|concurrent(?:ly)? modif/i.test(
    `${error?.name ?? ''} ${error?.message ?? ''} ${error?.code ?? ''}`,
  );

export const normalizeWorkspacePath = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const portable = value.trim().replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[a-zA-Z]:\//.test(portable)) return null;
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized;
};

export const classifyFileKind = (filePath) => {
  const normalized = String(filePath ?? '').toLowerCase();
  const name = path.posix.basename(normalized);
  if (
    /(^|\/)(__tests__|tests?|spec)(\/|$)/.test(normalized) ||
    /\.(test|spec)\.[^.]+$/.test(name)
  ) {
    return 'test';
  }
  if (/(^|\/)(docs?|documentation)(\/|$)/.test(normalized) || /\.(md|mdx|rst|adoc)$/.test(name)) {
    return 'documentation';
  }
  if (
    /(^|\/)(config|terraform|\.github)(\/|$)/.test(normalized) ||
    /(^|\.)(env|ya?ml|json|toml|ini|tf|tfvars|lock)$/.test(name) ||
    /^(dockerfile|makefile)$/.test(name)
  ) {
    return 'configuration';
  }
  return 'implementation';
};

export const validateTraceabilityDocument = (
  value,
  { expectedStage = null, expectedUnit = null } = {},
) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: 'document must be an object' };
  }
  const stage = typeof value.stage === 'string' ? value.stage.trim() : '';
  const unit = typeof value.unit === 'string' ? value.unit.trim() : '';
  if (!stage || !unit || !Array.isArray(value.coverage)) {
    return { valid: false, reason: 'stage, unit, and coverage are required' };
  }
  if (expectedStage && stage !== expectedStage) {
    return { valid: false, reason: `stage mismatch (${stage})` };
  }
  if (expectedUnit && unit !== expectedUnit) {
    return { valid: false, reason: `unit mismatch (${unit})` };
  }

  const coverage = [];
  for (const [index, entry] of value.coverage.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { valid: false, reason: `coverage[${index}] must be an object` };
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const status = typeof entry.status === 'string' ? entry.status.trim().toUpperCase() : '';
    const target = entry.target == null ? null : normalizeWorkspacePath(entry.target);
    if (!id || !status || (entry.target != null && !target) || (status === 'OK' && !target)) {
      return { valid: false, reason: `coverage[${index}] is invalid` };
    }
    coverage.push({ id, status, target });
  }
  return { valid: true, document: { stage, unit, coverage } };
};

const isPresentFile = async (root, filePath) => {
  try {
    const entry = await lstat(path.resolve(root, filePath));
    return entry.isFile() || entry.isSymbolicLink();
  } catch {
    return false;
  }
};

export const loadProducedTraceability = async ({ repoDir, changedFiles, stageId, unitSlug }) => {
  const candidates = changedFiles
    .filter((file) => path.posix.basename(file).toLowerCase() === TRACEABILITY_FILE)
    .toSorted();
  if (candidates.length === 0) return { status: 'missing', document: null, files: [] };

  const valid = [];
  for (const file of candidates) {
    try {
      const artifactPath = path.resolve(repoDir, file);
      const stat = await lstat(artifactPath);
      if (!stat.isFile() || stat.size > MAX_TRACEABILITY_BYTES) continue;
      const parsed = JSON.parse(await readFile(artifactPath, 'utf8'));
      const result = validateTraceabilityDocument(parsed, {
        expectedStage: stageId,
        expectedUnit: unitSlug,
      });
      if (result.valid) valid.push({ file, document: result.document });
    } catch {
      // Invalid JSON is the same supported degraded mode as an invalid schema.
    }
  }
  if (valid.length === 0) return { status: 'invalid', document: null, files: candidates };

  // A non-unit stage passes expectedUnit=null, so two manifests declaring
  // DIFFERENT units can both validate. Merging their coverage under the first
  // manifest's unit would mis-stamp the batch, so keep only manifests that
  // agree with the first unit.
  const first = valid[0].document;
  const merged = valid.filter(({ document }) => document.unit === first.unit);
  return {
    status: 'valid',
    document: {
      stage: first.stage,
      unit: first.unit,
      coverage: merged.flatMap(({ document }) => document.coverage),
    },
    files: merged.map(({ file }) => file),
  };
};

export const collectCodeTraceabilityBatches = async ({
  gitResult,
  repos = [],
  workspaceDir,
  stageId,
  stageInstanceId,
  unitSlug = null,
}) => {
  const multi = repos.length > 1;
  const batches = [];
  for (const change of gitResult?.results ?? []) {
    if (!change?.repo || !change?.sha || !Array.isArray(change.files) || !change.files.length) {
      continue;
    }
    const repoDir = multi ? path.join(workspaceDir, change.repo) : workspaceDir;
    const normalized = [...new Set(change.files.map(normalizeWorkspacePath).filter(Boolean))];
    const files = [];
    for (const file of normalized) {
      if (await isPresentFile(repoDir, file)) files.push(file);
    }
    if (!files.length) continue;

    const traceability = await loadProducedTraceability({
      repoDir,
      changedFiles: files,
      stageId,
      unitSlug,
    });
    const evidenceByTarget = new Map();
    for (const entry of traceability.document?.coverage ?? []) {
      if (entry.status !== 'OK' || !files.includes(entry.target)) continue;
      if (!evidenceByTarget.has(entry.target)) evidenceByTarget.set(entry.target, new Set());
      evidenceByTarget.get(entry.target).add(entry.id);
    }

    batches.push({
      repository: change.repo,
      commitRef: change.sha,
      stageInstanceId,
      unitSlug: traceability.document?.unit ?? unitSlug,
      traceabilityStatus: traceability.status,
      files: files.map((filePath) => {
        const evidenceIds = [...(evidenceByTarget.get(filePath) ?? [])].toSorted();
        return {
          filePath,
          fileKind: classifyFileKind(filePath),
          traceabilitySource: evidenceIds.length ? 'aidlc-traceability' : 'git',
          summary: evidenceIds.length ? `Implements ${evidenceIds.join(', ')}` : '',
          evidenceIds,
        };
      }),
    });
  }
  return batches;
};

export const ingestStageCodeTraceability = async ({
  openGraph,
  scope,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  createWriter = createGraphWriter,
  ...input
}) => {
  const batches = await collectCodeTraceabilityBatches(input);
  if (!batches.length || !openGraph) {
    return { batches: batches.length, codeFiles: 0, evidenceEdges: 0, statuses: [] };
  }

  let g = null;
  try {
    g = await openGraph();
    const writer = createWriter({ g, scope });
    let codeFiles = 0;
    let evidenceEdges = 0;
    for (const batch of batches) {
      // Retry a transient CME (parallel unit lanes colliding on the shared
      // Intent anchor); only a persistent failure propagates to degrade.
      let result;
      for (let attempt = 0; ; attempt += 1) {
        try {
          result = await writer.ingestCodeFiles(batch);
          break;
        } catch (error) {
          if (!isConcurrentModification(error) || attempt >= CME_RETRY_DELAYS_MS.length)
            throw error;
          await sleep(CME_RETRY_DELAYS_MS[attempt]);
        }
      }
      codeFiles += result.codeFiles;
      evidenceEdges += result.evidenceEdges;
    }
    return {
      batches: batches.length,
      codeFiles,
      evidenceEdges,
      statuses: batches.map((batch) => batch.traceabilityStatus),
    };
  } finally {
    await closeGraphSource(g);
  }
};
