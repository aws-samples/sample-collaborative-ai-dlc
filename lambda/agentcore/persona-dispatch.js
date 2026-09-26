// persona-dispatch — spawn ONE persona's CLI session (author or reviewer MCP
// role) and run it to completion.
//
// Shared by run-stage.js's `runReviewer` and ensemble personas. It owns the
// common CLI-dispatch mechanics — driver and model resolution, per-CLI MCP
// materialization, invocation, and the child run — behind a role-generic
// surface so callers do not re-derive that behavior.
//
// Persona views stay separate because dispatchPersona never reaches into
// stage/library internals to build a prompt. The caller owns `brief`
// completely; the only OTHER inputs that can reach the rendered prompt are
// `persona` and `knowledge`, appended via the fixed tail in
// `composePersonaPrompt` — the same tail run-stage.js's `buildReviewerPrompt`
// has always rendered for the reviewer, now shared so every future persona
// role gets it for free instead of re-deriving it.
//
// MCP role: 'reviewer' gets the read-only reviewer role plus the trusted
// `reviewerAgent` identity the MCP bridge validates `submit_review` against
// (mcp/process-bridge.js). Every other role (support/lead/link/integrator, …)
// gets 'author' — the same MCP role the single-session ensemble prompt
// already grants today.

import { getDriver } from './cli/drivers.js';
import { runChild } from './cli/spawn.js';
import { withOpenCodeStore as defaultWithOpenCodeStore } from './cli/opencode-store.js';
import { resolveStageModel } from './model-resolver.js';
import { neutralizeTokens } from './stage-materializer.js';

// Package-manager caches use container-local /tmp; the working tree stays on the
// session mount so cache growth cannot consume space needed for durable changes.
export const OFF_MOUNT_CACHE_ENV = {
  npm_config_cache: '/tmp/aidlc-cache/npm',
  YARN_CACHE_FOLDER: '/tmp/aidlc-cache/yarn',
  PNPM_HOME: '/tmp/aidlc-cache/pnpm',
  PIP_CACHE_DIR: '/tmp/aidlc-cache/pip',
  UV_CACHE_DIR: '/tmp/aidlc-cache/uv',
  TMPDIR: '/tmp',
};

// The MCP role a dispatched persona session runs under. Only 'reviewer' is
// read-only (submit_review, no artifact writes); every other persona role —
// today just 'support', later 'lead' | 'integrator' | 'link' — is an author
// session with the same write surface the single-session ensemble prompt
// already grants.
const mcpRoleFor = (role) => (role === 'reviewer' ? 'reviewer' : 'author');

const roleLabel = (role) => role.charAt(0).toUpperCase() + role.slice(1);

// The ONLY place `persona` / `knowledge` reach the rendered prompt: a fixed
// tail appended after the caller's `brief`. `buildReviewerPrompt`
// (run-stage.js) renders this EXACT tail for the reviewer today — kept here,
// shared, so it is byte-identical and every future persona role renders it
// the same way instead of re-deriving it.
export const composePersonaPrompt = ({ brief, persona, knowledge, role }) =>
  [
    brief,
    '',
    `## ${roleLabel(role)} role`,
    neutralizeTokens(persona) || `(no ${role} persona supplied)`,
    knowledge ? `\n## Reference knowledge\n${neutralizeTokens(knowledge)}` : '',
  ].join('\n');

