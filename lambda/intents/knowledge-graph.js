// The intent's Neptune KNOWLEDGE subgraph — what the run produced and drew on:
//   - the Intent anchor (hub)
//   - Artifact vertices it CONTAINS + the typed business edges between them
//     (PRODUCES/CONSUMES/DERIVED_FROM/RELATES_TO/DEPENDS_ON, written by the
//     agent's link tools)
//   - Question vertices it CONTAINS (the graph mirror of agent questions)
//   - Discussion threads (Intent --HAS_DISCUSSION--> Discussion --DISCUSSES-->
//     its anchor: the Intent itself or an Artifact)
//   - the PROJECT's TeamKnowledge + LearningRule corpus — these are injected
//     into EVERY stage prompt of the run, so they are literally "the knowledge
//     the agent works on" even though they hang off the Project vertex.
//
// Response shape mirrors the v1 sprint-graph endpoint ({ nodes, edges }, generic
// node bags) so the frontend graph types apply unchanged. Artifact/knowledge
// `content` can be many KB of markdown — nodes carry a bounded PREVIEW plus the
// full length; the artifact cards on the page already hold the full content.
//
// Edge semantics: every edge except INFORMS exists in the graph verbatim.
// INFORMS is synthesized (TeamKnowledge/LearningRule → Intent) to express the
// real prompt-injection relation — those vertices anchor on the Project, but
// the run is what they steer.

import gremlin from 'gremlin';

const __ = gremlin.process.statics;
const { t: T } = gremlin.process;

export const BUSINESS_EDGES = ['PRODUCES', 'CONSUMES', 'DERIVED_FROM', 'RELATES_TO', 'DEPENDS_ON'];

// Bounded content preview for node payloads (full content stays on the detail DTO).
const PREVIEW_CHARS = 400;
const preview = (content) => {
  const s = String(content ?? '');
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s;
};

