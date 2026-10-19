// The engine's Neptune operations, one function per semantic call.
//
// engine-data runs these against a scope it rebuilt from a verified grant; the
// runtime's local (flag-off) adapter runs the same functions against its own
// connection, so both sides of the seam share one implementation. Each
// function takes the narrowed input engine-data accepts (see
// engine-data/graph-schemas.js) and returns plain JSON-safe data. Internal
// vertex ids never leave this module.
//
// Writer-shaped operations delegate to the graph writer; the named operations
// are the raw graph helpers the engine used to run itself (Intent anchor,
// inspect, discussion assist, Quorum edits, versioning). Ownership rules that
// need graph state the gateway cannot see up front raise EngineGraphScopeError,
// which engine-data reports as a denial.
import gremlin from 'gremlin';
import { createGraphWriter, DERIVED_ITEM_LABELS } from './mcp/graph-writer.js';
import { extractArtifactStructure } from './artifact-extractors.js';
import { contributionArtifactId } from './ensemble-contribution.js';
import { flattenVertexMap } from './graph-rows.js';
import { parseCliModels } from './cli-models.js';
import { parseTierModels } from './tier-models.js';
import {
  applyArtifactEdit,
  fetchDownstreamClosure,
  markArtifactsStale,
  verifyArtifact,
} from './artifact-edit.js';
import {
  archiveArtifactsForStages,
  artifactAliases,
  artifactLogicalKeyFromRow,
  readCurrentArtifactHeadHashes,
  readIntentArtifactEntries,
  selectCanonicalArtifact,
  selectCurrentArtifactHeads,
  snapshotCurrentArtifactHeads,
} from './artifact-versioning.js';

const { cardinality } = gremlin.process;
const __ = gremlin.process.statics;

export const ITEM_TYPES = Object.freeze([...DERIVED_ITEM_LABELS, 'ArtifactItem']);

// Limits the discussion prompt already applies; applying them here keeps the
// response bounded without changing what the prompt sees.
export const DISCUSSION_MAX_MESSAGE_CONTENT = 2000;
export const DISCUSSION_MAX_RECENT_MESSAGES = 40;
export const DISCUSSION_MAX_ANCHOR_CONTENT = 12 * 1024;

const QUORUM_ACTOR = Object.freeze({ id: 'quorum', name: 'Quorum' });

export class EngineGraphScopeError extends Error {
  constructor(reason) {
    super('Graph reference is outside the granted scope');
    this.name = 'EngineGraphScopeError';
    this.code = reason;
  }
}

export class EngineGraphError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EngineGraphError';
    this.code = code;
  }
}

// The Intent anchor's ownership, read without trusting any caller input.
export const readIntentAnchor = async (g, intentId) => {
  const rows = await g.V().has('Intent', 'id', intentId).values('project_id').toList();
  const exists = rows.length > 0 || (await g.V().has('Intent', 'id', intentId).hasNext());
  return { exists, projectIds: [...new Set(rows.map(String))] };
};

const firstValue = (v, key) => {
  const raw = v instanceof Map ? v.get(key) : v?.[key];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
};

const plainValueMap = (v) => {
  const out = {};
  if (!v) return out;
  const entries = v instanceof Map ? v.entries() : Object.entries(v);
  for (const [key, raw] of entries) out[key] = Array.isArray(raw) ? (raw[0] ?? '') : raw;
  return out;
};