// Spawn one persona's headless CLI session and run it to completion.
//
// `brief` is the ONLY stage/library context this persona receives — the
// blindness seam described above.
//
// Returns `{ ok, detail }` rather than throwing on a session
// failure — `store`/`publish` bookkeeping (running/failed events, verdict or
// contribution rows) stays with the caller, which decides what a failure
// means for ITS role (today: the reviewer's INCONCLUSIVE row; later streams:
// the retry-once-then-GAP policy). dispatchPersona itself never writes a
// receipt/contribution/verdict row.
export const dispatchPersona = async ({
  role,
  agentBlock = null,
  persona,
  knowledge,
  brief,
  personaScope = {},
  cli,
  cliModels,
  tierModels,
  env,
  workspaceDir,
  spawnFn,
  mcpEntry,
  materializeMcpConfig,
  materializeKiroAgent,
  materializeOpenCodeConfig,
  materializeCodexHome,
  cleanupCodexHome,
  withOpenCodeStore = defaultWithOpenCodeStore,
  executionId,
  projectId,
  intentId,
  stageId,
  stageInstanceId,
  stageAttempt,
  unitSlug,
  sectionIndex,
  ids,
  timeoutMs = 0,
}) => {
  const mcpRole = mcpRoleFor(role);
  const { agentRef, policy = null, checkpointOwner = true, canAsk = true } = personaScope ?? {};
  try {
    const driver = getDriver(cli);
    const model = resolveStageModel({ cliModels, tierModels, agentBlock, cli, env });
    const scope = {
      executionId,
      intentId,
      projectId,
      stageId,
      stageInstanceId,
      stageAttempt,
      unitSlug,
      sectionIndex,
      role: mcpRole,
      // Trusted reviewer identity: the bridge stamps THIS name on the verdict
      // row (sensorId `reviewer:<name>`), never the agent's self-report — a
      // hallucinated or omitted name can no longer detach the verdict from
      // the round that ran.
      ...(mcpRole === 'reviewer' ? { reviewerAgent: agentRef } : {}),
      // The author-side twin of `reviewerAgent`: the trusted identity of the
      // persona whose session this is. graph-writer pins a `contribution`'s
      // collaborator to it, so one support can no longer write another's
      // contribution — the identity stops being agent-asserted.
      ...(mcpRole === 'author' ? { agentRef } : {}),
      policy,
      checkpointOwner,
      ...(canAsk === false ? { canAsk: false } : {}),
      model,
    };
    const prompt = composePersonaPrompt({ brief, persona, knowledge, role });
    const mcpKwargs =
      cli === 'kiro'
        ? {
            agentName: await materializeKiroAgent({ workspaceDir, mcpEntry, scope, env }),
          }
        : cli === 'opencode'
          ? {
              opencodeConfigContent: await materializeOpenCodeConfig({
                workspaceDir,
                mcpEntry,
                scope,
                env,
                maxTurns: agentBlock?.maxTurns ?? null,
              }),
            }
          : cli === 'codex'
            ? {
                codexHome: await materializeCodexHome({ workspaceDir, mcpEntry, scope, env }),
              }
            : {
                mcpConfigPath: await materializeMcpConfig({ workspaceDir, mcpEntry, scope, env }),
              };
    const invocation = driver.buildInvocation({
      prompt,
      model,
      allowedTools: [],
      sessionId: cli === 'claude' ? ids() : null,
      ...mcpKwargs,
    });
    const execute = () =>
      runChild({
        command: invocation.command,
        args: invocation.args,
        env: { ...OFF_MOUNT_CACHE_ENV, ...invocation.env, ...driver.envForAuth(env) },
        cwd: workspaceDir,
        prompt,
        promptViaStdin: invocation.promptViaStdin,
        timeoutMs,
        spawnFn,
      });
    let childResult;
    try {
      if (cli === 'opencode') {
        childResult = await withOpenCodeStore({ env, operation: execute });
      } else {
        childResult = await execute();
      }
    } finally {
      if (cli === 'codex') {
        await cleanupCodexHome({ codexHome: mcpKwargs.codexHome, env }).catch(() => false);
      }
    }
    if (childResult?.exitCode !== 0) {
      return {
        ok: false,
        detail: {
          cli,
          model,
          mcpRole,
          exitCode: childResult?.exitCode ?? null,
          ...(childResult?.timedOut ? { timedOut: true } : {}),
          ...(childResult?.stderrTail ? { stderrTail: childResult.stderrTail } : {}),
        },
      };
    }
    return { ok: true, detail: { cli, model, mcpRole } };
  } catch (error) {
    return { ok: false, detail: error };
  }
};
