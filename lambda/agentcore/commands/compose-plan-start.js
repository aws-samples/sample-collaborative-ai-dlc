// compose-plan-start — async composer proposals (Adaptive Workflows).
//
// The intents lambda creates a PENDING COMPOSE row and invokes this command
// (accept-then-background, the discussion-assist pattern). The job grounds
// the composer agent in the pinned workflow's REAL compiled numbers (per-
// scope run shapes from the pure plan resolver — never prose claims), runs
// one bounded CLI prompt, parses the strict JSON proposal, RE-VALIDATES it
// through the same plan resolver, and writes the outcome to the COMPOSE row.
//
// Invariant ("LLM proposes, engine disposes"): this job never touches the
// intent's scope/composedGrid — the proposal is data on the COMPOSE row, and
// applying it is a separate human action through the DRAFT PATCH / recompose
// endpoints, which validate again. A degraded compose (CLI failure,
// unparseable output, a grid the resolver rejects) FAILS the row with the
// structured reason; an unrunnable grid is never presented as a proposal.

import { mkdir } from 'node:fs/promises';
import { runOneShotPrompt } from '../cli/one-shot.js';
import { loadLibrary, loadBlockBody, listMergedBlocks } from '../block-loader.js';
import { buildExecutionPlan } from '../../shared/v2-execution-plan.js';
import {
  buildGroundingPack,
  parseComposeProposal,
  PROPOSAL_CONTRACT,
} from '../../shared/compose-match.js';
import { resolveCliSelection } from './discussion-assist-start.js';
import { closeGraphSource } from '../mcp/graph-writer.js';

const CONTEXT_LIMIT = 48 * 1024;
const MAX_REPORT_EXCERPT = 24 * 1024;
const COMPOSER_AGENT_ID = 'aidlc-composer-agent';

const jobKey = (p) => `${p.intentId}:${p.composeId}`;

const composeWorkspaceFor = (intentId) =>
  `/tmp/compose/${String(intentId).replace(/[^A-Za-z0-9._-]/g, '_')}`;

// Project a named scope's grid off the placements (the same rule the resolver
// uses): EXECUTE where the membership says so, SKIP elsewhere.
const scopeGridFor = (workflow, scopeId) => {
  const grid = {};
  for (const p of workflow.placements ?? []) {
    grid[p.stageId] = p.scopeMembership?.[scopeId] === 'EXECUTE' ? 'EXECUTE' : 'SKIP';
  }
  return grid;
};

// The deterministic grounding: every stock scope's authoritative run shape.
const buildScopeGrounding = ({ workflow, library, scopeBlocks }) => {
  const offered = new Set(
    (workflow.scopeRefs ?? []).map((r) => r.scopeId).filter(Boolean).length
      ? (workflow.scopeRefs ?? []).map((r) => r.scopeId)
      : (workflow.placements ?? []).flatMap((p) => Object.keys(p.scopeMembership ?? {})),
  );
  const scopes = scopeBlocks.filter((s) => offered.has(s.id ?? s.blockId));
  const summaries = {};
  const grids = {};
  for (const scope of scopes) {
    const id = scope.id ?? scope.blockId;
    const { valid, plan } = buildExecutionPlan({ workflow, scope: id, library });
    if (valid && plan) summaries[id] = plan.summary;
    grids[id] = scopeGridFor(workflow, id);
  }
  const stages = (workflow.placements ?? [])
    .map((p) => library.stagesById[p.stageId])
    .filter(Boolean);
  return { scopes, summaries, grids, stages, offeredScopeIds: [...offered] };
};

// Validate a parsed proposal through the plan resolver — the ONLY authority.
// Returns { validation } (authoritative verdict for a runnable proposal) or
// { error, validation } when the proposal is not runnable.
const validateProposal = ({ proposal, workflow, library, offeredScopeIds, strict = false }) => {
  if (proposal.mode === 'matched') {
    if (!offeredScopeIds.includes(proposal.scope)) {
      return { error: `matched scope "${proposal.scope}" is not offered by this workflow` };
    }
    const { valid, errors, warnings, plan } = buildExecutionPlan({
      workflow,
      scope: proposal.scope,
      library,
    });
    const validation = { valid, errors, warnings, summary: plan?.summary ?? null };
    return valid ? { validation } : { error: 'matched scope does not resolve', validation };
  }
  const { valid, errors, warnings, plan } = buildExecutionPlan({
    workflow,
    scope: proposal.scope,
    library,
    composedGrid: proposal.grid,
    strict,
  });
  const validation = { valid, errors, warnings, summary: plan?.summary ?? null };
  return valid ? { validation } : { error: 'proposed grid does not resolve', validation };
};

