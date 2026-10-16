// Execution truth, not provider PR state. MERGED means integrated into the
// intent branch. A deliberately omitted lane needs a recorded human decision.
import { createHash } from 'node:crypto';
import { repoUrl } from './repo-provider.js';

export const unitPlanIdentity = (plan) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        units: plan?.units ?? [],
        sourceArtifactId: plan?.sourceArtifactId ?? null,
        producedByStageInstanceId: plan?.producedByStageInstanceId ?? null,
      }),
    )
    .digest('hex');

export const skeletonCeremonyDisabled = (stages = []) =>
  stages.find((stage) => stage.policy?.skeleton)?.policy?.skeleton === 'off';

export const skeletonCandidates = (plan) => {
  const roots = new Set(
    (plan?.units ?? []).filter((unit) => !(unit.dependsOn ?? []).length).map((unit) => unit.slug),
  );
  return [
    ...new Set([...(plan?.batches ?? []).flat(), ...(plan?.units ?? []).map((u) => u.slug)]),
  ].filter((slug) => roots.has(slug));
};

// Preserve a captured decision, including an invalid one, so approval/execution
// can explain and reject it. Only an absent decision receives a safe default.
export const effectiveSkeleton = (plan) =>
  plan?.walkingSkeleton ?? skeletonCandidates(plan)[0] ?? null;

export const skeletonProblem = (plan, skeleton = effectiveSkeleton(plan), stages = []) => {
  if (skeletonCeremonyDisabled(stages)) return null;
  const unit = plan?.units?.find((item) => item.slug === skeleton);
  if (!unit) return `Walking skeleton "${skeleton}" is not in the current unit plan.`;
  if (unit.dependsOn?.length) {
    return `Walking skeleton "${skeleton}" depends on ${unit.dependsOn.join(', ')}. It must run first, alone; select a dependency-free unit (${skeletonCandidates(plan).join(', ')}).`;
  }
  return null;
};

export const dependentClosure = (plan, slugs) => {
  const selected = new Set(slugs);
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of plan.units ?? []) {
      if (!selected.has(unit.slug) && unit.dependsOn?.some((slug) => selected.has(slug))) {
        selected.add(unit.slug);
        changed = true;
      }
    }
  }
  return [...selected];
};

export const hasUnitSkipDecision = (unit, plan) =>
  unit?.state !== 'MERGED' &&
  Boolean(unit?.completionSkip?.humanTaskId) &&
  unit.completionSkip.planIdentity === unitPlanIdentity(plan);

export const activePlanUnits = (plan, units = []) => {
  const slugs = new Set((plan?.units ?? []).map((unit) => unit.slug));
  return units.filter((unit) => slugs.has(unit.slug));
};

export const completionSections = (plan) => [
  ...new Set((plan?.stages ?? []).map((stage) => stage.parallelSection).filter((s) => s != null)),
];

export const unverifiedCompletion = (reason) => ({
  state: 'unknown',
  reason,
  total: 0,
  integrated: 0,
  skipped: 0,
  unresolved: [],
  legacyPartial: false,
});

// Legacy halt prompts listed the exact failed lanes. Their old "without them"
// wording did not explicitly authorize every blocked dependent, much less a
// different section. Missing scope or plan provenance is ambiguity, not consent.
const legacyOmission = (records, sectionIndex, slug) => {
  let ambiguous = false;
  for (const gate of records.humanTasks ?? []) {
    if (
      !gate.orchestratorRunId ||
      gate.orchestratorRunId !== records.meta?.orchestratorRunId ||
      !/^eg-halt-s\d/.test(gate.humanTaskId ?? '') ||
      !['approved', 'answered'].includes(gate.status) ||
      (gate.answer?.decision ?? gate.answer?.choice ?? gate.answer) !== 'skip'
    )
      continue;
    const section = gate.sectionIndex ?? Number(gate.humanTaskId.match(/^eg-halt-s(\d+)/)?.[1]);
    if (section !== sectionIndex) continue;
    const named = [
      ...(gate.prompt ?? '').matchAll(
        /^- ([^:\n]+): (?:failed|FAILED|BLOCKED|PENDING|RUNNING|undefined)$/gm,
      ),
    ].map((match) => match[1]);
    const planTime = Date.parse(records.unitPlan?.promotedAt);
    const gateTime = Date.parse(gate.createdAt);
    if (!named.length || !Number.isFinite(planTime) || !Number.isFinite(gateTime)) {
      ambiguous = true;
      continue;
    }
    if (gateTime < planTime) continue;
    if (named.includes(slug)) return 'skipped';
    if (dependentClosure(records.unitPlan, named).includes(slug)) {
      // Policy 1 made the dependent scope explicit in the accepted prompt.
      // Its per-row receipt loop can fail partway through; preserve the rest
      // of that recorded decision without broadening the older "without them".
      if (
        gate.prompt.includes(
          '- skip: explicitly omit these lanes and all their unintegrated dependents from delivery',
        )
      )
        return 'skipped';
      ambiguous = true;
    }
  }
  return ambiguous ? 'unknown' : null;
};

