// Single source of truth for AgentCore invocation routing and authentication.
// Engine-only commands keep `agentAuth: false` so they remain available during
// credential-store outages. CLI-consuming commands select the binding strategy
// the invocation-scoped auth resolver must use.

export const AGENT_AUTH_MODES = Object.freeze({
  EXECUTION: 'execution',
  CAPABILITIES: 'capabilities',
  COMPOSE: 'compose',
  DISCUSSION: 'discussion',
  VERIFY_CONNECTION: 'verify-connection',
});

// The Gateway grant a dispatch of the command must carry, issued by the Lambda
// that invokes the runtime (see gatewayScopeForCommand). `execution` covers
// engine commands that read or write the execution's process data; `none` is
// for commands that touch no execution data. Discussion grants are issued by
// the discussions Lambda itself.
export const GRANT_SCOPES = Object.freeze({
  STAGE: 'stage',
  CONFLICT: 'conflict',
  DISCUSSION: 'discussion',
  EXECUTION: 'execution',
  NONE: 'none',
});
const GRANT_SCOPE_VALUES = new Set(Object.values(GRANT_SCOPES));

const command = (handler, grantScope, agentAuth = false) => {
  if (!GRANT_SCOPE_VALUES.has(grantScope)) {
    throw new TypeError(`Command ${handler} declares no valid grant scope`);
  }
  return Object.freeze({ handler, agentAuth, grantScope });
};

export const COMMANDS = Object.freeze({
  'init-ws': command('initWs', GRANT_SCOPES.EXECUTION),
  'run-stage': command('runStage', GRANT_SCOPES.STAGE, AGENT_AUTH_MODES.EXECUTION),
  'run-stage-start': command('runStageStart', GRANT_SCOPES.STAGE, AGENT_AUTH_MODES.EXECUTION),
  'promote-units': command('promoteUnits', GRANT_SCOPES.EXECUTION),
  'derive-artifacts': command(
    'deriveArtifacts',
    GRANT_SCOPES.EXECUTION,
    AGENT_AUTH_MODES.EXECUTION,
  ),
  'create-workflow-checkpoint': command('createWorkflowCheckpoint', GRANT_SCOPES.EXECUTION),
  'record-pr': command('recordPr', GRANT_SCOPES.EXECUTION),
  'record-learning': command('recordLearning', GRANT_SCOPES.EXECUTION),
  'record-unit-pr': command('recordUnitPr', GRANT_SCOPES.EXECUTION),
  'init-lane': command('initLane', GRANT_SCOPES.EXECUTION),
  'merge-lane': command('mergeLane', GRANT_SCOPES.EXECUTION),
  'reconcile-lane': command('reconcileLane', GRANT_SCOPES.EXECUTION),
  'refresh-intent': command('refreshIntent', GRANT_SCOPES.NONE),
  'resolve-conflict': command('resolveConflict', GRANT_SCOPES.CONFLICT, AGENT_AUTH_MODES.EXECUTION),
  'discussion-assist-start': command(
    'discussionAssistStart',
    GRANT_SCOPES.DISCUSSION,
    AGENT_AUTH_MODES.DISCUSSION,
  ),
  'compose-plan-start': command(
    'composePlanStart',
    GRANT_SCOPES.EXECUTION,
    AGENT_AUTH_MODES.COMPOSE,
  ),
  'quorum-edit-plan-start': command(
    'quorumEditPlanStart',
    GRANT_SCOPES.EXECUTION,
    AGENT_AUTH_MODES.EXECUTION,
  ),
  'quorum-edit-apply-start': command(
    'quorumEditApplyStart',
    GRANT_SCOPES.EXECUTION,
    AGENT_AUTH_MODES.EXECUTION,
  ),
  'repair-structure': command(
    'repairStructure',
    GRANT_SCOPES.EXECUTION,
    AGENT_AUTH_MODES.EXECUTION,
  ),
  inspect: command('inspect', GRANT_SCOPES.EXECUTION),
  capabilities: command('capabilities', GRANT_SCOPES.NONE, AGENT_AUTH_MODES.CAPABILITIES),
  'managed-runtime-check': command('managedRuntimeCheck', GRANT_SCOPES.NONE),
  'verify-mcp': command('verifyMcp', GRANT_SCOPES.NONE),
  'verify-connection': command(
    'verifyConnection',
    GRANT_SCOPES.NONE,
    AGENT_AUTH_MODES.VERIFY_CONNECTION,
  ),
});

export const commandDefinition = (name) =>
  typeof name === 'string' && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
