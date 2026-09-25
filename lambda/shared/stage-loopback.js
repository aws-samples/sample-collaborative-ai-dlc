// Build-and-Test loop-back.
//
// Upstream's construction protocol lets a build-and-test run send the work back
// to code generation, autonomously, up to three times per intent. The platform
// reproduces the BOUND and the ROUTING but not the autonomy: the decision is
// offered to the human at the validation gate build-and-test already has, which
// is where every other backward jump in this system is decided.
//
// Everything here is pure: the derivation of the target stage from the resolved
// plan, the cap, and the two typed event names. The orchestrator owns the walk
// and the row resets; the MCP bridge owns the recommendation event. Keeping the
// derivation here is what lets the rule be tested without a durable run and
// stops it from being restated at each call site.
//
// No version string appears in this file. The target is read off the plan the
// release already resolved, and the capability that enables the offer is a
// registry entry keyed on the closure's runtime files (aidlc-capabilities.js).

import { PLAN_APPROVAL_ARTIFACT } from './aidlc-capabilities.js';
import { eventTypeOf } from './v2-process-keys.js';

// The registry key whose presence turns the offer on. Release mode alone is not
// enough: a catalog that ships no construction protocol has no loop-back to
// reproduce.
const LOOP_BACK_CAPABILITY = 'PROTOCOL:build-and-test-loopback';

// Upstream's bound, per intent. The durable counter and applied IDs live on META
// and update atomically with the final target-stage reset.
const LOOP_BACK_LIMIT = 3;

// The agent's recommendation, recorded by the platform (never parsed from prose)
// — see `emitStageNote`'s `loopBackRecommended` field.
const LOOP_BACK_RECOMMENDED_EVENT = 'v2.loopback.recommended';
// The human's decision, recorded when the walk actually jumps back. This is
// timeline data; the durable stage counter, not this best-effort event, enforces
// the cap.
const LOOP_BACK_RECORDED_EVENT = 'v2.loopback.recorded';

// The gate option label. `parseChoice` matches it verbatim and the frontend keys
// its third button off the same string, so it is spelled once.
const LOOP_BACK_OPTION = 'loop-back';

const outputArtifactTypesOf = (stage) =>
  (stage?.outputArtifacts ?? []).map((output) => output?.artifact ?? output).filter(Boolean);

/**
 * Whether this catalog proves it has a construction loop-back at all. Consumed
 * by `resolveStagePolicy` so the runtime reads a resolved policy key instead of
 * re-deriving capability presence.
 */
const loopBackApplies = ({ capabilities = {} } = {}) => capabilities[LOOP_BACK_CAPABILITY] === true;

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
 * The loop-back target for the stage at `currentIndex`: the NEAREST PRECEDING
 * in-scope stage in the same segment that the release marks as code generation.
 *
 * Segment-scoped on purpose, exactly like `resolveSkipTo`'s forward jump: the
 * walk index the caller rewinds is a segment index. A target that lives inside a
 * parallel section (the per-unit `code-generation` lane of a scope with a unit
 * DAG) is therefore NOT offered — re-entering a fan-out section would have to
 * re-derive the unit plan and its approved decisions, which is a different
 * operation from rewinding a linear run. Those scopes keep the rewind API.
 *
 * Returns `{ index, stageId }`, or `null` when no such stage precedes this one.
 */
const loopBackTarget = ({ segmentStages = [], currentIndex = 0, skippedStageIds = [] } = {}) => {
  for (let i = Number(currentIndex) - 1; i >= 0; i -= 1) {
    const candidate = segmentStages[i];
    if (!candidate) continue;
    if (skippedStageIds.includes(candidate.stageId)) continue;
    if (!isCodeGenerationStage(candidate)) continue;
    return { index: i, stageId: candidate.stageId };
  }
  return null;
};

/**
 * Did the agent recommend a loop-back for THIS attempt of THIS stage?
 *
 * Attempt-scoped like every receipt in this phase: a rewind bumps the STAGE#
 * attempt, so a recommendation from a previous attempt is invisible rather than
 * deleted. The attempt is read from the event's `detail`, which the MCP bridge
 * stamps from the trusted container ENV — never from the agent's arguments.
 */
const loopBackRecommendation = ({ events = [], stageInstanceId = null, attempt = 0 } = {}) => {
  const matches = events.filter(
    (row) =>
      eventTypeOf(row) === LOOP_BACK_RECOMMENDED_EVENT &&
      row.stageInstanceId === stageInstanceId &&
      Number(row.detail?.attempt ?? 0) === Number(attempt),
  );
  const latest = matches.at(-1) ?? null;
  if (!latest) return null;
  return { reason: String(latest.detail?.reason ?? latest.summary ?? '').slice(0, 300) };
};

/**
 * The whole offer decision in one pure call, so the gate site reads as the rule.
 *
 * `offered: false` with a `target` and `atCap: true` is the cap case: the option
 * is withheld but the gate still SAYS so, which is what keeps the human from
 * choosing between "approve" and nothing while wondering where the agent's
 * recommendation went.
 */
const resolveLoopBackOffer = ({
  stage = null,
  segmentStages = [],
  currentIndex = 0,
  skippedStageIds = [],
  events = [],
  attempt = 0,
  loopBackCount = null,
} = {}) => {
  if (stage?.policy?.loopBack !== 'human-offered') return { offered: false, atCap: false };
  const recommendation = loopBackRecommendation({
    events,
    stageInstanceId: stage.stageInstanceId ?? null,
    attempt,
  });
  if (!recommendation) return { offered: false, atCap: false };
  const target = loopBackTarget({ segmentStages, currentIndex, skippedStageIds });
  if (!target) return { offered: false, atCap: false };
  if (!Number.isInteger(loopBackCount) || loopBackCount < 0) {
    return { offered: false, atCap: false };
  }
  const spent = loopBackCount;
  if (spent >= LOOP_BACK_LIMIT) {
    return { offered: false, atCap: true, target, spent, reason: recommendation.reason };
  }
  return {
    offered: true,
    atCap: false,
    target,
    spent,
    remaining: LOOP_BACK_LIMIT - spent,
    reason: recommendation.reason,
  };
};

export {
  LOOP_BACK_CAPABILITY,
  LOOP_BACK_LIMIT,
  LOOP_BACK_OPTION,
  LOOP_BACK_RECOMMENDED_EVENT,
  LOOP_BACK_RECORDED_EVENT,
  isCodeGenerationStage,
  loopBackApplies,
  loopBackRecommendation,
  loopBackTarget,
  resolveLoopBackOffer,
};

export default {
  LOOP_BACK_CAPABILITY,
  LOOP_BACK_LIMIT,
  LOOP_BACK_OPTION,
  LOOP_BACK_RECOMMENDED_EVENT,
  LOOP_BACK_RECORDED_EVENT,
  isCodeGenerationStage,
  loopBackApplies,
  loopBackRecommendation,
  loopBackTarget,
  resolveLoopBackOffer,
};
