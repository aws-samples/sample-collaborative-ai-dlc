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
// REPLAY DISCIPLINE: every side effect (agent invokes, all store writes, the
// git-token read) MUST be inside ctx.step(...) or it re-executes on replay.

import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
// Shared modules are CommonJS — default-import then destructure (the esbuild
// build injects the createRequire banner, so the bundle must NOT declare its
// own `createRequire`/`require` or it collides with the banner at runtime).
import processStorePkg from '../shared/v2-process-store.js';
import workflowPlanPkg from '../shared/v2-workflow-plan.js';
import executionPlanPkg from '../shared/v2-execution-plan.js';
import gitConnectionStorePkg from '../shared/git-connection-store.js';
import gitTokenPkg from '../shared/git-token.js';
import githubAuthConfigPkg from '../shared/github-auth-config.js';
import gitProvidersPkg from '../shared/git-providers.js';
import wsFanoutPkg from '../shared/ws-fanout.js';
import { runParallelSection } from './section.js';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const { createProcessStore } = processStorePkg;
const { loadExecutionPlan } = workflowPlanPkg;
const { planSegments, stageInstanceId: planStageInstanceId } = executionPlanPkg;
const { getGitConnection } = gitConnectionStorePkg;
const { resolveGitToken, getInstallationTokenFromConfig } = gitTokenPkg;
const { getGitHubAuthMode } = githubAuthConfigPkg;
const { getProvider } = gitProvidersPkg;
const { broadcastToIntentChannel } = wsFanoutPkg;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});
const agentcore = new BedrockAgentCoreClient({});
const defaultStore = createProcessStore({ ddb });

const RUNTIME_ARN = () => process.env.AGENTCORE_RUNTIME_ARN;
const BLOCKS_TABLE = () => process.env.BLOCKS_TABLE;

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

// Normalize a repo entry (slug or URL, string or {url}) to an "owner/repo"
// slug — the shape both the provider layer and installation-token minting use.
const toRepoSlug = (repo) => {
  const raw = typeof repo === 'string' ? repo : (repo?.url ?? '');
  return raw
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
};

// Resolve the git token for the intent's run. Mode-aware for GitHub (see
// shared/github-auth-config.js): in 'app' mode a repo-scoped installation
// token is minted (no per-user connection involved); in 'oauth' mode (and for
// every non-GitHub provider) the starter's per-user connection is resolved.
// Returns { token, mode, reason } — the reason names WHY the token is empty
// (no_connection / resolve_failed with the error), so a repo-ful run can
// surface it instead of silently degrading to unauthenticated git. An empty
// token can turn a private clone failure into a blind run against an empty repo.
const defaultResolveToken = async ({ startedBy, gitProvider, repos = [] }) => {
  if (gitProvider === 'github') {
    try {
      const mode = await getGitHubAuthMode(ssm);
      if (mode === 'app') {
        const repoSlugs = repos.map(toRepoSlug).filter(Boolean);
        if (repoSlugs.length === 0) return { token: '', mode, reason: 'app_mode_no_repos' };
        const token = await getInstallationTokenFromConfig({
          ssm,
          secrets,
          repositories: repoSlugs,
        });
        return token ? { token, mode } : { token: '', mode, reason: 'app_mint_empty' };
      }
    } catch (e) {
      console.error('[v2-orchestrator] app-mode git token mint failed:', e?.message);
      return { token: '', mode: 'app', reason: `app_mint_failed: ${e?.message ?? 'unknown'}` };
    }
  }
  if (!startedBy || !gitProvider) return { token: '', reason: 'no_starter_or_provider' };
  try {
    const item = await getGitConnection(ddb, startedBy, gitProvider);
    if (!item?.parameterName) return { token: '', reason: 'no_connection' };
    const token = (await resolveGitToken(ssm, item)) || '';
    return token ? { token } : { token: '', reason: 'empty_ssm_token' };
  } catch (e) {
    console.error('[v2-orchestrator] git token resolution failed:', e?.message);
    return { token: '', reason: `resolve_failed: ${e?.message ?? 'unknown'}` };
  }
};