const integrationProblem = (records, row) => {
  const repos = (records.meta?.repos ?? []).map(repoUrl);
  const prs = (records.unitPrs ?? []).filter(
    (pr) => pr.sectionIndex === row.sectionIndex && (pr.unitSlug ?? pr.slug) === row.slug,
  );
  if (prs.some((pr) => !['MERGED', 'UNCHANGED'].includes(pr.state))) {
    return 'repository_integration_incomplete';
  }
  if (records.meta?.prStrategy === 'pr-per-unit') {
    if (repos.some((repo) => !prs.some((pr) => pr.repository === repo))) {
      return 'repository_evidence_missing';
    }
  } else if (Object.hasOwn(row, 'integrationResults')) {
    // Only an absent attribute identifies a pre-deploy MERGED row. New writes
    // always persist this attribute, including an empty result array.
    if (
      !Array.isArray(row.integrationResults) ||
      row.integrationResults.some((r) => !r || typeof r.repo !== 'string' || !r.repo)
    )
      return 'repository_evidence_invalid';
    if (row.integrationResults.some((r) => r.merged !== true && r.merged !== 'up_to_date')) {
      return 'repository_integration_incomplete';
    }
    if (repos.some((repo) => !row.integrationResults.some((r) => r.repo === repo))) {
      return 'repository_evidence_missing';
    }
  }
  return null;
};

export const unitCompletion = (records, sectionIndexes) => {
  if (records.truncated) return unverifiedCompletion('completion_read_limit');
  const plan = records.unitPlan;
  if (!plan?.units?.length) {
    return sectionIndexes?.length
      ? unverifiedCompletion('unit_plan_missing')
      : sectionIndexes
        ? { ...unverifiedCompletion(null), state: 'complete' }
        : null;
  }
  const rows = activePlanUnits(plan, records.units);
  const sections = sectionIndexes ?? [...new Set(rows.map((unit) => unit.sectionIndex))];
  if (!sections.length && sectionIndexes === undefined) {
    return unverifiedCompletion('expected_sections_unknown');
  }
  if (
    sections.some((s) => s == null) ||
    (sections.length && rows.some((r) => r.sectionIndex == null))
  ) {
    return unverifiedCompletion('legacy_section_mapping_unknown');
  }
  const outcomes = sections.flatMap((sectionIndex) =>
    plan.units.map((unit) => {
      const row = rows.find(
        (item) => item.slug === unit.slug && item.sectionIndex === sectionIndex,
      );
      const problem = row?.state === 'MERGED' ? integrationProblem(records, row) : null;
      const skipped = hasUnitSkipDecision(row, plan);
      const legacy =
        !skipped && row?.state !== 'MERGED'
          ? legacyOmission(records, sectionIndex, unit.slug)
          : null;
      return {
        sectionIndex,
        slug: unit.slug,
        state: row?.state ?? (row ? 'UNKNOWN' : 'MISSING'),
        integrated: row?.state === 'MERGED' && !problem,
        skipped: skipped || legacy === 'skipped',
        legacyPartial: legacy === 'skipped',
        reason:
          problem ??
          (legacy === 'unknown'
            ? 'legacy_skip_scope_unknown'
            : row
              ? row.state
                ? 'unit_unfinished'
                : 'unit_state_missing'
              : 'unit_row_missing'),
        unknown:
          problem === 'repository_evidence_missing' ||
          problem === 'repository_evidence_invalid' ||
          legacy === 'unknown' ||
          Boolean(row && !row.state),
      };
    }),
  );
  const unresolved = outcomes.filter((unit) => !unit.integrated && !unit.skipped);
  return {
    state: unresolved.length
      ? unresolved.some((unit) => unit.unknown)
        ? 'unknown'
        : 'incomplete'
      : outcomes.some((unit) => unit.skipped)
        ? 'partial'
        : 'complete',
    total: outcomes.length,
    integrated: outcomes.filter((unit) => unit.integrated).length,
    skipped: outcomes.filter((unit) => unit.skipped).length,
    unresolved,
    legacyPartial: outcomes.some((unit) => unit.legacyPartial),
    reason: unresolved.find((unit) => unit.unknown)?.reason ?? unresolved[0]?.reason ?? null,
  };
};

export const completionMessage = (completion) => {
  const work = completion.unresolved
    .slice(0, 12)
    .map((unit) => `section ${unit.sectionIndex}/${unit.slug}: ${unit.reason ?? unit.state}`)
    .join('; ');
  return `${completion.integrated}/${completion.total} units verified integrated, ${completion.skipped} explicitly omitted. ${
    work || completion.reason || 'Completion evidence unavailable'
  }${completion.unresolved.length > 12 ? '; further units in diagnostics' : ''}. Work is preserved. Review completion diagnostics. Work remains preserved; ordinary rewind reruns affected stages.`;
};

