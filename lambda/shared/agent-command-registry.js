// Single source of truth for AgentCore invocation routing and authentication.
// Engine-only commands keep `agentAuth: false` so they remain available during
// credential-store outages. CLI-consuming commands select the binding strategy
// the invocation-scoped auth resolver must use.

export const AGENT_AUTH_MODES = Object.freeze({
  EXECUTION: 'execution',
  CAPABILITIES: 'capabilities',
  COMPOSE: 'compose',
  DISCUSSION: 'discussion',
});

const command = (handler, agentAuth = false) => Object.freeze({ handler, agentAuth });

export const COMMANDS = Object.freeze({
  'init-ws': command('initWs'),
  'run-stage': command('runStage', AGENT_AUTH_MODES.EXECUTION),
  'run-stage-start': command('runStageStart', AGENT_AUTH_MODES.EXECUTION),
  'promote-units': command('promoteUnits'),
  'derive-artifacts': command('deriveArtifacts', AGENT_AUTH_MODES.EXECUTION),
  'record-pr': command('recordPr'),
  'record-unit-pr': command('recordUnitPr'),
  'init-lane': command('initLane'),
  'merge-lane': command('mergeLane'),
  'reconcile-lane': command('reconcileLane'),
  'refresh-intent': command('refreshIntent'),
  'resolve-conflict': command('resolveConflict', AGENT_AUTH_MODES.EXECUTION),
  'discussion-assist-start': command('discussionAssistStart', AGENT_AUTH_MODES.DISCUSSION),
  'compose-plan-start': command('composePlanStart', AGENT_AUTH_MODES.COMPOSE),
  'quorum-edit-plan-start': command('quorumEditPlanStart', AGENT_AUTH_MODES.EXECUTION),
  'quorum-edit-apply-start': command('quorumEditApplyStart', AGENT_AUTH_MODES.EXECUTION),
  'repair-structure': command('repairStructure', AGENT_AUTH_MODES.EXECUTION),
  inspect: command('inspect'),
  capabilities: command('capabilities', AGENT_AUTH_MODES.CAPABILITIES),
  'managed-runtime-check': command('managedRuntimeCheck'),
  'verify-mcp': command('verifyMcp'),
});

export const commandDefinition = (name) =>
  typeof name === 'string' && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
