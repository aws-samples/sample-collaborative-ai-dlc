// V2 business-graph writer — the typed, scope-stamped Neptune layer behind the
// MCP server's artifact tools. This is the ONLY way a v2 stage mutates Neptune.
//
// Model (decided): v2 business artifacts are DOCUMENT-LEVEL stage outputs (e.g.
// `requirements-analysis`, `application-design`), not v1's fine-grained
// Requirement/UserStory/Task vertices. We represent each as a single `Artifact`
// vertex discriminated by `artifact_type` (the v2 artifact id from the stage
// graph), anchored to the run's `Intent` vertex via CONTAINS, and wired to other
// artifacts with the produces→consumes vocabulary. This mirrors the block stage
// graph 1:1, so the runtime graph can't drift from the authored workflow.
//
// Pure-ish + injectable: every method uses the live gremlin traversal `g` passed
// to the factory, so the suite tests it against a real gremlin-server
// testcontainer (with a PartitionStrategy) — no mocks of the graph.
//
// Provenance is SPOOF-PROOF: project/intent/execution/stage ids + timestamps are
// stamped from the TRUSTED container ENV scope, never from agent tool args. Any
// caller-supplied reserved prop is dropped.

import gremlin from 'gremlin';
import {
  DERIVED_ITEM_LABELS,
  flattenVertexMap,
  isCurrentRow,
  jsonListProp as jsonList,
} from '../../shared/graph-rows.js';
import { validateStructuredBlock } from '../../shared/artifact-extractors.js';

const __ = gremlin.process.statics;
const { cardinality } = gremlin.process;

// Row helpers shared with the intents lambda's knowledge-graph read (ONE
// implementation — the Neptune valueMap-order bug once had to be fixed in two
// copies). Re-exported under the established local names.
export { DERIVED_ITEM_LABELS, isCurrentRow };
export { flattenVertexMap as flattenValueMap };
const flattenValueMap = flattenVertexMap;

// The single business vertex label. `artifact_type` carries the v2 artifact id.
export const ARTIFACT_LABEL = 'Artifact';
// The scope anchor every artifact hangs off (already created by init-ws).
export const INTENT_LABEL = 'Intent';
// Question vertex so the Intent page can render agent questions (parity with v1).
export const QUESTION_LABEL = 'Question';
// Steering vertex — a human course correction (docs/v2-steering.md). Created by
// the intents lambda (human-initiated, the inverse of a Question); referenced
// here so a consuming stage can link Steering --INFLUENCES--> Artifact.
export const STEERING_LABEL = 'Steering';

// Team knowledge: durable learnings an agent accrues while working an intent,
// but which are reusable across EVERY intent in the project — so they hang off
// the Project vertex, not the per-run Intent. This is the runtime half of the
// two-tier knowledge corpus (the `methodology` tier ships in the block library;
// this `team` tier accrues here). Business data that steers future intents, so
// it lives in Neptune like any other business artifact.
export const PROJECT_LABEL = 'Project';
export const TEAM_KNOWLEDGE_LABEL = 'TeamKnowledge';

// Learning rules: the feedback half of the loop. Where team knowledge is
// reference prose the agent reads, a learning rule is a GUARDRAIL that enters
// the rule-resolution stack at the team-learnings / project-learnings layers
// (priorities 1.5 / 2.5) — a more-specific layer overrides a broader one. Also
// project-scoped (hung off Project), accrued at runtime, so a constraint learned
// in one intent steers every later intent in the project.
export const LEARNING_RULE_LABEL = 'LearningRule';

// Derived context nodes: machine-produced projections of canonical Artifact
// markdown. Agents never create these directly; they are rebuilt from approved
// artifacts by the runtime derivation step. (Typed item labels come from the
// shared extraction registry — see the graph-rows re-export above.)
export const SECTION_LABEL = 'Section';

// Unit-of-work lane mirror (docs/v2-parallel.md WP3). The DDB UNITPLAN/UNIT#
// rows are the SCHEDULING TRUTH; these vertices exist for traceability/UI
// only (the intent graph can render the unit DAG next to the artifacts).
// Anchored Intent --CONTAINS--> UnitOfWork; dependencies as DEPENDS_ON edges
// between UnitOfWork vertices (already an allowlisted business edge).
export const UNIT_OF_WORK_LABEL = 'UnitOfWork';

// The two runtime learnings layers V2's resolver interleaves. Mirrors the
// learnings half of shared/blocks.js RULE_LAYERS.
export const LEARNING_LAYERS = ['team-learnings', 'project-learnings'];

// Anchor edge: Intent --CONTAINS--> Artifact (scope membership).
export const ANCHOR_EDGE = 'CONTAINS';
// Anchor edge: Project --HAS_KNOWLEDGE--> TeamKnowledge (project-scoped, shared
// across all the project's intents).
export const KNOWLEDGE_EDGE = 'HAS_KNOWLEDGE';
// Anchor edge: Project --HAS_LEARNING--> LearningRule (project-scoped guardrails).
export const LEARNING_EDGE = 'HAS_LEARNING';
// Question answer provenance: answered human input that steered an artifact.
export const INFLUENCES_EDGE = 'INFLUENCES';

// Business edges the tools may create between artifacts. PRODUCES/CONSUMES wire
// the stage data flow; the rest are durable semantic relations. Kept explicit so
// an agent can't fabricate arbitrary topology.
export const BUSINESS_EDGES = ['PRODUCES', 'CONSUMES', 'DERIVED_FROM', 'RELATES_TO', 'DEPENDS_ON'];
export const DERIVED_EDGES = [
  'HAS_SECTION',
  'HAS_ITEM',
  'CITES',
  'FOR_PERSONA',
  'COVERS',
  'IMPLEMENTS',
  'EXPOSES',
  'CONSUMES_CONTRACT',
];

export class GraphWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GraphWriteError';
  }
}

export const assertEdge = (edge) => {
  if (!BUSINESS_EDGES.includes(edge)) {
    throw new GraphWriteError(
      `edge "${edge}" is not an allowed business edge (${BUSINESS_EDGES.join(', ')})`,
    );
  }
  return edge;
};

const assertArtifactType = (artifactType) => {
  if (typeof artifactType !== 'string' || !artifactType) {
    throw new GraphWriteError('artifactType is required');
  }
  return artifactType;
};

const assertId = (id) => {
  if (typeof id !== 'string' || !id) throw new GraphWriteError('artifact id is required');
  return id;
};