// App-mode only: mint a FRESH repo-scoped installation token (served from the
// ~1h cache in shared/git-token.js when still valid). Installation tokens
// expire after ~1h — far shorter than a long run — so every dispatch that
// hands git credentials to the runtime re-resolves through this instead of
// reusing the run-start snapshot. Returns null in oauth mode (the snapshot
// token never expires for GitHub OAuth) and null on failure (callers fall
// back to the snapshot, which keeps oauth/legacy behaviour intact).
const defaultMintFreshToken = async ({ gitProvider, repos = [] }) => {
  if (gitProvider !== 'github') return null;
  try {
    const mode = await getGitHubAuthMode(ssm);
    if (mode !== 'app') return null;
    const repoSlugs = repos.map(toRepoSlug).filter(Boolean);
    if (repoSlugs.length === 0) return null;
    return await getInstallationTokenFromConfig({ ssm, secrets, repositories: repoSlugs });
  } catch (e) {
    console.error('[v2-orchestrator] fresh app token mint failed:', e?.message);
    return null;
  }
};

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
  return { action: 'agent.note', noteType: type, summary };
};

// The orchestrator's collaborators, injectable for tests. Defaults bind the real
// store / plan loader / runtime invoke / git-token resolver.
const defaultDeps = () => ({
  store: defaultStore,
  loadPlan: (args) => loadExecutionPlan({ ddb, tableName: BLOCKS_TABLE(), ...args }),
  invokeRuntime: defaultInvokeRuntime,
  resolveToken: defaultResolveToken,
  mintFreshToken: defaultMintFreshToken,
  stopSession: stopRuntimeSession,
  broadcast: broadcastToIntentChannel,
  // WP6: open the fan-in PR through the shared provider layer. Injectable so
  // tests never touch provider APIs.
  openPr: ({ gitProvider, token, repoId, branch, baseBranch, title, body }) =>
    getProvider(gitProvider).createPullRequest({ token }, repoId, {
      branch,
      baseBranch,
      title,
      body,
    }),
});