// Normalize a valueMap(true) row into a flat object (arrays → first element,
// T.id/T.label symbol keys → strings).
const flatten = (vm) => {
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

// A Question vertex has no title — label it with the first question's text.
const questionLabel = (questionsJson) => {
  try {
    const parsed = JSON.parse(questionsJson ?? '[]');
    const first = Array.isArray(parsed) ? parsed[0]?.text : null;
    return first ? String(first) : 'Question';
  } catch {
    return 'Question';
  }
};

// Map edge-projection rows ({source,target,label} gremlin Maps) to plain
// objects, keeping only edges whose BOTH endpoints are rendered nodes.
const mapEdgeRows = (rows, nodeIds) =>
  rows
    .map((r) => ({ source: r.get('source'), target: r.get('target'), label: r.get('label') }))
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

export const fetchKnowledgeGraph = async (g, { projectId, intentId }) => {
  // The Intent anchor is created by init-ws at Start — before that there is no
  // subgraph. An empty graph (not an error): the intent exists in the process
  // store, it just hasn't produced anything yet.
  const intentRes = await g.V().has('Intent', 'id', intentId).valueMap(true).next();
  if (intentRes.done || !intentRes.value) return { nodes: [], edges: [] };
  const intentVm = flatten(intentRes.value);

  const artifacts = (
    await g
      .V()
      .has('Intent', 'id', intentId)
      .out('CONTAINS')
      .hasLabel('Artifact')
      .valueMap(true)
      .toList()
  ).map(flatten);

  const questions = (
    await g
      .V()
      .has('Intent', 'id', intentId)
      .out('CONTAINS')
      .hasLabel('Question')
      .valueMap(true)
      .toList()
  ).map(flatten);

  const discussions = (
    await g
      .V()
      .has('Intent', 'id', intentId)
      .out('HAS_DISCUSSION')
      .hasLabel('Discussion')
      .valueMap(true)
      .toList()
  ).map(flatten);

  // Project knowledge corpus — injected into every stage of this run.
  let knowledge = [];
  let learnings = [];
  if (projectId && (await g.V().has('Project', 'id', projectId).hasNext())) {
    knowledge = (
      await g
        .V()
        .has('Project', 'id', projectId)
        .out('HAS_KNOWLEDGE')
        .hasLabel('TeamKnowledge')
        .valueMap(true)
        .toList()
    ).map(flatten);
    learnings = (
      await g
        .V()
        .has('Project', 'id', projectId)
        .out('HAS_LEARNING')
        .hasLabel('LearningRule')
        .valueMap(true)
        .toList()
    ).map(flatten);
  }

  const nodes = [
    {
      id: intentId,
      type: 'Intent',
      label: intentVm.title || 'Intent',
      createdAt: intentVm.created_at ?? null,
    },
    ...artifacts.map((a) => ({
      id: a.id,
      type: 'Artifact',
      label: a.title || a.id,
      artifactType: a.artifact_type ?? null,
      createdByStageInstanceId: a.created_by_stage_instance_id ?? null,
      createdAt: a.created_at ?? null,
      updatedAt: a.updated_at ?? null,
      contentPreview: preview(a.content),
      contentLength: String(a.content ?? '').length,
    })),
    ...questions.map((q) => ({
      id: q.id,
      type: 'Question',
      label: questionLabel(q.questions),
      questions: q.questions ?? null,
      createdAt: q.created_at ?? null,
    })),
    ...discussions.map((d) => ({
      id: d.id,
      type: 'Discussion',
      label: d.entity_title || 'Discussion',
      entityType: d.entity_type ?? null,
      status: d.status ?? null,
      createdAt: d.created_at ?? null,
    })),
    ...knowledge.map((k) => ({
      id: k.id,
      type: 'TeamKnowledge',
      label: k.title || k.id,
      agentRef: k.agent_ref ?? null,
      createdByIntentId: k.created_by_intent_id ?? null,
      createdAt: k.created_at ?? null,
      contentPreview: preview(k.content),
      contentLength: String(k.content ?? '').length,
    })),
    ...learnings.map((l) => ({
      id: l.id,
      type: 'LearningRule',
      label: l.title || l.id,
      layer: l.layer ?? null,
      pairing: l.pairing ?? null,
      createdByIntentId: l.created_by_intent_id ?? null,
      createdAt: l.created_at ?? null,
      contentPreview: preview(l.content),
      contentLength: String(l.content ?? '').length,
    })),
  ];
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Typed business edges between this intent's artifacts.
  let businessEdges = [];
  if (artifacts.length > 0) {
    const rows = await g
      .V()
      .has('Intent', 'id', intentId)
      .out('CONTAINS')
      .hasLabel('Artifact')
      .outE(...BUSINESS_EDGES)
      .project('source', 'target', 'label')
      .by(__.outV().values('id'))
      .by(__.inV().values('id'))
      .by(T.label)
      .dedup()
      .toList();
    businessEdges = mapEdgeRows(rows, nodeIds);
  }

  // Discussion → anchor (the Intent itself, or an Artifact).
  let discussEdges = [];
  if (discussions.length > 0) {
    const rows = await g
      .V()
      .has('Intent', 'id', intentId)
      .out('HAS_DISCUSSION')
      .hasLabel('Discussion')
      .outE('DISCUSSES')
      .project('source', 'target', 'label')
      .by(__.outV().values('id'))
      .by(__.inV().values('id'))
      .by(T.label)
      .dedup()
      .toList();
    discussEdges = mapEdgeRows(rows, nodeIds);
  }

  const edges = [
    // Scope membership (real CONTAINS edges — re-derived from the node sets).
    ...artifacts.map((a) => ({ source: intentId, target: a.id, label: 'CONTAINS' })),
    ...questions.map((q) => ({ source: intentId, target: q.id, label: 'CONTAINS' })),
    ...businessEdges,
    ...discussEdges,
    // Synthesized: the prompt-injection relation (see module header).
    ...knowledge.map((k) => ({ source: k.id, target: intentId, label: 'INFORMS' })),
    ...learnings.map((l) => ({ source: l.id, target: intentId, label: 'INFORMS' })),
  ];

  return { nodes, edges };
};
