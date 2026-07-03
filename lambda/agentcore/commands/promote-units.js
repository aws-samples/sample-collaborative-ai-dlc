// promote-units — freeze the approved unit-of-work-dependency DAG into the
// scheduling data model (docs/v2-parallel.md WP3).
//
// Invoked by the orchestrator (durable step) right after the stage producing
// `unit-of-work-dependency` SUCCEEDS — i.e. after its sensors passed (the
// blocking `required-sections` sensor already ran parseBoltDag on the body)
// and after every question gate the stage opened was answered. This command:
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
// frozen with DETERMINISTIC defaults here; the WP5 fan-out gate patches them
// with the human's choices via store.updateUnitPlanDecisions:
//   skipMatrix      {}                — every unit executes every per-unit stage
//   walkingSkeleton first slug of the first batch (stable: batches are sorted)
//   autonomyMode    null              — decided at the autonomy-ladder prompt
//
// Returns values, never throws for expected conditions:
//   { ok: true, unitCount, ... }               — promoted
//   { ok: false, reason: 'artifact_not_found' }— no (current) DAG artifact
//   { ok: false, reason: 'dag_absent'|'dag_malformed'|'dag_cyclic', detail }
//   { ok: false, reason: 'promotion_failed', detail } — infra error

import { createRequire } from 'node:module';
import { createGraphWriter, closeGraphSource } from '../mcp/graph-writer.js';

const require = createRequire(import.meta.url);
const { parseBoltDag } = require('../../shared/v2-sensor-contract.js');

const DAG_ARTIFACT_TYPE = 'unit-of-work-dependency';

// Pick the artifact row to promote: current (non-superseded) rows win; among
// those the newest by updated_at/created_at. A rewind marks old rows
// superseded, so re-promotion naturally follows the re-produced artifact.
const artifactTs = (r) => String(r.updated_at ?? r.created_at ?? '');
export const pickCurrentArtifact = (rows = []) => {
  const current = rows.filter((r) => !r.superseded_at);
  return current.toSorted((a, b) => artifactTs(b).localeCompare(artifactTs(a)))[0] ?? null;
};

export const promoteUnits = async (payload, deps) => {
  const { projectId, intentId, executionId, stageInstanceId = null } = payload ?? {};
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
    const rows = await graph.lookupArtifacts({ artifactType: DAG_ARTIFACT_TYPE });
    const artifact = pickCurrentArtifact(rows);
    if (!artifact) {
      await event('v2.units.promotion_failed', `no current ${DAG_ARTIFACT_TYPE} artifact`);
      return { ok: false, reason: 'artifact_not_found' };
    }
    const dag = parseBoltDag(String(artifact.content ?? ''));
    if (!dag.ok) {
      await event('v2.units.promotion_failed', `DAG ${dag.reason}: ${dag.detail}`);
      return { ok: false, reason: `dag_${dag.reason}`, detail: dag.detail };
    }

    const units = dag.units.map((u) => ({ slug: u.name, dependsOn: u.depends_on }));
    const batches = dag.batches;

    // 3. Scheduling truth: UNITPLAN snapshot + UNIT rows (active lanes safe).
    // Deterministic skeleton default: first slug of the first topological
    // batch (batches are sorted). The WP5 fan-out gate can override.
    const existingPlan = await store.getUnitPlan(executionId);
    const plan = await store.putUnitPlan({
      executionId,
      units,
      batches,
      sourceArtifactId: artifact.id ?? null,
      producedByStageInstanceId: stageInstanceId,
      // Preserve previously captured human decisions across a re-promotion —
      // a rewind re-produces the DAG, not the humans' skip/skeleton/autonomy
      // answers (WP5 re-opens the gate when the DAG materially changed).
      skipMatrix: existingPlan?.skipMatrix ?? {},
      walkingSkeleton: existingPlan?.walkingSkeleton ?? batches[0]?.[0] ?? null,
      autonomyMode: existingPlan?.autonomyMode ?? null,
    });
    const sync = await store.syncUnitRows({ executionId, units, batches });

    // 4. Traceability mirror (never blocks promotion outcome — the DDB truth
    // is already written; a mirror failure is recorded and visible).
    let mirror = null;
    try {
      mirror = await graph.mirrorUnitDag({ units, sourceArtifactId: artifact.id ?? null });
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