const MODE_TASKS = {
  front: [
    'Task: propose the workflow projection that fits this intent.',
    'Prefer a stock scope (mode "matched") when one genuinely fits; compose a custom grid only when no stock shape does.',
  ].join('\n'),
  report: [
    'Task: an external analysis report is attached. Triage its findings, then propose the most COMPACT projection that fixes what the report surfaces and ships the fix.',
    'Prefer a stock scope (e.g. a bugfix-shaped one) when it fits; compose a custom grid only when no stock shape does.',
    'In `rationale`, lead with a short triage summary: which findings are auto-fixable in this run and which need a human decision.',
  ].join('\n'),
  inflight: [
    'Task: a workflow is ALREADY RUNNING — its live stage progress is attached. Propose EXECUTE/SKIP flips for PENDING, ahead-of-cursor stages only.',
    'Completed, in-progress and already-skipped stages are frozen: your grid must keep them exactly as the progress shows.',
    'Never flip a stage whose required inputs a proposed SKIP would starve.',
  ].join('\n'),
};

const buildComposePrompt = ({
  mode,
  persona,
  knowledge,
  grounding,
  intentPrompt,
  instructions,
  repoSignals,
  reportExcerpt,
  progressContext,
}) => {
  const parts = [];
  const push = (t) => {
    if (t && parts.join('\n').length < CONTEXT_LIMIT) parts.push(String(t));
  };
  push(
    persona ||
      'You are the AI-DLC composer agent: you propose workflow projections; you never route, advance, gate, or write workflow state.',
  );
  push(knowledge);
  push(MODE_TASKS[mode]);
  push(`Intent:\n${intentPrompt || '(none provided)'}`);
  if (instructions) push(`Requester instructions:\n${instructions}`);
  if (repoSignals)
    push(
      `Workspace signals (advisory — runtime detection is authoritative):\n${JSON.stringify(repoSignals, null, 2)}`,
    );
  if (reportExcerpt) push(`Report excerpt:\n${String(reportExcerpt).slice(0, MAX_REPORT_EXCERPT)}`);
  if (progressContext) push(`Live stage progress:\n${progressContext}`);
  push(grounding);
  push(PROPOSAL_CONTRACT);
  return parts.join('\n\n').slice(0, CONTEXT_LIMIT);
};

