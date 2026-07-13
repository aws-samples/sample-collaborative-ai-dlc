// Parallel-section runner (docs/v2-parallel.md WP5) — the deterministic
// replacement for v1's LLM construction orchestrator.
//
// One section = one fan-out → lanes → merge cycle over the promoted UNITPLAN
// (DDB scheduling truth; bolt-plan prose is never parsed):
//
//   fan-out gate      — engine-created approval gate confirming the frozen
//                       decisions (unit × conditional-stage skip matrix +
//                       walking-skeleton pick, defaults from WP3's promotion;
//                       structured answer may override — validated, never
//                       trusted blindly).
//   walking skeleton  — the picked lane runs SOLO (A2 rule 8), then a
//                       mandatory Bolt-level approval gate covering its design
//                       artifacts and generated code together.
//   autonomy ladder   — exactly one prompt (A2 rule 9): 'autonomous' (no more
//                       approval gates; failures still halt-and-ask) vs
//                       'gated' (one approval gate per parallel batch).
//   lanes             — autonomous: TRUE WAVEFRONT (one runInChildContext per
//                       lane; dependents await their dependency lanes'
//                       DurablePromises — the replay-safe shape proven in
//                       poc-a) with an app-level semaphore for
//                       maxParallelUnits. gated: batch barriers (topological
//                       waves) with a per-batch gate.
//   lane lifecycle    — own AgentCore session (aidlc-intent-<id>-s<k>-<slug>),
//                       own workspace, own branch (<intent>--s<k>-unit-<slug>);
//                       init-lane → section stages (park/resume per lane,
//                       release-on-park frees the LANE session) → serialized
//                       --no-ff merge-back into the intent branch (in-process
//                       merge lock; merge-lane is idempotent) → MERGED →
//                       lane session released.
//   halt-and-ask      — a failed lane BLOCKS its dependents, independents
//                       finish (allSettled join), then ONE gate: retry (same
//                       branch/worktree, fresh durable round) / skip (audited;
//                       blocked lanes stay blocked, fan-in proceeds without
//                       them) / abort (fail the run; pushed work preserved).
//
// REPLAY DISCIPLINE: every side effect lives in a ctx step (lane steps inside
// the lane's own child context); lane coordination goes through the lanes'
// DurablePromises only — completed lanes resolve from checkpointed history and
// never re-execute (poc-a). Engine gates are re-read after their callback
// wakes: a superseded gate (cancel/rewind) retires the run with NO writes.

import processKeysPkg from '../shared/v2-process-keys.js';
import { stageIsNoopForUnit } from '../shared/unit-kind-pruning.js';

const { CONSTRUCTION_AUTONOMY_MODES } = processKeysPkg;

// App-level concurrency cap (docs/v2-parallel.md B1 note): the wavefront shape
// has no built-in maxConcurrency. Replayed (completed) lanes never re-execute
// their bodies, so they never re-contend for permits — only genuinely pending
// lanes queue here. limit <= 0 → unbounded (the DAG is the only limit).
export const makeSemaphore = (limit) => {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { acquire: async () => {}, release: () => {} };
  }
  let active = 0;
  const waiters = [];
  return {
    acquire: () =>
      new Promise((resolve) => {
        if (active < limit) {
          active += 1;
          resolve();
        } else {
          waiters.push(resolve);
        }
      }),
    release: () => {
      const next = waiters.shift();
      if (next) next();
      else active = Math.max(0, active - 1);
    },
  };
};

// In-process merge lock: lane merges are SERIALIZED (A3 — deterministic
// merge-back, completion order). Chained promises, never rejects outward.
export const makeMergeLock = () => {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    // keep the chain alive even when a merge fails (failure is a value).
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };
};

// The unit lane's branch (A2 rule 6: per-section, fresh branch per section).
export const unitBranchFor = (intentBranch, sectionIndex, slug) =>
  `${intentBranch}--s${sectionIndex}-unit-${slug}`;

// The unit lane's AgentCore session (A2 rule 3). >= 33 chars like the intent
// session; distinct session = distinct microVM + persistent mount per lane.
export const laneSessionIdFor = (intentId, sectionIndex, slug) =>
  `aidlc-intent-${intentId}-s${sectionIndex}-${slug}`.padEnd(33, '0');

