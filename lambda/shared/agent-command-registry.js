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

const command = (handler, { agentAuth = false, executionData = true } = {}) =>
  Object.freeze({ handler, agentAuth, executionData });

export const COMMANDS = Object.freeze({
  'init-ws': command('initWs'),
  'run-stage': command('runStage', { agentAuth: AGENT_AUTH_MODES.EXECUTION }),
  'run-stage-start': command('runStageStart', { agentAuth: AGENT_AUTH_MODES.EXECUTION }),
  'promote-units': command('promoteUnits'),
  'derive-artifacts': command('deriveArtifacts', { agentAuth: AGENT_AUTH_MODES.EXECUTION }),
  'create-workflow-checkpoint': command('createWorkflowCheckpoint'),
  'record-pr': command('recordPr'),
  'record-learning': command('recordLearning'),
  'record-unit-pr': command('recordUnitPr'),
  'init-lane': command('initLane'),
  'merge-lane': command('mergeLane'),
  'reconcile-lane': command('reconcileLane'),
  'refresh-intent': command('refreshIntent', { executionData: false }),
  'resolve-conflict': command('resolveConflict', { agentAuth: AGENT_AUTH_MODES.EXECUTION }),
  'discussion-assist-start': command('discussionAssistStart', {
    agentAuth: AGENT_AUTH_MODES.DISCUSSION,
  }),
  'compose-plan-start': command('composePlanStart', { agentAuth: AGENT_AUTH_MODES.COMPOSE }),
  'quorum-edit-plan-start': command('quorumEditPlanStart', {
    agentAuth: AGENT_AUTH_MODES.EXECUTION,
  }),
  'quorum-edit-apply-start': command('quorumEditApplyStart', {
    agentAuth: AGENT_AUTH_MODES.EXECUTION,
  }),
  'repair-structure': command('repairStructure', { agentAuth: AGENT_AUTH_MODES.EXECUTION }),
  inspect: command('inspect', { executionData: false }),
  capabilities: command('capabilities', {
    agentAuth: AGENT_AUTH_MODES.CAPABILITIES,
    executionData: false,
  }),
  'managed-runtime-check': command('managedRuntimeCheck', { executionData: false }),
  'verify-mcp': command('verifyMcp', { executionData: false }),
});

export const commandDefinition = (name) =>
  typeof name === 'string' && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;

// Execution whose DynamoDB partition an AgentCore command may access, or null
// when the command needs no execution state. v2 keys an execution by its intent
// (executionId === intentId); some payloads carry only intentId.
export const executionDataId = (payload) => {
  if (!commandDefinition(payload?.command)?.executionData) return null;
  return payload.executionId || payload.intentId || null;
};
