// Per-intent stage skipping — policy + validation shared by the intents API
// (create-time deselection), the orchestrator (gate-time "skip to stage X"),
// and the plan resolver (the skip overlay itself lives in v2-execution-plan.js).
//
// Upstream provenance (awslabs/aidlc-workflows, pinned by aidlc_repo_ref):
//   - stage front-matter `execution: ALWAYS | CONDITIONAL` — only CONDITIONAL
//     stages carry a skip condition; ALWAYS stages are the methodology's
//     backbone (requirements-analysis, code-generation, build-and-test, …).
//   - stage-protocol.md §0.5 — "'Skip to stage X' means skip INTERMEDIATE
//     stages, NOT shortcut the TARGET stage's ritual."
//   - The per-unit skip matrix (section.js validateFanoutOverrides) already
//     enforces the same CONDITIONAL-only rule at construction fan-out; this
//     module extends that rule to once-per-workflow stages.
//
// The feature is gated by a platform setting (SSM `<prefix>/stage-skipping`,
// Admin UI managed) with a per-project override on the Project vertex
// (`stage_skipping`: default | enabled | disabled). The EFFECTIVE value is
// resolved once at intent create and snapshotted onto the execution META row
// (`stageSkipping`), so a toggle flip never changes a run mid-flight.

// Platform values (SSM) and project override values (Neptune vertex).
const STAGE_SKIPPING_MODES = ['enabled', 'disabled'];
const PROJECT_STAGE_SKIPPING_MODES = ['default', 'enabled', 'disabled'];

// Effective run value: the project override wins when explicit; 'default'
// (or anything unrecognized) inherits the platform setting. Fail-safe:
// anything other than an explicit 'enabled' resolves to 'disabled'.
const effectiveStageSkipping = (platformValue, projectValue = 'default') => {
  if (projectValue === 'enabled' || projectValue === 'disabled') return projectValue;
  return platformValue === 'enabled' ? 'enabled' : 'disabled';
};

// Why a stage may NOT be skipped, or null when it is skippable. Mirrors the
// fan-out skip matrix's rule (execution must be CONDITIONAL) plus the
// initialization guard (those stages are runtime prerequisites: workspace
// scaffold/state, and workspace-detection stamps the brownfield/greenfield
// mode that conditionalOn consumes evaluate against).
const stageSkipBlockReason = (stage) => {
  if (!stage) return 'unknown stage';
  if ((stage.phase ?? null) === 'initialization') {
    return 'initialization stages are runtime prerequisites and always run';
  }
  if (stage.execution !== 'CONDITIONAL') {
    return `execution is ${stage.execution ?? 'ALWAYS'} — only CONDITIONAL stages are skippable`;
  }
  return null;
};

// Normalize a caller-supplied skip list to a deduplicated string array.
// Returns null for "no skips" (absent/empty) so META stays sparse.
const normalizeSkipStageIds = (input) => {
  if (!Array.isArray(input)) return null;
  const ids = [...new Set(input.filter((s) => typeof s === 'string' && s.trim()))];
  return ids.length ? ids : null;
};

// Gate-time "skip to stage X" resolution (upstream §0.5). Given the ordered
// stage list of ONE linear segment and the index of the stage whose validation
// gate was just approved, a target is valid when:
//   - it sits at least two positions ahead (>= one INTERMEDIATE stage —
//     skipping zero stages is a plain approve, not a skip), and
//   - every intermediate stage is skippable per stageSkipBlockReason.
// The TARGET itself always runs (its ritual is never shortcut), so it carries
// no skippability constraint. Skips never cross a segment boundary — parallel
// sections keep their own fan-out gate + per-unit skip matrix.
const skipTargetsFrom = (segmentStages, currentIndex) => {
  const targets = [];
  for (let t = currentIndex + 2; t < segmentStages.length; t += 1) {
    const blocked = segmentStages
      .slice(currentIndex + 1, t)
      .some((s) => stageSkipBlockReason(s) !== null);
    if (blocked) break; // a non-skippable intermediate blocks every farther target too
    targets.push(segmentStages[t].stageId);
  }
  return targets;
};