export const createComposePlanStart = ({
  openGraph,
  store,
  broadcast = async () => {},
  availableClis = [],
  oneShot = runOneShotPrompt,
  loadLibraryFn = loadLibrary,
  loadBlockBodyFn = loadBlockBody,
  listMergedBlocksFn = listMergedBlocks,
  mkdirFn = mkdir,
  env = process.env,
  busy = null,
  activeJobs = new Map(),
  log = (...args) => console.error('[compose-plan-start]', ...args),
}) => {
  const start = async (payload = {}) => {
    const {
      projectId,
      intentId,
      composeId,
      mode = 'front',
      workflowId,
      workflowVersion,
      prompt = '',
      instructions = '',
      repoSignals = null,
      reportExcerpt = null,
      progressContext = null,
      frozenGrid = null,
    } = payload;
    if (!projectId || !intentId || !composeId || !workflowId || !workflowVersion) {
      return { ok: false, reason: 'missing_compose_identity' };
    }
    if (!MODE_TASKS[mode]) {
      return { ok: false, reason: 'invalid_compose_mode' };
    }
    const key = jobKey(payload);
    if (activeJobs.has(key)) {
      return { ok: true, accepted: true, alreadyRunning: true, composeId };
    }
    activeJobs.set(key, { startedAt: Date.now() });
    busy?.enter();

    // Terminalize the row + tell the intent channel. FAILED writes the
    // structured reason; COMPLETED writes proposal + authoritative validation.
    const finish = async ({ state, fields }) => {
      const row = await store.updateCompose({
        executionId: intentId,
        composeId,
        state,
        fromStates: ['PENDING'],
        fields,
      });
      if (row) {
        await broadcast({ action: 'compose.updated', intentId, compose: row }).catch?.(() => {});
        await store
          .appendEvent({
            executionId: intentId,
            type: state === 'COMPLETED' ? 'v2.compose.completed' : 'v2.compose.failed',
            actor: 'composer',
            summary:
              state === 'COMPLETED'
                ? `Composer proposed ${fields.proposal?.mode === 'matched' ? `scope "${fields.proposal.scope}"` : `a custom grid ("${fields.proposal?.scope}")`}`
                : `Compose failed: ${fields.failureReason ?? 'unknown'}`,
          })
          .catch(() => {});
      }
      return row;
    };

    const job = (async () => {
      let g;
      try {
        const { workflow, library } = await loadLibraryFn({ workflowId, workflowVersion });
        if (!workflow || !library) {
          await finish({
            state: 'FAILED',
            fields: { failureReason: `workflow ${workflowId}@${workflowVersion} not found` },
          });
          return;
        }
        const scopeBlocks = await listMergedBlocksFn('SCOPE').catch(() => []);
        const { scopes, summaries, grids, stages, offeredScopeIds } = buildScopeGrounding({
          workflow,
          library,
          scopeBlocks,
        });
        const grounding = buildGroundingPack({ scopes, summaries, grids, stages });

        // Composer persona + methodology knowledge from the block library
        // (fork-shadowing applies — a user's edited composer is honoured).
        const agentBlock = library.agentsById?.[COMPOSER_AGENT_ID] ?? null;
        const persona = agentBlock ? await loadBlockBodyFn(agentBlock).catch(() => '') : '';
        const knowledgeBlocks = Object.values(library.knowledgeById ?? {}).filter(
          (k) => k.agentRef === COMPOSER_AGENT_ID,
        );
        const knowledgeBodies = await Promise.all(
          knowledgeBlocks.map((k) => loadBlockBodyFn(k).catch(() => '')),
        );

        const fullPrompt = buildComposePrompt({
          mode,
          persona,
          knowledge: knowledgeBodies.filter(Boolean).join('\n\n'),
          grounding,
          intentPrompt: prompt,
          instructions,
          repoSignals,
          reportExcerpt,
          progressContext,
        });

        g = await openGraph();
        const { requestedCli, cliModels } = await resolveCliSelection({
          store,
          g,
          projectId,
          intentId,
        });
        // The throwaway working directory MUST exist before the spawn — Node
        // fires the child's 'error' event on a missing cwd, which surfaces as
        // an instant cli_failed with no output (field incident: every compose
        // failed in <500ms because nothing had created /tmp/compose/<id>).
        const cwd = composeWorkspaceFor(intentId);
        await mkdirFn(cwd, { recursive: true });
        const out = await oneShot({
          prompt: fullPrompt,
          requestedCli,
          cliModels,
          availableClis,
          env,
          cwd,
        });
        if (out.metrics) {
          await store
            .recordMetric({
              executionId: intentId,
              stageInstanceId: null,
              metrics: { ...out.metrics, composeCalls: 1 },
              resolvedModel: out.model ?? null,
            })
            .catch(() => {});
        }
        if (!out.ok) {
          // Carry the one-shot's diagnostics onto the row: the reason alone
          // ("cli_failed") is undebuggable — the exit code and the captured
          // output sample say WHY.
          const detail = [
            out.cli ? `cli=${out.cli}` : null,
            out.exitCode != null ? `exit=${out.exitCode}` : null,
            out.sample ? `output: ${String(out.sample).slice(0, 600)}` : null,
          ]
            .filter(Boolean)
            .join(' — ');
          log(
            `one-shot failed (${key}): ${out.reason ?? 'unknown'}${detail ? ` — ${detail}` : ''}`,
          );
          await finish({
            state: 'FAILED',
            fields: {
              failureReason: `composer CLI failed: ${out.reason ?? 'unknown'}${
                detail ? ` (${detail})` : ''
              }`,
            },
          });
          return;
        }
        const { proposal, error: parseError } = parseComposeProposal(out.text);
        if (parseError) {
          await finish({ state: 'FAILED', fields: { failureReason: parseError } });
          return;
        }
        // In-flight recompose: frozen stages (completed / in-progress /
        // already-skipped, supplied by the dispatcher) must survive verbatim —
        // enforce here so a hallucinated flip of the past can never validate.
        if (frozenGrid && proposal.grid) {
          for (const [stageId, value] of Object.entries(frozenGrid)) {
            if (proposal.grid[stageId] !== undefined && proposal.grid[stageId] !== value) {
              await finish({
                state: 'FAILED',
                fields: {
                  failureReason: `proposal flips frozen stage "${stageId}" (${value} → ${proposal.grid[stageId]})`,
                },
              });
              return;
            }
            proposal.grid[stageId] = value;
          }
        }
        const { validation, error: validationError } = validateProposal({
          proposal,
          workflow,
          library,
          offeredScopeIds,
          strict: mode === 'inflight',
        });
        if (validationError) {
          await finish({
            state: 'FAILED',
            fields: {
              failureReason: validationError,
              ...(validation ? { validation } : {}),
            },
          });
          return;
        }
        await finish({ state: 'COMPLETED', fields: { proposal, validation } });
      } catch (err) {
        log(`job failed (${key}):`, err?.message ?? err);
        await finish({
          state: 'FAILED',
          fields: { failureReason: err?.message ?? 'compose job crashed' },
        }).catch(() => {});
      } finally {
        await closeGraphSource(g);
        activeJobs.delete(key);
        busy?.leave();
      }
    })();
    job.catch((err) => log(`job promise rejected unexpectedly (${key}):`, err?.message));

    return { ok: true, accepted: true, composeId, jobKey: key };
  };
  start.activeJobs = activeJobs;
  return start;
};

export { buildScopeGrounding, validateProposal, buildComposePrompt, scopeGridFor };
