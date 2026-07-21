// V2 orchestrator — the durable function that drives one intent end to end.
//
// Triggered (async Invoke) by lambda/intents on Start. It walks the intent's
// plan as a durable execution: init-ws once, then the plan SEGMENTS
// (docs/v2-parallel.md WP4) — once-per-workflow stages in run order, and
// parallel sections (`forEach: unit-of-work`) as unit LANES over the promoted
// UNITPLAN (sequential in WP4; wavefront concurrency arrives with WP5). Every
// stage runs via ASYNC invocation (WP1): a durable callback is created per
// stage attempt, `run-stage-start` dispatches the stage as a background job in
// the AgentCore container (returns in ms), and the execution suspends at zero
// compute until the container completes the callback with the stage verdict.
// Human gates park the run on their own callbacks (lambda/intents sends
// SendDurableExecutionCallbackSuccess).
//
// The async path exists because a stage regularly outlives both the
// orchestrator Lambda timeout (900s) and AgentCore's hard 15-minute synchronous
// request window — a synchronous run-stage step would re-execute the whole
// agent stage on re-drive (RETRY_INTERRUPTED_STEP). Proven in
// test/poc/poc-c-interrupted-step.test.js / poc-d-async-stage.test.js.
//
// REPLAY DISCIPLINE: every side effect (agent invokes, provider operations,
// and all store writes) MUST be inside ctx.step(...) or it re-executes on replay.

import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { parseLambdaPayload } from '../shared/lambda-payload.js';
import { repoProvider as sharedRepoProvider } from '../shared/repo-provider.js';
import { createProcessStore } from '../shared/v2-process-store.js';
import { loadExecutionPlan } from '../shared/v2-workflow-plan.js';
import {
  planSegments,
  stageInstanceId as planStageInstanceId,
} from '../shared/v2-execution-plan.js';
import { resolveSkipTo, skipTargetsFrom, resolveRecomposeSkips } from '../shared/stage-skip.js';
import { broadcastToIntentChannel } from '../shared/ws-fanout.js';
import {
  awaitEngineGate,
  parseChoice,
  runParallelSection,
  validateFanoutOverrides,
  defaultSkeletonFor,
  fanoutGateAddendum,
} from './section.js';
import { runQuorumEdit } from './quorum-edit.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});
const agentcore = new BedrockAgentCoreClient({});
const defaultStore = createProcessStore({ ddb });

const RUNTIME_ARN = () => process.env.AGENTCORE_RUNTIME_ARN;
const BLOCKS_TABLE = () => process.env.BLOCKS_TABLE;
const SOURCE_CONTROL_FN = () => process.env.SOURCE_CONTROL_FUNCTION;
const DURABLE_EXECUTION_TIMEOUT_SECONDS = () =>
  Number(process.env.DURABLE_EXECUTION_TIMEOUT_SECONDS || 31622400);
const DURABLE_GATE_DEADLINE_MARGIN_SECONDS = () =>
  Number(process.env.DURABLE_GATE_DEADLINE_MARGIN_SECONDS || 300);

// AgentCore requires a session id >= 33 chars; reuse ONE per intent so the
// checkout stays warm across init-ws + every run-stage (matches scripts/phaseb.sh).
const sessionIdFor = (intentId) => `aidlc-intent-${intentId}`.padEnd(33, '0');

// One AgentCore /invocations call. Returns the parsed JSON body the command
// handler returned (init-ws / run-stage). Throws on a non-2xx transport.
const defaultInvokeRuntime = async (payload, sessionId) => {
  const res = await agentcore.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN(),
      runtimeSessionId: sessionId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const text = res.response ? await streamToString(res.response) : '';
  return text ? JSON.parse(text) : {};
};

// Free a parked stage's warm microVM compute (D1 release-on-park). Resume
// re-mounts the persistent session storage, so the parked CLI conversation is
// not lost. Best-effort: a failed/already-stopped session must not break resume.
const stopRuntimeSession = async (sessionId) => {
  try {
    await agentcore.send(
      new StopRuntimeSessionCommand({
        runtimeSessionId: sessionId,
        agentRuntimeArn: RUNTIME_ARN(),
      }),
    );
    return { stopped: true };
  } catch (e) {
    return { stopped: false, error: e.message };
  }
};

const streamToString = async (body) => {
  if (typeof body.transformToString === 'function') return body.transformToString();
  const chunks = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

const defaultSourceControlOperation = async ({
  projectId,
  provider,
  repo,
  operation,
  args = {},
}) => {
  if (!SOURCE_CONTROL_FN()) throw new Error('SOURCE_CONTROL_FUNCTION is not configured');
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: SOURCE_CONTROL_FN(),
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(
        JSON.stringify({
          action: 'operate',
          projectId,
          provider,
          repo,
          operation,
          args,
        }),
      ),
    }),
  );
  if (response.FunctionError) throw new Error('Source-control service invocation failed');
  const body = parseLambdaPayload(response.Payload);
  if (!body?.ok) {
    throw Object.assign(new Error('Source-control operation failed'), {
      code: body?.code || 'SOURCE_CONTROL_OPERATION_FAILED',
    });
  }
  return body.result;
};

const repoProvider = (meta, repoId) =>
  sharedRepoProvider(repoId, meta.gitProvider, meta.repoProviders);

// Map a timeline event type to the live broadcast payload the UI routes on
// (useIntentEvents → refetch on agent.workspace / agent.execution). The
// orchestrator is NOT VPC-attached and reaches the connections table over the
// public DDB endpoint, so it can fan out directly (unlike its Neptune access
// which must tunnel through the runtime).
const livePayloadFor = (type, summary) => {
  if (type.startsWith('v2.workspace.')) {
    return {
      action: 'agent.workspace',
      state: type === 'v2.workspace.initialized' ? 'INITIALIZED' : 'INITIALIZING',
      summary,
    };
  }
  if (type === 'v2.execution.failed')
    return { action: 'agent.execution', status: 'FAILED', summary };
  if (type === 'v2.execution.succeeded')
    return { action: 'agent.execution', status: 'SUCCEEDED', summary };
  // Unit-lane lifecycle (docs/v2-parallel.md WP4): its own action so the UI can
  // route lane transitions without string-matching note types. The caller's
  // `extra` merges unitSlug + the lane state into the payload.
  if (type.startsWith('v2.unit.')) return { action: 'agent.unit', noteType: type, summary };
  if (type.startsWith('v2.unit_pr.')) return { action: 'agent.unit-pr', noteType: type, summary };
  if (type.startsWith('v2.feedback.')) return { action: 'agent.feedback', noteType: type, summary };
  return { action: 'agent.note', noteType: type, summary };
};

// The orchestrator's collaborators, injectable for tests. Provider operations
// cross the source-control service boundary; credentials never enter this process.
const defaultDeps = () => ({
  store: defaultStore,
  loadPlan: (args) => loadExecutionPlan({ ddb, tableName: BLOCKS_TABLE(), ...args }),
  invokeRuntime: defaultInvokeRuntime,
  stopSession: stopRuntimeSession,
  broadcast: broadcastToIntentChannel,
  openPr: ({ projectId, gitProvider, repoId, branch, baseBranch, title, body }) =>
    defaultSourceControlOperation({
      projectId,
      provider: gitProvider,
      repo: repoId,
      operation: 'create-pr',
      args: { branch, baseBranch, title, body },
    }),
  // PR-time verification (2026-07 incident): compare base...head BEFORE the PR
  // call so a never-pushed or commit-less intent branch is a LOUD failure, not
  // a benign "no changes" skip. Injectable so tests never touch provider APIs.
  comparePrBranches: ({ projectId, gitProvider, repoId, base, head }) =>
    defaultSourceControlOperation({
      projectId,
      provider: gitProvider,
      repo: repoId,
      operation: 'compare',
      args: { base, head },
    }),
  unitPrProvider: {
    compare: ({ projectId, gitProvider, repoId, base, head }) =>
      defaultSourceControlOperation({
        projectId,
        provider: gitProvider,
        repo: repoId,
        operation: 'compare',
        args: { base, head },
      }),
    find: ({ projectId, gitProvider, repoId, sourceBranch, targetBranch, state = 'open' }) =>
      defaultSourceControlOperation({
        projectId,
        provider: gitProvider,
        repo: repoId,
        operation: 'find-pr',
        args: {
          sourceBranch,
          targetBranch,
          state: gitProvider === 'gitlab' && state === 'open' ? 'opened' : state,
        },
      }),
    createDraft: ({ projectId, gitProvider, repoId, branch, baseBranch, title, body }) =>
      defaultSourceControlOperation({
        projectId,
        provider: gitProvider,
        repo: repoId,
        operation: 'create-pr',
        args: { branch, baseBranch, title, body, draft: true },
      }),
    status: ({ projectId, gitProvider, repoId, number }) =>
      defaultSourceControlOperation({
        projectId,
        provider: gitProvider,
        repo: repoId,
        operation: 'pr-status',
        args: { number },
      }),
    setDraft: ({ projectId, gitProvider, repoId, number, draft }) =>
      defaultSourceControlOperation({
        projectId,
        provider: gitProvider,
        repo: repoId,
        operation: 'set-pr-draft',
        args: { number, draft },
      }),
    reopen: ({ projectId, gitProvider, repoId, number }) =>
      defaultSourceControlOperation({
        projectId,
        provider: gitProvider,
        repo: repoId,
        operation: 'reopen-pr',
        args: { number },
      }),
    isAncestor: ({ projectId, gitProvider, repoId, ancestorSha, descendantRef }) =>
      defaultSourceControlOperation({
        projectId,
        provider: gitProvider,
        repo: repoId,
        operation: 'is-ancestor',
        args: { ancestorSha, descendantRef },
      }),
    listComments: ({ projectId, gitProvider, repoId, number }) =>
      defaultSourceControlOperation({
        projectId,
        provider: gitProvider,
        repo: repoId,
        operation: 'list-review-comments',
        args: { number },
      }),
    addComment: ({ projectId, gitProvider, repoId, number, body }) =>
      defaultSourceControlOperation({
        projectId,
        provider: gitProvider,
        repo: repoId,
        operation: 'add-review-comment',
        args: { number, body },
      }),
  },
});

