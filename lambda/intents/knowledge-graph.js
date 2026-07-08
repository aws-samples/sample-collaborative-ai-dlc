// The intent's Neptune KNOWLEDGE subgraph — what the run produced and drew on:
//   - the Intent anchor (hub)
//   - Artifact vertices it CONTAINS + the typed business edges between them
//     (PRODUCES/CONSUMES/DERIVED_FROM/RELATES_TO/DEPENDS_ON, written by the
//     agent's link tools)
//   - Question vertices it CONTAINS (the graph mirror of agent questions)
//     and INFLUENCES edges to artifacts that changed after the answer
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
import {
  DERIVED_ITEM_LABELS,
  flattenVertexMap,
  isCurrentRow as isCurrent,
} from '../shared/graph-rows.js';

const __ = gremlin.process.statics;
const { t: T } = gremlin.process;

export const BUSINESS_EDGES = ['PRODUCES', 'CONSUMES', 'DERIVED_FROM', 'RELATES_TO', 'DEPENDS_ON'];

// Row helpers shared with the agentcore graph-writer (ONE implementation —
// the Neptune valueMap-order bug once had to be fixed in two copies).
// Section vertices are deliberately EXCLUDED from this read — a heading per
// node would swamp the canvas without adding topology.
export { DERIVED_ITEM_LABELS, flattenVertexMap };
const flatten = flattenVertexMap;

// Item↔item traceability edges the derive sweep materializes from the slug
// refs in structured blocks (graph-writer resolveDerivedItemEdges): Story
// COVERS Requirement / FOR_PERSONA Persona / DEPENDS_ON Story, Component
// DEPENDS_ON Component, StoryMapEntry IMPLEMENTS Story|UnitOfWork, UnitOfWork
// EXPOSES / CONSUMES_CONTRACT Contract.
export const ITEM_EDGES = ['COVERS', 'FOR_PERSONA', 'DEPENDS_ON', 'IMPLEMENTS'];
export const UNIT_CONTRACT_EDGES = ['EXPOSES', 'CONSUMES_CONTRACT'];

