import { runCredentialJob } from '../credential-session.js';
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

import { Logger } from '@aws-lambda-powertools/logger';
import { mkdir } from 'node:fs/promises';
import { runOneShotPrompt } from '../cli/one-shot.js';
import {
  loadLibrary,
  loadBlockBody,
  listMergedBlocks,
  listReleaseBlocks,
} from '../block-loader.js';
import { buildExecutionPlan } from '../../shared/v2-execution-plan.js';
import {
  authoredScopeSettings,
  buildGroundingPack,
  COMPOSER_AGENT_ID,
  parseComposeProposal,
  proposalContract,
} from '../../shared/compose-match.js';
import {
  aidlcSettingsFromComposeProposal,
  effectiveAidlcSettingRows,
  scopeAidlcSettings,
} from '../../shared/intent-aidlc-settings.js';
import { resolveCliSelection } from './discussion-assist-start.js';
import { closeGraphSource } from '../mcp/graph-writer.js';
import {
  hasInvokeToken,
  invokeDialectAnnex,
  invokesCheckpointLog,
  neutralizeTokens,
} from '../stage-materializer.js';

const logger = new Logger({
  persistentKeys: { component: 'agentcore', module: 'compose-plan-start' },
});

const CONTEXT_LIMIT = 48 * 1024;
const MAX_REPORT_EXCERPT = 24 * 1024;

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
  const scopeSettings = {};
  for (const scope of scopes) {
    const id = scope.id ?? scope.blockId;
    const { valid, plan } = buildExecutionPlan({ workflow, scope: id, library });
    if (valid && plan) summaries[id] = plan.summary;
    grids[id] = scopeGridFor(workflow, id);
    const authored = authoredScopeSettings(scope);
    if (Object.keys(authored).length > 0) scopeSettings[id] = authored;
  }
  const stages = (workflow.placements ?? [])
    .map((p) => library.stagesById[p.stageId])
    .filter(Boolean);
  return { scopes, summaries, grids, stages, scopeSettings, offeredScopeIds: [...offered] };
};

// The scope whose authored settings a proposal's settings must come from, for
// ALL THREE shapes a proposal can take:
//
//   matched           -> the matched stock scope IS the settings scope;
//   custom + base     -> the explicit base scope the proposal names;
//   custom, no base   -> the scope the selection already runs on.
//
// Resolving this for every mode is the point. Checking it only when an optional
// `baseScope` happened to be present let a matched proposal, and a custom
// proposal that omitted the member, complete with settings the draft write then
// refused — an Apply card that says Applied over values that were silently
// pruned.
const settingsScopeFor = ({ proposal, policyScope = null }) =>
  proposal.mode === 'matched' ? proposal.scope : (proposal.baseScope ?? policyScope ?? null);

const scopeBlockFor = (scopeBlocks, scopeId) =>
  scopeBlocks.find((block) => (block.id ?? block.blockId) === scopeId) ?? null;

// The settings a member may accept are the ones the resolved settings scope
// AUTHORS. Checked against the SCOPE block rather than against the proposal, so
// the answer is the same one the draft write will give.
const unauthoredProposalSettings = ({ proposal, scopeBlocks, settingsScope }) => {
  const proposed = Object.keys(aidlcSettingsFromComposeProposal(proposal));
  if (proposed.length === 0) return [];
  const authored = scopeAidlcSettings(scopeBlockFor(scopeBlocks, settingsScope));
  return proposed.filter((key) => !Object.hasOwn(authored, key));
};

