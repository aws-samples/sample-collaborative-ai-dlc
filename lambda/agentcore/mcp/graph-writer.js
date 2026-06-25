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

const __ = gremlin.process.statics;
const { cardinality } = gremlin.process;

// The single business vertex label. `artifact_type` carries the v2 artifact id.
export const ARTIFACT_LABEL = 'Artifact';
// The scope anchor every artifact hangs off (already created by init-ws).
export const INTENT_LABEL = 'Intent';
// Question vertex so the Intent page can render agent questions (parity with v1).
export const QUESTION_LABEL = 'Question';

// Anchor edge: Intent --CONTAINS--> Artifact (scope membership).
export const ANCHOR_EDGE = 'CONTAINS';

// Business edges the tools may create between artifacts. PRODUCES/CONSUMES wire
// the stage data flow; the rest are durable semantic relations. Kept explicit so
// an agent can't fabricate arbitrary topology.
export const BUSINESS_EDGES = ['PRODUCES', 'CONSUMES', 'DERIVED_FROM', 'RELATES_TO', 'DEPENDS_ON'];

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

// Normalize a valueMap(true) row into a flat object. valueMap returns each
// property as a single-element array; T.id/T.label arrive as symbol-ish keys we
// surface as id/label.
export const flattenValueMap = (vm) => {
  if (!vm) return null;
  const out = {};
  const entries =
    typeof vm.forEach === 'function' && !Array.isArray(vm) ? [...vm.entries()] : Object.entries(vm);
  for (const [k, v] of entries) {
    const key = typeof k === 'string' ? k : (k?.elementName ?? String(k));
    out[key] = Array.isArray(v) ? v[0] : v;
  }
  return out;
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
  const upsertVertex = async (label, id) => {
    await g
      .V()
      .has(label, 'id', id)
      .fold()
      .coalesce(__.unfold(), __.addV(label).property(cardinality.single, 'id', id))
      .next();
  };

  // Idempotent edge create between two existing vertices (same label/id pair).
  const ensureEdge = async ({ fromLabel, fromId, toLabel, toId, edge }) => {
    const exists = await g
      .V()
      .has(fromLabel, 'id', fromId)
      .outE(edge)
      .where(__.inV().has(toLabel, 'id', toId))
      .hasNext();
    if (!exists) {
      await g
        .V()
        .has(fromLabel, 'id', fromId)
        .addE(edge)
        .to(__.V().has(toLabel, 'id', toId))
        .next();
    }
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
    let q = g.V().has(ARTIFACT_LABEL, 'id', id);
    for (const [k, v] of Object.entries(stamped)) q = q.property(cardinality.single, k, v);
    await q.next();

    await ensureEdge({
      fromLabel: INTENT_LABEL,
      fromId: scope.intentId,
      toLabel: ARTIFACT_LABEL,
      toId: id,
      edge: ANCHOR_EDGE,
    });

    for (const l of links) await linkArtifacts({ fromId: id, toId: l.toId, edge: l.edge });
    return { id, artifactType, ...stamped };
  };

  // Update mutable props on an existing artifact. Never touches the provenance
  // stamp or artifact_type; refuses reserved props. Errors if absent.
  const updateArtifact = async ({ id, props = {} }) => {
    assertId(id);
    const exists = await g.V().has(ARTIFACT_LABEL, 'id', id).hasNext();
    if (!exists) throw new GraphWriteError(`Artifact "${id}" not found`);
    const clean = sanitizeProps(props);
    let q = g.V().has(ARTIFACT_LABEL, 'id', id).property(cardinality.single, 'updated_at', now());
    for (const [k, v] of Object.entries(clean)) q = q.property(cardinality.single, k, v);
    await q.next();
    return { id, updated: Object.keys(clean) };
  };

  const linkArtifacts = async ({ fromId, toId, edge }) => {
    assertEdge(edge);
    assertId(fromId);
    assertId(toId);
    const fromExists = await g.V().has(ARTIFACT_LABEL, 'id', fromId).hasNext();
    if (!fromExists) throw new GraphWriteError(`edge source artifact "${fromId}" not found`);
    const toExists = await g.V().has(ARTIFACT_LABEL, 'id', toId).hasNext();
    if (!toExists) throw new GraphWriteError(`edge target artifact "${toId}" not found`);
    await ensureEdge({ fromLabel: ARTIFACT_LABEL, fromId, toLabel: ARTIFACT_LABEL, toId, edge });
    return { fromId, toId, edge };
  };

  const getArtifact = async ({ id }) => {
    assertId(id);
    const res = await g.V().has(ARTIFACT_LABEL, 'id', id).valueMap(true).next();
    return res.value ? flattenValueMap(res.value) : null;
  };

  // Every artifact of a given type in this intent's scope.
  const lookupArtifacts = async ({ artifactType }) => {
    assertArtifactType(artifactType);
    const list = await g
      .V()
      .has(INTENT_LABEL, 'id', scope.intentId)
      .out(ANCHOR_EDGE)
      .hasLabel(ARTIFACT_LABEL)
      .has('artifact_type', artifactType)
      .valueMap(true)
      .toList();
    return list.map(flattenValueMap);
  };

  // The full artifact subgraph for the intent: every contained artifact — a
  // compact snapshot for the agent to orient.
  const getIntentGraph = async () => {
    const list = await g
      .V()
      .has(INTENT_LABEL, 'id', scope.intentId)
      .out(ANCHOR_EDGE)
      .hasLabel(ARTIFACT_LABEL)
      .valueMap(true)
      .toList();
    return list.map(flattenValueMap);
  };

  // Neighbors of an artifact, optionally filtered by edge + direction.
  const getNeighbors = async ({ id, edge = null, direction = 'both' }) => {
    assertId(id);
    if (edge) assertEdge(edge);
    let q = g.V().has(ARTIFACT_LABEL, 'id', id);
    const step = direction === 'in' ? 'in_' : direction === 'out' ? 'out' : 'both';
    q = edge ? q[step](edge) : q[step]();
    const list = await q.hasLabel(ARTIFACT_LABEL).valueMap(true).toList();
    return list.map(flattenValueMap);
  };

  // Substring search across the intent's artifacts. Matches title/content/type,
  // optionally narrowed to one artifact_type. Done in-process for portability
  // across Neptune/gremlin-server (TextP.containing support varies).
  const searchGraph = async ({ query, artifactType = null, limit = 25 }) => {
    if (typeof query !== 'string' || !query) throw new GraphWriteError('search query is required');
    let q = g.V().has(INTENT_LABEL, 'id', scope.intentId).out(ANCHOR_EDGE).hasLabel(ARTIFACT_LABEL);
    if (artifactType) q = q.has('artifact_type', artifactType);
    const all = await q.valueMap(true).toList();
    const needle = query.toLowerCase();
    return all
      .map(flattenValueMap)
      .filter((a) =>
        `${a.title ?? ''}\n${a.content ?? ''}\n${a.artifact_type ?? ''}`
          .toLowerCase()
          .includes(needle),
      )
      .slice(0, limit);
  };

  // Create a Question vertex on the Intent so the page can render it. The
  // blocking/answer flow lives in the process bridge (DynamoDB); this is the
  // business-graph mirror, matching v1.
  const recordQuestion = async ({ questionId, questionsJson }) => {
    await g
      .addV(QUESTION_LABEL)
      .property(cardinality.single, 'id', questionId)
      .property(cardinality.single, 'intent_id', scope.intentId)
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

  return {
    createArtifact,
    updateArtifact,
    linkArtifacts,
    getArtifact,
    lookupArtifacts,
    getIntentGraph,
    getNeighbors,
    searchGraph,
    recordQuestion,
  };
};