// Props the agent may never set — they are the trusted provenance stamp. Dropped
// from any caller-supplied bag before write.
const RESERVED_PROPS = new Set([
  'id',
  'artifact_type',
  'project_id',
  'intent_id',
  'created_by_execution_id',
  'created_by_stage_instance_id',
  'created_at',
  'updated_at',
  // Supersede bookkeeping is owned by the rewind flow (intents lambda) + the
  // un-supersede below — never settable from agent tool args. (`status` stays
  // agent-settable: it is an existing free-form prop, e.g. 'draft'.)
  'superseded_at',
  'superseded_by',
  // Post-hoc edit bookkeeping (shared/artifact-edit.js): drift markers, edit
  // provenance and verification stamps are server-owned trust anchors — an
  // agent must never spoof "a human edited/verified this" or clear a drift
  // marker by prop-writing. The stale marker IS cleared on update, but via the
  // dedicated rehabilitation below, never from the props bag.
  'stale_since',
  'stale_reason',
  'edited_by',
  'edited_by_name',
  'edited_at',
  'edit_origin',
  'edit_ref',
  'verified_by',
  'verified_by_name',
  'verified_at',
  'verify_note',
]);

export const sanitizeProps = (properties = {}) => {
  const clean = {};
  for (const [k, v] of Object.entries(properties)) {
    if (RESERVED_PROPS.has(k)) continue;
    if (v === undefined || v === null) continue;
    clean[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return clean;
};

// Normalization/currency-filter/JSON-list helpers live in shared/graph-rows.js
// (see the re-export at the top). Reads must NEVER surface stale rows — an
// agent acting on a superseded section is worse than one with no graph at all.
// Explicit-id getArtifact is the one deliberate exception (a needle read may
// target history).

const byteLength = (value = '') => Buffer.byteLength(String(value ?? ''), 'utf8');

export const compactArtifact = (artifact = {}) => {
  const { content, ...rest } = artifact;
  return {
    ...rest,
    contentLength: byteLength(content),
  };
};

const artifactToc = (artifact = {}) => {
  const headings = [];
  const lines = String(artifact.content ?? '').split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) headings.push({ level: match[1].length, heading: match[2], line: index + 1 });
  });
  return { ...compactArtifact(artifact), headings };
};

const derivedId = ({ label, intentId, slug }) =>
  `${String(label).toLowerCase()}:${intentId}:${String(slug)}`;

// The searchable text of an artifact row: title/body/type plus enrichment
// summaries, so a query phrased in the summary's wording still hits.
const searchCorpus = (a) =>
  `${a.title ?? ''}\n${a.content ?? ''}\n${a.artifact_type ?? ''}\n${a.summary_gist ?? ''}\n${a.summary_claims ?? ''}`;

const briefItem = (i) => ({ slug: i.slug, title: i.title ?? '' });

const snippetFor = (text = '', needle = '', radius = 180) => {
  const body = String(text ?? '');
  const q = String(needle ?? '').toLowerCase();
  const at = q ? body.toLowerCase().indexOf(q) : -1;
  if (at < 0) return body.slice(0, radius * 2).trim();
  const start = Math.max(0, at - radius);
  const end = Math.min(body.length, at + q.length + radius);
  return `${start > 0 ? '...' : ''}${body.slice(start, end).trim()}${end < body.length ? '...' : ''}`;
};

// Close the traversal source `g` (from openGraph), releasing its WebSocket fd.
// The long-lived session process opens the graph several times per stage; every
// unclosed source orphaned a socket until the process hit EMFILE ("too many open
// files") and the next stage crashed. Best-effort and never throws: an
// already-closed or fake (test) source no-ops. Gremlin exposes the closable
// DriverRemoteConnection at `remoteConnection`. Lives here (not clients.js) so
// the injected-deps command modules can close without importing the AWS clients.
export const closeGraphSource = async (g) => {
  try {
    await g?.remoteConnection?.close?.();
  } catch {
    /* already closed / unreachable — the fd is gone either way */
  }
};