// Called inside one versioned durable step. The final decision and its status
// commit together. A lost step response returns that receipt without rewriting
// the historical decision. Run, META revision and promoted plan are fenced by
// the process-store transaction; this function never writes unit/stage rows.
export const finalizeUnitCompletion = async ({
  store,
  executionId,
  runId,
  plan,
  expectedUnitPlanIdentity = null,
}) => {
  const saved = await store.getExecution(executionId, { consistentRead: true });
  if (
    saved?.orchestratorRunId === runId &&
    ['SUCCEEDED', 'FAILED'].includes(saved.status) &&
    saved.completionValidation?.runId === runId
  )
    return saved.completionValidation;
  const records = await store.getCompletionRecords(executionId);
  const meta = records.meta;
  if (!meta || meta.orchestratorRunId !== runId) return { state: 'retired' };
  if (['SUCCEEDED', 'FAILED'].includes(meta.status) && meta.completionValidation?.runId === runId)
    return meta.completionValidation;
  if (meta.status !== 'RUNNING') return { state: 'retired' };
  const sections = completionSections(plan);
  const completion =
    expectedUnitPlanIdentity && unitPlanIdentity(records.unitPlan) !== expectedUnitPlanIdentity
      ? unverifiedCompletion('unit_plan_changed_after_section')
      : unitCompletion(records, sections);
  const succeeded = ['complete', 'partial'].includes(completion.state);
  const validation = {
    ...completion,
    unresolved: completion.unresolved.slice(0, 50),
    unresolvedCount: completion.unresolved.length,
    version: 2,
    runId,
    expectedSections: sections,
    unitPlanIdentity: unitPlanIdentity(records.unitPlan),
    message: succeeded ? null : completionMessage(completion),
  };
  try {
    await store.updateExecution({
      executionId,
      projectId: meta.projectId,
      startedAt: meta.startedAt,
      ifOrchestratorRunId: runId,
      fromStatus: 'RUNNING',
      ifUpdatedAt: meta.updatedAt,
      ifUnitPlan: records.unitPlan,
      status: succeeded ? 'SUCCEEDED' : 'FAILED',
      completedAt: new Date().toISOString(),
      pendingHumanTaskId: null,
      failureReason: validation.message,
      failure: succeeded
        ? null
        : {
            code:
              completion.state === 'unknown' ? 'completion_unverified' : 'completion_inconsistent',
            message: validation.message,
          },
      completionValidation: validation,
    });
    return validation;
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') return { state: 'retired' };
    // The transaction may have committed before its response (or the store's
    // follow-up read) was lost. Reconcile the saved decision before reporting
    // failure; never overwrite a committed success because its response failed.
    const current = await store
      .getExecution(executionId, { consistentRead: true })
      .catch(() => null);
    if (
      current?.orchestratorRunId === runId &&
      ['SUCCEEDED', 'FAILED'].includes(current.status) &&
      current.completionValidation?.runId === runId
    )
      return current.completionValidation;
    throw error;
  }
};

export const assessExecutionCompletion = async ({ records, loadPlan }) => {
  if (!records.meta) return unverifiedCompletion('execution_missing');
  if (records.truncated) return unverifiedCompletion('completion_read_limit');
  const capturedSections =
    records.meta.completionValidation?.runId === records.meta.orchestratorRunId
      ? records.meta.completionValidation?.expectedSections
      : null;
  // Old workflow versions can still reference LATEST stage definitions. A
  // fresh resolution cannot prove the sections that old execution walked.
  if (
    !records.meta.methodologyRelease &&
    !records.meta.methodologyPins?.STAGE &&
    !Array.isArray(capturedSections)
  ) {
    // Legacy serial executions have no unit work to diagnose. This exception
    // cannot hide a current receipt's expected sections or a pinned unit plan.
    if (!records.unitPlan?.units?.length && !records.units?.length) return null;
    return unverifiedCompletion('legacy_workflow_unpinned');
  }
  let resolved;
  try {
    resolved = await loadPlan(records.meta);
  } catch {
    return unverifiedCompletion('pinned_plan_read_failed');
  }
  if (!resolved?.valid || !Array.isArray(resolved.plan?.stages)) {
    return unverifiedCompletion('pinned_plan_unverified');
  }
  const completion = unitCompletion(records, capturedSections ?? completionSections(resolved.plan));
  const aborted =
    records.meta.status === 'CANCELLED' ||
    (records.meta.failure?.code === 'section_aborted' &&
      (records.humanTasks ?? []).some(
        (gate) =>
          gate.orchestratorRunId === records.meta.orchestratorRunId &&
          ['answered', 'approved'].includes(gate.status) &&
          (gate.answer?.decision ?? gate.answer?.choice ?? gate.answer) === 'abort',
      ));
  return aborted ? { ...completion, state: 'aborted', reason: 'execution_aborted' } : completion;
};