// Validate a gate answer's `skipTo` against the segment. Returns
// { targetIndex, skippedStages } or { error } — the CALLER decides whether a
// rejected skip fails loudly or degrades to a plain approve (never trust,
// never silently drop: the rejection reason is for the timeline).
const resolveSkipTo = ({ skipTo, segmentStages, currentIndex }) => {
  if (typeof skipTo !== 'string' || !skipTo) return { error: 'skipTo must be a stage id' };
  const targetIndex = segmentStages.findIndex((s, i) => i > currentIndex && s.stageId === skipTo);
  if (targetIndex < 0) {
    return { error: `"${skipTo}" is not a later stage in this segment` };
  }
  if (targetIndex < currentIndex + 2) {
    return { error: `"${skipTo}" is the next stage — nothing to skip` };
  }
  const skippedStages = segmentStages.slice(currentIndex + 1, targetIndex);
  for (const s of skippedStages) {
    const reason = stageSkipBlockReason(s);
    if (reason) return { error: `cannot skip "${s.stageId}": ${reason}` };
  }
  return { targetIndex, skippedStages };
};

// Validate a gate answer's recompose delta (`recompose: { skip: [...] }`) —
// an ARBITRARY set of not-yet-reached stages to deselect, unlike skipTo's
// contiguous jump. Evaluated against the FLAT plan-stage list (skips may name
// stages in later linear segments too). Per-entry verdicts, never all-or-
// nothing: the caller applies the valid flips and reports the rejected ones
// on the timeline (never trust, never silently drop). Rules per stage:
//   - must exist in the plan and sit strictly AFTER the current stage
//     (behind-cursor reshapes are rewind's job),
//   - must not sit in a parallel section (unit lanes are reshaped at the
//     fan-out gate's skip matrix, not here),
//   - must pass the skip policy (CONDITIONAL-only, never initialization),
//   - must not already be skipped.
const resolveRecomposeSkips = ({ stages, currentStageId, requested, alreadySkipped = [] }) => {
  const applied = [];
  const rejected = [];
  const ids = Array.isArray(requested)
    ? [...new Set(requested.filter((s) => typeof s === 'string' && s.trim()))]
    : [];
  const currentIndex = stages.findIndex((s) => s.stageId === currentStageId);
  const skippedSet = new Set(alreadySkipped);
  for (const stageId of ids) {
    const idx = stages.findIndex((s) => s.stageId === stageId);
    if (idx < 0) {
      rejected.push({ stageId, reason: 'not in this run\u2019s plan' });
      continue;
    }
    if (idx <= currentIndex) {
      rejected.push({ stageId, reason: 'already reached — rewind to reshape the past' });
      continue;
    }
    const stage = stages[idx];
    if (stage.parallelSection != null) {
      rejected.push({
        stageId,
        reason: 'runs per unit of work — reshape it at the fan-out gate',
      });
      continue;
    }
    const blockReason = stageSkipBlockReason({ phase: stage.phase, execution: stage.execution });
    if (blockReason) {
      rejected.push({ stageId, reason: blockReason });
      continue;
    }
    if (skippedSet.has(stageId)) {
      rejected.push({ stageId, reason: 'already skipped' });
      continue;
    }
    applied.push(stageId);
  }
  return { applied, rejected };
};

export {
  STAGE_SKIPPING_MODES,
  PROJECT_STAGE_SKIPPING_MODES,
  effectiveStageSkipping,
  stageSkipBlockReason,
  normalizeSkipStageIds,
  skipTargetsFrom,
  resolveSkipTo,
  resolveRecomposeSkips,
};
export default {
  STAGE_SKIPPING_MODES,
  PROJECT_STAGE_SKIPPING_MODES,
  effectiveStageSkipping,
  stageSkipBlockReason,
  normalizeSkipStageIds,
  skipTargetsFrom,
  resolveSkipTo,
  resolveRecomposeSkips,
};