const handler = async (event, ctx, deps = defaultDeps()) => {
  const {
    store,
    loadPlan,
    invokeRuntime,
    stopSession,
    broadcast,
    openPr,
    comparePrBranches,
    unitPrProvider,
  } = deps;
  const { intentId, executionId } = event;
  // Quorum-supported artifact edit (post-hoc document editing): its own small
  // durable flow — plan → human approval → apply — fully independent of the
  // stage loop below (an edit is refused while a run is active anyway).
  if (event.action === 'quorum-edit') {
    return runQuorumEdit(event, ctx, deps);
  }
  if (event.action !== 'start') {
    // Resume is handled out-of-band via SendDurableExecutionCallbackSuccess
    // against the suspended callback — there is no separate resume invocation.
    ctx.logger?.info?.('ignoring non-start invocation', { action: event.action });
    return { ok: false, reason: 'not_a_start' };
  }

  const meta = await ctx.step('load-meta', () => store.getExecution(executionId));
  if (!meta) return { ok: false, reason: 'execution_not_found' };

  const { projectId, workflowId, workflowVersion, scope } = meta;
  const gitProvider = meta.gitProvider || 'github';
  // Rewind relaunch (docs/v2-steering.md): start the stage loop at this stage
  // instead of the beginning (upstream stages keep their SUCCEEDED rows).
  const startAtStageId = event.startAtStageId ?? null;
  // Ownership token: minted per orchestrator run and stamped on META (see
  // claim-run below). Terminal META writes CAS on it, so a run retired by a
  // cancel/rewind relaunch can never clobber the new run's state.
  let runId = null;
  let orchestratorExpiresAt = null;

  // Map a stored lifecycle event type to the live realtime payload the UI already
  // Append a timeline event AND fan it out live. Both are best-effort telemetry
  // (never break the run; tolerate a store/broadcast mock). Wrapped in a durable
  // step so a replay doesn't re-append — a replayed broadcast is harmless (the UI
  // just refetches). These back the activity feed + drive the live UI: they are
  // how init-ws / failure progress becomes visible to the user. `extra` carries
  // structured attribution (unitSlug, lane state) onto the event row + payload.
  // Parameterized on the durable context so lane child contexts (WP5) emit
  // under their own checkpoint identity.
  const emitEvent = (ctxArg, stepName, type, summary, extra = {}) =>
    ctxArg.step(stepName, async () => {
      try {
        await store.appendEvent?.({
          executionId,
          type,
          actor: 'orchestrator',
          summary,
          ...(extra.unitSlug !== undefined ? { unitSlug: extra.unitSlug } : {}),
          ...(extra.sectionIndex !== undefined ? { sectionIndex: extra.sectionIndex } : {}),
        });
      } catch {
        /* events are best-effort telemetry */
      }
      try {
        await broadcast?.(intentId, {
          intentId,
          projectId,
          ...livePayloadFor(type, summary),
          ...extra,
        });
      } catch {
        /* live fan-out is best-effort; the stored event + REST refetch are truth */
      }
    });

  // Record FAILED + a human-readable reason + a timeline event, all in idempotent
  // durable steps, so a failure surfaces in the UI (status badge + failureReason
  // banner + activity feed) instead of silently dying at the durable boundary.
  // Guarded by the ownership token: a retired run (cancel/rewind relaunched the
  // intent under a new runId) fails the CAS and exits quietly instead of
  // clobbering the new run's META.
  const fail = async (reason, detail) => {
    const message = detail ? `${reason}: ${detail}` : reason;
    // The ownership verdict is the STEP RESULT (not a closure flag) so a durable
    // replay — which skips the memoized step body — still sees it.
    const owned = await ctx.step(`fail-${reason}`, async () => {
      try {
        await store.updateExecution({
          executionId,
          projectId,
          status: 'FAILED',
          startedAt: meta.startedAt,
          completedAt: nowIso(),
          failureReason: message,
          pendingHumanTaskId: null,
          ...(runId ? { ifOrchestratorRunId: runId } : {}),
        });
        return true;
      } catch (e) {
        if (e?.name === 'ConditionalCheckFailedException') return false;
        throw e;
      }
    });
    if (!owned) {
      ctx.logger?.info?.('retired run skipped terminal write', { intentId, reason });
      return { ok: false, reason: 'retired', supersededBy: 'relaunch' };
    }
    await emitEvent(ctx, `fail-event-${reason}`, 'v2.execution.failed', message);
    return { ok: false, reason, detail };
  };

  try {
    // Claim the run: stamp this run's ownership token on META before any other
    // write. A later relaunch (rewind/cancel+start) overwrites it; this run's
    // terminal writes then fail their CAS and exit quietly.
    const claim = await ctx.step('mint-run-id', async () => {
      const token = `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const startedAt = nowIso();
      const expiresAt = new Date(
        Date.parse(startedAt) + DURABLE_EXECUTION_TIMEOUT_SECONDS() * 1000,
      ).toISOString();
      const updated = await store.updateExecution({
        executionId,
        orchestratorRunId: token,
        orchestratorStartedAt: startedAt,
        orchestratorExpiresAt: expiresAt,
      });
      return {
        runId: updated?.orchestratorRunId ?? token,
        orchestratorExpiresAt: updated?.orchestratorExpiresAt ?? expiresAt,
      };
    });
    runId = claim.runId;
    orchestratorExpiresAt = claim.orchestratorExpiresAt;
    // init-ws — clone repos, create the Neptune Intent anchor, seed RUNNING state.
    // Idempotent in the runtime (ConditionalCheckFailed → already initialized), so
    // a replay of this step is safe.
    const gitAuthor =
      meta.starterName && meta.starterEmail
        ? { name: meta.starterName, email: meta.starterEmail }
        : null;
    const sessionId = sessionIdFor(intentId);
    await emitEvent(
      ctx,
      'init-ws-start',
      'v2.workspace.initializing',
      `Initializing workspace (${(meta.repos ?? []).length} repo(s))…`,
    );
    const initResult = await ctx.step('init-ws', () =>
      invokeRuntime(
        {
          command: 'init-ws',
          projectId,
          intentId,
          executionId,
          repos: meta.repos ?? [],
          branch: meta.branch,
          baseBranch: meta.baseBranch,
          baseBranches: meta.baseBranches,
          gitProvider,
          repoProviders: meta.repoProviders ?? null,
          ...(gitAuthor ? { gitAuthor } : {}),
          title: meta.title,
          prompt: meta.prompt,
          workflowId,
          workflowVersion,
          scope,
          startedBy: meta.startedBy,
        },
        sessionId,
      ),
    );
    // The runtime returns {ok:false, reason} on checkout / vertex / seed failure;
    // it does NOT throw. Detect it here or the run would march on into stages
    // against an un-initialized workspace.
    if (initResult && initResult.ok === false) {
      return await fail('init_ws_failed', initResult.reason ?? initResult.detail);
    }
    await emitEvent(ctx, 'init-ws-done', 'v2.workspace.initialized', 'Workspace ready');

    await ctx.step('mark-running', () =>
      store.updateExecution({
        executionId,
        projectId,
        status: 'RUNNING',
        fromStatus: 'CREATED',
        startedAt: meta.startedAt,
      }),
    );
    // Flip the live status badge to RUNNING (the stage-level broadcasts come from
    // the runtime; this is the execution-level transition the orchestrator owns).
    await ctx.step('broadcast-running', async () => {
      try {
        await broadcast?.(intentId, {
          intentId,
          projectId,
          action: 'agent.execution',
          status: 'RUNNING',
        });
      } catch {
        /* live fan-out is best-effort */
      }
    });

    // Resolve the ordered stage list once (pure read of pinned block metadata).
    // The per-intent skip overlay snapshotted at create rides along — every
    // recompute of this intent's plan (create check, this walk, rewinds, the
    // container's stage resolution) applies the same overlay or plans drift.
    const intentSkipIds = Array.isArray(meta.skipStageIds) ? meta.skipStageIds : [];
    // Per-intent composed EXECUTE/SKIP grid (Adaptive Workflows): pinned on
    // META at create/start and threaded into every plan recompute exactly like
    // the skip overlay — the grid, not the scope name, is the projection.
    const composedGrid =
      meta.composedGrid && typeof meta.composedGrid === 'object' ? meta.composedGrid : null;
    // Gate-time skips ("skip to stage X", stage-skip.js) accumulate here as
    // the walk progresses (and are re-seeded from prior-run SKIPPED rows on a
    // rewind); together with the intent-level overlay they ride every
    // run-stage dispatch so the container resolves the SAME plan (downstream
    // prompts mark the skipped producers' artifacts expectedAbsent). Replay-
    // deterministic: the list is rebuilt from the same memoized gate answers.
    const dynamicSkipIds = [];
    const planResult = await ctx.step('load-plan', () =>
      loadPlan({
        workflowId,
        workflowVersion,
        scope,
        ...(intentSkipIds.length ? { skipStageIds: intentSkipIds } : {}),
        ...(composedGrid ? { composedGrid } : {}),
      }),
    );
    if (!planResult.valid || !planResult.plan) {
      const out = await fail('plan_invalid', JSON.stringify(planResult.errors ?? []));
      return { ...out, errors: planResult.errors };
    }
    // Non-fatal scope-shortcut warnings (inputs whose producer is out of scope,
    // sections degraded to once-per-workflow) — visible on the timeline so a
    // degraded lean-scope run is attributable, never a blocker.
    if (planResult.warnings?.length) {
      await emitEvent(
        ctx,
        'plan-warnings',
        'v2.plan.warnings',
        `Plan resolved with ${planResult.warnings.length} scope warning(s): ${[
          ...new Set(planResult.warnings.map((w) => w.code)),
        ].join(', ')}`,
      );
    }

    const stages = planResult.plan.stages;
    // Instance-id namespace: exposed by the plan so per-unit instance ids here
    // match the ones run-stage computes (defensive fallback for stubbed plans).
    const namespace = planResult.plan.namespace ?? `${workflowId}@${workflowVersion}`;

    // Intent-level skips (deselected at create): write their SKIPPED audit rows
    // once so the timeline shows a deliberate skip, not a missing stage. The
    // rows are guarded per stage — a rewind relaunch re-walks this and must not
    // re-emit the event for a row that is already SKIPPED.
    for (const skipped of planResult.plan.skippedStages ?? []) {
      const marked = await ctx.step(`skip-intent-${skipped.stageId}`, async () => {
        try {
          const row = await store.getStage(executionId, skipped.stageInstanceId).catch(() => null);
          if (row?.state === 'SKIPPED') return false;
          await store.putStage({
            executionId,
            stageInstanceId: skipped.stageInstanceId,
            stageId: skipped.stageId,
            phase: skipped.phase ?? null,
            state: 'SKIPPED',
          });
          return true;
        } catch {
          return false; // the SKIPPED row is audit; never break the run over it
        }
      });
      if (marked) {
        await emitEvent(
          ctx,
          `skip-intent-event-${skipped.stageId}`,
          'v2.stage.skipped',
          `Stage ${skipped.stageId} skipped (deselected when the intent was created)`,
        );
      }
    }
    // Rewind relaunch: slice the loop to start at the rewound stage. Upstream
    // stages must hold SUCCEEDED rows from the prior run — a rewind past a
    // never-completed stage would run against missing upstream artifacts.
    let runStages = stages;
    if (startAtStageId) {
      const idx = stages.findIndex((s) => s.stageId === startAtStageId);
      if (idx < 0) {
        const out = await fail('rewind_stage_not_found', startAtStageId);
        return out;
      }
      const upstreamCheck = await ctx.step('rewind-upstream-check', async () => {
        // A `forEach: unit-of-work` upstream stage has one instance PER UNIT
        // (docs/v2-parallel.md WP4) — every lane's instance must be terminal
        // (SUCCEEDED, or SKIPPED per the approved skip matrix).
        // Linear upstream stages that hold a SKIPPED row (gate-time "skip to
        // stage X" from a prior run) are collected so the relaunch re-seeds
        // its dispatch overlay — downstream prompts must keep treating their
        // absent artifacts as by-design.
        const skippedUpstream = [];
        let unitSlugs = null; // lazy — only needed when a section precedes the rewind point
        for (const s of stages.slice(0, idx)) {
          if (s.parallelSection != null) {
            if (unitSlugs === null) {
              const up = await store.getUnitPlan?.(executionId).catch(() => null);
              unitSlugs = (up?.units ?? []).map((u) => u.slug);
              if (unitSlugs.length === 0) return { incomplete: s.stageId }; // section ran without a promoted plan → incomplete
            }
            for (const slug of unitSlugs) {
              const row = await store
                .getStage(
                  executionId,
                  planStageInstanceId(namespace, s.stageId, slug, s.parallelSection),
                )
                .catch(() => null);
              if (!row || (row.state !== 'SUCCEEDED' && row.state !== 'SKIPPED'))
                return { incomplete: `${s.stageId} [unit ${slug}]` };
            }
            continue;
          }
          const row = await store.getStage(executionId, s.stageInstanceId).catch(() => null);
          // SKIPPED is terminal for upstream completeness too: a stage skipped
          // at a validation gate ("skip to stage X") deliberately produced
          // nothing — rewinding past it must not demand a SUCCEEDED row it was
          // never meant to have. (Same rule the per-unit branch above applies.)
          if (!row || (row.state !== 'SUCCEEDED' && row.state !== 'SKIPPED'))
            return { incomplete: s.stageId };
          if (row.state === 'SKIPPED') skippedUpstream.push(s.stageId);
        }
        return { incomplete: null, skippedUpstream };
      });
      if (upstreamCheck?.incomplete) {
        return await fail('rewind_upstream_incomplete', upstreamCheck.incomplete);
      }
      for (const id of upstreamCheck?.skippedUpstream ?? []) {
        if (!intentSkipIds.includes(id) && !dynamicSkipIds.includes(id)) dynamicSkipIds.push(id);
      }
      runStages = stages.slice(idx);
    }
    // Per-CLI model selection was snapshotted onto META at create (intents lambda
    // reads the project vertex; the orchestrator is not VPC-attached for Neptune).
    // run-stage applies cliModels[cli] as the authoritative model knob.
    const cliModels = meta.cliModels ?? null;
    // Tier-model config (merged project-over-global, snapshotted alongside):
    // maps each agent's tier to a model per CLI + the fallback/quorum rows.
    const tierModels = meta.tierModels ?? null;
    // The project's explicitly selected agent CLI; forwarded to run-stage as
    // `requestedCli` so the run uses the chosen CLI (selection depends on which
    // CLI is authed). null = let run-stage pick the first installed CLI.
    const requestedCli = meta.agentCli ?? null;
    // Custom MCP servers + custom agent rules snapshotted onto META at create.
    // MCP servers are carried as TWO SEPARATE tier maps (global + project),
    // holding only `${VAR}` references — the runtime resolves each tier's secrets
    // against its own SSM prefix and merges only AFTER resolution. Forwarded to
    // run-stage as `mcpServersByTier`. Back-compat: an OLD row carries a single
    // merged `customMcpServers` map (secrets inline) — treat it as the project
    // tier so it still resolves (its refs, if any, are legacy inline literals).
    const mcpServersByTier =
      meta.mcpServersByTier ??
      (meta.customMcpServers ? { global: {}, project: meta.customMcpServers } : null);
    const customRules = meta.customRules ?? null;
    // Derive-time graph enrichment mode ('off'|'llm'), snapshotted onto META at
    // create from the Admin SSM setting; forwarded in the derive-artifacts
    // payload so the container needs no redeploy (and no SSM read) to honour it.
    const deriveEnrichment = meta.deriveEnrichment === 'llm' ? 'llm' : 'off';
    // Seconds a parked stage's warm microVM lingers before release (D1).
    const parkReleaseSeconds = meta.parkReleaseSeconds ?? null;

    // Clone inputs so run-stage can self-heal a wiped source checkout. These are
    // references only; AgentCore asks the credential broker at each git network
    // operation.
    const cloneInputs = {
      repos: meta.repos ?? [],
      branch: meta.branch,
      baseBranch: meta.baseBranch,
      baseBranches: meta.baseBranches,
      gitProvider,
      repoProviders: meta.repoProviders ?? null,
      ...(gitAuthor ? { gitAuthor } : {}),
    };

    // ── One stage instance through its park loop (D3) ─────────────────────
    // Parameterized for unit lanes (docs/v2-parallel.md WP4/WP5):
    //   ctxArg       — the durable context to run under (a lane's child
    //                  context, or the root ctx for once-per-workflow stages)
    //   unitSlug     — null = once-per-workflow; set = one lane's instance
    //   sessionId    — the AgentCore session the stage dispatches to (a lane's
    //                  own session, or the intent session)
    //   cloneInputs  — branch inputs (a lane's unit branch, or the intent's)
    //   suffix       — durable-identity suffix for halt-and-ask / validation rounds
    //   initialResumeFrom — answered gate id to inject into the first attempt
    // Every durable identity (callback names, step names) carries the unit
    // dimension + suffix so lanes and rounds never collide. Outcomes (the
    // caller owns terminal META writes + lane bookkeeping):
    //   { state:'SUCCEEDED' }
    //   { state:'FAILED', reason }        — stage verdict was FAILED
    //   { state:'TERMINAL', value }       — already-handled terminal handler
    //                                       return (retired / parked_without_gate)
    const executeStage = async (ctxArg, stage, opts = {}) => {
      const {
        unitSlug = null,
        sectionIndex = null,
        sessionId: stageSessionId = sessionId,
        cloneInputs: stageCloneInputs = cloneInputs,
        suffix = '',
        initialResumeFrom = null,
        reviewFeedback = null,
      } = opts;
      const label = `${unitSlug ? `${stage.stageId}-u-${unitSlug}` : stage.stageId}${suffix}`;
      const allSkipIds = [...intentSkipIds, ...dynamicSkipIds];
      const stageOpts = {
        stage,
        unitSlug,
        sectionIndex,
        suffix,
        ids: { projectId, intentId, executionId },
        workflowId,
        workflowVersion,
        scope,
        ...(allSkipIds.length ? { skipStageIds: allSkipIds } : {}),
        ...(composedGrid ? { composedGrid } : {}),
        cliModels,
        tierModels,
        requestedCli,
        mcpServersByTier,
        customRules,
        sessionId: stageSessionId,
        cloneInputs: stageCloneInputs,
        reviewFeedback,
      };
      let result = await runStage(ctxArg, invokeRuntime, {
        ...stageOpts,
        resumeFrom: initialResumeFrom,
      });

      // Park loop (D3): the stage may open more than one gate across resumes. Each
      // WAITING_FOR_HUMAN suspends on a durable callback until the gate is answered.
      while (result?.state === 'WAITING_FOR_HUMAN') {
        const fresh = await ctxArg.step(`gate-${label}-${result.humanTaskId ?? 'pending'}`, () =>
          store.getExecution(executionId),
        );
        // Parallel lanes (WP5): META's single pendingHumanTaskId pointer can
        // belong to ANOTHER lane — trust the stage's own verdict first.
        const humanTaskId = result.humanTaskId ?? fresh?.pendingHumanTaskId;
        if (!humanTaskId) {
          return { state: 'TERMINAL', value: await fail('parked_without_gate', label) };
        }

        const deadline = await ctxArg.step(`gate-deadline-${humanTaskId}`, async () => {
          const current = await store.getExecution(executionId);
          const expiresAt = current?.orchestratorExpiresAt ?? orchestratorExpiresAt;
          const expiryMs = Date.parse(expiresAt ?? '');
          const marginMs = DURABLE_GATE_DEADLINE_MARGIN_SECONDS() * 1000;
          return {
            expiresAt,
            tooClose:
              Number.isFinite(expiryMs) &&
              Date.now() >= expiryMs - (Number.isFinite(marginMs) ? marginMs : 300000),
          };
        });
        if (deadline.tooClose) {
          await ctxArg.step(`supersede-deadline-gate-${humanTaskId}`, () =>
            store.supersedeHumanTask({
              executionId,
              humanTaskId,
              supersededBy: 'durable_deadline_expired',
            }),
          );
          return {
            state: 'TERMINAL',
            value: await fail(
              'durable_deadline_expired',
              `refusing to wait on gate ${humanTaskId}; durable execution expires at ${deadline.expiresAt}`,
            ),
          };
        }

        // Create a durable callback and stamp it on the gate so the answer path
        // can resume THIS execution. Then suspend (zero compute) until answered.
        const [callbackPromise, callbackId] = await ctxArg.createCallback(`await-${humanTaskId}`);
        const callbackBound = await ctxArg.step(`bind-callback-${humanTaskId}`, () =>
          store.setGateCallbackId({
            executionId,
            humanTaskId,
            callbackId,
            stageInstanceId: result.stageInstanceId ?? stage.stageInstanceId ?? null,
            callbackOwner: `stage:${result.stageInstanceId ?? stage.stageInstanceId ?? label}`,
          }),
        );
        if (!callbackBound) {
          return {
            state: 'TERMINAL',
            value: await fail(
              'gate_callback_conflict',
              `gate ${humanTaskId} is already bound to a different stage callback`,
            ),
          };
        }

        // Answer/bind race (field incident): a fast human can answer in the
        // window between the runtime parking the stage and the bind above —
        // the answer endpoint found NO callbackId to complete, so nothing
        // would wake this run until the park-release timer fired (a full
        // parkReleaseSeconds stall the human reads as "my answer was
        // ignored"). Re-read AFTER binding: an already-answered gate skips
        // the wait entirely and resumes now.
        const answeredEarly = await ctxArg.step(`gate-answered-early-${humanTaskId}`, async () => {
          const gate = await store.getHumanTask(executionId, humanTaskId);
          return Boolean(gate?.status) && gate.status !== 'pending';
        });
        if (!answeredEarly) {
          // D1 release-on-park: if no human answers within parkReleaseSeconds, free
          // the warm microVM compute (StopRuntimeSession) while we keep waiting —
          // for a lane, ITS OWN session is released, never a sibling's. Resume
          // re-mounts the persistent session storage, so the parked CLI
          // conversation is not lost. parkReleaseSeconds <= 0 stops immediately;
          // null skips release (wait on the callback alone).
          if (Number.isFinite(parkReleaseSeconds) && parkReleaseSeconds >= 0) {
            // Race the human answer (callbackPromise) against the release deadline
            // (a durable wait). Both are DurablePromises so race is replay-safe. The
            // wait resolves to void; if the callback hasn't resolved by then the gate
            // is still pending — re-read to disambiguate the winner deterministically.
            await ctxArg.promise.race(`park-${humanTaskId}`, [
              callbackPromise,
              ctxArg.wait(`release-timer-${humanTaskId}`, { seconds: parkReleaseSeconds }),
            ]);
            const stillPending = await ctxArg.step(`gate-status-${humanTaskId}`, async () => {
              const gate = await store.getHumanTask(executionId, humanTaskId);
              return gate?.status === 'pending';
            });
            if (stillPending) {
              await ctxArg.step(`release-${humanTaskId}`, () => stopSession(stageSessionId));
              await callbackPromise; // keep waiting; resume re-mounts persistent storage
            }
          } else {
            await callbackPromise; // resolved by SendDurableExecutionCallbackSuccess
          }
        }

        // Retired while parked? Cancel/rewind supersedes the pending gate and
        // wakes this callback with a cancel sentinel. The cancel/rewind path owns
        // META from here — exit WITHOUT any further write (docs/v2-steering.md).
        const gateAfter = await ctxArg.step(`gate-after-${humanTaskId}`, () =>
          store.getHumanTask(executionId, humanTaskId),
        );
        if (gateAfter?.status === 'superseded') {
          ctx.logger?.info?.('run retired while parked', { intentId, humanTaskId });
          return {
            state: 'TERMINAL',
            value: { ok: false, reason: 'retired', intentId, humanTaskId },
          };
        }
        // The gate may be ANSWERED yet the run retired anyway: a rewind/retry
        // relaunches under a NEW orchestratorRunId without superseding
        // already-answered gates. Without this ownership check the retired run
        // dispatched a resume against stage rows the rewind had just reset
        // (wiped CLI session → resume_no_session, and a stale FAILED write
        // over the fresh row — field incident). Verify we still own the run
        // BEFORE dispatching anything.
        const ownerRunId = await ctxArg.step(`run-owner-${humanTaskId}`, async () => {
          const currentMeta = await store.getExecution(executionId);
          return currentMeta?.orchestratorRunId ?? null;
        });
        if (runId && ownerRunId && ownerRunId !== runId) {
          ctx.logger?.info?.('run retired while parked (ownership lost)', {
            intentId,
            humanTaskId,
          });
          return {
            state: 'TERMINAL',
            value: { ok: false, reason: 'retired', intentId, humanTaskId },
          };
        }

        result = await runStage(ctxArg, invokeRuntime, { ...stageOpts, resumeFrom: humanTaskId });
      }

      if (result?.state === 'FAILED')
        return { state: 'FAILED', reason: result?.reason ?? '', result };
      return { state: 'SUCCEEDED', result };
    };

    // ── Parallel sections (docs/v2-parallel.md WP5) ────────────────────────
    // Skeleton-solo → skeleton gate → autonomy ladder → wavefront (or gated
    // batch barriers) over the promoted UNITPLAN, per-lane sessions/branches,
    // serialized merge-back, halt-and-ask on failure. See section.js.
    const sectionToolkit = {
      ctx,
      store,
      invokeRuntime,
      stopSession,
      broadcast,
      emitEvent,
      fail,
      executeStage,
      ids: { projectId, intentId, executionId },
      runId: null, // stamped below once minted
      intentBranch: meta.branch,
      cloneBase: {
        repos: meta.repos ?? [],
        baseBranch: meta.baseBranch,
        baseBranches: meta.baseBranches,
        gitProvider,
        repoProviders: meta.repoProviders ?? null,
        ...(gitAuthor ? { gitAuthor } : {}),
      },
      intentSessionId: sessionId,
      maxParallelUnits: meta.maxParallelUnits ?? 0,
      requestedCli,
      cliModels,
      tierModels,
      deriveEnrichment,
      prStrategy: meta.prStrategy ?? 'intent-pr',
      unitPrProvider,
      stageInstanceIdFor: (stageId, slug, sectionIndex = null) =>
        planStageInstanceId(namespace, stageId, slug, sectionIndex),
    };
    sectionToolkit.runId = runId;

    // ── The plan walk: alternating once-per-workflow segments and parallel
    // sections (docs/v2-parallel.md A2; detection is structural via forEach).
    const segments = planSegments(runStages);
    for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
      const segment = segments[segIdx];
      if (segment.kind === 'section') {
        const sectionOut = await runParallelSection(segment, sectionToolkit);
        if (sectionOut) return sectionOut;
        continue;
      }
      // The parallel section (if any) that consumes this segment's unit DAG:
      // its validation gate doubles as the FAN-OUT approval (A2 rules 2/7/8) —
      // one gate approves the artifact AND the fan-out decisions, instead of a
      // second engine gate at section start.
      const nextSection = segments.slice(segIdx + 1).find((s) => s.kind === 'section') ?? null;
      for (let stageIdx = 0; stageIdx < segment.stages.length; stageIdx += 1) {
        const stage = segment.stages[stageIdx];
        // A stage deselected by an earlier gate's recompose delta is passed
        // over here — its SKIPPED row + timeline event were written when the
        // flip was approved. Replay-deterministic: dynamicSkipIds is rebuilt
        // from the same memoized gate answers on every replay.
        if (dynamicSkipIds.includes(stage.stageId)) continue;
        // Gate-time "skip to stage X" (stage-skip.js, upstream stage-protocol
        // §0.5): set by an approved validation answer below, applied after the
        // stage's post-hooks — intermediates get SKIPPED rows, the TARGET
        // stage runs its full ritual.
        let skipToIndex = null;
        // Gate-time recompose delta ({ recompose: { skip: [...] } } riding the
        // approve answer): an ARBITRARY set of later, once-per-workflow,
        // CONDITIONAL stages to deselect — validated below, applied after the
        // post-hooks alongside skipTo.
        let recomposeSkips = [];
        const outputArtifactTypes = (stage.outputArtifacts ?? [])
          .map((o) => o.artifact ?? o)
          .filter(Boolean);
        // Unit DAG promotion trigger (docs/v2-parallel.md WP3): this stage
        // produces `unit-of-work-dependency`. Promotion runs BEFORE the
        // validation gate (each revision round re-promotes the re-produced
        // artifact) so the gate can present the fan-out plan; when a parallel
        // section consumes the DAG, the gate is REQUIRED regardless of the
        // stage's humanValidation flag (A2 rule 2: fan-out needs a human gate).
        const producesUnitDag = outputArtifactTypes.includes('unit-of-work-dependency');
        const fanoutSection = producesUnitDag ? nextSection : null;
        let validationRound = 0;
        let resumeFromValidation = null;
        for (;;) {
          const suffix = validationRound ? `-validation-${validationRound}` : '';
          const outcome = await executeStage(ctx, stage, {
            suffix,
            initialResumeFrom: resumeFromValidation,
          });
          if (outcome.state === 'TERMINAL') return outcome.value;
          if (outcome.state === 'FAILED') {
            const out = await fail('stage_failed', `${stage.stageId}: ${outcome.reason}`);
            return { ...out, stageId: stage.stageId };
          }

          if (outputArtifactTypes.length > 0) {
            const derived = await ctx.step(`derive-artifacts-${stage.stageId}${suffix}`, () =>
              invokeRuntime(
                {
                  command: 'derive-artifacts',
                  projectId,
                  intentId,
                  executionId,
                  stageInstanceId: stage.stageInstanceId ?? null,
                  sectionIndexes: segments
                    .filter((candidate) => candidate.kind === 'section')
                    .map((candidate) => candidate.index),
                  artifactTypes: outputArtifactTypes,
                  enrichment: deriveEnrichment,
                  ...(requestedCli ? { requestedCli } : {}),
                  ...(cliModels ? { cliModels } : {}),
                  ...(tierModels ? { tierModels } : {}),
                },
                sessionId,
              ),
            );
            if (!derived || derived.ok === false) {
              await emitEvent(
                ctx,
                `derive-artifacts-failed-${stage.stageId}${suffix}`,
                'v2.derive.failed',
                `${stage.stageId}: ${derived?.reason ?? 'no_response'}${
                  derived?.detail ? ` (${derived.detail})` : ''
                }`,
              );
            }
          }

          // Freeze the (re-)produced DAG into the UNITPLAN/UNIT scheduling
          // rows via the VPC-attached container (the orchestrator has no
          // Neptune access). A promotion failure fails the run HERE,
          // deterministically — discovering a missing UNITPLAN at fan-out
          // time would be far worse. (The hook only fires for once-per-workflow
          // stages; a per-unit DAG producer would be a pathological workflow
          // the plan validator already rejects for its own section.)
          let unitPlanForGate = null;
          if (producesUnitDag) {
            const promotion = await ctx.step(`promote-units-${stage.stageId}${suffix}`, () =>
              invokeRuntime(
                {
                  command: 'promote-units',
                  projectId,
                  intentId,
                  executionId,
                  stageInstanceId: stage.stageInstanceId ?? null,
                  sectionIndexes: segments
                    .filter((candidate) => candidate.kind === 'section')
                    .map((candidate) => candidate.index),
                },
                sessionId,
              ),
            );
            if (!promotion || promotion.ok === false) {
              const out = await fail(
                'units_promotion_failed',
                `${stage.stageId}: ${promotion?.reason ?? 'no_response'}${
                  promotion?.detail ? ` (${promotion.detail})` : ''
                }`,
              );
              return { ...out, stageId: stage.stageId };
            }
            await emitEvent(
              ctx,
              `units-promoted-${stage.stageId}${suffix}`,
              'v2.units.plan_ready',
              `Unit plan ready: ${promotion.unitCount} unit(s), ${promotion.batchCount} wave(s), skeleton ${promotion.walkingSkeleton ?? 'n/a'}`,
            );
            if (fanoutSection) {
              unitPlanForGate = await ctx.step(`load-unit-plan-${stage.stageId}${suffix}`, () =>
                store.getUnitPlan(executionId).catch(() => null),
              );
            }
          }

          // The fan-out approval rides THIS stage's validation gate (one gate,
          // not two) — so it is mandatory whenever a section consumes the DAG.
          const fanoutGateNeeded = Boolean(
            fanoutSection && unitPlanForGate && (unitPlanForGate.units ?? []).length > 0,
          );
          if (stage.humanValidation !== 'required' && !fanoutGateNeeded) break;

          // Valid forward-skip targets from THIS gate (empty when the feature
          // is disabled for the run, or no later stage qualifies). Advisory
          // for the UI; the answer is re-validated below — never trusted.
          const gateSkipTargets =
            meta.stageSkipping === 'enabled' ? skipTargetsFrom(segment.stages, stageIdx) : [];
          // Valid recompose-delta targets: every later once-per-workflow
          // CONDITIONAL stage the approve answer may flip to SKIP. Computed by
          // the SAME validator that judges the answer (resolveRecomposeSkips
          // with every plan stage as the candidate set), so the offer can
          // never drift from what the engine accepts. This powers the review
          // gate's "reshape upcoming stages" — decide right where you review,
          // in place, without retiring the parked run.
          const gateRecomposeTargets =
            meta.stageSkipping === 'enabled'
              ? resolveRecomposeSkips({
                  stages: runStages,
                  currentStageId: stage.stageId,
                  requested: runStages.map((s) => s.stageId),
                  alreadySkipped: [...intentSkipIds, ...dynamicSkipIds],
                }).applied
              : [];
          // The COMPUTED next stage in the overall run order (upstream 2.2.6:
          // gate options name it verbatim, never guess). Read from the flat
          // plan — not the segment — so the last stage before a parallel
          // section names the section's first stage. null = final stage; the
          // gate reads as "Complete workflow".
          const nextStageId = nextStageIdAfter(runStages, stage);
          const validation = await awaitEngineGate(ctx, sectionToolkit, {
            name: `validation-${stage.stageInstanceId ?? stage.stageId}-${validationRound}`,
            kind: 'validation',
            stageInstanceId: stage.stageInstanceId ?? null,
            prompt: [
              validationPrompt(
                stage,
                outputArtifactTypes,
                validationRound,
                gateSkipTargets,
                nextStageId,
                gateRecomposeTargets,
              ),
              // A2 rules 2/7/8: the unit-DAG stage's gate presents the fan-out
              // plan (units, waves, skeleton pick, skip matrix) and accepts
              // structured overrides on the approve answer.
              ...(fanoutGateNeeded
                ? [
                    '',
                    fanoutGateAddendum({
                      sectionIndex: fanoutSection.index,
                      unitPlan: unitPlanForGate,
                      sectionStages: fanoutSection.stages,
                      skeleton: defaultSkeletonFor(unitPlanForGate),
                    }),
                  ]
                : []),
            ].join('\n'),
            options: ['approve', 'request-changes'],
            nextStageId,
            ...(gateSkipTargets.length ? { skipTargets: gateSkipTargets } : {}),
            ...(gateRecomposeTargets.length ? { recomposeTargets: gateRecomposeTargets } : {}),
          });
          if (validation.superseded) return { ok: false, reason: 'retired', intentId };

          const choice =
            parseChoice(validation.gate?.answer, ['approve', 'request-changes']) ??
            (validation.gate?.status === 'approved'
              ? 'approve'
              : validation.gate?.status === 'rejected'
                ? 'request-changes'
                : 'approve');
          if (choice === 'approve') {
            await emitEvent(
              ctx,
              `stage-validated-${stage.stageId}-${validationRound}`,
              'v2.stage.validated',
              `Stage ${stage.stageId} approved by human validation`,
            );
            // Fan-out approval (A2 rules 2/7/8): freeze the effective
            // decisions — defaults + validated overrides riding the approve
            // answer — onto the UNITPLAN so the section runner schedules
            // exactly what the human approved. Invalid entries are rejected
            // into a timeline event (never trusted, never silently dropped).
            if (fanoutGateNeeded) {
              const decisions = await ctx.step(
                `fanout-decisions-${stage.stageId}-${validationRound}`,
                async () => {
                  const bySlug = new Map((unitPlanForGate.units ?? []).map((u) => [u.slug, u]));
                  const overrides = validateFanoutOverrides(validation.gate?.answer, {
                    slugs: new Set(bySlug.keys()),
                    sectionStages: fanoutSection.stages,
                    bySlug,
                  });
                  const effective = {
                    walkingSkeleton:
                      overrides.walkingSkeleton ?? defaultSkeletonFor(unitPlanForGate),
                    skipMatrix: overrides.skipMatrix ?? unitPlanForGate.skipMatrix ?? {},
                  };
                  try {
                    await store.updateUnitPlanDecisions({ executionId, ...effective });
                  } catch {
                    /* promotion defaults stand when the patch write is lost */
                  }
                  if (overrides.rejected.length) {
                    try {
                      await store.appendEvent({
                        executionId,
                        type: 'v2.units.decisions_invalid',
                        actor: 'orchestrator',
                        summary: `Fan-out overrides partially rejected: ${overrides.rejected.join('; ')}`,
                      });
                    } catch {
                      /* audit is best-effort */
                    }
                  }
                  return effective;
                },
              );
              await emitEvent(
                ctx,
                `fanout-approved-${stage.stageId}-${validationRound}`,
                'v2.units.fanout_approved',
                `Fan-out approved for section ${fanoutSection.index}: skeleton ${decisions.walkingSkeleton}, ${(unitPlanForGate.units ?? []).length} unit(s)`,
              );
            }
            // A skip request rides the approve answer ({ decision: 'approve',
            // skipTo: '<stageId>' }). Re-validate against the segment + policy;
            // a rejected skip degrades to the plain approve (the run continues
            // normally) with the reason on the timeline — never trust, never
            // silently drop.
            const requestedSkipTo = validation.gate?.answer?.skipTo;
            if (requestedSkipTo != null) {
              if (meta.stageSkipping !== 'enabled') {
                await emitEvent(
                  ctx,
                  `skip-to-rejected-${stage.stageId}-${validationRound}`,
                  'v2.stage.skip_rejected',
                  `Skip to "${requestedSkipTo}" ignored: stage skipping is disabled for this run`,
                );
              } else {
                const skip = resolveSkipTo({
                  skipTo: requestedSkipTo,
                  segmentStages: segment.stages,
                  currentIndex: stageIdx,
                });
                if (skip.error) {
                  await emitEvent(
                    ctx,
                    `skip-to-rejected-${stage.stageId}-${validationRound}`,
                    'v2.stage.skip_rejected',
                    `Skip to "${requestedSkipTo}" ignored: ${skip.error}`,
                  );
                } else {
                  skipToIndex = skip.targetIndex;
                }
              }
            }
            // A recompose delta may also ride the approve answer
            // ({ recompose: { skip: [...] } }): arbitrary later stages to
            // deselect, not just a contiguous jump. Per-entry validation
            // (stage-skip.js resolveRecomposeSkips) against the FLAT plan;
            // rejected entries degrade to timeline events — never trusted,
            // never silently dropped.
            const requestedRecompose = validation.gate?.answer?.recompose?.skip;
            if (Array.isArray(requestedRecompose) && requestedRecompose.length > 0) {
              if (meta.stageSkipping !== 'enabled') {
                await emitEvent(
                  ctx,
                  `recompose-rejected-${stage.stageId}-${validationRound}`,
                  'v2.stage.recompose_rejected',
                  `Recompose ignored: stage skipping is disabled for this run`,
                );
              } else {
                const verdict = resolveRecomposeSkips({
                  stages: runStages,
                  currentStageId: stage.stageId,
                  requested: requestedRecompose,
                  alreadySkipped: [...intentSkipIds, ...dynamicSkipIds],
                });
                recomposeSkips = verdict.applied;
                for (const rej of verdict.rejected) {
                  await emitEvent(
                    ctx,
                    `recompose-rejected-${stage.stageId}-${validationRound}-${rej.stageId}`,
                    'v2.stage.recompose_rejected',
                    `Recompose skip of "${rej.stageId}" ignored: ${rej.reason}`,
                  );
                }
              }
            }
            break;
          }

          resumeFromValidation = validation.gate.humanTaskId;
          validationRound += 1;
          await emitEvent(
            ctx,
            `stage-validation-revision-${stage.stageId}-${validationRound}`,
            'v2.stage.revision_requested',
            `Human requested changes for ${stage.stageId}; re-running stage with feedback`,
          );
        }

        // Apply an approved "skip to stage X": mark every intermediate SKIPPED
        // (audit row + timeline event, same shape as the fan-out skip matrix)
        // and jump the walk to the target. The skipped ids join the dispatch
        // overlay so downstream stages resolve their absent inputs as
        // expectedAbsent instead of hallucinating them. Applied AFTER the
        // post-hooks — the approved stage's own derive/promote work is done.
        if (skipToIndex != null) {
          const target = segment.stages[skipToIndex];
          for (let k = stageIdx + 1; k < skipToIndex; k += 1) {
            const skipped = segment.stages[k];
            await ctx.step(`skip-gate-${skipped.stageId}`, async () => {
              try {
                await store.putStage({
                  executionId,
                  stageInstanceId: skipped.stageInstanceId,
                  stageId: skipped.stageId,
                  phase: skipped.phase ?? null,
                  state: 'SKIPPED',
                });
              } catch {
                /* the SKIPPED row is audit; never break the run over it */
              }
            });
            await emitEvent(
              ctx,
              `skip-gate-event-${skipped.stageId}`,
              'v2.stage.skipped',
              `Stage ${skipped.stageId} skipped (skip to ${target.stageId} approved at the ${stage.stageId} gate)`,
            );
            dynamicSkipIds.push(skipped.stageId);
          }
          stageIdx = skipToIndex - 1; // the walk resumes AT the target stage
        }

        // Apply an approved recompose delta: SKIPPED rows + events for every
        // validated flip, then the ids join the dispatch overlay (downstream
        // prompts see the deselected producers' artifacts as expectedAbsent)
        // and the walk-level pass-over above. Deduplicated against skipTo's
        // intermediates, which may overlap the delta.
        for (const flippedId of recomposeSkips) {
          if (dynamicSkipIds.includes(flippedId)) continue;
          const flipped = runStages.find((s) => s.stageId === flippedId);
          if (!flipped) continue;
          await ctx.step(`recompose-skip-${flippedId}`, async () => {
            try {
              await store.putStage({
                executionId,
                stageInstanceId: flipped.stageInstanceId,
                stageId: flipped.stageId,
                phase: flipped.phase ?? null,
                state: 'SKIPPED',
              });
            } catch {
              /* the SKIPPED row is audit; never break the run over it */
            }
          });
          await emitEvent(
            ctx,
            `recompose-skip-event-${flippedId}`,
            'v2.stage.recomposed',
            `Stage ${flippedId} deselected (recompose approved at the ${stage.stageId} gate)`,
          );
          dynamicSkipIds.push(flippedId);
        }
      }
    }

    // Terminal success — CAS on the ownership token: a retired run (relaunched
    // under a new runId while this one was still unwinding) exits quietly. The
    // verdict is the step result so a durable replay sees it too.
    const ownedFinish = await ctx.step('finish-succeeded', async () => {
      try {
        await store.updateExecution({
          executionId,
          projectId,
          status: 'SUCCEEDED',
          startedAt: meta.startedAt,
          completedAt: nowIso(),
          ...(runId ? { ifOrchestratorRunId: runId } : {}),
        });
        return true;
      } catch (e) {
        if (e?.name === 'ConditionalCheckFailedException') return false;
        throw e;
      }
    });
    if (!ownedFinish) {
      ctx.logger?.info?.('retired run skipped terminal success write', { intentId });
      return { ok: false, reason: 'retired', intentId };
    }
    await emitEvent(ctx, 'succeeded-event', 'v2.execution.succeeded', 'All stages completed');

    // ── PR at fan-in (docs/v2-parallel.md WP6, A3: "execution SUCCEEDED →
    // PR(s) per project prStrategy"). intent-pr: ONE PR per repo from the
    // intent branch onto the base branch, via the source-control service (the
    // v1 unmerged-branch guard lives inside createPullRequest). PR problems
    // never un-succeed the run — every outcome is a loud timeline event. A
    const prResults = await ctx.step('open-pr', async () =>
      openIntentPrs({
        openPr,
        comparePrBranches,
        store,
        meta,
        executionId,
        gitProvider,
        log: (m) => ctx.logger?.info?.(m, { intentId }),
      }),
    );
    for (let i = 0; i < prResults.length; i++) {
      const r = prResults[i];
      await emitEvent(ctx, `pr-event-${i}`, r.eventType, r.summary);
    }
    // Write the opened PR(s) into the graph via the VPC-attached runtime (the
    // orchestrator has no Neptune access). Best-effort: a failure here never
    // un-succeeds a run whose PR already exists on the remote.
    const openedPrs = prResults.map((r) => r.pr).filter(Boolean);
    if (openedPrs.length > 0) {
      const recordResult = await ctx.step('record-pr', async () => {
        try {
          return await invokeRuntime(
            { command: 'record-pr', projectId, intentId, executionId, prs: openedPrs },
            sessionId,
          );
        } catch (e) {
          ctx.logger?.error?.('record-pr dispatch failed', { intentId, error: e?.message });
          return { ok: false, reason: 'dispatch_failed' };
        }
      });
      // Trigger the UI refetch AFTER the vertex is written (the runtime's own
      // agent.pr broadcast can be missed if its session was cold at fan-in).
      // This orchestrator event always broadcasts, so the PR appears live.
      if (recordResult?.ok !== false) {
        await emitEvent(
          ctx,
          'pr-recorded',
          'v2.pr.recorded',
          `Recorded ${openedPrs.length} pull request(s)`,
        );
      }
    }
    return { ok: true, intentId, stages: runStages.length };
  } catch (err) {
    // Any unexpected throw (runtime transport error, store write failure) — record
    // it so the UI shows FAILED + the message rather than the run silently dying
    // at the durable-function boundary (module INIT crashes used to fail with
    // zero user-visible feedback).
    ctx.logger?.error?.('orchestrator failed', { intentId, error: err?.message });
    return await fail('orchestrator_error', err?.message ?? String(err));
  }
};

// One async stage attempt (docs/v2-parallel.md WP1):
//   1. create a durable callback for the stage verdict (named per attempt so a
//      resume leg is a fresh durable identity),
//   2. dispatch `run-stage-start` to the container in a short durable step —
//      the container runs the stage as a background job and holds HealthyBusy,
//   3. suspend at zero compute until the container completes the callback with
//      the run-stage return contract (state always present — the container
//      normalizes), or the callback times out / stops being heartbeaten.
//
// Every outcome is returned as a value (never thrown): the stage loop has one
// decode path over `result.state`.
//
// Callback guards: `timeout` matches AgentCore's 8h async-job ceiling — a
// stage cannot legitimately outlive it. `heartbeatTimeout` is the
// dead-container detector: the background job beats every ~60s, so a container
// that dies mid-stage surfaces here in minutes instead of hours.
const STAGE_CALLBACK_TIMEOUT = { hours: 8 };
const STAGE_CALLBACK_HEARTBEAT_TIMEOUT = { minutes: 15 };

const runStage = async (
  ctx,
  invokeRuntime,
  {
    stage,
    unitSlug = null,
    sectionIndex = null,
    suffix = '',
    ids,
    workflowId,
    workflowVersion,
    scope,
    // Per-run skip overlay (intent-level + accumulated gate-time skips) —
    // forwarded so the container's plan resolution matches the walk's.
    skipStageIds = null,
    // Per-intent composed grid — forwarded for the same plan-parity reason.
    composedGrid = null,
    cliModels,
    tierModels = null,
    requestedCli,
    mcpServersByTier,
    customRules,
    sessionId,
    cloneInputs,
    resumeFrom,
    reviewFeedback = null,
  },
) => {
  // The attempt key names every durable identity for this stage attempt. It
  // carries the unit dimension (docs/v2-parallel.md WP4) and the halt-and-ask
  // round suffix (WP5) so N lanes' instances — and a lane's retry rounds —
  // are distinct callbacks/steps: a collision would make the durable engine
  // memoize one attempt's verdict as another's.
  const attemptKey = `${stage.stageId}${
    unitSlug ? `-s${sectionIndex ?? 'legacy'}-u-${unitSlug}` : ''
  }${suffix}${
    resumeFrom ? `-resume-${resumeFrom}` : ''
  }${reviewFeedback ? `-feedback-${reviewFeedback.batchId ?? 'batch'}` : ''}`;
  const [stageDone, stageCallbackId] = await ctx.createCallback(`stage-cb-${attemptKey}`, {
    timeout: STAGE_CALLBACK_TIMEOUT,
    heartbeatTimeout: STAGE_CALLBACK_HEARTBEAT_TIMEOUT,
  });

  const dispatch = await ctx.step(`run-${attemptKey}`, async () =>
    invokeRuntime(
      {
        command: 'run-stage-start',
        // Launch-latency anchor (cold start metric): stamped at dispatch,
        // INSIDE the step so a memoized replay never re-stamps it. The
        // container computes agentLaunchMs = accept − dispatchedAt, covering
        // the InvokeAgentRuntime hop + any microVM cold start.
        dispatchedAt: nowIso(),
        ...ids,
        stageId: stage.stageId,
        // Unit lane (WP4): run-stage derives the per-unit instance id, stamps
        // the slug on every row/event/broadcast, and scopes the prompt.
        unitSlug,
        sectionIndex,
        workflowId,
        workflowVersion,
        scope,
        ...(skipStageIds?.length ? { skipStageIds } : {}),
        ...(composedGrid ? { composedGrid } : {}),
        ...(cliModels ? { cliModels } : {}),
        ...(tierModels ? { tierModels } : {}),
        ...(requestedCli ? { requestedCli } : {}),
        ...(mcpServersByTier ? { mcpServersByTier } : {}),
        ...(customRules ? { customRules } : {}),
        // Repository and branch references for source self-heal. AgentCore
        // resolves a short-lived credential directly from the broker.
        ...cloneInputs,
        resumeFrom: resumeFrom ?? null,
        reviewFeedback: reviewFeedback
          ? {
              batchId: reviewFeedback.batchId ?? null,
              prompt: reviewFeedback.prompt,
              targets: reviewFeedback.targets ?? [],
            }
          : null,
        stageCallbackId,
      },
      sessionId,
    ),
  );
  // The accept response only says "job started" — a refusal (unknown command on
  // an old container, duplicate job, missing fields) fails the stage HERE; the
  // verdict for an accepted job always travels through the callback.
  if (!dispatch || dispatch.ok === false || dispatch.error) {
    return {
      ok: false,
      state: 'FAILED',
      reason: dispatch?.reason ?? 'stage_dispatch_failed',
      detail: dispatch?.detail ?? dispatch?.error ?? null,
    };
  }

  try {
    // createCallback's default serdes is PASS-THROUGH (unlike steps): the
    // container's SendDurableExecutionCallbackSuccess body arrives as the raw
    // JSON string. Decode defensively — a malformed body is a stage failure,
    // not an orchestrator crash.
    const raw = await stageDone;
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result || typeof result !== 'object') {
      return { ok: false, state: 'FAILED', reason: 'stage_bad_callback_result' };
    }
    return result;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return {
        ok: false,
        state: 'FAILED',
        reason: 'stage_bad_callback_result',
        detail: err.message,
      };
    }
    // Callback timeout / heartbeat expiry (dead container) / explicit failure.
    return {
      ok: false,
      state: 'FAILED',
      reason: 'stage_callback_failed',
      detail: err?.message ?? String(err),
    };
  }
};

const nowIso = () => new Date().toISOString();

// The stage that runs after `stage` in the FLAT plan order, or null when this
// is the run's final stage (upstream 2.2.6: `next_stage: string | null`, the
// gate names it verbatim — "Complete workflow" when null). Matched by
// stageInstanceId (unique per plan) with a stageId fallback for the degenerate
// no-instance-id case; a stage not in the plan yields null rather than a guess.
const nextStageIdAfter = (runStages = [], stage = {}) => {
  const ix = runStages.findIndex((s) =>
    stage.stageInstanceId != null
      ? s.stageInstanceId === stage.stageInstanceId
      : s.stageId === stage.stageId,
  );
  if (ix < 0) return null;
  return runStages[ix + 1]?.stageId ?? null;
};

const validationPrompt = (
  stage,
  outputArtifactTypes = [],
  round = 0,
  skipTargets = [],
  nextStageId = null,
  recomposeTargets = [],
) => {
  const artifacts = outputArtifactTypes.length
    ? outputArtifactTypes.join(', ')
    : 'no declared artifacts';
  return [
    `Review stage ${stage.stageId}${round ? ` (revision ${round})` : ''}.`,
    '',
    `Produced artifacts: ${artifacts}.`,
    '',
    // Name the COMPUTED next stage (upstream 2.2.6) — never a guessed one.
    nextStageId
      ? `Choose approve to continue to ${nextStageId}, or request-changes with feedback to send this stage back to the agent.`
      : 'This is the final stage — choose approve to complete the workflow, or request-changes with feedback to send this stage back to the agent.',
    ...(skipTargets.length
      ? [
          '',
          `Skip ahead (optional): approve may carry { "skipTo": "<stageId>" } to jump to one of [${skipTargets.join(
            ', ',
          )}] — every stage in between is CONDITIONAL and will be marked SKIPPED; the target stage runs in full.`,
        ]
      : []),
    ...(recomposeTargets.length
      ? [
          '',
          `Reshape (optional): approve may carry { "recompose": { "skip": ["<stageId>", …] } } to drop any of [${recomposeTargets.join(
            ', ',
          )}] — an arbitrary selection of later CONDITIONAL stages, marked SKIPPED in place; downstream stages treat their outputs as absent by design.`,
        ]
      : []),
  ].join('\n');
};

// ── WP6: open the fan-in PR(s) (intent-pr strategy) ─────────────────────────
// One PR per repo from the intent branch onto the base branch. NEVER throws —
// every outcome (opened / already-open / no-changes / guard-conflict / error)
// becomes a timeline event the caller records. The PR body carries
// the execution id and an HONEST unit summary: lanes that were skipped after
// failure are named, so the reviewer knows what the increment does NOT
// contain (the human explicitly chose to continue without them — the fan-in
// gate is the decision record, the PR body is its mirror).
const openIntentPrs = async ({
  openPr,
  comparePrBranches = null,
  store,
  meta,
  executionId,
  gitProvider,
  log,
}) => {
  const repos = meta.repos ?? [];
  const branch = meta.branch;
  const strategy = meta.prStrategy ?? 'intent-pr';
  // Per-repo base-branch override wins; the legacy single string is the
  // project-wide fallback; a repo absent from both falls through to null so
  // the provider resolves that repo's ACTUAL default branch (never 'main').
  const baseFor = (repoId) => meta.baseBranches?.[repoId] ?? meta.baseBranch ?? null;
  if (repos.length === 0) {
    return [
      { eventType: 'v2.pr.skipped', summary: 'No repositories on this intent — no PR to open' },
    ];
  }
  // Deterministic lost-work signal (2026-07 incident): did the engine record
  // repo work during this run? v2.git.pushed names repos whose commits reached
  // the remote; v2.git.push_failed names repos whose work did NOT become
  // durable. An artifact-only run has neither — for those, a commit-less
  // branch is genuinely "no changes". Best-effort: an unreadable timeline
  // just means the signal is silent (never blocks the PR).
  let gitEvents = [];
  try {
    gitEvents = ((await store.listEvents?.(executionId)) ?? []).filter(
      (e) => e.eventType === 'v2.git.pushed' || e.eventType === 'v2.git.push_failed',
    );
  } catch {
    /* signal is best-effort */
  }
  const repoGitActivity = (repoId) => ({
    pushed: gitEvents.some((e) => e.eventType === 'v2.git.pushed' && e.summary?.includes(repoId)),
    pushFailed: gitEvents.some(
      (e) => e.eventType === 'v2.git.push_failed' && e.summary?.includes(repoId),
    ),
  });

  // Unit transparency for the PR body (best-effort — a store without unit
  // rows, or a pre-WP3 run, just omits the section).
  let unitLines = [];
  try {
    const units = (await store.listUnits?.(executionId)) ?? [];
    const unmerged = units.filter((u) => u.state && u.state !== 'MERGED');
    if (units.length) {
      unitLines = [
        '',
        `Units: ${units.length} total, ${units.length - unmerged.length} merged.`,
        ...unmerged.map(
          (u) =>
            `- ⚠️ unit \`${u.slug}\` NOT merged (${u.state}${u.failureReason ? `: ${u.failureReason}` : ''}) — its branch is preserved`,
        ),
      ];
    }
  } catch {
    /* transparency section is best-effort */
  }

  const title = meta.title || `AI-DLC: ${branch}`;
  const body = [
    `Automated ${gitProvider === 'gitlab' ? 'MR' : 'PR'} created by AI-DLC (strategy: ${strategy})`,
    '',
    `Execution ID: ${executionId}`,
    `Project: ${meta.projectId}`,
    ...unitLines,
  ].join('\n');

  const results = [];
  for (const repo of repos) {
    const repoId = typeof repo === 'string' ? repo : repo.url;
    const provider = repoProvider(meta, repoId);
    try {
      const activity = repoGitActivity(repoId);
      // Pre-check: does the intent branch exist remotely with commits ahead of
      // base? 'unknown' (comparison unavailable) falls through to the PR call
      // — the pre-check adds safety, never a new way to block a good PR.
      const cmp = comparePrBranches
        ? await comparePrBranches({
            projectId: meta.projectId,
            gitProvider: provider,
            repoId,
            base: baseFor(repoId),
            head: branch,
          }).catch((e) => ({ status: 'unknown', detail: e?.message }))
        : { status: 'unknown' };
      if (cmp.status === 'missing_head') {
        results.push({
          eventType: 'v2.pr.failed',
          summary: `PR for ${repoId} not possible: intent branch "${branch}" does not exist on the remote — the engine never pushed it${
            activity.pushFailed
              ? ' (git push failures were recorded during the run; the work may still sit on the session workspace)'
              : ''
          }`,
        });
        continue;
      }
      if (cmp.status === 'identical' || cmp.status === 'behind') {
        // No commits to merge. Benign ONLY for a run that never had repo work;
        // a run that recorded engine git activity but ends commit-less has
        // LOST WORK and must fail loudly (the 2026-07 incident: two ENOSPC'd
        // commits, a clean-looking branch, and a quiet "no changes" skip).
        if (activity.pushed || activity.pushFailed) {
          results.push({
            eventType: 'v2.pr.failed',
            summary: `PR for ${repoId} not possible: "${branch}" has no commits ahead of ${cmp.base ?? 'the base branch'} although the run recorded ${
              activity.pushFailed ? 'engine push FAILURES' : 'engine pushes'
            } — likely lost work; check the run's v2.git events and the session workspace`,
          });
          continue;
        }
        results.push({
          eventType: 'v2.pr.skipped',
          summary: `No PR for ${repoId}: no changes between ${branch} and ${cmp.base ?? 'the base branch'} (no repo work was recorded this run)`,
        });
        continue;
      }
      const res = await openPr({
        projectId: meta.projectId,
        gitProvider: provider,
        repoId,
        branch,
        baseBranch: baseFor(repoId),
        title,
        body,
      });
      if (res?.prUrl) {
        results.push({
          eventType: 'v2.pr.opened',
          summary: `${res.existing ? 'PR already open' : 'PR opened'} for ${repoId}: ${res.prUrl}`,
          // Structured data for record-pr (the graph write happens in the
          // VPC-attached runtime; the orchestrator has no Neptune access).
          pr: {
            repoId,
            prUrl: res.prUrl,
            prNumber: res.prNumber ?? null,
            branch,
            // The provider retargets to the repo's real default branch when the
            // requested base was invalid — record the ACTUAL merge target.
            baseBranch: res.retargetedBase ?? baseFor(repoId),
          },
        });
      } else if (res?.skipped) {
        // The provider's own "no changes" verdict (compare was unavailable).
        // Same lost-work override as above: recorded git activity means this
        // skip is NOT benign.
        if (activity.pushed || activity.pushFailed) {
          results.push({
            eventType: 'v2.pr.failed',
            summary: `PR for ${repoId} reported "${res.reason ?? 'no changes'}" although the run recorded ${
              activity.pushFailed ? 'engine push FAILURES' : 'engine pushes'
            } — likely lost work; check the run's v2.git events and the session workspace`,
          });
        } else {
          results.push({
            eventType: 'v2.pr.skipped',
            summary: `No PR for ${repoId}: ${res.reason ?? 'no changes between the branches'}`,
          });
        }
      } else if (res?.failed) {
        results.push({
          eventType: 'v2.pr.failed',
          summary: `PR for ${repoId} failed (${res.reason ?? 'error'}): ${res.error ?? 'no detail'}`,
        });
      } else if (res?.conflict) {
        results.push({
          eventType: 'v2.pr.failed',
          summary: `PR blocked for ${repoId}: ${res.error ?? 'unmerged branches'}${
            res.unmergedBranches?.length ? ` (${res.unmergedBranches.join(', ')})` : ''
          }`,
        });
      } else {
        results.push({
          eventType: 'v2.pr.failed',
          summary: `PR for ${repoId} returned an unexpected result: ${JSON.stringify(res).slice(0, 300)}`,
        });
      }
    } catch (e) {
      log?.(`PR open failed for ${repoId}: ${e?.message}`);
      results.push({
        eventType: 'v2.pr.failed',
        summary: `PR open failed for ${repoId}: ${e?.message ?? String(e)}`,
      });
    }
  }
  return results;
};

export const lambdaHandler = withDurableExecution(handler);
// Exported for unit tests that drive the control flow with a fake DurableContext.
export const __durableHandler = handler;
