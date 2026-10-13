// Rebuildable indexes over admitted, immutable file bytes. No runtime state,
// model calls, private checkpoint reads or execution writes belong here.
import { createHash } from 'node:crypto';
import { extractDeclaredArtifactStructure } from '../shared/artifact-extractors.js';
import {
  NATIVE_ARTIFACT_CONTEXT_MAX_FILE_BYTES,
  nativeArtifactRevisionId,
} from '../shared/native-artifact-revision.js';
import { NATIVE_PUBLICATION_LIMITS } from '../shared/native-publication.js';
import { nativeFileExclusion, nativeCredentialPath } from '../shared/native-project-files.js';
import { nativeArtifactLocation } from '../shared/native-workspace-projector.js';

export const NATIVE_TRACE_CONTRACT = 'native-trace-v1';
const verified = new WeakMap();
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeOf = ({ draft, publication, manifest }) =>
  JSON.stringify([
    draft.projectId,
    draft.executionId,
    publication.id,
    publication.sequence,
    manifest.packageId,
    manifest.scope,
  ]);
const invalid = () => {
  throw Object.assign(new Error('Native trace source could not be verified'), {
    code: 'NATIVE_PUBLICATION_INVALID',
  });
};
const freezeTrace = (value) => {
  if (!value || typeof value !== 'object') return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeTrace(child);
};

export const verifiedNativeTrace = (trace, input) => {
  if (verified.get(trace) !== scopeOf(input)) invalid();
  return trace;
};

const traceFile = ({ file, extraction, draft, publication, manifest, id, locations }) => {
  const location = nativeArtifactLocation(file.path);
  const provenance = {
    projectId: draft.projectId,
    executionId: draft.executionId,
    publicationId: publication.id,
    publicationSequence: publication.sequence,
    packageId: manifest.packageId,
    fileId: file.id,
    sha256: file.sha256,
    revisionId: nativeArtifactRevisionId({ fileId: file.id, sha256: file.sha256 }),
    path: file.path,
    contract: NATIVE_TRACE_CONTRACT,
    method: 'deterministic',
  };
  const fileNodes = [];
  const fileEdges = [];
  const node = (type, label, key, source) => ({
    id: id(file.id, file.sha256, type, key),
    type,
    label,
    artifactId: file.id,
    path: file.path,
    sha256: file.sha256,
    publicationId: publication.id,
    provenance: { ...provenance, ...source },
  });
  for (const section of extraction.sections) {
    const derived = node('Section', section.heading, section.order, {
      sourceKind: 'markdown-section',
      startLine: section.startLine,
      endLine: section.endLine,
    });
    fileNodes.push(derived);
    fileEdges.push({ source: file.id, target: derived.id, label: 'HAS_SECTION' });
  }
  for (const [index, item] of extraction.items.entries()) {
    const derived = {
      ...node(item.label, item.title, index, {
        sourceKind: item.sourceKind,
        startLine: item.startLine,
        endLine: item.endLine,
        artifactType: item.artifactType,
        itemSlug: item.slug,
        itemOrder: item.order,
      }),
      // Authored claims stay explicitly namespaced. In particular a Decision
      // status never becomes an accepted approval or verified execution status.
      declared: item.props,
      logicalScope: location?.recordRoot ?? file.path,
      unit: location?.unit ?? null,
    };
    fileNodes.push(derived);
    fileEdges.push({ source: file.id, target: derived.id, label: 'HAS_ITEM' });
  }
  if (location) {
    const { contract: locationContract, ...recordLocation } = location;
    const locationNode = (type, key, label) => ({
      ...node(type, label, key, {
        sourceKind: 'record-path',
        locationContract,
        ...recordLocation,
      }),
      id: id(type, key),
    });
    const phaseKey = [location.recordRoot, location.phase];
    const stageKey = [...phaseKey, location.unit, location.stage];
    const phase = locationNode('NativePhase', phaseKey, location.phase);
    const stage = locationNode(
      'NativeStage',
      stageKey,
      `${location.stage}${location.unit ? ` · ${location.unit}` : ''}`,
    );
    for (const entry of [phase, stage]) if (!locations.has(entry.id)) fileNodes.push(entry);
    fileEdges.push(
      { source: file.id, target: stage.id, label: 'LOCATED_IN' },
      { source: stage.id, target: phase.id, label: 'LOCATED_IN' },
    );
  }
  return { fileNodes, fileEdges };
};

