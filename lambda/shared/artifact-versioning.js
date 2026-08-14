import { createHash } from 'node:crypto';
import gremlin from 'gremlin';
import { flattenVertexMap } from './graph-rows.js';

const __ = gremlin.process.statics;
const { cardinality, t: T, P } = gremlin.process;

export const ARTIFACT_VERSION_LABEL = 'ArtifactVersion';
export const HAS_VERSION_EDGE = 'HAS_VERSION';
export const HAS_CHECKPOINT_VERSION_EDGE = 'HAS_CHECKPOINT_VERSION';
export const VERSIONED_RELATIONSHIP_EDGES = [
  'PRODUCES',
  'CONSUMES',
  'DERIVED_FROM',
  'RELATES_TO',
  'DEPENDS_ON',
  'CITES',
];

export class CheckpointArtifactUnavailableError extends Error {
  constructor({ versionId, reason }) {
    super(`workflow-checkpoint: artifact version ${versionId} is unavailable (${reason})`);
    this.name = 'CheckpointArtifactUnavailableError';
    this.code = 'export_checkpoint_unavailable';
    this.versionId = versionId;
    this.reason = reason;
  }
}

const dimension = (value) => (value === undefined || value === null ? '' : String(value));

export const artifactLogicalKey = ({
  intentId,
  sectionIndex = null,
  unitSlug = null,
  stageInstanceId = null,
  artifactType = null,
}) =>
  JSON.stringify([
    dimension(intentId),
    dimension(sectionIndex),
    dimension(unitSlug),
    dimension(stageInstanceId),
    dimension(artifactType),
  ]);

export const artifactLogicalKeyFromRow = (row, intentId = row?.intent_id) =>
  row?.artifact_logical_key ||
  artifactLogicalKey({
    intentId,
    sectionIndex: row?.section_index,
    unitSlug: row?.unit_slug,
    stageInstanceId: row?.created_by_stage_instance_id,
    artifactType: row?.artifact_type,
  });

