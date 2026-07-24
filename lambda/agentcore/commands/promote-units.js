// promote-units — freeze the approved unit-of-work-dependency DAG into the
// scheduling data model.
//
// Invoked by the orchestrator (durable step) right after the stage producing
// `unit-of-work-dependency` SUCCEEDS and after every question gate the stage
// opened was answered. Sensors are advisory here — nothing upstream guarantees
// the DAG artifact exists or parses; this command re-derives everything itself.
// This command:
//
//   1. reads the artifact body from the business graph (the container is the
//      only VPC-attached component on this path; the orchestrator has no
//      Neptune access),
//   2. re-parses it with the SAME parser the sensor used (parseBoltDag — the
//      scheduling truth is derived, never trusted from an agent claim),
//   3. writes the UNITPLAN snapshot + UNIT#<slug> lane rows to the DDB
//      process table (scheduling truth; re-promotion after a rewind never
//      touches lanes that already started),
//   4. mirrors UnitOfWork vertices + DEPENDS_ON edges to Neptune
//      (traceability/UI only),
//   5. records a v2.units.promoted event + broadcast.
//
// Decision fields (skip matrix / walking-skeleton pick / autonomy mode) are
// frozen with DETERMINISTIC defaults here; the unit-DAG stage's validation
// gate (which doubles as the fan-out approval) patches them with the human's
// choices via store.updateUnitPlanDecisions:
//   skipMatrix      {}                — every unit executes every per-unit stage
//   walkingSkeleton first slug of the first batch (stable: batches are sorted)
//   autonomyMode    null              — decided at the autonomy-ladder prompt
//
// Trivial-intent degeneration (issue #336): a small intent can leave the model
// with nothing to fan out, so units-generation exits 0 without ever recording
// the DAG artifact (or records prose with no units: block). Instead of aborting
// the run one step after the stage was marked SUCCEEDED, promotion synthesizes
// a one-unit plan — the whole intent as a single unit with no dependencies —
// writes it as a real artifact (provenance/traceability identical to an
// agent-written one) and promotes it through the normal path. The fan-out
// validation gate still presents the 1-unit plan to the human. A DAG that
// EXISTS but is broken (cycle, bad kind, unparseable entries) keeps failing
// loudly: that is an agent defect, not a trivial intent.
//
// Returns values, never throws for expected conditions:
//   { ok: true, unitCount, ... }               — promoted (synthesized: true
//                                                when the plan was degenerated)
//   { ok: false, reason: 'dag_malformed'|'dag_cyclic', detail }
//   { ok: false, reason: 'promotion_failed', detail } — infra error

import { createGraphWriter, closeGraphSource } from '../mcp/graph-writer.js';
import { parseBoltDag } from '../../shared/v2-sensor-contract.js';

const DAG_ARTIFACT_TYPE = 'unit-of-work-dependency';

// Deterministic slug for the degenerate plan: stable across re-promotions
// (lanes are keyed by slug), git-ref-safe, and free of `--` (reserved as the
// unit-lane separator in branch names — see unitBranchFor).
const SYNTH_UNIT_SLUG = 'whole-intent';
const SYNTH_ARTIFACT_ID = 'unit-of-work-dependency-synthesized';

const SYNTH_DAG_BODY = `# Unit of Work Dependency

No unit decomposition was produced by units-generation — the intent is small
enough to build as a single unit of work. This plan was synthesized by the
platform so the workflow can continue; the whole intent is one unit.

\`\`\`yaml
units:
  - name: ${SYNTH_UNIT_SLUG}
    depends_on: []
\`\`\`
`;

// The degeneration cases: no artifact at all, an artifact without a units:
// block, or a units: block with zero entries. Everything else malformed stays
// a loud failure.
const isDegenerateDag = (dag) =>
  dag.reason === 'absent' || (dag.reason === 'malformed' && dag.detail === 'no entries');

// Pick the artifact row to promote: current (non-superseded) rows win; among
// those the newest by updated_at/created_at. A rewind marks old rows
// superseded, so re-promotion naturally follows the re-produced artifact.
const artifactTs = (r) => String(r.updated_at ?? r.created_at ?? '');
export const pickCurrentArtifact = (rows = []) => {
  const current = rows.filter((r) => !r.superseded_at);
  return current.toSorted((a, b) => artifactTs(b).localeCompare(artifactTs(a)))[0] ?? null;
};

