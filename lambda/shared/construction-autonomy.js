// Construction Autonomy Mode.
//
// Upstream's construction protocol lets a human grant the run permission to
// complete the REMAINING construction stage gates without stopping, keeping only
// the halt-and-ask set: the first construction stage's own approval, Plan
// Approval, a stage failure, a blocking gate sensor, and an exhausted loop-back
// bound. The grant is per-intent, workflow-global, and two-valued — absent,
// `unset`, and `gated` all read as gated, and only the exact string `autonomous`
// waives anything.
//
// Everything here is pure: the two-value vocabulary, the capability key, the
// anchor derivation (which stage keeps its human gate), and the eligibility
// predicate. The orchestrator owns the gate walk and the receipts; the intents
// lambda owns the grant at create. Keeping the rule here is what lets it be
// tested without a durable run and stops it from being restated per call site.
//
// No version string appears in this file. The capability that enables the mode is
// a registry entry keyed on the closure's runtime files (aidlc-capabilities.js),
// exactly like the loop-back it shares a protocol module with.

// The registry key whose presence allows the grant. Release mode alone is not
// enough: a catalog that ships no construction protocol has no autonomy to
// reproduce, so the field is refused at create rather than silently ignored.
const CONSTRUCTION_AUTONOMY_CAPABILITY = 'PROTOCOL:construction-autonomy';

// The gate option that escalates a gated run, offered at the one construction
// gate that always stays human. `parseChoice` matches it verbatim.
const GRANT_AUTONOMY_OPTION = 'grant-autonomy';

const AUTONOMY_MODE_SET_EVENT = 'v2.autonomy.mode_set';
const GATE_AUTO_APPROVED_EVENT = 'v2.gate.auto_approved';

// The approval receipt's recorded answer. Upstream mandates a marker string on an
// autonomous completion so an audit reader can tell a waived gate from a human
// one; this is that marker.
const AUTONOMOUS_GATE_INPUT = 'Autonomous construction gate per construction protocol module';

/**
 * Whether this catalog proves it has construction autonomy at all. Consumed by
 * `resolveStagePolicy` so the runtime reads a resolved policy key instead of
 * re-deriving capability presence.
 */
const constructionAutonomyApplies = ({ capabilities = {} } = {}) =>
  capabilities[CONSTRUCTION_AUTONOMY_CAPABILITY] === true;

/**
 * The anchor: the first non-skipped construction stage of the WHOLE plan that
 * opens a sequential gate, whose gate stays human in every stance.
 *
 * A stage inside a parallel section (`parallelSection != null`) never opens a
 * sequential gate: its human stop is the section's skeleton gate and lane
 * ladder. Anchoring on it would leave the grant with no gate to be offered at,
 * and let a create-time grant waive the first sequential construction gate.
 *
 * Read off the full plan rather than the stages a rewind happens to replay — a
 * backward jump must not move the anchor, or a relaunch that starts inside
 * construction would re-arm a gate the human already answered (or, worse, waive
 * the one gate upstream never waives).
 */
const firstConstructionStageId = ({ stages = [], skippedStageIds = [] } = {}) => {
  const skipped = new Set(skippedStageIds.filter(Boolean));
  const first = stages.find(
    (stage) =>
      stage?.phase === 'construction' &&
      stage.parallelSection == null &&
      !skipped.has(stage.stageId),
  );
  return first?.stageId ?? null;
};

/**
 * Is THIS gate one the grant waives?
 *
 * Every clause is a hard precondition, so the predicate reads as the rule:
 *   1. the grant is exactly `autonomous` (absent / `gated` / anything else = no);
 *   2. the catalog proves it has the protocol (`policy.constructionAutonomy`);
 *   3. the stage is in the construction phase;
 *   4. the stage is NOT the anchor (the plan's first non-skipped construction
 *      stage with a sequential gate);
 *   5. no fan-out approval rides this gate (the unit plan is the human's to
 *      shape, and a waived fan-out would commit a DAG nobody looked at);
 *   6. Plan Approval does not apply to this stage — upstream's hard human stop.
 *
 * The caller still has to find the findings empty: an eligible gate with any
 * finding at all halts and asks, which is the halt-and-ask seam.
 */
const autonomousGateApplies = ({
  mode = null,
  stage = null,
  stages = [],
  skippedStageIds = [],
  fanoutGateNeeded = false,
} = {}) => {
  if (mode !== 'autonomous') return false;
  if (stage?.policy?.constructionAutonomy !== 'native') return false;
  if (stage?.phase !== 'construction') return false;
  if (fanoutGateNeeded) return false;
  if (stage?.policy?.planApproval === 'required') return false;
  const anchor = firstConstructionStageId({ stages, skippedStageIds });
  if (anchor === null || anchor === stage?.stageId) return false;
  return true;
};

/**
 * Is THIS gate the one that may offer the escalation?
 *
 * The anchor gate, and only while the run is still gated — so the offer appears
 * exactly once per intent, at the ladder position upstream puts it, and never on
 * a gate the grant would already have waived.
 */
const grantAutonomyOffered = ({
  mode = null,
  stage = null,
  stages = [],
  skippedStageIds = [],
} = {}) => {
  if (mode === 'autonomous') return false;
  if (stage?.policy?.constructionAutonomy !== 'native') return false;
  if (stage?.phase !== 'construction') return false;
  return firstConstructionStageId({ stages, skippedStageIds }) === stage?.stageId;
};

export {
  AUTONOMOUS_GATE_INPUT,
  AUTONOMY_MODE_SET_EVENT,
  CONSTRUCTION_AUTONOMY_CAPABILITY,
  GATE_AUTO_APPROVED_EVENT,
  GRANT_AUTONOMY_OPTION,
  autonomousGateApplies,
  constructionAutonomyApplies,
  firstConstructionStageId,
  grantAutonomyOffered,
};
export default {
  AUTONOMOUS_GATE_INPUT,
  AUTONOMY_MODE_SET_EVENT,
  CONSTRUCTION_AUTONOMY_CAPABILITY,
  GATE_AUTO_APPROVED_EVENT,
  GRANT_AUTONOMY_OPTION,
  autonomousGateApplies,
  constructionAutonomyApplies,
  firstConstructionStageId,
  grantAutonomyOffered,
};