// ── engine gates ─────────────────────────────────────────────────────────────
// An approval gate the ENGINE opens (fan-out / skeleton / ladder / batch /
// halt) — same HUMAN# row + callback discipline as agent question gates, so
// the existing answer endpoint, cancel path, and UI all apply unchanged.
// Deterministic id per (run, name): replay-stable within a run; a relaunch
// (new runId) re-asks rather than reusing a retired run's decision.
// Returns { gate } (answered/approved/rejected row) or { superseded: true }.
export const awaitEngineGate = async (
  ctxArg,
  toolkit,
  {
    name,
    prompt,
    options = null,
    kind = 'approval',
    stageInstanceId = null,
    unitSlug = null,
    // Valid "skip to stage X" targets for a validation gate (stage-skip.js).
    // Advisory for the UI; the orchestrator re-validates the answer.
    skipTargets = null,
    // The COMPUTED next stage after this gate approves (upstream 2.2.6):
    // string = its stageId, null = approving completes the workflow,
    // undefined = not computed (non-validation gates) — the UI keeps its
    // generic labels. Display-only; never drives routing.
    nextStageId = undefined,
  },
) => {
  const { store, broadcast, ids, runId } = toolkit;
  const { executionId, intentId, projectId } = ids;
  const humanTaskId = `eg-${name}-${runId}`;

  // A prior attempt of THIS run may have already opened and even answered the
  // gate (resume after a suspend) — reuse the decision instead of hanging on
  // a callback nobody will complete.
  const existing = await ctxArg.step(`gate-pre-${name}`, () =>
    store.getHumanTask(executionId, humanTaskId).catch(() => null),
  );
  if (existing && existing.status === 'superseded') return { superseded: true };
  if (existing && existing.status !== 'pending') return { gate: existing };

  await ctxArg.step(`gate-open-${name}`, async () => {
    try {
      await store.createHumanTask({
        executionId,
        humanTaskId,
        stageInstanceId,
        unitSlug,
        kind,
        prompt,
        options,
        ...(skipTargets ? { skipTargets } : {}),
        ...(nextStageId !== undefined ? { nextStageId } : {}),
      });
    } catch {
      /* already exists from a prior attempt — idempotent open */
    }
    // Park META (WAITING + pointer): the cancel endpoint and the UI badge key
    // off it. Engine gates are barriers — no lanes are running while pending.
    try {
      await store.updateExecution({
        executionId,
        status: 'WAITING',
        pendingHumanTaskId: humanTaskId,
      });
    } catch {
      /* park bookkeeping is best-effort; the gate row is the truth */
    }
    try {
      await broadcast?.(intentId, {
        intentId,
        projectId,
        executionId,
        action: 'agent.question',
        humanTaskId,
        stageInstanceId,
        unitSlug,
        kind,
        prompt,
        options,
        ...(skipTargets ? { skipTargets } : {}),
        ...(nextStageId !== undefined ? { nextStageId } : {}),
      });
    } catch {
      /* live fan-out is best-effort */
    }
  });

  const [callbackPromise, callbackId] = await ctxArg.createCallback(`await-${humanTaskId}`);
  await ctxArg.step(`bind-callback-${humanTaskId}`, () =>
    store.setGateCallbackId({ executionId, humanTaskId, callbackId }),
  );
  await callbackPromise;

  // Re-read after the wake: cancel/rewind supersedes and wakes with a
  // sentinel — that run owns META from here (same discipline as stage gates).
  const gate = await ctxArg.step(`gate-after-${name}`, () =>
    store.getHumanTask(executionId, humanTaskId).catch(() => null),
  );
  if (!gate || gate.status === 'superseded') return { superseded: true };
  await ctxArg.step(`gate-unpark-${name}`, async () => {
    try {
      await store.updateExecution({ executionId, status: 'RUNNING', pendingHumanTaskId: null });
    } catch {
      /* best-effort un-park */
    }
  });
  return { gate };
};

// Parse a gate answer into one of `allowed`, tolerating the shapes the answer
// endpoint stores ({ decision }, { mode }, a raw string, { freeText }).
// Anything unrecognized returns null — the CALLER picks the deterministic
// fallback and records what was interpreted.
export const parseChoice = (answer, allowed) => {
  const candidates = [
    answer?.decision,
    answer?.mode,
    answer?.choice,
    typeof answer === 'string' ? answer : null,
    typeof answer?.freeText === 'string' ? answer.freeText : null,
  ];
  for (const c of candidates) {
    const v = typeof c === 'string' ? c.trim().toLowerCase() : null;
    if (v && allowed.includes(v)) return v;
  }
  return null;
};

// Validate fan-out-gate overrides against the plan (A2 rule 7: only
// CONDITIONAL section stages are skippable, only known units addressable; the
// walking skeleton must be DEPENDENCY-FREE — it runs solo first, so a
// dependent unit would block on its unmerged deps immediately).
// Returns { walkingSkeleton?, skipMatrix?, rejected: [] } — apply what is
// valid, report what is not (never trust, never silently drop).
export const validateFanoutOverrides = (answer, { slugs, sectionStages, bySlug }) => {
  const rejected = [];
  const out = { rejected };
  if (!answer || typeof answer !== 'object') return out;
  if (answer.walkingSkeleton !== undefined) {
    const slug = answer.walkingSkeleton;
    if (typeof slug !== 'string' || !slugs.has(slug)) {
      rejected.push(`walkingSkeleton "${slug}" is not a unit`);
    } else if ((bySlug?.get(slug)?.dependsOn ?? []).length > 0) {
      rejected.push(
        `walkingSkeleton "${slug}" depends on [${bySlug.get(slug).dependsOn.join(', ')}] — the skeleton runs first, solo, and must be dependency-free`,
      );
    } else {
      out.walkingSkeleton = slug;
    }
  }
  if (answer.skipMatrix !== undefined) {
    if (answer.skipMatrix && typeof answer.skipMatrix === 'object') {
      const matrix = {};
      for (const [slug, stages] of Object.entries(answer.skipMatrix)) {
        if (!slugs.has(slug)) {
          rejected.push(`skipMatrix unit "${slug}" is not a unit`);
          continue;
        }
        const valid = [];
        for (const stageId of Array.isArray(stages) ? stages : []) {
          const stage = sectionStages.find((s) => s.stageId === stageId);
          if (!stage) rejected.push(`skipMatrix stage "${stageId}" is not in this section`);
          else if (stage.execution !== 'CONDITIONAL')
            rejected.push(`skipMatrix stage "${stageId}" is not CONDITIONAL (not skippable)`);
          else valid.push(stageId);
        }
        matrix[slug] = valid;
      }
      out.skipMatrix = matrix;
    } else {
      rejected.push('skipMatrix must be an object of unit → [stageId]');
    }
  }
  return out;
};