export const promoteUnits = async (payload, deps) => {
  const {
    projectId,
    intentId,
    executionId,
    stageInstanceId = null,
    sectionIndexes = [null],
  } = payload ?? {};
  const {
    store,
    openGraph,
    broadcast = async () => {},
    clock,
    // Injectable for tests; production binds the real writer factory.
    createWriter = createGraphWriter,
  } = deps;
  if (!intentId || !executionId) {
    return { ok: false, reason: 'missing_identity' };
  }

  const publish = (p) => broadcast({ executionId, intentId, projectId, ...p }).catch(() => {});
  const event = (type, summary) =>
    store
      .appendEvent({ executionId, type, stageInstanceId, actor: 'agentcore', summary })
      .catch(() => {});

  let graph;
  let g;
  try {
    g = await openGraph();
    graph = createWriter({
      g,
      scope: { projectId, intentId, executionId, stageInstanceId },
      ...(clock ? { clock } : {}),
    });
  } catch (e) {
    await closeGraphSource(g);
    await event('v2.units.promotion_failed', `graph unavailable: ${e.message}`);
    return { ok: false, reason: 'promotion_failed', detail: `graph unavailable: ${e.message}` };
  }

  // Close the graph connection on every exit (release its fd — see
  // closeGraphSource). The long-lived session process reuses this command.
  try {
    // 1+2. Read + re-parse the DAG artifact.
    const rows = await graph.lookupArtifacts({
      artifactType: DAG_ARTIFACT_TYPE,
      includeContent: true,
    });
    let artifact = pickCurrentArtifact(rows);
    let dag = artifact ? parseBoltDag(String(artifact.content ?? '')) : null;
    let synthesized = false;
    if (!artifact || (!dag.ok && isDegenerateDag(dag))) {
      // Trivial-intent degeneration: no DAG (or an empty one) collapses to a
      // single unit spanning the whole intent. Written as a real artifact so
      // sourceArtifactId/DERIVED_FROM provenance and rewind supersession work
      // exactly as for an agent-written DAG. Re-promotion is idempotent: the
      // synthesized artifact is itself a valid DAG the next lookup finds.
      const created = await graph.createArtifact({
        artifactType: DAG_ARTIFACT_TYPE,
        id: SYNTH_ARTIFACT_ID,
        title: 'Unit of Work Dependency (synthesized single unit)',
        content: SYNTH_DAG_BODY,
      });
      artifact = { id: created.id, content: SYNTH_DAG_BODY };
      dag = parseBoltDag(SYNTH_DAG_BODY);
      synthesized = true;
      await event(
        'v2.units.synthesized',
        `no unit DAG produced — intent degenerated to a single unit "${SYNTH_UNIT_SLUG}"`,
      );
    }
    if (!dag.ok) {
      await event('v2.units.promotion_failed', `DAG ${dag.reason}: ${dag.detail}`);
      return { ok: false, reason: `dag_${dag.reason}`, detail: dag.detail };
    }

    // `kind` (parsed + validated by parseBoltDag) rides into the scheduling
    // truth: per-unit dispatch prunes a stage's produces_kinds-narrowed
    // artifacts for units whose kind is not listed. null = untagged (the unit
    // gets the full artifact matrix).
    const units = dag.units.map((u) => ({
      slug: u.name,
      dependsOn: u.depends_on,
      kind: u.kind ?? null,
    }));
    const batches = dag.batches;

    // 3. Scheduling truth: UNITPLAN snapshot + UNIT rows (active lanes safe).
    // Deterministic skeleton default: first slug of the first topological
    // batch (batches are sorted). The fan-out approval can override.
    const existingPlan = await store.getUnitPlan(executionId);
    const plan = await store.putUnitPlan({
      executionId,
      units,
      batches,
      sourceArtifactId: artifact.id ?? null,
      producedByStageInstanceId: stageInstanceId,
      // Preserve previously captured human decisions across a re-promotion —
      // a rewind re-produces the DAG, not the humans' skip/skeleton/autonomy
      // answers (the unit-DAG stage's gate re-confirms them on re-approval).
      skipMatrix: existingPlan?.skipMatrix ?? {},
      walkingSkeleton: existingPlan?.walkingSkeleton ?? batches[0]?.[0] ?? null,
      autonomyMode: existingPlan?.autonomyMode ?? null,
    });
    const sync = await store.syncUnitRows({ executionId, units, batches, sectionIndexes });

    // 4. Traceability mirror (never blocks promotion outcome — the DDB truth
    // is already written; a mirror failure is recorded and visible).
    let mirror = null;
    try {
      mirror = await graph.mirrorUnitDag({ units, sourceArtifactId: artifact.id ?? null });
      // Re-resolve item↔item traceability now that the UnitOfWork vertices
      // exist: StoryMapEntry/Contract items derived BEFORE promotion could not
      // wire IMPLEMENTS/EXPOSES/CONSUMES_CONTRACT edges to units yet.
      if (graph.resolveDerivedItemEdges) await graph.resolveDerivedItemEdges();
    } catch (e) {
      await event('v2.units.mirror_failed', e.message);
    }

    // 5. Trace + live update.
    const summary =
      `Unit DAG promoted: ${units.length} unit(s) in ${batches.length} wave(s)` +
      `${sync.created.length ? `, created ${sync.created.join(', ')}` : ''}` +
      `${sync.preserved.length ? `, preserved active ${sync.preserved.join(', ')}` : ''}` +
      `${sync.orphaned.length ? `, orphaned ${sync.orphaned.join(', ')}` : ''}`;
    await event('v2.units.promoted', summary);
    await publish({ action: 'agent.units', unitCount: units.length, state: 'PROMOTED' });

    return {
      ok: true,
      unitCount: units.length,
      batchCount: batches.length,
      walkingSkeleton: plan.walkingSkeleton,
      synthesized,
      sync,
      mirror,
    };
  } catch (e) {
    await event('v2.units.promotion_failed', e.message);
    return { ok: false, reason: 'promotion_failed', detail: e.message };
  } finally {
    await closeGraphSource(g);
  }
};
