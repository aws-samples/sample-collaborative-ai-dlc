// V2 orchestrator — the durable function that drives one intent end to end.
//
// Triggered (async Invoke) by lambda/intents on Start. It runs the intent's
// stages as a SEQUENTIAL durable execution: init-ws once, then each stage's
// run-stage in `plan.order`, parking on human gates via durable callbacks. The
// AWS Durable Execution SDK checkpoints each step (so a replay never re-invokes
// a completed run-stage) and suspends at `createCallback` at zero compute until
// the gate is answered (lambda/intents sends SendDurableExecutionCallbackSuccess).
//
// REPLAY DISCIPLINE: every side effect (agent invokes, all store writes, the
// git-token read) MUST be inside ctx.step(...) or it re-executes on replay.

import { createRequire } from 'node:module';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const require = createRequire(import.meta.url);
const { createProcessStore } = require('../shared/v2-process-store.js');
const { loadExecutionPlan } = require('../shared/v2-workflow-plan.js');
const { getGitConnection } = require('../shared/git-connection-store.js');
const { resolveGitToken } = require('../shared/git-token.js');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const agentcore = new BedrockAgentCoreClient({});
const store = createProcessStore({ ddb });

const RUNTIME_ARN = () => process.env.AGENTCORE_RUNTIME_ARN;
const BLOCKS_TABLE = () => process.env.BLOCKS_TABLE;

// AgentCore requires a session id >= 33 chars; reuse ONE per intent so the
// checkout stays warm across init-ws + every run-stage (matches scripts/phaseb.sh).
const sessionIdFor = (intentId) => `aidlc-intent-${intentId}`.padEnd(33, '0');

