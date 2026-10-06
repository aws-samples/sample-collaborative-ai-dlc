// Build-and-Test loop-back.
//
// Upstream's construction protocol lets a build-and-test run send the work back
// to code generation, autonomously, up to three times per intent. The platform
// reproduces the BOUND and the ROUTING but not the autonomy: the decision is
// offered to the human at the validation gate build-and-test already has, which
// is where every other backward jump in this system is decided.
//
// Everything here is pure: the derivation of the target stage from the resolved
// plan, the cap, and the decision event name. The orchestrator owns the walk
// and the row resets; the MCP bridge records the agent's recommendation on the
// stage row. Keeping the derivation here is what lets the rule be tested
// without a durable run and stops it from being restated at each call site.
//
// No version string appears in this file. The target is read off the plan the
// release already resolved, and the capability that enables the offer is a
// registry entry keyed on the closure's runtime files (aidlc-capabilities.js).

import { LOOP_BACK_RESULTS_ARTIFACT, PLAN_APPROVAL_ARTIFACT } from './aidlc-capabilities.js';
import { LOOP_BACK_OPTION } from './gate-answer.js';

// The registry key whose presence turns the offer on. Release mode alone is not
// enough: a catalog that ships no construction protocol has no loop-back to
// reproduce.
const LOOP_BACK_CAPABILITY = 'PROTOCOL:build-and-test-loopback';

// Upstream's bound, per intent. The durable counter and applied IDs live on META
// and update atomically with the final target-stage reset.
const LOOP_BACK_LIMIT = 3;

// The human's decision, recorded when the walk actually jumps back. This is
// timeline data; the durable META tally, not this best-effort event, enforces
// the cap.
const LOOP_BACK_RECORDED_EVENT = 'v2.loopback.recorded';

// The authored output slugs of a stage, read from either shape the two call sites
// hold: the PLAN instance (`outputArtifacts`, at the gate) and the CATALOG block
// (`produces`, while the policy is resolved). Both are the same authored list.
const outputArtifactTypesOf = (stage) =>
  (stage?.outputArtifacts ?? stage?.produces ?? [])
    .map((output) => output?.artifact ?? output)
    .filter(Boolean);

/**
 * Whether this catalog proves it has a construction loop-back at all. Consumed
 * by `resolveStagePolicy` so the runtime reads a resolved policy key instead of
 * re-deriving capability presence.
 */
const loopBackApplies = ({ capabilities = {} } = {}) => capabilities[LOOP_BACK_CAPABILITY] === true;

/**
 * Is this stage the one the release lets RECOMMEND a loop-back — upstream's
 * build-and-test?
 *
 * `loopBackApplies` says the RELEASE has a loop-back; this says WHO may offer one.
 * Both are required, and adjacency cannot substitute for either: any stage that
 * happens to run after code generation would otherwise qualify. Read off the
 * authored `build-test-results` output for the same reason `isCodeGenerationStage`
 * reads `code-generation-plan` — upstream states the recommender in protocol prose,
 * and mapping a new stage-block field would move the 2.3.3 block digest.
 */
const isLoopBackRecommenderStage = (stage) =>
  outputArtifactTypesOf(stage).includes(LOOP_BACK_RESULTS_ARTIFACT);

/**
 * Is this stage the one the release marks as code generation — the stage a
 * build-and-test loop-back targets?
 *
 * Upstream marks it with `workspace_requires: true`. That key is deliberately not
 * mapped onto the plan's stage instance (mapping it would move the 2.3.3 block
 * digest, which is the coexistence contract's byte-identity proof), so the
 * authored `code-generation-plan` output is read as the equivalent marker — the
 * same substitution `planApprovalApplies` makes, for the same reason.
 * `workspaceRequires` is still honoured first so that mapping it later needs no
 * change here.
 */
const isCodeGenerationStage = (stage) =>
  stage?.workspaceRequires === true ||
  outputArtifactTypesOf(stage).includes(PLAN_APPROVAL_ARTIFACT);

/**
 * The loop-back target for the stage at `currentIndex`: the stage IMMEDIATELY
 * before it in the same segment (passing over skipped stages), and only when that
 * stage is code generation. Upstream sends build-and-test back to code generation
 * and nothing else back, so a later stage (deployment, observability) gets null.
 *
 * Segment-scoped on purpose, exactly like `resolveSkipTo`'s forward jump: the
 * walk index the caller rewinds is a segment index. When code generation runs
 * per unit in a parallel section, build-and-test opens the next segment and has
 * no target — re-entering a fan-out would have to re-derive the approved unit
 * plan. Those scopes keep the rewind API.
 *
 * Returns `{ index, stageId }`, or `null`.
 */
const loopBackTarget = ({ segmentStages = [], currentIndex = 0, skippedStageIds = [] } = {}) => {
  for (let i = Number(currentIndex) - 1; i >= 0; i -= 1) {
    const candidate = segmentStages[i];
    if (!candidate || skippedStageIds.includes(candidate.stageId)) continue;
    return isCodeGenerationStage(candidate) ? { index: i, stageId: candidate.stageId } : null;
  }
  return null;
};

/**
 * The whole offer decision in one pure call, so the gate site reads as the rule.
 *
 * `recommendation` is the reason the agent recorded on this stage's row through
 * `emit_stage_note` (the orchestrator clears it once a gate has read it, so it
 * always belongs to the run that just finished).
 *
 * - `{ offered: true, target, spent, remaining, reason }`: the gate offers it.
 * - `{ offered: false, atCap: true, target, spent, reason }`: the cap is spent;
 *   the gate says so instead of silently withholding the option.
 * - `{ offered: false, unavailable: true, reason }`: the agent recommended it but
 *   this stage has no linear code-generation stage to go back to; the gate says so.
 * - `{ offered: false }`: nothing to show — including when the stage asking is not
 *   the release's recommender, which no amount of stage order can make it.
 */
const resolveLoopBackOffer = ({
  stage = null,
  segmentStages = [],
  currentIndex = 0,
  skippedStageIds = [],
  recommendation = null,
  loopBackCount = 0,
} = {}) => {
  if (stage?.policy?.loopBack !== 'human-offered' || !recommendation) return { offered: false };
  if (!isLoopBackRecommenderStage(stage)) return { offered: false };
  const reason = String(recommendation).slice(0, 300);
  const target = loopBackTarget({
    segmentStages,
    currentIndex,
    skippedStageIds,
  });
  if (!target) return { offered: false, unavailable: true, reason };
  const spent = loopBackCount;
  if (spent >= LOOP_BACK_LIMIT) return { offered: false, atCap: true, target, spent, reason };
  return {
    offered: true,
    target,
    spent,
    remaining: LOOP_BACK_LIMIT - spent,
    reason,
  };
};

export {
  LOOP_BACK_CAPABILITY,
  LOOP_BACK_LIMIT,
  LOOP_BACK_OPTION,
  LOOP_BACK_RECORDED_EVENT,
  isCodeGenerationStage,
  isLoopBackRecommenderStage,
  loopBackApplies,
  loopBackTarget,
  resolveLoopBackOffer,
};

export default {
  LOOP_BACK_CAPABILITY,
  LOOP_BACK_LIMIT,
  LOOP_BACK_OPTION,
  LOOP_BACK_RECORDED_EVENT,
  isCodeGenerationStage,
  isLoopBackRecommenderStage,
  loopBackApplies,
  loopBackTarget,
  resolveLoopBackOffer,
};