const resolveItemRelationships = (nodes, graphBytes) => {
  // Resolve explicit item references only within this publication and record
  // scope. Ambiguity is left unresolved, never guessed across lanes/files.
  const items = nodes.filter((node) => node.declared);
  const index = new Map();
  for (const item of items) {
    const key = JSON.stringify([item.logicalScope, item.type, item.provenance.itemSlug]);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(item);
  }
  const relationships = [];
  let relationshipStatus = 'indexed';
  for (const source of items) {
    const relations =
      source.type === 'Story'
        ? [
            ['covers', 'Requirement', 'COVERS'],
            ['persona', 'Persona', 'FOR_PERSONA'],
            ['depends_on', 'Story', 'DEPENDS_ON'],
          ]
        : source.type === 'Component'
          ? [['depends_on', 'Component', 'DEPENDS_ON']]
          : source.type === 'StoryMapEntry'
            ? [['stories', 'Story', 'IMPLEMENTS']]
            : [];
    for (const [field, type, label] of relations) {
      let refs;
      try {
        refs =
          field === 'persona'
            ? [source.declared[field]]
            : JSON.parse(source.declared[field] || '[]');
      } catch {
        continue;
      }
      for (const ref of new Set(refs.filter((value) => typeof value === 'string'))) {
        const targets = (index.get(JSON.stringify([source.logicalScope, type, ref])) ?? []).filter(
          (target) => target.unit === source.unit || target.unit === null,
        );
        if (targets.length === 1 && targets[0].id !== source.id) {
          const edge = { source: source.id, target: targets[0].id, label };
          graphBytes += Buffer.byteLength(JSON.stringify(edge));
          if (graphBytes > NATIVE_PUBLICATION_LIMITS.manifestBytes)
            relationshipStatus = 'structure_limit';
          else relationships.push(edge);
        }
      }
    }
  }
  return {
    edges: relationshipStatus === 'indexed' ? relationships : [],
    status: relationshipStatus,
  };
};

export const readNativePublicationTrace = async ({
  draft,
  publication,
  manifest,
  publications,
  authorize,
}) => {
  if (
    manifest.scope.projectId !== draft.projectId ||
    manifest.scope.executionId !== draft.executionId ||
    manifest.sequence !== publication.sequence
  )
    invalid();
  const nodes = [];
  const edges = [];
  const files = [];
  const locations = new Map();
  let readBytes = 0;
  let graphBytes = 0;
  const id = (...parts) =>
    `native-trace-${digest([
      draft.projectId,
      draft.executionId,
      publication.id,
      NATIVE_TRACE_CONTRACT,
      ...parts,
    ])}`;
  for (const file of manifest.files.toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    const report = { fileId: file.id, status: 'generic' };
    files.push(report);
    // Existing manifests stay readable under their original policy. Derivation
    // does not widen visibility of legacy private/harness or credential files:
    // only public Markdown/plain-text work products are indexed.
    if (
      nativeFileExclusion(file.path) ||
      nativeCredentialPath(file.path) ||
      !['artifact', 'question'].includes(file.role) ||
      !['text/markdown', 'text/plain'].includes(file.mediaType)
    )
      continue;
    if (
      file.bytes > NATIVE_ARTIFACT_CONTEXT_MAX_FILE_BYTES ||
      readBytes + file.bytes > NATIVE_ARTIFACT_CONTEXT_MAX_FILE_BYTES
    ) {
      report.status = 'byte_limit';
      continue;
    }
    await authorize();
    const { bytes } = await publications.file(manifest.scope, manifest, file.id);
    readBytes += file.bytes;
    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (content.includes('\0')) continue;
    } catch {
      continue;
    }
    const extraction = extractDeclaredArtifactStructure({ artifactId: file.id, content });
    if (extraction.limited) {
      report.status = 'structure_limit';
      continue;
    }
    const { fileNodes, fileEdges } = traceFile({
      file,
      extraction,
      draft,
      publication,
      manifest,
      id,
      locations,
    });
    const size = Buffer.byteLength(JSON.stringify([fileNodes, fileEdges]));
    if (
      nodes.length + fileNodes.length > NATIVE_PUBLICATION_LIMITS.files ||
      graphBytes + size > NATIVE_PUBLICATION_LIMITS.manifestBytes
    ) {
      report.status = 'structure_limit';
      continue; // No partial document is presented as complete extraction.
    }
    graphBytes += size;
    nodes.push(...fileNodes);
    edges.push(...fileEdges);
    for (const entry of fileNodes)
      if (entry.type === 'NativePhase' || entry.type === 'NativeStage')
        locations.set(entry.id, entry);
    report.status = extraction.incompatible
      ? 'incompatible'
      : fileNodes.length
        ? 'extracted'
        : 'generic';
  }
  const relationships = resolveItemRelationships(nodes, graphBytes);
  edges.push(...relationships.edges);
  const trace = {
    nodes,
    edges: [...new Map(edges.map((edge) => [JSON.stringify(edge), edge])).values()],
    traceability: {
      contract: NATIVE_TRACE_CONTRACT,
      enrichment: 'off',
      relationships: relationships.status,
      files,
    },
  };
  freezeTrace(trace);
  verified.set(trace, scopeOf({ draft, publication, manifest }));
  await authorize();
  return trace;
};