// One AgentCore /invocations call. Returns the parsed JSON body the command
// handler returned (init-ws / run-stage). Throws on a non-2xx transport.
const invokeRuntime = async (payload, sessionId) => {
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

// Resolve the git token for the intent's run (from the starter's connection).
const resolveToken = async ({ startedBy, gitProvider }) => {
  if (!startedBy || !gitProvider) return '';
  try {
    const item = await getGitConnection(ddb, startedBy, gitProvider);
    if (!item?.parameterName) return '';
    return (await resolveGitToken(ssm, item)) || '';
  } catch {
    return '';
  }
};

// The orchestrator's collaborators, injectable for tests. Defaults bind the real
// store / plan loader / runtime invoke / git-token resolver.
const defaultDeps = () => ({
  store,
  loadPlan: (args) => loadExecutionPlan({ ddb, tableName: BLOCKS_TABLE(), ...args }),
  invokeRuntime,
  resolveToken,
  stopSession: stopRuntimeSession,
});

const handler = async (event, ctx, deps = defaultDeps()) => {
  const { store, loadPlan, invokeRuntime, resolveToken, stopSession } = deps;
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

  // init-ws — clone repos, create the Neptune Intent anchor, seed RUNNING state.
  // Idempotent in the runtime (ConditionalCheckFailed → already initialized), so
  // a replay of this step is safe.
  const token = await ctx.step('git-token', () =>
    resolveToken({ startedBy: meta.startedBy, gitProvider }),
  );
  const sessionId = sessionIdFor(intentId);
  await ctx.step('init-ws', () =>
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

  await ctx.step('mark-running', () =>
    store.updateExecution({
      executionId,
      projectId,
      status: 'RUNNING',
      fromStatus: 'CREATED',
      startedAt: meta.startedAt,
    }),
  );

  // Resolve the ordered stage list once (pure read of pinned block metadata).
  const planResult = await ctx.step('load-plan', () =>
    loadPlan({ workflowId, workflowVersion, scope }),
  );
  if (!planResult.valid || !planResult.plan) {
    await ctx.step('finish-plan-invalid', () =>
      store.updateExecution({
        executionId,
        projectId,
        status: 'FAILED',
        startedAt: meta.startedAt,
        completedAt: nowIso(),
      }),
    );
    return { ok: false, reason: 'plan_invalid', errors: planResult.errors };
  }

  const stages = planResult.plan.stages;
  // Per-CLI model selection was snapshotted onto META at create (intents lambda
  // reads the project vertex; the orchestrator is not VPC-attached for Neptune).
  // run-stage applies cliModels[cli] as the authoritative model knob.
  const cliModels = meta.cliModels ?? null;
  // Seconds a parked stage's warm microVM lingers before release (D1).
  const parkReleaseSeconds = meta.parkReleaseSeconds ?? null;

  for (const stage of stages) {
    let result = await runStage(ctx, invokeRuntime, {
      stage,
      ids: { projectId, intentId, executionId },
      workflowId,
      workflowVersion,
      scope,
      cliModels,
      sessionId,
      resumeFrom: null,
    });

    // Park loop (D3): the stage may open more than one gate across resumes. Each
    // WAITING_FOR_HUMAN suspends on a durable callback until the gate is answered.
    while (result?.state === 'WAITING_FOR_HUMAN') {
      const fresh = await ctx.step(`gate-${stage.stageId}-${result.humanTaskId ?? 'pending'}`, () =>
        store.getExecution(executionId),
      );
      const humanTaskId = fresh?.pendingHumanTaskId ?? result.humanTaskId;
      if (!humanTaskId) return { ok: false, reason: 'parked_without_gate' };

      // Create a durable callback and stamp it on the gate so the answer path
      // can resume THIS execution. Then suspend (zero compute) until answered.
      const [callbackPromise, callbackId] = await ctx.createCallback(`await-${humanTaskId}`);
      await ctx.step(`bind-callback-${humanTaskId}`, () =>
        store.setGateCallbackId({ executionId, humanTaskId, callbackId }),
      );

      // D1 release-on-park: if no human answers within parkReleaseSeconds, free
      // the warm microVM compute (StopRuntimeSession) while we keep waiting.
      // Resume re-mounts the persistent session storage, so the parked CLI
      // conversation is not lost. parkReleaseSeconds <= 0 stops immediately;
      // null skips release (wait on the callback alone).
      if (Number.isFinite(parkReleaseSeconds) && parkReleaseSeconds >= 0) {
        // Race the human answer (callbackPromise) against the release deadline
        // (a durable wait). Both are DurablePromises so race is replay-safe. The
        // wait resolves to void; if the callback hasn't resolved by then the gate
        // is still pending — re-read to disambiguate the winner deterministically.
        await ctx.promise.race(`park-${humanTaskId}`, [
          callbackPromise,
          ctx.wait(`release-timer-${humanTaskId}`, { seconds: parkReleaseSeconds }),
        ]);
        const stillPending = await ctx.step(`gate-status-${humanTaskId}`, async () => {
          const gate = await store.getHumanTask(executionId, humanTaskId);
          return gate?.status === 'pending';
        });
        if (stillPending) {
          await ctx.step(`release-${humanTaskId}`, () => stopSession(sessionId));
          await callbackPromise; // keep waiting; resume re-mounts persistent storage
        }
      } else {
        await callbackPromise; // resolved by SendDurableExecutionCallbackSuccess
      }

      result = await runStage(ctx, invokeRuntime, {
        stage,
        ids: { projectId, intentId, executionId },
        workflowId,
        workflowVersion,
        scope,
        cliModels,
        sessionId,
        resumeFrom: humanTaskId,
      });
    }

    if (result?.state === 'FAILED') {
      await ctx.step(`finish-failed-${stage.stageId}`, () =>
        store.updateExecution({
          executionId,
          projectId,
          status: 'FAILED',
          startedAt: meta.startedAt,
          completedAt: nowIso(),
        }),
      );
      return { ok: false, reason: 'stage_failed', stageId: stage.stageId, detail: result?.reason };
    }
  }

  await ctx.step('finish-succeeded', () =>
    store.updateExecution({
      executionId,
      projectId,
      status: 'SUCCEEDED',
      startedAt: meta.startedAt,
      completedAt: nowIso(),
    }),
  );
  return { ok: true, intentId, stages: stages.length };
};

// One run-stage invoke, wrapped as a durable step keyed by stage + mode so a
// replay reuses the result rather than re-invoking the agent.
const runStage = (
  ctx,
  invokeRuntime,
  { stage, ids, workflowId, workflowVersion, scope, cliModels, sessionId, resumeFrom },
) =>
  ctx.step(`run-${stage.stageId}${resumeFrom ? `-resume-${resumeFrom}` : ''}`, () =>
    invokeRuntime(
      {
        command: 'run-stage',
        ...ids,
        stageId: stage.stageId,
        workflowId,
        workflowVersion,
        scope,
        ...(cliModels ? { cliModels } : {}),
        resumeFrom: resumeFrom ?? null,
      },
      sessionId,
    ),
  );

const nowIso = () => new Date().toISOString();

export const lambdaHandler = withDurableExecution(handler);
// Exported for unit tests that drive the control flow with a fake DurableContext.
export const __durableHandler = handler;