// Bounded content preview for node payloads (full content stays on the detail DTO).
const PREVIEW_CHARS = 400;
const preview = (content) => {
  const s = String(content ?? '');
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s;
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
  // Traversal builders (a gremlin traversal is single-use, so these construct
  // a fresh one per call): `anchored` starts at this intent's scope edge;
  // `flatRows`/`edgeRows` finish a traversal as flattened vertex rows or as
  // {source,target,label} edge projections.
  const anchored = (label, edge = 'CONTAINS') =>
    g.V().has('Intent', 'id', intentId).out(edge).hasLabel(label);
  const flatRows = async (traversal) => (await traversal.valueMap(true).toList()).map(flatten);
  const edgeRows = (traversal) =>
    traversal
      .project('source', 'target', 'label')
      .by(__.outV().values('id'))
      .by(__.inV().values('id'))
      .by(T.label)
      .dedup()
      .toList();

  // The Intent anchor is created by init-ws at Start — before that there is no
  // subgraph. An empty graph (not an error): the intent exists in the process
  // store, it just hasn't produced anything yet.
  const intentRes = await g.V().has('Intent', 'id', intentId).valueMap(true).next();
  if (intentRes.done || !intentRes.value) return { nodes: [], edges: [] };
  const intentVm = flatten(intentRes.value);

  const artifacts = await flatRows(anchored('Artifact'));
  const questions = await flatRows(anchored('Question'));
  // Steering vertices — human course corrections (docs/v2-steering.md): the
  // WHY behind a direction change, with REVISES/INFLUENCES provenance edges.
  const steering = await flatRows(anchored('Steering'));
  const discussions = await flatRows(anchored('Discussion', 'HAS_DISCUSSION'));

  // Project knowledge corpus — injected into every stage of this run.
  let knowledge = [];
  let learnings = [];
  if (projectId && (await g.V().has('Project', 'id', projectId).hasNext())) {
    const projectOut = (edge, label) =>
      g.V().has('Project', 'id', projectId).out(edge).hasLabel(label);
    knowledge = await flatRows(projectOut('HAS_KNOWLEDGE', 'TeamKnowledge'));
    learnings = await flatRows(projectOut('HAS_LEARNING', 'LearningRule'));
  }

  // ── The DERIVED layer (docs/v2-graph-context.md) ──
  // Typed items mirrored from artifact structured blocks, plus the unit-of-work
  // DAG traceability mirror. Current rows only: a superseded item (re-derive)
  // or an item of a superseded artifact (rewind) never renders. Kept in
  // separate arrays so the node mapping can tag them for the UI layer toggle.
  const currentArtifactIds = new Set(artifacts.filter(isCurrent).map((a) => a.id));
  const derivedItemRows = (await flatRows(anchored('Artifact').out('HAS_ITEM').dedup()))
    .filter(isCurrent)
    .filter((i) => !i.artifact_id || currentArtifactIds.has(i.artifact_id));
  const units = (await flatRows(anchored('UnitOfWork'))).filter(isCurrent);

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
      // Rewind lineage: a superseded artifact came from a rewound stage attempt
      // and has not (yet) been rehabilitated by the re-run. UI dims it.
      superseded: Boolean(a.superseded_at),
      supersededAt: a.superseded_at ?? null,
      contentPreview: preview(a.content),
      contentLength: String(a.content ?? '').length,
    })),
    ...questions.map((q) => ({
      id: q.id,
      type: 'Question',
      label: questionLabel(q.questions),
      questions: q.questions ?? null,
      answer: q.structured_answer ?? null,
      answeredBy: q.answered_by ?? null,
      answeredByName: q.answered_by_name ?? null,
      answeredAt: q.answered_at ?? null,
      createdAt: q.created_at ?? null,
    })),
    ...steering.map((s) => ({
      id: s.id,
      type: 'Steering',
      label: preview(s.message) || 'Course correction',
      kind: s.kind ?? null,
      targetGateId: s.target_gate_id || null,
      targetStageId: s.target_stage_id || null,
      createdBy: s.created_by || null,
      createdByName: s.created_by_name || null,
      createdAt: s.created_at ?? null,
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
    // ── Derived layer (UI-toggleable via graphLayer) ──
    ...derivedItemRows.map((i) => ({
      id: i.id,
      // The vertex label IS the item type (Story/Requirement/…), surfaced by
      // flatten() from T.label.
      type: i.label || 'Item',
      graphLayer: 'derived',
      label: i.title || i.slug || i.id,
      slug: i.slug ?? null,
      artifactId: i.artifact_id ?? null,
      artifactType: i.artifact_type ?? null,
      priority: i.priority ?? null,
      status: i.status ?? null,
      createdAt: i.created_at ?? null,
    })),
    ...units.map((u) => ({
      id: u.id,
      type: 'UnitOfWork',
      graphLayer: 'derived',
      label: u.slug || u.id,
      slug: u.slug ?? null,
      createdAt: u.created_at ?? null,
    })),
  ];
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Real graph edges, one projection per source set. mapEdgeRows drops any
  // edge touching a node that is not rendered (stale items, foreign scopes).
  // - business: typed artifact↔artifact links + CITES (derived citations)
  // - derived: Artifact --HAS_ITEM--> item, plus the item↔item traceability
  //   the derive sweep materializes (COVERS/FOR_PERSONA/DEPENDS_ON/IMPLEMENTS)
  // - units: the DAG mirror (DEPENDS_ON/DERIVED_FROM) + contract wiring
  // - questions/steering/discussions: provenance edges
  const project = async (enabled, traversalFn) =>
    enabled ? mapEdgeRows(await edgeRows(traversalFn()), nodeIds) : [];
  const businessEdges = await project(artifacts.length > 0, () =>
    anchored('Artifact').outE(...BUSINESS_EDGES, 'CITES'),
  );
  const derivedEdges = [
    ...(await project(derivedItemRows.length > 0, () => anchored('Artifact').outE('HAS_ITEM'))),
    ...(await project(derivedItemRows.length > 0, () =>
      anchored('Artifact')
        .out('HAS_ITEM')
        .dedup()
        .outE(...ITEM_EDGES),
    )),
  ];
  const unitEdges = await project(units.length > 0, () =>
    anchored('UnitOfWork').outE('DEPENDS_ON', 'DERIVED_FROM', ...UNIT_CONTRACT_EDGES),
  );
  const discussEdges = await project(discussions.length > 0, () =>
    anchored('Discussion', 'HAS_DISCUSSION').outE('DISCUSSES'),
  );
  const influenceEdges = await project(questions.length > 0, () =>
    anchored('Question').outE('INFLUENCES'),
  );
  // Steering provenance: REVISES (correction → the question it corrects) and
  // INFLUENCES (correction → the artifacts the redirected stage produced).
  const steeringEdges = await project(steering.length > 0, () =>
    anchored('Steering').outE('REVISES', 'INFLUENCES'),
  );

  const edges = [
    // Scope membership (real CONTAINS edges — re-derived from the node sets).
    ...artifacts.map((a) => ({ source: intentId, target: a.id, label: 'CONTAINS' })),
    ...questions.map((q) => ({ source: intentId, target: q.id, label: 'CONTAINS' })),
    ...steering.map((s) => ({ source: intentId, target: s.id, label: 'CONTAINS' })),
    ...units.map((u) => ({ source: intentId, target: u.id, label: 'CONTAINS' })),
    ...businessEdges,
    ...derivedEdges,
    ...unitEdges,
    ...influenceEdges,
    ...steeringEdges,
    ...discussEdges,
    // Synthesized: the prompt-injection relation (see module header).
    ...knowledge.map((k) => ({ source: k.id, target: intentId, label: 'INFORMS' })),
    ...learnings.map((l) => ({ source: l.id, target: intentId, label: 'INFORMS' })),
  ];

  return { nodes, edges };
};