const parseJsonArray = (raw) => {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const withoutVertexId = (row) => {
  if (!row) return row;
  const { vertexId: _vertexId, ...rest } = row;
  return rest;
};

export const discussionMessageDto = (v) => ({
  id: firstValue(v, 'id'),
  requestId: firstValue(v, 'request_id') || undefined,
  content: firstValue(v, 'content'),
  authorId: firstValue(v, 'author_id'),
  authorName: firstValue(v, 'author_name'),
  authorType: firstValue(v, 'author_type') || 'user',
  command: firstValue(v, 'command') || undefined,
  requestedBy: firstValue(v, 'requested_by') || undefined,
  requestedByName: firstValue(v, 'requested_by_name') || undefined,
  assistStatus: firstValue(v, 'assist_status') || undefined,
  mentions: parseJsonArray(firstValue(v, 'mentions')),
  redacted: firstValue(v, 'redacted') === 'true' || firstValue(v, 'redacted') === true,
  createdAt: firstValue(v, 'created_at'),
  updatedAt: firstValue(v, 'updated_at'),
  discussionId: firstValue(v, 'discussion_id'),
  sprintId: firstValue(v, 'sprint_id') || firstValue(v, 'intent_id'),
});

const byCreated = (a, b) =>
  a.createdAt.localeCompare(b.createdAt) || String(a.id).localeCompare(String(b.id));

const boundedMessage = (m) => ({
  ...m,
  content: String(m.content ?? '').slice(0, DISCUSSION_MAX_MESSAGE_CONTENT),
});

export const ensureIntentVertex = async ({ g, projectId, intentId, title = '', now }) => {
  await g
    .V()
    .has('Intent', 'id', intentId)
    .fold()
    .coalesce(__.unfold(), __.addV('Intent').property(cardinality.single, 'id', intentId))
    .next();
  await g
    .V()
    .has('Intent', 'id', intentId)
    .property(cardinality.single, 'project_id', projectId)
    .property(cardinality.single, 'title', title)
    .property(cardinality.single, 'created_at', now)
    .next();
  return { intentId };
};

export const fetchProjectCliConfig = async (g, projectId) => {
  const r = await g
    .V()
    .has('Project', 'id', projectId)
    .valueMap('agent_cli', 'cli_models', 'tier_models')
    .next();
  if (r.done) return { agentCli: null, cliModels: null, tierModels: null };
  const cliModels = parseCliModels(firstValue(r.value, 'cli_models') || '{}');
  const tierModels = parseTierModels(firstValue(r.value, 'tier_models') || '{}');
  return {
    agentCli: firstValue(r.value, 'agent_cli') || null,
    cliModels: Object.keys(cliModels).length ? cliModels : null,
    tierModels: Object.keys(tierModels).length ? tierModels : null,
  };
};

// Exact-id read for an edit: the current row, or null when absent or
// superseded (an edit must never target a rewound-away artifact).
export const fetchArtifactForEdit = async (g, intentId, artifactId) => {
  const res = await g
    .V()
    .has('Artifact', 'id', artifactId)
    .has('intent_id', intentId)
    .valueMap(true)
    .next();
  if (res.done || !res.value) return null;
  const row = flattenVertexMap(res.value);
  if (row.superseded_at) return null;
  return row;
};

const fetchDiscussion = async (g, intentId, discussionId) => {
  const r = await g
    .V()
    .has('Discussion', 'id', discussionId)
    .has('intent_id', intentId)
    .valueMap()
    .next();
  return r.done ? null : plainValueMap(r.value);
};

const fetchThreadMessages = async (g, intentId, discussionId) => {
  const rows = await g
    .V()
    .has('Discussion', 'id', discussionId)
    .has('intent_id', intentId)
    .out('HAS_MESSAGE')
    .hasLabel('DiscussionMessage')
    .has('intent_id', intentId)
    .has('discussion_id', discussionId)
    .valueMap()
    .toList();
  return rows.map(discussionMessageDto).toSorted(byCreated);
};

const fetchArtifactAnchor = async (g, intentId, artifactId) => {
  const rows = await readIntentArtifactEntries(g, intentId);
  const logicalKeys = new Set(
    rows
      .filter((row) => row.id === artifactId || artifactAliases(row).includes(artifactId))
      .map((row) => artifactLogicalKeyFromRow(row, intentId)),
  );
  return selectCanonicalArtifact(
    rows.filter((row) => logicalKeys.has(artifactLogicalKeyFromRow(row, intentId))),
  );
};

const fetchQuestionAnchor = async (g, intentId, questionId) => {
  const r = await g
    .V()
    .has('Intent', 'id', intentId)
    .out('CONTAINS')
    .hasLabel('Question')
    .has('intent_id', intentId)
    .has('id', questionId)
    .valueMap()
    .next();
  return r.done ? null : plainValueMap(r.value);
};

const fetchIntentMap = async (g, intentId) => {
  const artifacts = selectCurrentArtifactHeads(
    await readIntentArtifactEntries(g, intentId),
    intentId,
  ).toSorted((a, b) =>
    String(a.updated_at ?? a.created_at ?? '').localeCompare(
      String(b.updated_at ?? b.created_at ?? ''),
    ),
  );
  const questions = await g
    .V()
    .has('Intent', 'id', intentId)
    .out('CONTAINS')
    .hasLabel('Question')
    .has('intent_id', intentId)
    .valueMap('id', 'title', 'status', 'answer', 'state')
    .toList();
  return {
    artifacts: artifacts.slice(-25).map((artifact) => ({
      id: artifact.id,
      artifact_type: artifact.artifact_type,
      title: artifact.title,
      status: artifact.status,
      gist: artifact.gist ?? artifact.summary_gist,
      claims: artifact.claims ?? artifact.summary_claims,
    })),
    questions: questions.map(plainValueMap).slice(-15),
  };
};

const discussionMessageAt = (g, { intentId, discussionId, messageId }) =>
  g
    .V()
    .has('DiscussionMessage', 'id', messageId)
    .has('discussion_id', discussionId)
    .has('intent_id', intentId);

// `scope` is the trusted scope engine-data rebuilt from the grant (or the
// runtime's own scope in local mode): { projectId, intentId, executionId,
// stageInstanceId?, stageId?, sectionIndex?, unitSlug? }.
export const createEngineGraphOps = ({
  g,
  scope,
  clock = () => new Date().toISOString(),
  createWriter = createGraphWriter,
}) => {
  const { projectId, intentId } = scope;
  const writerScope = {
    projectId,
    intentId,
    executionId: scope.executionId,
    ...(scope.stageInstanceId ? { stageInstanceId: scope.stageInstanceId } : {}),
    ...(scope.sectionIndex !== undefined && scope.sectionIndex !== null
      ? { sectionIndex: scope.sectionIndex }
      : {}),
    ...(scope.unitSlug ? { unitSlug: scope.unitSlug } : {}),
  };
  let writer;
  const graph = () => (writer ??= createWriter({ g, scope: writerScope, clock }));

  // The engine's own extraction of the CURRENT head, recomputed here so a
  // derivation or enrichment can only ever describe what the graph holds.
  const currentExtraction = async (artifactId, sourceHash) => {
    const heads = await graph().getIntentGraph({ includeContent: true });
    const artifact = heads.find((row) => row.id === artifactId);
    if (!artifact) throw new EngineGraphError(`artifact "${artifactId}" not found`, 'not_found');
    const extraction = extractArtifactStructure({
      artifactType: artifact.artifact_type,
      artifactId: artifact.id,
      content: artifact.content ?? '',
    });
    if (extraction.error) throw new EngineGraphError(extraction.error, 'extraction_failed');
    if (extraction.contentHash !== sourceHash) {
      throw new EngineGraphError(
        `artifact "${artifactId}" changed since it was read`,
        'artifact_changed',
      );
    }
    return { artifact, extraction };
  };

  const requireArtifact = async (artifactId) => {
    if (!(await g.V().has('Artifact', 'id', artifactId).has('intent_id', intentId).hasNext())) {
      throw new EngineGraphScopeError('artifact_not_in_scope');
    }
  };

  return {
    // ── writer-shaped ──
    getIntentGraph: (input) => graph().getIntentGraph(input),
    lookupArtifacts: (input) => graph().lookupArtifacts(input),
    getArtifactToc: (input) => graph().getArtifactToc(input),
    getItems: (input) => graph().getItems(input),
    getCoverage: (input) => graph().getCoverage(input),
    getTeamKnowledge: (input) => graph().getTeamKnowledge(input),
    getLearningRules: () => graph().getLearningRules(),
    updateArtifact: ({ id, props }) =>
      graph().updateArtifact({ id, props: { content: props.content } }),
    recordPullRequest: (input) => graph().recordPullRequest(input),
    recordUnitPullRequest: (input) => graph().recordUnitPullRequest(input),
    recordLearningRule: (input) => graph().recordLearningRule(input),
    linkSteeringInfluences: (input) => graph().linkSteeringInfluences(input),
    mirrorUnitDag: (input) => graph().mirrorUnitDag(input),
    ingestCodeFiles: (input) => graph().ingestCodeFiles(input),
    mirrorArtifactDerivations: async ({ artifactId, sourceHash }) =>
      graph().mirrorArtifactDerivations(await currentExtraction(artifactId, sourceHash)),
    resolveDerivedItemEdges: () => graph().resolveDerivedItemEdges(),
    applyArtifactEnrichment: async ({ artifactId, gist, claims, model = null, sourceHash }) => {
      await currentExtraction(artifactId, sourceHash);
      return graph().applyArtifactEnrichment({ artifactId, gist, claims, model, sourceHash });
    },
    supersedeDerivationsForArtifacts: (input) => graph().supersedeDerivationsForArtifacts(input),
    // The platform's gap stub for a collaborator that recorded nothing. Id,
    // type, content and status are fixed here; only the persona and the reason
    // come from the caller.
    recordContributionGap: ({ agentRef, reason }) => {
      if (!scope.stageInstanceId || !scope.stageId) {
        throw new EngineGraphError('a contribution gap needs a stage', 'stage_required');
      }
      const gapWriter = createWriter({ g, scope: { ...writerScope, systemWriter: true }, clock });
      return gapWriter.createArtifact({
        artifactType: 'contribution',
        id: contributionArtifactId({ stageId: scope.stageId, agentRef }),
        title: `Contribution gap: ${agentRef}`,
        content: `**Collaborator:** ${agentRef}\n\n## Contribution\n\nNone recorded — ${reason}.\n\n## Positions\n\n(none)\n`,
        props: { collaborator: agentRef, status: 'gap', positions: '' },
      });
    },

    // ── named ──
    ensureIntent: ({ title = '' }) =>
      ensureIntentVertex({ g, projectId, intentId, title, now: clock() }),
    inspect: async ({ artifactType = null, artifactId = null }) => {
      const reader = createWriter({ g, scope: { intentId } });
      const artifacts = await reader.getIntentGraph({ includeContent: true });
      const result = {
        ok: true,
        intentId,
        artifactCount: artifacts.length,
        artifacts: artifacts.map((a) => ({
          id: a.id,
          artifact_type: a.artifact_type,
          title: a.title ?? null,
          created_by_execution_id: a.created_by_execution_id ?? null,
          created_by_stage_instance_id: a.created_by_stage_instance_id ?? null,
          created_at: a.created_at ?? null,
          contentBytes: typeof a.content === 'string' ? a.content.length : 0,
        })),
      };
      if (artifactType) {
        result.ofType = await reader.lookupArtifacts({ artifactType, includeContent: true });
      }
      if (artifactId) result.artifact = await reader.getArtifact({ id: artifactId });
      return result;
    },
    readProjectCliConfig: () => fetchProjectCliConfig(g, projectId),
    readDiscussionContext: async ({ discussionId, messageId, selectedMessageIds = [] }) => {
      const discussion = await fetchDiscussion(g, intentId, discussionId);
      if (!discussion) throw new EngineGraphError('Discussion not found', 'not_found');
      const thread = await fetchThreadMessages(g, intentId, discussionId);
      const threadIds = new Set(thread.map((m) => m.id));
      if (!threadIds.has(messageId)) throw new EngineGraphScopeError('message_not_in_thread');
      if (selectedMessageIds.some((id) => !threadIds.has(id))) {
        throw new EngineGraphScopeError('message_not_in_thread');
      }
      const messages = thread.filter((m) => m.id !== messageId);
      const selectedSet = new Set(selectedMessageIds);
      const selected = messages.filter((m) => selectedSet.has(m.id));
      const recent = messages
        .filter((m) => !selectedSet.has(m.id))
        .slice(-DISCUSSION_MAX_RECENT_MESSAGES);
      let anchor;
      if (discussion.entity_type === 'artifact') {
        anchor = withoutVertexId(await fetchArtifactAnchor(g, intentId, discussion.entity_id));
      } else if (discussion.entity_type === 'question') {
        anchor = await fetchQuestionAnchor(g, intentId, discussion.entity_id);
      } else {
        anchor = { id: intentId, entityType: 'intent', title: discussion.entity_title || '' };
      }
      if (anchor?.content) {
        anchor = {
          ...anchor,
          content: String(anchor.content).slice(0, DISCUSSION_MAX_ANCHOR_CONTENT),
        };
      }
      return {
        discussion,
        selected: selected.map(boundedMessage),
        recent: recent.map(boundedMessage),
        anchor: anchor ?? null,
        intentMap: await fetchIntentMap(g, intentId),
      };
    },
    // Writes only the assist's own result onto the pending agent message the
    // discussions service created for this request.
    completeDiscussionAssist: async ({ discussionId, messageId, requestId, content, status }) => {
      if (!(await fetchDiscussion(g, intentId, discussionId))) {
        throw new EngineGraphScopeError('discussion_not_in_scope');
      }
      const at = () => discussionMessageAt(g, { intentId, discussionId, messageId });
      const current = await at().valueMap().next();
      if (current.done) throw new EngineGraphScopeError('message_not_in_thread');
      const message = discussionMessageDto(current.value);
      if (message.authorType !== 'agent' || message.requestId !== requestId) {
        throw new EngineGraphScopeError('message_not_assist_request');
      }
      await at()
        .property(cardinality.single, 'content', content)
        .property(cardinality.single, 'assist_status', status)
        .property(cardinality.single, 'updated_at', clock())
        .next();
      const r = await at().valueMap().next();
      return r.done ? null : discussionMessageDto(r.value);
    },
    getArtifactForEdit: ({ artifactId }) => fetchArtifactForEdit(g, intentId, artifactId),
    fetchDownstreamClosure: ({ artifactId, maxDepth, maxNodes }) =>
      fetchDownstreamClosure({ g, intentId, artifactId, maxDepth, maxNodes }),
    applyArtifactEdit: ({ artifactId, editId, content, ifEditRevision, ifCollaborationEpoch }) =>
      applyArtifactEdit({
        g,
        intentId,
        artifactId,
        content,
        editedBy: QUORUM_ACTOR.id,
        editedByName: QUORUM_ACTOR.name,
        origin: 'quorum',
        editRef: `qedit:${editId}`,
        ifEditRevision,
        ifCollaborationEpoch,
        now: clock(),
      }),
    verifyArtifact: ({ artifactId, note = '' }) =>
      verifyArtifact({
        g,
        intentId,
        artifactId,
        verifiedBy: QUORUM_ACTOR.id,
        verifiedByName: QUORUM_ACTOR.name,
        note,
        now: clock(),
      }),
    markArtifactsStale: async ({ sourceArtifactId, artifactIds, editId }) => {
      await requireArtifact(sourceArtifactId);
      return markArtifactsStale({
        g,
        intentId,
        artifactIds,
        reason: `edit:${sourceArtifactId}:${editId}`,
        now: clock(),
      });
    },
    archiveArtifactsForStages: ({ stageInstanceIds, restartId, reason, actor }) =>
      archiveArtifactsForStages({ g, intentId, stageInstanceIds, restartId, reason, actor, clock }),
    snapshotCurrentArtifactHeads: () => snapshotCurrentArtifactHeads({ g, intentId, clock }),
    readCurrentArtifactHeadHashes: () => readCurrentArtifactHeadHashes({ g, intentId }),
  };
};