const handler = async (event, ctx, deps = defaultDeps()) => {
  const {
    store,
    loadPlan,
    invokeRuntime,
    resolveToken,
    mintFreshToken,
    stopSession,
    broadcast,
    openPr,
  } = deps;
  const { intentId, executionId } = event;
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
    runId = await ctx.step('mint-run-id', async () => {
      const token = `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const updated = await store.updateExecution({ executionId, orchestratorRunId: token });
      return updated?.orchestratorRunId ?? token;
    });
    // init-ws — clone repos, create the Neptune Intent anchor, seed RUNNING state.
    // Idempotent in the runtime (ConditionalCheckFailed → already initialized), so
    // a replay of this step is safe.
    // Token resolution returns { token, reason } (a legacy string stub is
    // normalized). A repo-ful run with NO token is loudly recorded — the run
    // proceeds (init-ws now fails a private clone honestly; public/read-only
    // flows still work) but the reason is on the timeline, not swallowed.
    const tokenResult = await ctx.step('git-token', async () => {
      const res = await resolveToken({
        startedBy: meta.startedBy,
        gitProvider,
        repos: meta.repos ?? [],
      });
      return typeof res === 'string' ? { token: res } : res;
    });
    const token = tokenResult?.token ?? '';
    if (!token && (meta.repos ?? []).length > 0) {
      await emitEvent(
        ctx,
        'git-token-missing',
        'v2.git.token_unavailable',
        tokenResult?.mode === 'app'
          ? `No usable git credentials for this run (${tokenResult?.reason ?? 'unknown'}) — private clones and pushes will fail; check the GitHub App configuration on the Admin page`
          : `No usable git credentials for this run (${tokenResult?.reason ?? 'unknown'}) — private clones and pushes will fail; connect ${gitProvider} for the starting user`,
      );
    }
    // Fresh-token accessor for every later dispatch that hands git credentials
    // to the runtime. In GitHub-App mode the run-start snapshot expires after
    // ~1h, so each dispatch re-resolves (cached mint); in oauth mode this
    // always returns the snapshot. Called INSIDE durable step bodies only —
    // replay never re-executes a memoized step, so a re-mint can't fork state.
    const freshGitToken = async () => {
      try {
        const fresh = await mintFreshToken?.({ gitProvider, repos: meta.repos ?? [] });
        return fresh || token;
      } catch {
        return token;
      }
    };
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
          gitToken: token,
          gitProvider,
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
    const planResult = await ctx.step('load-plan', () =>
      loadPlan({ workflowId, workflowVersion, scope }),
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
      const upstreamOk = await ctx.step('rewind-upstream-check', async () => {
        // A `forEach: unit-of-work` upstream stage has one instance PER UNIT
        // (docs/v2-parallel.md WP4) — every lane's instance must be terminal
        // (SUCCEEDED, or SKIPPED per the approved skip matrix).
        let unitSlugs = null; // lazy — only needed when a section precedes the rewind point
        for (const s of stages.slice(0, idx)) {
          if (s.parallelSection != null) {
            if (unitSlugs === null) {
              const up = await store.getUnitPlan?.(executionId).catch(() => null);
              unitSlugs = (up?.units ?? []).map((u) => u.slug);
              if (unitSlugs.length === 0) return s.stageId; // section ran without a promoted plan → incomplete
            }
            for (const slug of unitSlugs) {
              const row = await store
                .getStage(executionId, planStageInstanceId(namespace, s.stageId, slug))
                .catch(() => null);
              if (!row || (row.state !== 'SUCCEEDED' && row.state !== 'SKIPPED'))
                return `${s.stageId} [unit ${slug}]`;
            }
            continue;
          }
          const row = await store.getStage(executionId, s.stageInstanceId).catch(() => null);
          if (!row || row.state !== 'SUCCEEDED') return s.stageId;
        }
        return null;
      });
      if (upstreamOk) {
        return await fail('rewind_upstream_incomplete', upstreamOk);
      }
      runStages = stages.slice(idx);
    }
    // Per-CLI model selection was snapshotted onto META at create (intents lambda
    // reads the project vertex; the orchestrator is not VPC-attached for Neptune).
    // run-stage applies cliModels[cli] as the authoritative model knob.
    const cliModels = meta.cliModels ?? null;
    // The project's explicitly selected agent CLI; forwarded to run-stage as
    // `requestedCli` so the run uses the chosen CLI (selection depends on which
    // CLI is authed). null = let run-stage pick the first installed CLI.
    const requestedCli = meta.agentCli ?? null;
    // Seconds a parked stage's warm microVM lingers before release (D1).
    const parkReleaseSeconds = meta.parkReleaseSeconds ?? null;

    // Clone inputs so run-stage can self-heal a wiped source checkout (the mount is
    // wiped on every runtime redeploy). Same values init-ws used; forwarded on every
    // run-stage invoke (fresh + resume). The token read is already a durable step;
    // in app mode the dispatch-time freshGitToken override supersedes gitToken.
    const cloneInputs = {
      repos: meta.repos ?? [],
      branch: meta.branch,
      baseBranch: meta.baseBranch,
      gitToken: token,
      gitProvider,
    };

    // ── One stage instance through its park loop (D3) ─────────────────────
    // Parameterized for unit lanes (docs/v2-parallel.md WP4/WP5):
    //   ctxArg       — the durable context to run under (a lane's child
    //                  context, or the root ctx for once-per-workflow stages)
    //   unitSlug     — null = once-per-workflow; set = one lane's instance
    //   sessionId    — the AgentCore session the stage dispatches to (a lane's
    //                  own session, or the intent session)
    //   cloneInputs  — branch inputs (a lane's unit branch, or the intent's)
    //   suffix       — durable-identity suffix for halt-and-ask retry rounds
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
        sessionId: stageSessionId = sessionId,
        cloneInputs: stageCloneInputs = cloneInputs,
        suffix = '',
      } = opts;
      const label = `${unitSlug ? `${stage.stageId}-u-${unitSlug}` : stage.stageId}${suffix}`;
      const stageOpts = {
        stage,
        unitSlug,
        suffix,
        ids: { projectId, intentId, executionId },
        workflowId,
        workflowVersion,
        scope,
        cliModels,
        requestedCli,
        sessionId: stageSessionId,
        cloneInputs: stageCloneInputs,
        freshGitToken,
      };
      let result = await runStage(ctxArg, invokeRuntime, { ...stageOpts, resumeFrom: null });

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

        // Create a durable callback and stamp it on the gate so the answer path
        // can resume THIS execution. Then suspend (zero compute) until answered.
        const [callbackPromise, callbackId] = await ctxArg.createCallback(`await-${humanTaskId}`);
        await ctxArg.step(`bind-callback-${humanTaskId}`, () =>
          store.setGateCallbackId({ executionId, humanTaskId, callbackId }),
        );

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

        result = await runStage(ctxArg, invokeRuntime, { ...stageOpts, resumeFrom: humanTaskId });
      }

      if (result?.state === 'FAILED') return { state: 'FAILED', reason: result?.reason ?? '' };
      return { state: 'SUCCEEDED' };
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
        gitToken: token,
        gitProvider,
      },
      // Dispatch-time token refresh for lane init/merge/conflict dispatches
      // (see freshGitToken above) — called inside durable step bodies only.
      freshGitToken,
      intentSessionId: sessionId,
      maxParallelUnits: meta.maxParallelUnits ?? 0,
      requestedCli,
      cliModels,
      stageInstanceIdFor: (stageId, slug) => planStageInstanceId(namespace, stageId, slug),
    };
    sectionToolkit.runId = runId;

    // ── The plan walk: alternating once-per-workflow segments and parallel
    // sections (docs/v2-parallel.md A2; detection is structural via forEach).
    for (const segment of planSegments(runStages)) {
      if (segment.kind === 'section') {
        const sectionOut = await runParallelSection(segment, sectionToolkit);
        if (sectionOut) return sectionOut;
        continue;
      }
      for (const stage of segment.stages) {
        const outcome = await executeStage(ctx, stage);
        if (outcome.state === 'TERMINAL') return outcome.value;
        if (outcome.state === 'FAILED') {
          const out = await fail('stage_failed', `${stage.stageId}: ${outcome.reason}`);
          return { ...out, stageId: stage.stageId };
        }

        // Unit DAG promotion (docs/v2-parallel.md WP3): the stage that produces
        // `unit-of-work-dependency` just SUCCEEDED — its blocking sensors passed
        // and every question gate it opened was answered. Freeze the approved
        // DAG into the UNITPLAN/UNIT scheduling rows (+ Neptune mirror) via the
        // VPC-attached container (the orchestrator has no Neptune access). A
        // promotion failure fails the run HERE, deterministically — discovering
        // a missing UNITPLAN at fan-out time would be far worse. (The hook only
        // fires for once-per-workflow stages; a per-unit DAG producer would be
        // a pathological workflow the plan validator already rejects for its
        // own section.)
        const producesUnitDag = (stage.outputArtifacts ?? []).some(
          (o) => (o.artifact ?? o) === 'unit-of-work-dependency',
        );
        if (producesUnitDag) {
          const promotion = await ctx.step(`promote-units-${stage.stageId}`, () =>
            invokeRuntime(
              {
                command: 'promote-units',
                projectId,
                intentId,
                executionId,
                stageInstanceId: stage.stageInstanceId ?? null,
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
            `units-promoted-${stage.stageId}`,
            'v2.units.plan_ready',
            `Unit plan ready: ${promotion.unitCount} unit(s), ${promotion.batchCount} wave(s), skeleton ${promotion.walkingSkeleton ?? 'n/a'}`,
          );
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
    // intent branch onto the base branch, via the shared provider layer (the
    // v1 unmerged-branch guard lives inside createPullRequest). PR problems
    // never un-succeed the run — every outcome is a loud timeline event. A
    // token-less project records a skip instead of failing silently.
    const prResults = await ctx.step('open-pr', async () =>
      openIntentPrs({
        openPr,
        store,
        meta,
        executionId,
        // Re-resolve at PR time: an app-mode run that outlived the ~1h
        // installation token must not open PRs with the stale snapshot.
        token: await freshGitToken(),
        gitProvider,
        log: (m) => ctx.logger?.info?.(m, { intentId }),
      }),
    );
    for (let i = 0; i < prResults.length; i++) {
      const r = prResults[i];
      await emitEvent(ctx, `pr-event-${i}`, r.eventType, r.summary);
    }
    return { ok: true, intentId, stages: runStages.length };
  } catch (err) {
    // Any unexpected throw (runtime transport error, store write failure) — record
    // it so the UI shows FAILED + the message rather than the run silently dying
    // at the durable-function boundary (exactly what the createRequire INIT crash
    // did: the run failed with zero user-visible feedback).
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
    suffix = '',
    ids,
    workflowId,
    workflowVersion,
    scope,
    cliModels,
    requestedCli,
    sessionId,
    cloneInputs,
    freshGitToken,
    resumeFrom,
  },
) => {
  // The attempt key names every durable identity for this stage attempt. It
  // carries the unit dimension (docs/v2-parallel.md WP4) and the halt-and-ask
  // round suffix (WP5) so N lanes' instances — and a lane's retry rounds —
  // are distinct callbacks/steps: a collision would make the durable engine
  // memoize one attempt's verdict as another's.
  const attemptKey = `${stage.stageId}${unitSlug ? `-u-${unitSlug}` : ''}${suffix}${
    resumeFrom ? `-resume-${resumeFrom}` : ''
  }`;
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
        workflowId,
        workflowVersion,
        scope,
        ...(cliModels ? { cliModels } : {}),
        ...(requestedCli ? { requestedCli } : {}),
        // repos/branch/baseBranch/gitToken/gitProvider — for source self-heal.
        // The token is re-resolved at dispatch time (inside this step): a
        // GitHub-App installation token from the run-start snapshot would be
        // expired by now on any stage past the first hour.
        ...cloneInputs,
        ...(freshGitToken ? { gitToken: await freshGitToken() } : {}),
        resumeFrom: resumeFrom ?? null,
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

// ── WP6: open the fan-in PR(s) (intent-pr strategy) ─────────────────────────
// One PR per repo from the intent branch onto the base branch. NEVER throws —
// every outcome (opened / already-open / no-changes / guard-conflict / error /
// no-token) becomes a timeline event the caller records. The PR body carries
// the execution id and an HONEST unit summary: lanes that were skipped after
// failure are named, so the reviewer knows what the increment does NOT
// contain (the human explicitly chose to continue without them — the fan-in
// gate is the decision record, the PR body is its mirror).
const openIntentPrs = async ({ openPr, store, meta, executionId, token, gitProvider, log }) => {
  const repos = meta.repos ?? [];
  const branch = meta.branch;
  const strategy = meta.prStrategy ?? 'intent-pr';
  if (repos.length === 0) {
    return [
      { eventType: 'v2.pr.skipped', summary: 'No repositories on this intent — no PR to open' },
    ];
  }
  if (!token) {
    return [
      {
        eventType: 'v2.pr.skipped',
        summary: `No git credentials — open the PR manually from ${branch} onto ${meta.baseBranch ?? 'main'}`,
      },
    ];
  }

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
    try {
      const res = await openPr({
        gitProvider,
        token,
        repoId,
        branch,
        baseBranch: meta.baseBranch ?? 'main',
        title,
        body,
      });
      if (res?.prUrl) {
        results.push({
          eventType: 'v2.pr.opened',
          summary: `${res.existing ? 'PR already open' : 'PR opened'} for ${repoId}: ${res.prUrl}`,
        });
      } else if (res?.skipped) {
        results.push({
          eventType: 'v2.pr.skipped',
          summary: `No PR for ${repoId}: ${res.reason ?? 'no changes between the branches'}`,
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