const fanoutPrompt = ({ sectionIndex, unitPlan, sectionStages, skeleton }) => {
  const lines = [
    `Fan-out for parallel section ${sectionIndex}: ${unitPlan.units.length} unit(s) across ${
      (unitPlan.batches ?? []).length
    } wave(s).`,
    '',
    ...unitPlan.units.map(
      (u) =>
        `- ${u.slug}${(u.dependsOn ?? []).length ? ` (depends on ${(u.dependsOn ?? []).join(', ')})` : ''}`,
    ),
    '',
    `Walking skeleton: ${skeleton} (runs first, solo, with a mandatory review gate).`,
    `Per-unit stages: ${sectionStages.map((s) => s.stageId).join(', ')}.`,
    `Skip matrix (CONDITIONAL stages skipped per unit): ${
      Object.keys(unitPlan.skipMatrix ?? {}).length
        ? JSON.stringify(unitPlan.skipMatrix)
        : 'none — every unit runs every stage'
    }.`,
    '',
    'Approve to fan out. The structured answer may override',
    '{ "walkingSkeleton": "<slug>", "skipMatrix": { "<slug>": ["<conditional-stage>"] } }.',
  ];
  return lines.join('\n');
};

// ── the section runner ───────────────────────────────────────────────────────
// Returns null to continue the plan walk, or a TERMINAL handler return value.
export const runParallelSection = async (segment, toolkit) => {
  const {
    ctx,
    store,
    invokeRuntime,
    stopSession,
    emitEvent, // (ctxArg, stepName, type, summary, extra)
    fail, // (reason, detail) → terminal value
    executeStage, // (ctxArg, stage, opts) → { state, reason?, value? }
    ids,
    intentBranch,
    cloneBase, // { repos, baseBranch, baseBranches, gitToken, gitProvider }
    // Dispatch-time git-token refresh (GitHub-App mode mints ~1h tokens; the
    // run-start snapshot goes stale). Optional: falls back to cloneBase.gitToken.
    freshGitToken = null,
    intentSessionId,
    maxParallelUnits,
    // Forwarded to the conflict-resolution stage's CLI run (WP6).
    requestedCli = null,
    cliModels = null,
    tierModels = null,
    // Derive-time enrichment mode ('off'|'llm'), snapshotted on META — rides
    // the lane derive-artifacts dispatches like the once-per-workflow hook.
    deriveEnrichment = 'off',
  } = toolkit;
  const { executionId, intentId, projectId } = ids;
  const sk = `s${segment.index}`;

  // Fresh (or snapshot) git token for lane dispatches — must be resolved
  // INSIDE durable step bodies only (replay never re-executes memoized steps).
  const laneGitToken = async () => (freshGitToken ? await freshGitToken() : cloneBase.gitToken);

  const unitPlan = await ctx.step(`load-unit-plan-${sk}`, () => store.getUnitPlan(executionId));
  if (!unitPlan || (unitPlan.units ?? []).length === 0) {
    return await fail(
      'unit_plan_missing',
      `section ${segment.index} (${segment.stages.map((s) => s.stageId).join(', ')})`,
    );
  }
  const bySlug = new Map(unitPlan.units.map((u) => [u.slug, u]));
  const slugs = new Set(bySlug.keys());
  const waves = (
    unitPlan.batches?.length ? unitPlan.batches : [unitPlan.units.map((u) => u.slug)]
  ).map((w) => w.filter((slug) => bySlug.has(slug)));
  const laneOrder = waves.flat();
  const defaultSkeleton =
    unitPlan.walkingSkeleton && bySlug.has(unitPlan.walkingSkeleton)
      ? unitPlan.walkingSkeleton
      : laneOrder[0];

  // ── fan-out gate (A2 rules 2/7/8: human confirmation before any lane) ─────
  const fanout = await awaitEngineGate(ctx, toolkit, {
    name: `fanout-${sk}`,
    prompt: fanoutPrompt({
      sectionIndex: segment.index,
      unitPlan,
      sectionStages: segment.stages,
      skeleton: defaultSkeleton,
    }),
    options: ['approve', 'reject'],
  });
  if (fanout.superseded) {
    ctx.logger?.info?.('run retired at fan-out gate', { intentId, section: segment.index });
    return { ok: false, reason: 'retired', intentId };
  }
  if (fanout.gate.status === 'rejected') {
    return await fail('fanout_rejected', `section ${segment.index}`);
  }

  // Freeze the effective decisions (defaults + validated overrides) as a step
  // result so every replay sees the identical schedule.
  const decisions = await ctx.step(`fanout-decisions-${sk}`, async () => {
    const overrides = validateFanoutOverrides(fanout.gate.answer, {
      slugs,
      sectionStages: segment.stages,
      bySlug,
    });
    const effective = {
      walkingSkeleton: overrides.walkingSkeleton ?? defaultSkeleton,
      skipMatrix: overrides.skipMatrix ?? unitPlan.skipMatrix ?? {},
    };
    try {
      await store.updateUnitPlanDecisions({ executionId, ...effective });
    } catch {
      /* the step result is the scheduling truth; the row is the mirror */
    }
    if (overrides.rejected.length) {
      try {
        await store.appendEvent({
          executionId,
          type: 'v2.units.decisions_invalid',
          actor: 'orchestrator',
          summary: `Fan-out gate overrides partially rejected: ${overrides.rejected.join('; ')}`,
        });
      } catch {
        /* audit is best-effort */
      }
    }
    return effective;
  });
  await emitEvent(
    ctx,
    `fanout-approved-${sk}`,
    'v2.units.fanout_approved',
    `Fan-out approved for section ${segment.index}: skeleton ${decisions.walkingSkeleton}, ${laneOrder.length} unit(s)`,
  );

  // ── shared lane machinery ─────────────────────────────────────────────────
  const semaphore = makeSemaphore(maxParallelUnits);
  const withMergeLock = makeMergeLock();
  // slug → 'MERGED' | 'FAILED' | 'BLOCKED' — settled lane states (this run).
  const laneState = new Map();
  // slug → in-flight lane DurablePromise (wavefront cross-lane coordination).
  const lanePromises = new Map();

  // One lane: init-lane → section stages → serialized merge-back. Runs inside
  // its OWN child context; never throws — failure is a state (poc-a).
  const runLaneBody = async (laneCtx, slug, round) => {
    const unit = bySlug.get(slug);
    const rTag = round > 0 ? `-r${round}` : '';
    const laneSession = laneSessionIdFor(intentId, segment.index, slug);
    const unitBranch = unitBranchFor(intentBranch, segment.index, slug);
    const laneCloneInputs = {
      ...cloneBase,
      branch: unitBranch,
      // A wiped lane mount self-heals onto the unit branch; if the unit branch
      // vanished too, it is recreated from the intent branch — never main.
      baseBranch: intentBranch,
    };

    // Dependencies must be MERGED (A2 rule 4). In the wavefront, await the
    // dependency lanes' DurablePromises; settled lanes come from laneState.
    for (const dep of unit.dependsOn ?? []) {
      let depState = laneState.get(dep);
      if (lanePromises.has(dep)) {
        const settled = await lanePromises.get(dep).catch(() => ({ state: 'FAILED' }));
        depState = settled?.state;
      }
      if (depState !== 'MERGED') {
        await laneCtx.step(`unit-blocked-${sk}-${slug}${rTag}`, async () => {
          try {
            await store.updateUnitState({
              executionId,
              slug,
              state: 'BLOCKED',
              fields: { blockedOn: dep },
            });
          } catch {
            /* lane bookkeeping must never break the run */
          }
        });
        await emitEvent(
          laneCtx,
          `unit-blocked-event-${sk}-${slug}${rTag}`,
          'v2.unit.blocked',
          `Unit ${slug} blocked: dependency ${dep} is not merged`,
          { unitSlug: slug, state: 'BLOCKED' },
        );
        return { slug, state: 'BLOCKED', blockedOn: dep };
      }
    }

    // Concurrency permit AFTER the dependency wait — blocked/waiting lanes
    // must not hold capacity.
    await semaphore.acquire();
    try {
      await laneCtx.step(`unit-run-${sk}-${slug}${rTag}`, async () => {
        try {
          await store.updateUnitState({
            executionId,
            slug,
            state: 'RUNNING',
            // Round 0 starts fresh lanes; retry rounds revive FAILED/BLOCKED.
            fromStates:
              round > 0 ? ['FAILED', 'BLOCKED', 'PENDING', 'READY'] : ['PENDING', 'READY'],
            fields: { branch: unitBranch, sessionId: laneSession, startedAt: true },
          });
        } catch {
          /* lost CAS tolerated: STAGE rows are the execution truth */
        }
      });
      await emitEvent(
        laneCtx,
        `unit-started-${sk}-${slug}${rTag}`,
        'v2.unit.started',
        `Unit ${slug} started on ${unitBranch} (section ${segment.index}${round ? `, retry ${round}` : ''})`,
        { unitSlug: slug, state: 'RUNNING' },
      );

      // Lane workspace: clone + unit branch off intent HEAD + push (engine git).
      const init = await laneCtx.step(`init-lane-${sk}-${slug}${rTag}`, async () =>
        invokeRuntime(
          {
            command: 'init-lane',
            projectId,
            intentId,
            executionId,
            unitSlug: slug,
            sectionIndex: segment.index,
            repos: cloneBase.repos,
            unitBranch,
            intentBranch,
            gitToken: await laneGitToken(),
            gitProvider: cloneBase.gitProvider,
          },
          laneSession,
        ),
      );
      if (!init || init.ok === false) {
        return await laneFailed(laneCtx, slug, round, {
          stageId: 'init-lane',
          reason: init?.reason ?? 'lane_init_failed',
          detail: init?.detail ?? null,
        });
      }

      // The section's stages, in plan order, per-unit instances (WP4 model).
      for (const stage of segment.stages) {
        // Two deterministic per-unit skips, both recorded as SKIPPED rows:
        //   - the human-approved skip matrix (CONDITIONAL stages only);
        //   - kind pruning (produces_kinds): every required output of the
        //     stage is narrowed to kinds this unit is not — the stage has
        //     nothing to produce for this unit and never spawns.
        const matrixSkipped =
          (decisions.skipMatrix[slug] ?? []).includes(stage.stageId) &&
          stage.execution === 'CONDITIONAL';
        const kindSkipped =
          !matrixSkipped &&
          stageIsNoopForUnit(stage.outputArtifacts, stage.producesKinds, unit?.kind ?? null);
        if (matrixSkipped || kindSkipped) {
          await laneCtx.step(`skip-${stage.stageId}-u-${slug}${rTag}`, async () => {
            try {
              await store.putStage({
                executionId,
                stageInstanceId: toolkit.stageInstanceIdFor(stage.stageId, slug),
                stageId: stage.stageId,
                unitSlug: slug,
                phase: stage.phase ?? null,
                state: 'SKIPPED',
              });
            } catch {
              /* the SKIPPED row is audit; never break the lane over it */
            }
          });
          await emitEvent(
            laneCtx,
            `skip-event-${stage.stageId}-u-${slug}${rTag}`,
            'v2.stage.skipped',
            matrixSkipped
              ? `Stage ${stage.stageId} skipped for unit ${slug} (approved skip matrix)`
              : `Stage ${stage.stageId} skipped for unit ${slug} (no artifacts apply to kind "${unit?.kind}")`,
            { unitSlug: slug },
          );
          continue;
        }
        const outcome = await executeStage(laneCtx, stage, {
          unitSlug: slug,
          sessionId: laneSession,
          cloneInputs: laneCloneInputs,
          suffix: rTag,
        });
        if (outcome.state === 'TERMINAL') return { slug, state: 'TERMINAL', value: outcome.value };
        if (outcome.state === 'FAILED') {
          return await laneFailed(laneCtx, slug, round, {
            stageId: stage.stageId,
            reason: outcome.reason,
          });
        }

        // Graph projection for lane-produced artifacts — the lane twin of the
        // once-per-workflow derive hook (index.js). Scoped to THIS unit's
        // stage instance; unitSlug attributes enrichment spend + events to the
        // lane in the audit. Fail-open: a derive failure is an event, never a
        // lane failure (the canonical markdown is already in the graph).
        const laneOutputTypes = (stage.outputArtifacts ?? [])
          .map((o) => o.artifact ?? o)
          .filter(Boolean);
        if (laneOutputTypes.length > 0) {
          const derived = await laneCtx.step(
            `derive-artifacts-${stage.stageId}-u-${slug}${rTag}`,
            () =>
              invokeRuntime(
                {
                  command: 'derive-artifacts',
                  projectId,
                  intentId,
                  executionId,
                  stageInstanceId: toolkit.stageInstanceIdFor(stage.stageId, slug),
                  artifactTypes: laneOutputTypes,
                  enrichment: deriveEnrichment,
                  unitSlug: slug,
                  ...(requestedCli ? { requestedCli } : {}),
                  ...(cliModels ? { cliModels } : {}),
                  ...(tierModels ? { tierModels } : {}),
                },
                laneSession,
              ),
          );
          if (!derived || derived.ok === false) {
            await emitEvent(
              laneCtx,
              `derive-failed-${stage.stageId}-u-${slug}${rTag}`,
              'v2.derive.failed',
              `${stage.stageId} (unit ${slug}): ${derived?.reason ?? 'no_response'}`,
              { unitSlug: slug },
            );
          }
        }
      }

      // Merge-back: MERGING → serialized --no-ff merge in the INTENT session →
      // MERGED. The in-process lock serializes concurrent lanes; merge-lane is
      // idempotent so a re-dispatched step after a suspend is safe.
      await laneCtx.step(`unit-merging-${sk}-${slug}${rTag}`, async () => {
        try {
          await store.updateUnitState({
            executionId,
            slug,
            state: 'MERGING',
            fromStates: ['RUNNING'],
          });
        } catch {
          /* tolerated */
        }
      });
      const dispatchMerge = (stepName) =>
        laneCtx.step(stepName, () =>
          withMergeLock(async () =>
            invokeRuntime(
              {
                command: 'merge-lane',
                projectId,
                intentId,
                executionId,
                unitSlug: slug,
                repos: cloneBase.repos,
                unitBranch,
                intentBranch,
                baseBranch: cloneBase.baseBranch,
                baseBranches: cloneBase.baseBranches,
                gitToken: await laneGitToken(),
                gitProvider: cloneBase.gitProvider,
                ...(cloneBase.gitAuthor ? { gitAuthor: cloneBase.gitAuthor } : {}),
              },
              intentSessionId,
            ),
          ),
        );
      let merge = await dispatchMerge(`merge-lane-${sk}-${slug}${rTag}`);

      // Conflict → the scoped conflict-resolution stage (WP6, A3): ONE
      // automated attempt in the LANE session — the engine reverse-merges the
      // intent branch into the unit branch, the agent resolves ONLY the
      // conflicted files, the engine verifies (no markers), concludes the
      // merge commit, and pushes the unit branch — then the merge-back is
      // retried (clean by construction unless a sibling merged meanwhile).
      // Any failure here falls through to laneFailed → halt-and-ask: the
      // "human gate on repeat failure".
      if (merge?.ok === false && merge.reason === 'merge_conflict') {
        await emitEvent(
          laneCtx,
          `unit-conflict-${sk}-${slug}${rTag}`,
          'v2.unit.conflict',
          `Unit ${slug} merge conflicts with ${intentBranch}: ${(merge.conflicts ?? []).join(', ')} — running the conflict-resolution stage`,
          { unitSlug: slug },
        );
        const resolution = await laneCtx.step(`resolve-conflict-${sk}-${slug}${rTag}`, async () =>
          invokeRuntime(
            {
              command: 'resolve-conflict',
              projectId,
              intentId,
              executionId,
              unitSlug: slug,
              sectionIndex: segment.index,
              repos: cloneBase.repos,
              unitBranch,
              intentBranch,
              gitToken: await laneGitToken(),
              gitProvider: cloneBase.gitProvider,
              ...(cloneBase.gitAuthor ? { gitAuthor: cloneBase.gitAuthor } : {}),
              requestedCli,
              ...(cliModels ? { cliModels } : {}),
              ...(tierModels ? { tierModels } : {}),
            },
            laneSession,
          ),
        );
        if (resolution?.ok) {
          merge = await dispatchMerge(`merge-lane-retry-${sk}-${slug}${rTag}`);
        } else {
          merge = {
            ok: false,
            reason: resolution?.reason ?? 'conflict_unresolved',
            detail: resolution?.detail ?? null,
          };
        }
      }
      if (!merge || merge.ok === false) {
        return await laneFailed(laneCtx, slug, round, {
          stageId: 'merge-lane',
          reason: merge?.reason ?? 'merge_failed',
          detail: merge?.detail ?? null,
        });
      }
      await laneCtx.step(`unit-merged-${sk}-${slug}${rTag}`, async () => {
        try {
          await store.updateUnitState({
            executionId,
            slug,
            state: 'MERGED',
            fromStates: ['MERGING', 'RUNNING'],
            fields: { mergedAt: true },
          });
        } catch {
          /* tolerated */
        }
      });
      await emitEvent(
        laneCtx,
        `unit-merged-event-${sk}-${slug}${rTag}`,
        'v2.unit.merged',
        `Unit ${slug} merged into ${intentBranch} (section ${segment.index})`,
        { unitSlug: slug, state: 'MERGED' },
      );
      // Free the lane's warm microVM — the persistent mount survives for a
      // later retry; compute does not linger after the merge.
      await laneCtx.step(`lane-release-${sk}-${slug}${rTag}`, () => stopSession(laneSession));
      return { slug, state: 'MERGED' };
    } catch (err) {
      // Defensive: lane bodies must never throw (a rejected lane promise
      // would poison every dependent await). Convert to a FAILED state.
      ctx.logger?.error?.('lane crashed', { slug, error: err?.message });
      return await laneFailed(laneCtx, slug, round, {
        stageId: 'lane',
        reason: 'lane_crashed',
        detail: err?.message ?? String(err),
      });
    } finally {
      semaphore.release();
    }
  };

  const laneFailed = async (laneCtx, slug, round, { stageId, reason, detail }) => {
    const rTag = round > 0 ? `-r${round}` : '';
    await laneCtx.step(`unit-failed-${sk}-${slug}${rTag}`, async () => {
      try {
        await store.updateUnitState({
          executionId,
          slug,
          state: 'FAILED',
          fields: { failureReason: `${stageId}: ${reason}${detail ? ` (${detail})` : ''}` },
        });
      } catch {
        /* lane bookkeeping must never mask the failure */
      }
    });
    await emitEvent(
      laneCtx,
      `unit-failed-event-${sk}-${slug}${rTag}`,
      'v2.unit.failed',
      `Unit ${slug} failed at ${stageId}: ${reason}`,
      { unitSlug: slug, state: 'FAILED' },
    );
    return { slug, state: 'FAILED', stageId, reason };
  };

  // Run a set of lanes concurrently (the wavefront/barrier core). Returns
  // { terminal } when a lane saw a retire sentinel, else records lane states.
  const runLanes = async (slugsToRun, { round, tag }) => {
    const ordered = laneOrder.filter((s) => slugsToRun.includes(s));
    for (const slug of ordered) {
      lanePromises.set(
        slug,
        ctx.runInChildContext(`lane-${sk}-${slug}-r${round}${tag ?? ''}`, (laneCtx) =>
          runLaneBody(laneCtx, slug, round),
        ),
      );
    }
    const joined = ordered.map((s) => lanePromises.get(s));
    await ctx.promise.allSettled(`lanes-${sk}-r${round}${tag ?? ''}`, joined);
    let terminal = null;
    for (const slug of ordered) {
      const result = await lanePromises.get(slug).catch((err) => ({
        slug,
        state: 'FAILED',
        reason: 'lane_crashed',
        detail: err?.message,
      }));
      lanePromises.delete(slug);
      if (result?.state === 'TERMINAL') terminal = result.value;
      else laneState.set(slug, result?.state ?? 'FAILED');
    }
    return { terminal };
  };

  const blocked = () =>
    [...laneState.entries()].filter(([, s]) => s === 'BLOCKED').map(([slug]) => slug);

  // Halt-and-ask (stage-protocol.md): wait for all lanes (done by the caller),
  // preserve successes (pushed work + MERGED lanes), ask retry / skip / abort.
  // Returns 'retry' | 'skip' | a terminal value (abort/retired).
  const haltAndAsk = async (round, failedSlugs) => {
    const detailLines = failedSlugs.map((slug) => {
      const row = laneState.get(slug);
      return `- ${slug}: ${row === 'FAILED' ? 'failed' : row}`;
    });
    const halt = await awaitEngineGate(ctx, toolkit, {
      name: `halt-${sk}-r${round}`,
      prompt: [
        `Lane failure in section ${segment.index} (${failedSlugs.length} unit(s) failed, ${blocked().length} blocked, ${
          [...laneState.values()].filter((s) => s === 'MERGED').length
        } merged).`,
        ...detailLines,
        '',
        'All pushed work is preserved on the unit branches. Choose:',
        '- retry: re-run the failed lanes (and their blocked dependents) in place',
        '- skip: continue without them (their work will be missing downstream)',
        '- abort: fail the run',
      ].join('\n'),
      options: ['retry', 'skip', 'abort'],
    });
    if (halt.superseded) {
      return { terminal: { ok: false, reason: 'retired', intentId } };
    }
    const choice =
      halt.gate.status === 'rejected'
        ? 'abort'
        : (parseChoice(halt.gate.answer, ['retry', 'skip', 'abort']) ?? 'abort');
    await emitEvent(
      ctx,
      `halt-decision-${sk}-r${round}`,
      'v2.units.halt_decision',
      `Halt-and-ask (section ${segment.index}, round ${round}): human chose ${choice} for [${failedSlugs.join(', ')}]`,
    );
    if (choice === 'abort') {
      return {
        terminal: await fail(
          'section_aborted',
          `section ${segment.index}: units [${failedSlugs.join(', ')}] failed; human aborted`,
        ),
      };
    }
    return { choice };
  };

  // Run lanes + halt-and-ask rounds until every requested lane is MERGED, the
  // human skips, or a terminal exit. Returns null | terminal value.
  const runUntilResolved = async (initialSlugs, { tag }) => {
    let toRun = initialSlugs;
    let round = 0;
    // A retry round re-runs the previous round's FAILED lanes and revives
    // their BLOCKED dependents. Unbounded by design — each round is one
    // explicit human decision; durable identities carry the round number.
    for (;;) {
      const { terminal } = await runLanes(toRun, { round, tag });
      if (terminal) return terminal;
      const failed = toRun.filter((s) => laneState.get(s) === 'FAILED');
      if (failed.length === 0) return null;
      const decision = await haltAndAsk(round, failed);
      if (decision.terminal) return decision.terminal;
      if (decision.choice === 'skip') {
        await emitEvent(
          ctx,
          `skip-lanes-${sk}-r${round}`,
          'v2.units.lanes_skipped',
          `Continuing section ${segment.index} without [${failed.join(', ')}] (human skip); dependents stay blocked`,
        );
        return null;
      }
      // retry: failed lanes + their blocked dependents from this round.
      round += 1;
      toRun = [...failed, ...toRun.filter((s) => laneState.get(s) === 'BLOCKED')];
    }
  };

  // ── phase 1: walking skeleton, SOLO (A2 rule 8) ───────────────────────────
  const skeleton = decisions.walkingSkeleton;
  const skeletonOut = await runUntilResolved([skeleton], { tag: '-skel' });
  if (skeletonOut) return skeletonOut;

  if (laneState.get(skeleton) === 'MERGED') {
    const skeletonGate = await awaitEngineGate(ctx, toolkit, {
      name: `skeleton-${sk}`,
      prompt: [
        `Walking skeleton "${skeleton}" completed and merged into ${intentBranch}.`,
        `Review its design artifacts and generated code (branch ${unitBranchFor(intentBranch, segment.index, skeleton)}) as ONE increment.`,
        'Approve to open the remaining lanes; reject to stop the run.',
      ].join('\n'),
      options: ['approve', 'reject'],
    });
    if (skeletonGate.superseded) return { ok: false, reason: 'retired', intentId };
    if (skeletonGate.gate.status === 'rejected') {
      return await fail('skeleton_rejected', `section ${segment.index}: ${skeleton}`);
    }
    await emitEvent(
      ctx,
      `skeleton-approved-${sk}`,
      'v2.units.skeleton_approved',
      `Walking skeleton ${skeleton} approved`,
      { unitSlug: skeleton },
    );
  }

  // ── phase 2: autonomy ladder (A2 rule 9), then the remaining lanes ───────
  const remaining = laneOrder.filter((s) => s !== skeleton && laneState.get(s) !== 'MERGED');
  if (remaining.length === 0) {
    await emitEvent(
      ctx,
      `fan-in-${sk}`,
      'v2.units.fan_in',
      `Section ${segment.index} complete: ${[...laneState.values()].filter((s) => s === 'MERGED').length}/${laneOrder.length} unit(s) merged`,
    );
    return null;
  }

  let mode = CONSTRUCTION_AUTONOMY_MODES.includes(unitPlan.autonomyMode)
    ? unitPlan.autonomyMode
    : null;
  if (!mode) {
    const ladder = await awaitEngineGate(ctx, toolkit, {
      name: `ladder-${sk}`,
      prompt: [
        `Autonomy for the remaining ${remaining.length} lane(s) of section ${segment.index}:`,
        '- autonomous: lanes run without approval gates (failures still halt-and-ask)',
        '- gated: one approval gate per parallel batch',
      ].join('\n'),
      options: ['autonomous', 'gated'],
    });
    if (ladder.superseded) return { ok: false, reason: 'retired', intentId };
    mode = await ctx.step(`ladder-decision-${sk}`, async () => {
      // Deterministic fallback: an unparseable answer means GATED — the safe
      // mode (more human checkpoints), never silent full autonomy.
      const parsed =
        ladder.gate.status === 'rejected'
          ? 'gated'
          : (parseChoice(ladder.gate.answer, CONSTRUCTION_AUTONOMY_MODES) ?? 'gated');
      try {
        await store.updateExecution({ executionId, constructionAutonomyMode: parsed });
      } catch {
        /* META mirror is best-effort; the UNITPLAN write below is the truth */
      }
      try {
        await store.updateUnitPlanDecisions({ executionId, autonomyMode: parsed });
      } catch {
        /* tolerated — the step result governs this run */
      }
      return parsed;
    });
    await emitEvent(
      ctx,
      `ladder-set-${sk}`,
      'v2.units.autonomy_set',
      `Construction autonomy for section ${segment.index}: ${mode}`,
    );
  }

  if (mode === 'autonomous') {
    // TRUE WAVEFRONT: all remaining lanes at once; dependents self-block on
    // their dependency lanes' DurablePromises; the semaphore caps concurrency.
    const out = await runUntilResolved(remaining, { tag: '' });
    if (out) return out;
  } else {
    // GATED: batch barriers over the topological waves, one gate per batch.
    for (let w = 0; w < waves.length; w++) {
      const waveSlugs = waves[w].filter((s) => remaining.includes(s));
      if (waveSlugs.length === 0) continue;
      const out = await runUntilResolved(waveSlugs, { tag: `-w${w}` });
      if (out) return out;
      const batchGate = await awaitEngineGate(ctx, toolkit, {
        name: `batch-${sk}-w${w}`,
        prompt: [
          `Batch ${w + 1}/${waves.length} of section ${segment.index} finished: [${waveSlugs.join(', ')}].`,
          'Review the merged work on the intent branch. Approve to continue; reject to stop the run.',
        ].join('\n'),
        options: ['approve', 'reject'],
      });
      if (batchGate.superseded) return { ok: false, reason: 'retired', intentId };
      if (batchGate.gate.status === 'rejected') {
        return await fail('batch_rejected', `section ${segment.index}, batch ${w + 1}`);
      }
      await emitEvent(
        ctx,
        `batch-approved-${sk}-w${w}`,
        'v2.units.batch_approved',
        `Batch ${w + 1}/${waves.length} of section ${segment.index} approved`,
      );
    }
  }

  // ── fan-in bookkeeping (A2 rule 5) ────────────────────────────────────────
  const merged = [...laneState.values()].filter((s) => s === 'MERGED').length;
  await emitEvent(
    ctx,
    `fan-in-${sk}`,
    'v2.units.fan_in',
    `Section ${segment.index} complete: ${merged}/${laneOrder.length} unit(s) merged${
      merged < laneOrder.length ? ' (some lanes skipped after failure — see halt decisions)' : ''
    }`,
  );
  return null;
};