// Validate a parsed proposal through the plan resolver — the ONLY authority.
// Returns { validation, settingsScope, settingsAuthored } (authoritative verdict
// for a runnable proposal, with the scope its settings were checked against and
// that scope's authored defaults) or { error, validation } when the proposal is
// not runnable.
const validateProposal = ({
  proposal,
  workflow,
  library,
  scopeBlocks = [],
  offeredScopeIds,
  policyScope = null,
  // Whether the PINNED CATALOG authors the per-intent settings at all. Gated
  // on the catalog, never on a version string: a release that authors none is
  // never asked for one, so a value a model volunteers there is ignored exactly
  // as the parser contract says — the compose row, the DTO and the outcome of
  // an unpinned, 2.3.3, 2.8.2 or 2.9.0 compose are what they were before the
  // settings existed.
  settingsAware = false,
  strict = false,
}) => {
  const settingsScope = settingsAware ? settingsScopeFor({ proposal, policyScope }) : null;
  const accepted = (validation) =>
    settingsScope
      ? {
          validation,
          settingsScope,
          settingsAuthored: scopeAidlcSettings(scopeBlockFor(scopeBlocks, settingsScope)),
        }
      : { validation, settingsScope };
  const settingsError = () => {
    if (!settingsAware) return null;
    const unauthored = unauthoredProposalSettings({ proposal, scopeBlocks, settingsScope });
    if (!unauthored.length) return null;
    return settingsScope
      ? `proposal settings ${unauthored.join(', ')} are not authored by scope "${settingsScope}"`
      : `proposal settings ${unauthored.join(', ')} have no scope to be authored by — this selection resolves none`;
  };
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
    if (!valid) return { error: 'matched scope does not resolve', validation };
    const unauthored = settingsError();
    return unauthored ? { error: unauthored, validation } : accepted(validation);
  }
  if (settingsAware && proposal.baseScope && !offeredScopeIds.includes(proposal.baseScope)) {
    return { error: `proposal baseScope "${proposal.baseScope}" is not offered by this workflow` };
  }
  const { valid, errors, warnings, plan } = buildExecutionPlan({
    workflow,
    scope: proposal.scope,
    library,
    composedGrid: proposal.grid,
    ...(settingsScope ? { policyScope: settingsScope } : {}),
    strict,
  });
  const validation = { valid, errors, warnings, summary: plan?.summary ?? null };
  if (!valid) return { error: 'proposed grid does not resolve', validation };
  const unauthored = settingsError();
  return unauthored ? { error: unauthored, validation } : accepted(validation);
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

// Two sections of a compose prompt can be large and are only context: the
// composer persona with its knowledge (upstream methodology text; the 2.6.18+
// persona alone is ~46-48 KB) and a report excerpt of up to MAX_REPORT_EXCERPT.
// Everything else is what the model must act on: the engine-command annex, the
// execution-environment note, the mode task, the intent, the grounding (every
// stock scope's run shape and the complete stage catalog) and the output
// contract that demands a grid covering that catalog.
//
// When the whole prompt fits, it is joined in order. When it does not, the
// required sections are kept whole and the two large sections share the space
// they leave, each cut with a marker, so a catalog row is never lost to them.
// Only when the required sections alone exceed the limit is the text before the
// output contract cut at the limit.
//
// From 2.8.2 the persona invokes the upstream engine as `{{INVOKE}} engine …`,
// and it addresses the local harness through `{{HARNESS_DIR}}`. Neither exists
// here, so both tokens are neutralized and the engine-command annex that says
// what to do instead is carried, as in a stage prompt. The execution-environment
// note below rides in the uncut tail for the same reason.
// Ends a cut persona, so the model knows the methodology text above is partial.
export const COMPOSER_PERSONA_TRUNCATED =
  '[Composer persona and knowledge truncated here to fit the prompt budget.]';
// Ends a cut report excerpt, for the same reason.
export const REPORT_EXCERPT_TRUNCATED = '[Report excerpt truncated here to fit the prompt budget.]';

// The upstream composer persona is written for the local AI-DLC harness: it
// runs `detect`/`validate-grid`, writes proposal files, and must STOP when those
// tools are missing. None of them exist in this one-shot, so without this note
// a literal-minded model declares failure (or searches the filesystem) instead
// of proposing. The grounding replaces detection and the repertoire read; the
// plan resolver re-validates every proposal after the answer.
const PLATFORM_ENVIRONMENT = [
  'Execution environment (overrides the procedure above):',
  '- You are running inside the platform composer, not the AI-DLC harness. The harness tools (`aidlc-utility.ts detect`, `aidlc-graph.ts validate-grid`/`compile`) and `<runtime-managed>` paths do not exist here. Do not search for, install, or run them, and do not read or write files.',
  '- The grounding below replaces the Detect and Read-the-repertoire steps: it lists every offered scope with its authoritative compiled run shape, plus the stage catalog.',
  '- The platform replaces the Validate step: after you answer, it re-validates your proposal with the same deterministic resolver and computes the stage and gate summary itself. Do not add a summary.',
  '- The approval gate and any scope write happen in the platform after a human approves. Return only the proposal.',
  '- When no workspace signals are attached, the project type (greenfield/brownfield) is unknown: say so in the rationale and prefer a shape that is correct either way.',
  '- Unavailable harness tools are never a reason to answer with mode "failed". Use "failed" only when neither a stock scope nor a custom grid can be justified from the intent and the grounding.',
].join('\n');