// `scope` is the trusted execution context from ENV:
//   { projectId, intentId, executionId, stageInstanceId }
// `clock` is injectable for deterministic tests.
export const createGraphWriter = ({ g, scope = {}, clock } = {}) => {
  if (!g) throw new Error('createGraphWriter requires a gremlin traversal source');
  if (!scope.intentId) throw new Error('createGraphWriter requires scope.intentId');
  const now = () => (clock ? clock() : new Date().toISOString());

  // Provenance stamp written on every created artifact — provenance only, never
  // process status.
  const stamp = () => ({
    project_id: scope.projectId ?? '',
    intent_id: scope.intentId,
    created_by_execution_id: scope.executionId ?? '',
    created_by_stage_instance_id: scope.stageInstanceId ?? '',
    created_at: now(),
  });

  // Upsert a vertex by (label,id): create it only if absent, then return the
  // traversal positioned on it for property writes.
  //
  // Labels whose `id` prop is only unique WITHIN an intent — agents choose
  // Artifact ids freely and Section ids embed the artifact id (`section:<id>:
  // <slug>`), so two intents can pick the SAME id and, without scoping, share
  // (and overwrite/delete) one vertex — the field incident that lost a run's
  // items. Every lookup/edge/upsert of these MUST additionally match the
  // trusted `intent_id` prop (from stamp()). Project-scoped labels
  // (TeamKnowledge/LearningRule), the Intent anchor, and UUID/deterministic-id
  // labels (Question/Steering/UnitOfWork/typed items — ids are globally unique
  // or embed the intentId) are safe without it.
  const INTENT_SCOPED_LABELS = new Set([ARTIFACT_LABEL, SECTION_LABEL]);

  // Append the intent_id match iff the label's id space is intent-local. Works
  // on any traversal (`g.V()...`, `__.V()...`, `__.inV()...`).
  const scopeByIntent = (traversal, label) =>
    INTENT_SCOPED_LABELS.has(label) ? traversal.has('intent_id', scope.intentId) : traversal;

  // Position a fresh traversal on the (label,id) vertex, intent-scoped when the
  // label needs it. The one lookup helper the write/read sites share.
  const vAt = (label, id) => scopeByIntent(g.V().has(label, 'id', id), label);

  // Derived-row lookup by id alone (Section/item ids gathered from a scoped
  // artifact's edges). These rows always carry intent_id, so scope defensively
  // — an id collision across intents must never let a write cross over.
  const vDerivedById = (id) => g.V().has('id', id).has('intent_id', scope.intentId);

  const upsertVertex = async (label, id) => {
    const scoped = INTENT_SCOPED_LABELS.has(label);
    // The coalesce key must include intent_id for scoped labels so a second
    // intent reusing an id creates a NEW vertex instead of adopting the
    // existing one. The new vertex carries intent_id immediately (the full
    // stamp is written by the caller right after).
    let create = __.addV(label).property(cardinality.single, 'id', id);
    if (scoped) create = create.property(cardinality.single, 'intent_id', scope.intentId);
    await vAt(label, id).fold().coalesce(__.unfold(), create).next();
  };

  // Idempotent edge create between two existing vertices, each end matched with
  // intent scoping appropriate to its label.
  const ensureEdge = async ({ fromLabel, fromId, toLabel, toId, edge }) => {
    const exists = await scopeByIntent(g.V().has(fromLabel, 'id', fromId), fromLabel)
      .outE(edge)
      .where(scopeByIntent(__.inV().has(toLabel, 'id', toId), toLabel))
      .hasNext();
    if (!exists) {
      await scopeByIntent(g.V().has(fromLabel, 'id', fromId), fromLabel)
        .addE(edge)
        .to(scopeByIntent(__.V().has(toLabel, 'id', toId), toLabel))
        .next();
    }
  };

  const linkAnsweredQuestionsToArtifact = async (artifactId) => {
    const questionIds = await g
      .V()
      .has(QUESTION_LABEL, 'intent_id', scope.intentId)
      .has('stage_instance_id', scope.stageInstanceId ?? '')
      .has('answered_at')
      .values('id')
      .toList();
    for (const questionId of questionIds) {
      await ensureEdge({
        fromLabel: QUESTION_LABEL,
        fromId: questionId,
        toLabel: ARTIFACT_LABEL,
        toId: artifactId,
        edge: INFLUENCES_EDGE,
      });
    }
  };

  // Un-supersede: a rewound stage re-creating/updating an artifact the rewind
  // marked superseded rehabilitates it — the re-run's version is current again
  // (docs/v2-steering.md). The marker is the dedicated `superseded_at`/
  // `superseded_by` prop pair (NOT the free-form `status` prop agents may set).
  // Best-effort; a vertex without the marker is a no-op.
  const clearSuperseded = async (artifactId) => {
    try {
      await vAt(ARTIFACT_LABEL, artifactId)
        .has('superseded_at')
        .properties('superseded_at', 'superseded_by')
        .drop()
        .next();
    } catch {
      /* lineage marker cleanup is best-effort */
    }
  };

  // Un-stale: an artifact re-created/updated after an upstream document edit
  // marked it stale (shared/artifact-edit.js) is current again — the same
  // rehabilitation discipline as `superseded`. Best-effort; a vertex without
  // the marker is a no-op.
  const clearStale = async (artifactId) => {
    try {
      await vAt(ARTIFACT_LABEL, artifactId)
        .has('stale_since')
        .properties('stale_since', 'stale_reason')
        .drop()
        .next();
    } catch {
      /* drift marker cleanup is best-effort */
    }
  };

  // Provenance for steering: link every Steering vertex consumed by this stage
  // to the artifacts the stage produced (Steering --INFLUENCES--> Artifact),
  // mirroring the answered-question linking. Called by run-stage on stage
  // success with the steer ids it injected. Best-effort per steer id.
  const linkSteeringInfluences = async ({ steerIds = [], stageInstanceId }) => {
    const sid = stageInstanceId ?? scope.stageInstanceId ?? '';
    if (!steerIds.length || !sid) return { linked: 0 };
    const artifactIds = await g
      .V()
      .has(INTENT_LABEL, 'id', scope.intentId)
      .out(ANCHOR_EDGE)
      .hasLabel(ARTIFACT_LABEL)
      .has('created_by_stage_instance_id', sid)
      .values('id')
      .toList();
    let linked = 0;
    for (const steerId of steerIds) {
      const exists = await g.V().has(STEERING_LABEL, 'id', steerId).hasNext();
      if (!exists) continue;
      for (const artifactId of artifactIds) {
        await ensureEdge({
          fromLabel: STEERING_LABEL,
          fromId: steerId,
          toLabel: ARTIFACT_LABEL,
          toId: artifactId,
          edge: INFLUENCES_EDGE,
        });
        linked += 1;
      }
    }
    return { linked };
  };

  // Create (or upsert) a business Artifact vertex and anchor it to the Intent.
  // `links` optionally wires it to existing artifacts in the same call.
  const createArtifact = async ({
    artifactType,
    id,
    title = '',
    content = '',
    props = {},
    links = [],
  }) => {
    assertArtifactType(artifactType);
    assertId(id);
    for (const l of links) assertEdge(l.edge);

    // Reject a malformed structured block before writing — a bad block parses
    // to zero items downstream. The parse error goes back to the agent to fix.
    const structure = validateStructuredBlock({ artifactType, content });
    if (!structure.ok) {
      throw new GraphWriteError(
        `malformed \`${artifactType}\` structured YAML block — ${structure.error}. ` +
          `Fix the fenced YAML and call create_artifact again. ` +
          `Hint: quote any string value that begins with " ' - : [ ] { } # or contains ": ".`,
      );
    }

    const intentExists = await g.V().has(INTENT_LABEL, 'id', scope.intentId).hasNext();
    if (!intentExists)
      throw new GraphWriteError(`Intent "${scope.intentId}" not found — run init-ws first`);

    const stamped = {
      ...sanitizeProps(props),
      title: String(title ?? ''),
      content: String(content ?? ''),
      ...stamp(),
      id,
      artifact_type: artifactType,
    };

    await upsertVertex(ARTIFACT_LABEL, id);
    let q = vAt(ARTIFACT_LABEL, id);
    for (const [k, v] of Object.entries(stamped)) q = q.property(cardinality.single, k, v);
    await q.next();

    await ensureEdge({
      fromLabel: INTENT_LABEL,
      fromId: scope.intentId,
      toLabel: ARTIFACT_LABEL,
      toId: id,
      edge: ANCHOR_EDGE,
    });

    // A re-created artifact is current again (rewind rehabilitation) and no
    // longer stale (drift rehabilitation).
    await clearSuperseded(id);
    await clearStale(id);

    await linkAnsweredQuestionsToArtifact(id);

    for (const l of links) await linkArtifacts({ fromId: id, toId: l.toId, edge: l.edge });
    // Return a COMPACT ack, not the full stamped record. The agent just sent
    // `content` (potentially many KB) — echoing it back into the tool_result
    // bloats the CLI's next request with a duplicate of what it already holds,
    // which on large artifacts can wedge the model turn. Confirm id/type/links
    // only; provenance lives in the graph, re-readable via get_artifact.
    return { id, artifactType, created_at: stamped.created_at, links: links.length };
  };

  // Update mutable props on an existing artifact. Never touches the provenance
  // stamp or artifact_type; refuses reserved props. Errors if absent.
  const updateArtifact = async ({ id, props = {} }) => {
    assertId(id);
    const exists = await vAt(ARTIFACT_LABEL, id).hasNext();
    if (!exists) throw new GraphWriteError(`Artifact "${id}" not found`);
    const clean = sanitizeProps(props);
    let q = vAt(ARTIFACT_LABEL, id).property(cardinality.single, 'updated_at', now());
    for (const [k, v] of Object.entries(clean)) q = q.property(cardinality.single, k, v);
    await q.next();
    // An updated artifact is current again (rewind rehabilitation) and no
    // longer stale (drift rehabilitation).
    await clearSuperseded(id);
    await clearStale(id);
    await linkAnsweredQuestionsToArtifact(id);
    return { id, updated: Object.keys(clean) };
  };

  const linkArtifacts = async ({ fromId, toId, edge }) => {
    assertEdge(edge);
    assertId(fromId);
    assertId(toId);
    const fromExists = await vAt(ARTIFACT_LABEL, fromId).hasNext();
    if (!fromExists) throw new GraphWriteError(`edge source artifact "${fromId}" not found`);
    const toExists = await vAt(ARTIFACT_LABEL, toId).hasNext();
    if (!toExists) throw new GraphWriteError(`edge target artifact "${toId}" not found`);
    await ensureEdge({ fromLabel: ARTIFACT_LABEL, fromId, toLabel: ARTIFACT_LABEL, toId, edge });
    return { fromId, toId, edge };
  };

  const getArtifact = async ({ id, mode = 'full' }) => {
    assertId(id);
    const res = await vAt(ARTIFACT_LABEL, id).valueMap(true).next();
    if (!res.value) return null;
    const artifact = flattenValueMap(res.value);
    if (mode === 'summary') return compactArtifact(artifact);
    if (mode === 'toc') return artifactToc(artifact);
    return artifact;
  };

  // Every artifact of a given type in this intent's scope. Superseded
  // artifacts (rewind lineage) are excluded unless explicitly requested.
  const lookupArtifacts = async ({
    artifactType,
    includeContent = false,
    includeSuperseded = false,
  }) => {
    assertArtifactType(artifactType);
    const list = await g
      .V()
      .has(INTENT_LABEL, 'id', scope.intentId)
      .out(ANCHOR_EDGE)
      .hasLabel(ARTIFACT_LABEL)
      .has('artifact_type', artifactType)
      .valueMap(true)
      .toList();
    const rows = list.map(flattenValueMap).filter((r) => includeSuperseded || isCurrentRow(r));
    return includeContent ? rows : rows.map(compactArtifact);
  };

  // The full artifact subgraph for the intent: every contained artifact — a
  // compact snapshot for the agent to orient. Current rows only by default.
  const getIntentGraph = async ({ includeContent = false, includeSuperseded = false } = {}) => {
    const list = await g
      .V()
      .has(INTENT_LABEL, 'id', scope.intentId)
      .out(ANCHOR_EDGE)
      .hasLabel(ARTIFACT_LABEL)
      .valueMap(true)
      .toList();
    const rows = list.map(flattenValueMap).filter((r) => includeSuperseded || isCurrentRow(r));
    return includeContent ? rows : rows.map(compactArtifact);
  };

  // Neighbors of an artifact, optionally filtered by edge + direction.
  const getNeighbors = async ({ id, edge = null, direction = 'both', includeContent = false }) => {
    assertId(id);
    if (edge) assertEdge(edge);
    let q = vAt(ARTIFACT_LABEL, id);
    const step = direction === 'in' ? 'in_' : direction === 'out' ? 'out' : 'both';
    q = edge ? q[step](edge) : q[step]();
    const list = await q.hasLabel(ARTIFACT_LABEL).valueMap(true).toList();
    const rows = list.map(flattenValueMap).filter(isCurrentRow);
    return includeContent ? rows : rows.map(compactArtifact);
  };

  // Substring search across the intent's CURRENT artifacts. Matches title/
  // content/type plus enrichment summaries (gist/claims) — a query phrased in
  // the summary's wording must hit even when the prose differs. Done
  // in-process for portability across Neptune/gremlin-server (TextP.containing
  // support varies).
  const searchGraph = async ({ query, artifactType = null, limit = 25 }) => {
    if (typeof query !== 'string' || !query) throw new GraphWriteError('search query is required');
    let q = g.V().has(INTENT_LABEL, 'id', scope.intentId).out(ANCHOR_EDGE).hasLabel(ARTIFACT_LABEL);
    if (artifactType) q = q.has('artifact_type', artifactType);
    const all = await q.valueMap(true).toList();
    const needle = query.toLowerCase();
    return all
      .map(flattenValueMap)
      .filter(isCurrentRow)
      .filter((a) => searchCorpus(a).toLowerCase().includes(needle))
      .map((a) => ({
        ...compactArtifact(a),
        snippet: snippetFor(searchCorpus(a), query),
      }))
      .slice(0, limit);
  };

  // ── Team knowledge (project-scoped, cross-intent) ──

  // Provenance for a team-knowledge entry: project scope + which run produced it.
  // Unlike an artifact (stamped with the owning intent), knowledge is project
  // data, so `created_by_intent_id` is provenance, not scope.
  const knowledgeStamp = () => ({
    project_id: scope.projectId ?? '',
    created_by_intent_id: scope.intentId ?? '',
    created_by_execution_id: scope.executionId ?? '',
    created_by_stage_instance_id: scope.stageInstanceId ?? '',
    created_at: now(),
  });

  // Record a durable learning for the project. Upserts the Project anchor (it is
  // normally created by the projects service, but a v2 project may predate the
  // vertex), then upserts the TeamKnowledge vertex and anchors it. `agentRef`
  // scopes the learning to one agent's corpus, or 'shared' for cross-cutting.
  // Provenance is stamped from the trusted scope, never agent args.
  const recordTeamKnowledge = async ({
    id,
    title = '',
    content = '',
    agentRef = 'shared',
    props = {},
  }) => {
    assertId(id);
    if (!scope.projectId) throw new GraphWriteError('projectId is required to record knowledge');

    await upsertVertex(PROJECT_LABEL, scope.projectId);
    await upsertVertex(TEAM_KNOWLEDGE_LABEL, id);

    const stamped = {
      ...sanitizeProps(props),
      title: String(title ?? ''),
      content: String(content ?? ''),
      agent_ref: String(agentRef || 'shared'),
      tier: 'team',
      ...knowledgeStamp(),
      id,
    };
    let q = g.V().has(TEAM_KNOWLEDGE_LABEL, 'id', id);
    for (const [k, v] of Object.entries(stamped)) q = q.property(cardinality.single, k, v);
    await q.next();

    await ensureEdge({
      fromLabel: PROJECT_LABEL,
      fromId: scope.projectId,
      toLabel: TEAM_KNOWLEDGE_LABEL,
      toId: id,
      edge: KNOWLEDGE_EDGE,
    });
    // Compact ack (see createArtifact) — never echo `content` back into the turn.
    return { id, agentRef: stamped.agent_ref, created_at: stamped.created_at };
  };

  // Read the project's accrued team knowledge, optionally narrowed to one agent
  // (always including the 'shared' corpus). Project-scoped, so it spans every
  // intent in the project. Returns flat rows ordered by creation time.
  const getTeamKnowledge = async ({ agentRef = null } = {}) => {
    if (!scope.projectId) return [];
    const exists = await g.V().has(PROJECT_LABEL, 'id', scope.projectId).hasNext();
    if (!exists) return [];
    const list = await g
      .V()
      .has(PROJECT_LABEL, 'id', scope.projectId)
      .out(KNOWLEDGE_EDGE)
      .hasLabel(TEAM_KNOWLEDGE_LABEL)
      .valueMap(true)
      .toList();
    const rows = list.map(flattenValueMap);
    const filtered = agentRef
      ? rows.filter((r) => r.agent_ref === agentRef || r.agent_ref === 'shared')
      : rows;
    return filtered.toSorted((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  };

  // ── Learning rules (project-scoped guardrails, the feedback half) ──

  // Record a learning rule for the project — a guardrail that enters the rule
  // stack at its `team-learnings` / `project-learnings` layer (the resolver sorts
  // it to priority 1.5 / 2.5). Upserts the Project anchor, then the LearningRule
  // vertex. `pairing` optionally binds it to a sensor (the feedforward/feedback
  // link), defaulting to the 'feedforward-only' sentinel. Provenance is stamped
  // from the trusted scope; `layer` is validated against the two learnings tiers.
  const recordLearningRule = async ({
    id,
    title = '',
    content = '',
    layer = 'project-learnings',
    pairing = 'feedforward-only',
    props = {},
  }) => {
    assertId(id);
    if (!scope.projectId) throw new GraphWriteError('projectId is required to record a learning');
    if (!LEARNING_LAYERS.includes(layer)) {
      throw new GraphWriteError(`learning layer must be one of ${LEARNING_LAYERS.join(', ')}`);
    }

    await upsertVertex(PROJECT_LABEL, scope.projectId);
    await upsertVertex(LEARNING_RULE_LABEL, id);

    const stamped = {
      ...sanitizeProps(props),
      title: String(title ?? ''),
      content: String(content ?? ''),
      layer,
      pairing: String(pairing || 'feedforward-only'),
      ...knowledgeStamp(),
      id,
    };
    let q = g.V().has(LEARNING_RULE_LABEL, 'id', id);
    for (const [k, v] of Object.entries(stamped)) q = q.property(cardinality.single, k, v);
    await q.next();

    await ensureEdge({
      fromLabel: PROJECT_LABEL,
      fromId: scope.projectId,
      toLabel: LEARNING_RULE_LABEL,
      toId: id,
      edge: LEARNING_EDGE,
    });
    // Compact ack (see createArtifact) — never echo `content` back into the turn.
    return { id, layer: stamped.layer, created_at: stamped.created_at };
  };

  // Read the project's accrued learning rules (both learnings layers). Returns
  // flat rows ordered by creation time; run-stage merges them into the rule
  // resolver so the existing layer-precedence interleaving applies.
  const getLearningRules = async () => {
    if (!scope.projectId) return [];
    const exists = await g.V().has(PROJECT_LABEL, 'id', scope.projectId).hasNext();
    if (!exists) return [];
    const list = await g
      .V()
      .has(PROJECT_LABEL, 'id', scope.projectId)
      .out(LEARNING_EDGE)
      .hasLabel(LEARNING_RULE_LABEL)
      .valueMap(true)
      .toList();
    return list
      .map(flattenValueMap)
      .toSorted((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  };

  // Create a Question vertex on the Intent so the page can render it. The
  // blocking/answer flow lives in the process bridge (DynamoDB); this is the
  // business-graph mirror, matching v1.
  const recordQuestion = async ({ questionId, questionsJson }) => {
    await g
      .addV(QUESTION_LABEL)
      .property(cardinality.single, 'id', questionId)
      .property(cardinality.single, 'intent_id', scope.intentId)
      .property(cardinality.single, 'stage_instance_id', scope.stageInstanceId ?? '')
      .property(cardinality.single, 'questions', questionsJson)
      .property(cardinality.single, 'structured_answer', '')
      .property(cardinality.single, 'created_at', now())
      .next();
    await ensureEdge({
      fromLabel: INTENT_LABEL,
      fromId: scope.intentId,
      toLabel: QUESTION_LABEL,
      toId: questionId,
      edge: ANCHOR_EDGE,
    });
    return { questionId };
  };

  // Mirror the promoted unit DAG to the business graph (docs/v2-parallel.md
  // WP3). Traceability/UI ONLY — the DDB UNITPLAN/UNIT# rows are the
  // scheduling truth; nothing schedules off these vertices. Idempotent:
  // vertices upsert by deterministic id (unit:<intentId>:<slug>), edges via
  // ensureEdge, and units dropped by a re-promotion are marked superseded
  // rather than deleted (audit history). `sourceArtifactId` optionally wires
  // each unit DERIVED_FROM the unit-of-work-dependency artifact it came from.
  const mirrorUnitDag = async ({ units = [], sourceArtifactId = null }) => {
    const intentExists = await g.V().has(INTENT_LABEL, 'id', scope.intentId).hasNext();
    if (!intentExists)
      throw new GraphWriteError(`Intent "${scope.intentId}" not found — run init-ws first`);

    const unitId = (slug) => `unit:${scope.intentId}:${slug}`;
    const slugs = units.map((u) => u.slug ?? u.name);

    for (const u of units) {
      const slug = u.slug ?? u.name;
      const id = unitId(slug);
      await upsertVertex(UNIT_OF_WORK_LABEL, id);
      const props = {
        slug,
        depends_on: JSON.stringify(u.dependsOn ?? u.depends_on ?? []),
        ...stamp(),
        id,
        updated_at: now(),
        // A re-promoted unit is current again (rewind rehabilitation).
        superseded_at: '',
      };
      let q = g.V().has(UNIT_OF_WORK_LABEL, 'id', id);
      for (const [k, v] of Object.entries(props)) q = q.property(cardinality.single, k, v);
      await q.next();
      await ensureEdge({
        fromLabel: INTENT_LABEL,
        fromId: scope.intentId,
        toLabel: UNIT_OF_WORK_LABEL,
        toId: id,
        edge: ANCHOR_EDGE,
      });
      if (sourceArtifactId) {
        const artifactExists = await vAt(ARTIFACT_LABEL, sourceArtifactId).hasNext();
        if (artifactExists) {
          await ensureEdge({
            fromLabel: UNIT_OF_WORK_LABEL,
            fromId: id,
            toLabel: ARTIFACT_LABEL,
            toId: sourceArtifactId,
            edge: 'DERIVED_FROM',
          });
        }
      }
    }
    // Dependency edges AFTER all vertices exist.
    for (const u of units) {
      const slug = u.slug ?? u.name;
      for (const dep of u.dependsOn ?? u.depends_on ?? []) {
        await ensureEdge({
          fromLabel: UNIT_OF_WORK_LABEL,
          fromId: unitId(slug),
          toLabel: UNIT_OF_WORK_LABEL,
          toId: unitId(dep),
          edge: 'DEPENDS_ON',
        });
      }
    }
    // Units that existed from a prior promotion but are gone from this DAG:
    // mark superseded (never delete — audit history).
    const existingIds = await g
      .V()
      .has(INTENT_LABEL, 'id', scope.intentId)
      .out(ANCHOR_EDGE)
      .hasLabel(UNIT_OF_WORK_LABEL)
      .values('id')
      .toList();
    const currentIds = new Set(slugs.map(unitId));
    let superseded = 0;
    for (const id of existingIds) {
      if (currentIds.has(id)) continue;
      await g
        .V()
        .has(UNIT_OF_WORK_LABEL, 'id', id)
        .property(cardinality.single, 'superseded_at', now())
        .next();
      superseded += 1;
    }
    return { mirrored: units.length, superseded };
  };

  const upsertDerivedVertex = async ({ label, id, props = {} }) => {
    await upsertVertex(label, id);
    const stamped = { ...props, id, updated_at: now() };
    let q = vAt(label, id);
    for (const [k, v] of Object.entries(stamped)) {
      if (v === undefined || v === null) continue;
      q = q.property(cardinality.single, k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    await q.next();
  };

  const mirrorArtifactDerivations = async ({ artifact, extraction }) => {
    const artifactId = artifact?.id ?? extraction?.artifactId;
    assertId(artifactId);
    const artifactExists = await vAt(ARTIFACT_LABEL, artifactId).hasNext();
    if (!artifactExists) throw new GraphWriteError(`artifact "${artifactId}" not found`);

    const currentSectionIds = [];
    for (const section of extraction?.sections ?? []) {
      const id = `section:${artifactId}:${section.slug}`;
      currentSectionIds.push(id);
      await upsertDerivedVertex({
        label: SECTION_LABEL,
        id,
        props: {
          ...stamp(),
          artifact_id: artifactId,
          artifact_type: extraction.artifactType ?? artifact?.artifact_type ?? '',
          slug: section.slug,
          heading: section.heading,
          level: section.level,
          order: section.order,
          start_line: section.startLine,
          end_line: section.endLine,
          content: section.content,
          content_hash: section.contentHash,
          source_content_hash: extraction.contentHash ?? '',
          superseded_at: '',
        },
      });
      await ensureEdge({
        fromLabel: ARTIFACT_LABEL,
        fromId: artifactId,
        toLabel: SECTION_LABEL,
        toId: id,
        edge: 'HAS_SECTION',
      });
      await ensureEdge({
        fromLabel: SECTION_LABEL,
        fromId: id,
        toLabel: ARTIFACT_LABEL,
        toId: artifactId,
        edge: 'DERIVED_FROM',
      });
    }

    const currentItemIds = [];
    for (const item of extraction?.items ?? []) {
      const label = DERIVED_ITEM_LABELS.includes(item.label) ? item.label : 'ArtifactItem';
      const id = derivedId({ label, intentId: scope.intentId, slug: item.slug });
      currentItemIds.push(id);
      await upsertDerivedVertex({
        label,
        id,
        props: {
          ...stamp(),
          artifact_id: artifactId,
          artifact_type: extraction.artifactType ?? artifact?.artifact_type ?? '',
          slug: item.slug,
          title: item.title,
          order: item.order,
          content_hash: extraction.contentHash ?? '',
          superseded_at: '',
          ...item.props,
        },
      });
      await ensureEdge({
        fromLabel: ARTIFACT_LABEL,
        fromId: artifactId,
        toLabel: label,
        toId: id,
        edge: 'HAS_ITEM',
      });
      await ensureEdge({
        fromLabel: label,
        fromId: id,
        toLabel: ARTIFACT_LABEL,
        toId: artifactId,
        edge: 'DERIVED_FROM',
      });
    }

    for (const citedType of extraction?.citations ?? []) {
      const targets = await g
        .V()
        .has(INTENT_LABEL, 'id', scope.intentId)
        .out(ANCHOR_EDGE)
        .hasLabel(ARTIFACT_LABEL)
        .has('artifact_type', citedType)
        .values('id')
        .toList();
      for (const targetId of targets) {
        if (targetId === artifactId) continue;
        await ensureEdge({
          fromLabel: ARTIFACT_LABEL,
          fromId: artifactId,
          toLabel: ARTIFACT_LABEL,
          toId: targetId,
          edge: 'CITES',
        });
      }
    }

    const oldSectionIds = await vAt(ARTIFACT_LABEL, artifactId)
      .out('HAS_SECTION')
      .values('id')
      .toList();
    const oldItemIds = await vAt(ARTIFACT_LABEL, artifactId).out('HAS_ITEM').values('id').toList();
    const currentSections = new Set(currentSectionIds);
    const currentItems = new Set(currentItemIds);
    let superseded = 0;
    for (const id of oldSectionIds) {
      if (currentSections.has(id)) continue;
      await vAt(SECTION_LABEL, id).property(cardinality.single, 'superseded_at', now()).next();
      superseded += 1;
    }
    for (const id of oldItemIds) {
      if (currentItems.has(id)) continue;
      await vDerivedById(id).property(cardinality.single, 'superseded_at', now()).next();
      superseded += 1;
    }

    return {
      artifactId,
      sections: currentSectionIds.length,
      items: currentItemIds.length,
      citations: extraction?.citations?.length ?? 0,
      superseded,
    };
  };

  // Derive-time enrichment metadata — PROPS ONLY, never topology. Written by
  // the derive command when the Admin enrichment toggle is 'llm': a bounded
  // one-shot CLI call produced a gist + key claims for the artifact. The
  // `enrichment_source_hash` (the extraction content hash) lets a re-derive
  // skip artifacts whose content did not change. Because these are regular
  // vertex props, every compact read (orientation/search/lookup) carries the
  // gist for free while `content` stays behind an explicit full read.
  const applyArtifactEnrichment = async ({
    artifactId,
    gist = '',
    claims = [],
    model = null,
    sourceHash = '',
  }) => {
    assertId(artifactId);
    const exists = await vAt(ARTIFACT_LABEL, artifactId).hasNext();
    if (!exists) throw new GraphWriteError(`Artifact "${artifactId}" not found`);
    const props = {
      summary_gist: String(gist ?? ''),
      summary_claims: JSON.stringify(Array.isArray(claims) ? claims.map(String) : []),
      enrichment_model: String(model ?? ''),
      enrichment_source_hash: String(sourceHash ?? ''),
      enriched_at: now(),
    };
    let q = vAt(ARTIFACT_LABEL, artifactId);
    for (const [k, v] of Object.entries(props)) q = q.property(cardinality.single, k, v);
    await q.next();
    return { artifactId, enriched: true };
  };

  // Orphan sweep — mark every derived Section/Item hanging off the given
  // (superseded) artifacts as superseded too. A rewind re-run that mints a NEW
  // artifact id leaves the old artifact's derivations without any re-derive
  // path (mirrorArtifactDerivations only reconciles rows reachable from a
  // CURRENT artifact), so the derive command sweeps them explicitly.
  // Idempotent; only stamps rows that are still current.
  const supersedeDerivationsForArtifacts = async ({ artifactIds = [] }) => {
    let superseded = 0;
    for (const artifactId of artifactIds) {
      for (const edge of ['HAS_SECTION', 'HAS_ITEM']) {
        const rows = await vAt(ARTIFACT_LABEL, artifactId).out(edge).valueMap(true).toList();
        for (const row of rows.map(flattenValueMap)) {
          if (!isCurrentRow(row)) continue;
          await vDerivedById(row.id).property(cardinality.single, 'superseded_at', now()).next();
          superseded += 1;
        }
      }
    }
    return { superseded };
  };

  const getArtifactToc = async ({ id }) => {
    assertId(id);
    const rows = await vAt(ARTIFACT_LABEL, id)
      .out('HAS_SECTION')
      .hasLabel(SECTION_LABEL)
      .valueMap(true)
      .toList();
    return rows
      .map(flattenValueMap)
      .filter(isCurrentRow)
      .map(compactArtifact)
      .toSorted((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
  };

  const getSection = async ({ artifactId, heading = null, slug = null }) => {
    assertId(artifactId);
    let q = vAt(ARTIFACT_LABEL, artifactId).out('HAS_SECTION').hasLabel(SECTION_LABEL);
    if (slug) q = q.has('slug', slug);
    if (heading) q = q.has('heading', heading);
    // Client-side currency filter (see isCurrentRow) — a heading/slug lookup
    // must never resolve to a section a re-derive removed.
    const rows = await q.valueMap(true).toList();
    return rows.map(flattenValueMap).find(isCurrentRow) ?? null;
  };

  const getItems = async ({ itemType = null, artifactType = null, limit = 100 } = {}) => {
    // Two-hop currency: drop items superseded by a re-derive AND items whose
    // parent artifact was superseded by a rewind (the item row itself may
    // still be 'current' when no re-derive ran after the rewind).
    const currentArtifactIds = new Set(
      (await getIntentGraph({ includeContent: false })).map((a) => a.id),
    );
    let q = g.V().has(INTENT_LABEL, 'id', scope.intentId).out(ANCHOR_EDGE).hasLabel(ARTIFACT_LABEL);
    if (artifactType) q = q.has('artifact_type', artifactType);
    q = q.out('HAS_ITEM');
    if (itemType) q = q.hasLabel(itemType);
    const rows = await q.valueMap(true).toList();
    return rows
      .map(flattenValueMap)
      .filter(isCurrentRow)
      .filter((r) => !r.artifact_id || currentArtifactIds.has(r.artifact_id))
      .slice(0, limit)
      .map(compactArtifact);
  };

  // Coverage joins over the CURRENT typed items — the one-call answer to
  // "what is uncovered / unmapped / unknown" that agents and sensors would
  // otherwise reassemble from several get_items reads:
  //   requirements ← stories (story.covers), stories ← units (StoryMapEntry),
  //   contracts by provider/consumer, plus referential-integrity findings
  //   (covers/mappings pointing at slugs that do not exist).
  // `unitSlug` narrows the story/contract view to one lane. Compact by
  // construction (slug/title lists, never bodies).
  const getCoverage = async ({ unitSlug = null } = {}) => {
    const items = await getItems({ limit: 500 });
    const byLabel = (label) => items.filter((i) => (i.label ?? '') === label);
    const requirements = byLabel('Requirement');
    const stories = byLabel('Story');
    const mappings = byLabel('StoryMapEntry');
    const contracts = byLabel('Contract');
    const components = byLabel('Component');

    const storySlugs = new Set(stories.map((s) => s.slug));
    const requirementSlugs = new Set(requirements.map((r) => r.slug));

    const coveredRequirements = new Set(stories.flatMap((s) => jsonList(s.covers)));
    const uncovered = requirements.filter((r) => !coveredRequirements.has(r.slug));
    const uncoveredMustHave = uncovered.filter((r) =>
      String(r.priority ?? '')
        .toLowerCase()
        .startsWith('must'),
    );

    const mappedStories = new Set(mappings.flatMap((m) => jsonList(m.stories)));
    const unmappedStories = stories.filter((s) => !mappedStories.has(s.slug));

    const unknownRefs = [];
    for (const s of stories) {
      for (const ref of jsonList(s.covers)) {
        if (!requirementSlugs.has(ref))
          unknownRefs.push({ kind: 'story-covers-unknown-requirement', from: s.slug, ref });
      }
    }
    for (const m of mappings) {
      for (const ref of jsonList(m.stories)) {
        if (!storySlugs.has(ref))
          unknownRefs.push({ kind: 'mapping-references-unknown-story', from: m.slug, ref });
      }
    }
    const componentSlugs = new Set(components.map((c) => c.slug));
    for (const c of components) {
      for (const ref of jsonList(c.depends_on)) {
        if (!componentSlugs.has(ref))
          unknownRefs.push({ kind: 'component-depends-unknown-component', from: c.slug, ref });
      }
    }

    // Component dependency cycles — Kahn's algorithm over the KNOWN deps; any
    // node never freed sits on a cycle. Unknown deps are already reported
    // above and excluded here so one bad reference doesn't fake a cycle.
    const componentCycles = (() => {
      const deps = new Map(
        components.map((c) => [
          c.slug,
          jsonList(c.depends_on).filter((d) => componentSlugs.has(d)),
        ]),
      );
      const remaining = new Set(deps.keys());
      let progressed = true;
      while (progressed) {
        progressed = false;
        // Live Set iteration is safe for deletes; the outer loop re-runs until
        // a full pass frees nothing.
        for (const slug of remaining) {
          if (deps.get(slug).every((d) => !remaining.has(d))) {
            remaining.delete(slug);
            progressed = true;
          }
        }
      }
      return [...remaining].toSorted();
    })();

    const out = {
      counts: {
        requirements: requirements.length,
        stories: stories.length,
        mappings: mappings.length,
        contracts: contracts.length,
        components: components.length,
      },
      uncoveredRequirements: uncovered.map(briefItem),
      uncoveredMustHave: uncoveredMustHave.map(briefItem),
      unmappedStories: unmappedStories.map(briefItem),
      unknownReferences: unknownRefs,
      componentCycles,
    };
    if (unitSlug) {
      const unitStoryIds = new Set(
        mappings.filter((m) => (m.unit ?? '') === unitSlug).flatMap((m) => jsonList(m.stories)),
      );
      out.unit = {
        slug: unitSlug,
        stories: stories.filter((s) => unitStoryIds.has(s.slug)).map(briefItem),
        storyIds: [...unitStoryIds].toSorted(),
        contracts: contracts
          .filter(
            (c) => (c.provider ?? '') === unitSlug || jsonList(c.consumers).includes(unitSlug),
          )
          .map((c) => ({
            slug: c.slug,
            title: c.title ?? '',
            role: (c.provider ?? '') === unitSlug ? 'provides' : 'consumes',
            provider: c.provider ?? '',
            consumers: jsonList(c.consumers),
          })),
      };
    }
    return out;
  };

  // ── Item↔item traceability edges ──
  // Materialize the slug references the structure contracts already make
  // agents author (Story.covers, Story.persona, Story/Component.depends_on,
  // StoryMapEntry.stories/unit, Contract.provider/consumers) as typed edges —
  // the same joins getCoverage computes in memory, persisted as topology so
  // the UI graph and the context pack can walk them.
  //
  // Intent-wide, idempotent SWEEP (not per-artifact): managed outgoing edges
  // are dropped and re-created per current source vertex, so a re-derive that
  // removed a reference also removes its edge (ensureEdge alone is create-
  // only). Dangling slugs are skipped silently — the coverage sensor already
  // reports them as unknownReferences. Runs after every derive AND after
  // promote-units: StoryMapEntry/Contract items derive BEFORE the UnitOfWork
  // vertices exist (promote-units creates them after the DAG stage), so the
  // unit wiring resolves on the later sweep.
  //
  // Edge vocabulary (all pre-reserved in DERIVED_EDGES):
  //   Story        --COVERS-->            Requirement   (covers)
  //   Story        --FOR_PERSONA-->       Persona       (persona)
  //   Story        --DEPENDS_ON-->        Story         (depends_on)
  //   Component    --DEPENDS_ON-->        Component     (depends_on)
  //   StoryMapEntry--IMPLEMENTS-->        Story         (stories)
  //   StoryMapEntry--IMPLEMENTS-->        UnitOfWork    (unit)
  //   UnitOfWork   --EXPOSES-->           Contract      (provider)
  //   UnitOfWork   --CONSUMES_CONTRACT--> Contract      (consumers)
  const resolveDerivedItemEdges = async () => {
    const items = await getItems({ limit: 500 });
    const unitRows = (
      await g
        .V()
        .has(INTENT_LABEL, 'id', scope.intentId)
        .out(ANCHOR_EDGE)
        .hasLabel(UNIT_OF_WORK_LABEL)
        .valueMap(true)
        .toList()
    )
      .map(flattenValueMap)
      .filter(isCurrentRow);

    // slug → vertex id per label, CURRENT rows only — an edge is only created
    // when its target currently exists, and stale targets lose their edges on
    // the next sweep via the drop pass below.
    const bySlug = new Map(DERIVED_ITEM_LABELS.map((l) => [l, new Map()]));
    bySlug.set(UNIT_OF_WORK_LABEL, new Map(unitRows.map((u) => [u.slug, u.id])));
    for (const i of items) bySlug.get(i.label)?.set(i.slug, i.id);
    const target = (label, slug) => bySlug.get(label)?.get(String(slug)) ?? null;

    // Managed labels per source — ONLY these are dropped on the sweep, so
    // edges owned elsewhere survive (UnitOfWork DEPENDS_ON from mirrorUnitDag,
    // item DERIVED_FROM from mirrorArtifactDerivations).
    const managed = {
      Story: ['COVERS', 'FOR_PERSONA', 'DEPENDS_ON'],
      Component: ['DEPENDS_ON'],
      StoryMapEntry: ['IMPLEMENTS'],
      [UNIT_OF_WORK_LABEL]: ['EXPOSES', 'CONSUMES_CONTRACT'],
    };
    // Refs per source row: [edge, toLabel, slugs[]].
    const refs = {
      Story: (r) => [
        ['COVERS', 'Requirement', jsonList(r.covers)],
        ['FOR_PERSONA', 'Persona', r.persona ? [r.persona] : []],
        ['DEPENDS_ON', 'Story', jsonList(r.depends_on)],
      ],
      Component: (r) => [['DEPENDS_ON', 'Component', jsonList(r.depends_on)]],
      StoryMapEntry: (r) => [
        ['IMPLEMENTS', 'Story', jsonList(r.stories)],
        ['IMPLEMENTS', UNIT_OF_WORK_LABEL, r.unit ? [r.unit] : []],
      ],
    };
    // Contract wiring is INVERTED (the unit is the acting side): resolve the
    // unit-sourced edges from the Contract rows' provider/consumers props.
    const unitContractRefs = new Map(); // unitId → [{ edge, toId }]
    for (const c of items.filter((i) => i.label === 'Contract')) {
      const link = (unitSlug, edge) => {
        const unitVertex = target(UNIT_OF_WORK_LABEL, unitSlug);
        if (!unitVertex) return;
        if (!unitContractRefs.has(unitVertex)) unitContractRefs.set(unitVertex, []);
        unitContractRefs.get(unitVertex).push({ edge, toId: c.id });
      };
      if (c.provider) link(c.provider, 'EXPOSES');
      for (const consumer of jsonList(c.consumers)) link(consumer, 'CONSUMES_CONTRACT');
    }

    let edges = 0;
    const sweep = async ({ label, id, planned }) => {
      // Drop-then-recreate keeps the sweep idempotent AND removes edges whose
      // ref disappeared. Managed labels only (see above).
      await g
        .V()
        .has(label, 'id', id)
        .outE(...managed[label])
        .drop()
        .next();
      const seen = new Set();
      for (const { edge, toLabel, toId } of planned) {
        const key = `${edge}→${toId}`;
        if (!toId || toId === id || seen.has(key)) continue;
        seen.add(key);
        await ensureEdge({ fromLabel: label, fromId: id, toLabel, toId, edge });
        edges += 1;
      }
    };

    for (const item of items) {
      const plan = refs[item.label];
      if (!plan) continue;
      const planned = plan(item).flatMap(([edge, toLabel, slugs]) =>
        slugs.map((slug) => ({ edge, toLabel, toId: target(toLabel, slug) })).filter((p) => p.toId),
      );
      await sweep({ label: item.label, id: item.id, planned });
    }
    for (const u of unitRows) {
      await sweep({
        label: UNIT_OF_WORK_LABEL,
        id: u.id,
        planned: (unitContractRefs.get(u.id) ?? []).map((r) => ({
          edge: r.edge,
          toLabel: 'Contract',
          toId: r.toId,
        })),
      });
    }
    return { edges };
  };

  return {
    createArtifact,
    updateArtifact,
    linkArtifacts,
    getArtifact,
    lookupArtifacts,
    getIntentGraph,
    getNeighbors,
    searchGraph,
    recordTeamKnowledge,
    getTeamKnowledge,
    recordLearningRule,
    getLearningRules,
    recordQuestion,
    linkSteeringInfluences,
    mirrorUnitDag,
    mirrorArtifactDerivations,
    resolveDerivedItemEdges,
    applyArtifactEnrichment,
    supersedeDerivationsForArtifacts,
    getArtifactToc,
    getSection,
    getItems,
    getCoverage,
  };
};