export const artifactAliases = (row) => {
  if (Array.isArray(row?.artifact_aliases)) return row.artifact_aliases.map(String);
  if (typeof row?.artifact_aliases !== 'string' || !row.artifact_aliases) return [];
  try {
    const parsed = JSON.parse(row.artifact_aliases);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const rowTimestamp = (row) =>
  String(row?.updated_at || row?.edited_at || row?.created_at || row?.archived_at || '');

const compareNewest = (a, b) => {
  const byTime = rowTimestamp(b).localeCompare(rowTimestamp(a));
  if (byTime) return byTime;
  const byId = String(b?.id ?? '').localeCompare(String(a?.id ?? ''));
  if (byId) return byId;
  return String(b?.vertexId ?? '').localeCompare(String(a?.vertexId ?? ''));
};

// Legacy groups may contain multiple Artifact vertices for one logical output.
// Prefer the newest current row; if every row is superseded, keep the fallback
// deterministic so history reads and replayed restarts choose the same head.
export const selectCanonicalArtifact = (rows = []) => {
  const sorted = rows.toSorted(compareNewest);
  return sorted.find((row) => !row?.superseded_at) ?? sorted[0] ?? null;
};

// Adapt legacy intents lazily: old runs may have one Artifact vertex per rerun
// instead of one stable head. Collapse each logical identity to its canonical
// non-superseded row for every normal read surface. A group whose newest
// canonical row is superseded has no current output until a rerun rehabilitates
// the head.
export const selectCurrentArtifactHeads = (rows = [], intentId = undefined) => {
  const groups = new Map();
  for (const row of rows) {
    const key = artifactLogicalKeyFromRow(row, intentId ?? row?.intent_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()]
    .map(selectCanonicalArtifact)
    .filter((row) => row && !row.superseded_at);
};

export const sameLogicalArtifact = (row, identity) => {
  if (!row) return false;
  const expected = artifactLogicalKey(identity);
  if (row.artifact_logical_key) return row.artifact_logical_key === expected;
  if (
    dimension(row.created_by_stage_instance_id) !== dimension(identity.stageInstanceId) ||
    dimension(row.artifact_type) !== dimension(identity.artifactType)
  ) {
    return false;
  }
  // Old rows did not carry section/unit metadata. The stage instance is already
  // lane-specific, so absent legacy dimensions remain compatible; explicit
  // dimensions must agree.
  if (
    row.section_index !== undefined &&
    row.section_index !== null &&
    dimension(row.section_index) !== dimension(identity.sectionIndex)
  ) {
    return false;
  }
  if (
    row.unit_slug !== undefined &&
    row.unit_slug !== null &&
    dimension(row.unit_slug) !== dimension(identity.unitSlug)
  ) {
    return false;
  }
  return true;
};

export const readIntentArtifactEntries = async (g, intentId) => {
  const rows = await g
    .V()
    .has('Intent', 'id', intentId)
    .out('CONTAINS')
    .hasLabel('Artifact')
    .project('vertexId', 'props')
    .by(T.id)
    .by(__.valueMap(true))
    .toList();
  return rows.map((row) => ({
    vertexId: row.get('vertexId'),
    ...flattenVertexMap(row.get('props')),
  }));
};

export const legacyVersionId = (row) =>
  `legacy:${createHash('sha256')
    .update(
      JSON.stringify([
        row?.id ?? '',
        row?.created_at ?? '',
        row?.updated_at ?? '',
        row?.created_by_stage_instance_id ?? '',
        row?.content ?? '',
      ]),
    )
    .digest('hex')
    .slice(0, 20)}`;

const relationshipSnapshot = async (g, vertexId) => {
  const outgoing = await g
    .V(vertexId)
    .outE(...VERSIONED_RELATIONSHIP_EDGES)
    .project('edge', 'artifactId')
    .by(T.label)
    .by(__.inV().coalesce(__.values('id'), __.constant('')))
    .toList();
  const incoming = await g
    .V(vertexId)
    .inE(...VERSIONED_RELATIONSHIP_EDGES)
    .project('edge', 'artifactId')
    .by(T.label)
    .by(__.outV().coalesce(__.values('id'), __.constant('')))
    .toList();
  return [
    ...outgoing.map((row) => ({
      direction: 'out',
      edge: row.get('edge'),
      artifactId: row.get('artifactId'),
    })),
    ...incoming.map((row) => ({
      direction: 'in',
      edge: row.get('edge'),
      artifactId: row.get('artifactId'),
    })),
  ];
};

const setProperties = async (traversal, properties) => {
  let q = traversal;
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null) continue;
    const stored =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : JSON.stringify(value);
    q = q.property(cardinality.single, key, stored);
  }
  await q.next();
};

const ARTIFACT_SNAPSHOT_FIELDS = [
  'id',
  'artifact_type',
  'title',
  'created_by_execution_id',
  'created_by_stage_instance_id',
  'section_index',
  'unit_slug',
  'repository',
  'stage_attempt',
  'generation',
  'artifact_aliases',
  'created_at',
  'updated_at',
  'stale_since',
  'stale_reason',
  'edited_by',
  'edited_by_name',
  'edited_at',
  'edit_origin',
  'verified_by',
  'verified_by_name',
  'verified_at',
  'summary_gist',
  'summary_claims',
  'enrichment_model',
  'content',
];

// Keep only artifact properties that affect native projection and provenance;
// graph bookkeeping must not create a distinct immutable version.
export const artifactSnapshot = (row) =>
  Object.fromEntries(
    ARTIFACT_SNAPSHOT_FIELDS.filter((field) => row[field] !== undefined).map((field) => [
      field,
      row[field],
    ]),
  );

// Content-address the complete export-relevant artifact snapshot, not only its
// Markdown body, so attribution or repository changes produce a new version.
export const artifactSnapshotHash = (row) =>
  createHash('sha256')
    .update(JSON.stringify(artifactSnapshot(row)))
    .digest('hex');

const ensureCheckpointVersion = async ({ g, intentId, canonical, logicalKey, checkpointedAt }) => {
  const snapshotHash = artifactSnapshotHash(canonical);
  const versionId = `${canonical.id}:sha256:${snapshotHash}`;
  let versionVertexId = (
    await g
      .V()
      .has(ARTIFACT_VERSION_LABEL, 'id', versionId)
      .has('intent_id', intentId)
      .limit(1)
      .id()
      .toList()
  )[0];
  if (versionVertexId === undefined) {
    const content = String(canonical.content ?? '');
    await setProperties(g.addV(ARTIFACT_VERSION_LABEL), {
      ...artifactSnapshot(canonical),
      id: versionId,
      artifact_id: canonical.id,
      intent_id: intentId,
      artifact_logical_key: logicalKey,
      checkpointed_at: checkpointedAt,
      content_length: Buffer.byteLength(content, 'utf8'),
      content_type: 'text/markdown',
      content_hash: createHash('sha256').update(content).digest('hex'),
      snapshot_hash: snapshotHash,
    });
    versionVertexId = (
      await g
        .V()
        .has(ARTIFACT_VERSION_LABEL, 'id', versionId)
        .has('intent_id', intentId)
        .limit(1)
        .id()
        .next()
    ).value;
  }
  const linked = await g
    .V()
    .has('Intent', 'id', intentId)
    .outE(HAS_CHECKPOINT_VERSION_EDGE)
    .where(__.inV().hasId(versionVertexId))
    .hasNext();
  if (!linked) {
    await g
      .V()
      .has('Intent', 'id', intentId)
      .addE(HAS_CHECKPOINT_VERSION_EDGE)
      .to(__.V(versionVertexId))
      .next();
  }
  return {
    artifactId: canonical.id,
    logicalKey,
    versionId,
    snapshotHash,
  };
};

// Materialize immutable versions for every current logical artifact head.
// Unchanged heads reuse their existing content-addressed version.
export const snapshotCurrentArtifactHeads = async ({
  g,
  intentId,
  clock = () => new Date().toISOString(),
}) => {
  const heads = selectCurrentArtifactHeads(await readIntentArtifactEntries(g, intentId), intentId);
  const checkpointedAt = clock();
  const refs = [];
  for (const canonical of heads.toSorted((a, b) =>
    artifactLogicalKeyFromRow(a, intentId).localeCompare(artifactLogicalKeyFromRow(b, intentId)),
  )) {
    const logicalKey = artifactLogicalKeyFromRow(canonical, intentId);
    refs.push(
      await ensureCheckpointVersion({
        g,
        intentId,
        canonical,
        logicalKey,
        checkpointedAt,
      }),
    );
  }
  return refs;
};

// Hydrate the exact immutable artifact versions named by a workflow checkpoint
// and reject missing or mismatched references instead of falling back to heads.
export const readCheckpointArtifactVersions = async ({ g, intentId, refs = [] }) => {
  if (refs.length === 0) return [];
  const ids = refs.map((ref) => ref.versionId);
  const rows = await g
    .V()
    .hasLabel(ARTIFACT_VERSION_LABEL)
    .has('intent_id', intentId)
    .has('id', P.within(...ids))
    .valueMap(true)
    .toList();
  const byId = new Map(
    rows.map((row) => {
      const flat = flattenVertexMap(row);
      return [flat.id, flat];
    }),
  );
  return refs.map((ref) => {
    const row = byId.get(ref.versionId);
    if (!row) {
      throw new CheckpointArtifactUnavailableError({
        versionId: ref.versionId,
        reason: 'missing',
      });
    }
    if (row.snapshot_hash !== ref.snapshotHash) {
      throw new CheckpointArtifactUnavailableError({
        versionId: ref.versionId,
        reason: 'hash_mismatch',
      });
    }
    return row;
  });
};

const archiveOne = async ({
  g,
  intentId,
  canonical,
  logicalKey,
  archivedAt,
  restartId,
  reason,
  actor,
}) => {
  const generation = Math.max(1, Number(canonical.generation) || 1);
  const versionId = `${canonical.id}:v${generation}`;
  let versionVertexId = (
    await g
      .V()
      .has(ARTIFACT_VERSION_LABEL, 'id', versionId)
      .has('intent_id', intentId)
      .has('artifact_logical_key', logicalKey)
      .limit(1)
      .id()
      .toList()
  )[0];

  if (versionVertexId === undefined) {
    const relationships = await relationshipSnapshot(g, canonical.vertexId);
    const content = String(canonical.content ?? '');
    const immutable = {
      ...canonical,
      vertexId: undefined,
      id: versionId,
      artifact_id: canonical.id,
      intent_id: intentId,
      artifact_logical_key: logicalKey,
      generation,
      archived_at: archivedAt,
      restart_id: restartId,
      restart_reason: reason,
      archived_by: actor,
      content_length: Buffer.byteLength(content, 'utf8'),
      content_type: 'text/markdown',
      content_hash: createHash('sha256').update(content).digest('hex'),
      relationships: JSON.stringify(relationships),
    };
    await setProperties(g.addV(ARTIFACT_VERSION_LABEL), immutable);
    versionVertexId = (
      await g
        .V()
        .has(ARTIFACT_VERSION_LABEL, 'id', versionId)
        .has('intent_id', intentId)
        .has('artifact_logical_key', logicalKey)
        .limit(1)
        .id()
        .next()
    ).value;
  }

  const linked = await g
    .V(canonical.vertexId)
    .outE(HAS_VERSION_EDGE)
    .where(__.inV().hasId(versionVertexId))
    .hasNext();
  if (!linked) {
    await g.V(canonical.vertexId).addE(HAS_VERSION_EDGE).to(__.V(versionVertexId)).next();
  }
  return { versionId, generation };
};

// Snapshot current logical heads before a restart mutates any process rows.
// Every write is replay-safe: the immutable version is keyed by
// (artifact id, generation, logical identity), and HAS_VERSION is idempotent.
export const archiveArtifactsForStages = async ({
  g,
  intentId,
  stageInstanceIds,
  restartId,
  reason,
  actor,
  clock = () => new Date().toISOString(),
}) => {
  if (!stageInstanceIds?.length) return [];
  const affected = new Set(stageInstanceIds.map(String));
  const rows = (await readIntentArtifactEntries(g, intentId)).filter((row) =>
    affected.has(String(row.created_by_stage_instance_id ?? '')),
  );
  const groups = new Map();
  for (const row of rows) {
    const key = artifactLogicalKeyFromRow(row, intentId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const archivedAt = clock();
  const archived = [];
  for (const [logicalKey, group] of groups) {
    const canonical = selectCanonicalArtifact(group);
    if (!canonical) continue;
    const version = await archiveOne({
      g,
      intentId,
      canonical,
      logicalKey,
      archivedAt,
      restartId,
      reason,
      actor,
    });

    // All legacy siblings in the logical group must stop participating in
    // current reads, otherwise the next-newest row would resurface as current.
    for (const row of group) {
      await setProperties(g.V(row.vertexId), {
        artifact_logical_key: logicalKey,
        superseded_at: archivedAt,
        superseded_by: restartId,
        restart_reason: reason,
      });
      await g
        .V(row.vertexId)
        .out('HAS_SECTION', 'HAS_ITEM')
        .property(cardinality.single, 'superseded_at', archivedAt)
        .toList();
    }
    const versionCount = Number(
      (await g.V(canonical.vertexId).out(HAS_VERSION_EDGE).count().next()).value,
    );
    await g
      .V(canonical.vertexId)
      .property(cardinality.single, 'version_count', versionCount)
      .next();
    archived.push({
      artifactId: canonical.id,
      logicalKey,
      versionId: version.versionId,
      generation: version.generation,
    });
  }
  return archived;
};

export default {
  ARTIFACT_VERSION_LABEL,
  CheckpointArtifactUnavailableError,
  HAS_VERSION_EDGE,
  HAS_CHECKPOINT_VERSION_EDGE,
  VERSIONED_RELATIONSHIP_EDGES,
  artifactLogicalKey,
  artifactLogicalKeyFromRow,
  artifactAliases,
  sameLogicalArtifact,
  selectCanonicalArtifact,
  selectCurrentArtifactHeads,
  readIntentArtifactEntries,
  legacyVersionId,
  artifactSnapshot,
  artifactSnapshotHash,
  snapshotCurrentArtifactHeads,
  readCheckpointArtifactVersions,
  archiveArtifactsForStages,
};