const joinSections = (texts) => texts.join('\n\n');

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
  // Whether the PINNED CATALOG authors the per-intent AI-DLC settings at all.
  // Gating the richer output contract on the catalog — never on a version
  // string — is what keeps the whole compose prompt of an unpinned, 2.3.3,
  // 2.8.2 or 2.9.0 intent byte-identical: a release that authors no setting is
  // asked for none and its prompt is the one it was before.
  settingsAware = false,
}) => {
  const contract = proposalContract({ settingsAware });
  const head = [
    neutralizeTokens(
      persona ||
        'You are the AI-DLC composer agent: you propose workflow projections; you never route, advance, gate, or write workflow state.',
    ),
    knowledge ? neutralizeTokens(knowledge) : null,
  ]
    .filter(Boolean)
    .join('\n\n');
  const report = reportExcerpt
    ? `Report excerpt:\n${String(reportExcerpt).slice(0, MAX_REPORT_EXCERPT)}`
    : null;
  const sections = [
    { text: head, marker: COMPOSER_PERSONA_TRUNCATED },
    // The composer runs ONE-SHOT with no MCP configuration, so the annex it
    // receives is the tool-less form: every answer whose channel is a platform
    // tool is rewritten onto the proposal it returns, and it raises no
    // checkpoint. Appending the raw annex told a promoted fork's composer to
    // call tools its own session does not have.
    hasInvokeToken(persona, knowledge)
      ? {
          text: invokeDialectAnnex({
            toolless: true,
            checkpointLogInvoked: invokesCheckpointLog(persona, knowledge),
          }),
        }
      : null,
    { text: PLATFORM_ENVIRONMENT },
    { text: MODE_TASKS[mode] },
    { text: `Intent:\n${intentPrompt || '(none provided)'}` },
    instructions ? { text: `Requester instructions:\n${instructions}` } : null,
    repoSignals
      ? {
          text: `Workspace signals (advisory — runtime detection is authoritative):\n${JSON.stringify(repoSignals, null, 2)}`,
        }
      : null,
    report ? { text: report, marker: REPORT_EXCERPT_TRUNCATED } : null,
    progressContext ? { text: `Live stage progress:\n${progressContext}` } : null,
    grounding ? { text: String(grounding) } : null,
    { text: contract },
  ].filter(Boolean);
  const whole = joinSections(sections.map(({ text }) => text));
  if (whole.length <= CONTEXT_LIMIT) return whole;

  // Space left for the two bounded sections once every required section and
  // every separator is counted. They split it evenly, and a section that needs
  // less than its half gives the rest to the other.
  const bounded = sections.filter(({ marker }) => marker);
  const fixed = whole.length - bounded.reduce((sum, { text }) => sum + text.length, 0);
  const room = Math.max(0, CONTEXT_LIMIT - fixed);
  const [first, second] = bounded;
  const share = new Map();
  if (second) {
    const half = Math.floor(room / 2);
    const firstShare = Math.max(half, room - second.text.length);
    share.set(first, Math.min(first.text.length, firstShare));
    share.set(second, room - share.get(first));
  } else if (first) {
    share.set(first, room);
  }
  const cut = (section) => {
    const limit = share.get(section);
    if (limit === undefined || section.text.length <= limit) return section.text;
    // A cut section never takes more than its share, even when the share is
    // smaller than its marker: it keeps the marker alone if that fits, and
    // gives way entirely otherwise.
    const keep = limit - section.marker.length - 1;
    if (keep > 0) return `${section.text.slice(0, keep)}\n${section.marker}`;
    return section.marker.length <= limit ? section.marker : '';
  };
  const budgeted = joinSections(sections.map(cut));
  if (budgeted.length <= CONTEXT_LIMIT) return budgeted;
  // The required sections alone do not fit: keep the output contract whole and
  // cut what precedes it at the limit.
  const body = joinSections(sections.slice(0, -1).map(cut)).slice(
    0,
    CONTEXT_LIMIT - contract.length - 2,
  );
  return `${body}\n\n${contract}`;
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
  listReleaseBlocksFn = listReleaseBlocks,
  mkdirFn = mkdir,
  env = process.env,
  busy = null,
  activeJobs = new Map(),
  log = (...args) => logger.error(...args), // TODO: remove this (only used in tests)
}) => {
  const start = async (payload = {}) => {
    const {
      projectId,
      intentId,
      composeId,
      mode = 'front',
      workflowId,
      workflowVersion,
      // Immutable AI-DLC release pinned on the intent (issue #482). Present =>
      // the workflow, library and SCOPE vocabulary the composer is grounded in
      // all come from that closure, so a proposal is validated against the
      // methodology the intent will actually run.
      methodologyRelease = null,
      methodologyPins = null,
      // The per-intent AI-DLC settings this intent already runs with. The
      // composer must see them to propose a VALID change, and seeing them here
      // is what lets the annex forbid it hunting for them on disk.
      aidlcSettings = null,
      // The scope whose own settings the intent currently runs with: its base
      // scope when the selection is a composed grid, its scope otherwise. The
      // effective settings are that scope's values with the recorded overrides
      // on top, so the composer is grounded in what the run WOULD do rather
      // than in the subset a member happened to change.
      policyScope = null,
      prompt = '',
      instructions = '',
      repoSignals = null,
      reportExcerpt = null,
      progressContext = null,
      frozenGrid = null,
      requestedCli: explicitlyRequestedCli = null,
      cliModels: explicitlySelectedModels = null,
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

    const job = runCredentialJob(async () => {
      let g;
      try {
        const { workflow, library } = await loadLibraryFn({
          workflowId,
          workflowVersion,
          ...(methodologyRelease
            ? {
                methodologyRelease,
                ...(methodologyPins ? { methodologyPins } : {}),
              }
            : {}),
        });
        if (!workflow || !library) {
          await finish({
            state: 'FAILED',
            fields: { failureReason: `workflow ${workflowId}@${workflowVersion} not found` },
          });
          return;
        }
        // A pinned intent grounds on its release's SCOPE vocabulary. No .catch
        // here: an unresolvable closure must fail the compose, not silently
        // ground the composer in an empty scope list.
        const scopeBlocks = methodologyRelease
          ? await listReleaseBlocksFn('SCOPE', methodologyRelease, methodologyPins)
          : await listMergedBlocksFn('SCOPE').catch(() => []);
        const { scopes, summaries, grids, stages, scopeSettings, offeredScopeIds } =
          buildScopeGrounding({ workflow, library, scopeBlocks });
        // The per-intent settings exist only for a release that authors at least
        // one of them. Gating the settings grounding AND the richer output
        // contract on the CATALOG — never on a version string — is what keeps
        // the compose prompt of every older pinned release byte-for-byte what
        // it was.
        const settingsAware = scopes.some(
          (scope) => Object.keys(scopeAidlcSettings(scope)).length > 0,
        );
        const settingsScopeBlock =
          scopes.find((scope) => (scope.id ?? scope.blockId) === policyScope) ?? null;
        const grounding = buildGroundingPack({
          scopes,
          summaries,
          grids,
          stages,
          scopeSettings,
          settingsScopeId: settingsAware ? (policyScope ?? null) : null,
          effectiveSettings: settingsAware
            ? effectiveAidlcSettingRows(aidlcSettings, scopeAidlcSettings(settingsScopeBlock))
            : [],
        });

        // Composer persona + methodology knowledge from the block library
        // (fork-shadowing applies — a user's edited composer is honoured).
        const loadBody = methodologyRelease
          ? (block) => loadBlockBodyFn(block, { methodologyRelease })
          : (block) => loadBlockBodyFn(block).catch(() => '');
        const agentBlock = library.agentsById?.[COMPOSER_AGENT_ID] ?? null;
        const persona = agentBlock ? await loadBody(agentBlock) : '';
        const knowledgeBlocks = Object.values(library.knowledgeById ?? {}).filter(
          (k) => k.agentRef === COMPOSER_AGENT_ID,
        );
        const knowledgeBodies = await Promise.all(knowledgeBlocks.map(loadBody));

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
          settingsAware,
        });

        g = await openGraph();
        const inheritedSelection = await resolveCliSelection({
          store,
          g,
          projectId,
          intentId,
        });
        const requestedCli = explicitlyRequestedCli ?? inheritedSelection.requestedCli;
        const cliModels = explicitlySelectedModels ?? inheritedSelection.cliModels;
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
        const {
          validation,
          settingsScope,
          settingsAuthored,
          error: validationError,
        } = validateProposal({
          proposal,
          workflow,
          library,
          scopeBlocks,
          offeredScopeIds,
          policyScope,
          settingsAware,
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
        // The settings scope the proposal was validated against, and that
        // scope's authored defaults, are recorded on the row, so Apply
        // normalises the accepted values against the SAME authored map the
        // validation used instead of re-deriving one from whatever selection
        // the page happens to preview.
        await finish({
          state: 'COMPLETED',
          fields: {
            proposal,
            validation,
            ...(settingsScope ? { settingsScope, settingsAuthored } : {}),
          },
        });
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
    });
    job.catch((err) => log(`job promise rejected unexpectedly (${key}):`, err?.message));

    return { ok: true, accepted: true, composeId, jobKey: key };
  };
  start.activeJobs = activeJobs;
  return start;
};

export {
  CONTEXT_LIMIT as COMPOSE_CONTEXT_LIMIT,
  MAX_REPORT_EXCERPT,
  PLATFORM_ENVIRONMENT,
  buildScopeGrounding,
  settingsScopeFor,
  validateProposal,
  buildComposePrompt,
  scopeGridFor,
};
