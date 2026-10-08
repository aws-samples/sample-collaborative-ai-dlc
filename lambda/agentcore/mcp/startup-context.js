// Validate the runtime's fixed scope before connecting the MCP transport.
// This detects inconsistent runtime context; it is not a container boundary.
import { assertMcpRole } from './server.js';

const TRANSIENT_ERRORS = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'TimeoutError',
  'RequestTimeout',
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
]);
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

const isTransientReadError = (error) => {
  // Gremlin's WebSocket handshake errors expose the HTTP status only in text.
  const handshakeStatus = error?.message?.match(
    /^Unexpected server response(?: code |: )(\d{3})\b/,
  )?.[1];
  const status = Number(error?.$metadata?.httpStatusCode ?? error?.statusCode ?? handshakeStatus);
  return (
    TRANSIENT_ERRORS.has(error?.code) ||
    TRANSIENT_ERRORS.has(error?.name) ||
    TRANSIENT_STATUSES.has(status) ||
    error?.message === 'Connection has been closed.'
  );
};

const retryStartupRead = async (read, sleep) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 2 || !isTransientReadError(error)) throw error;
      const delayMs = 250 * 2 ** attempt;
      // Keep diagnostics off the JSON-RPC stdout stream and omit record/error data.
      console.error(`[agentcore-mcp] retrying startup read (${attempt + 1}/2) in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
};

// Preserve the runtime's policy parsing: the completion ladder independently
// enforces the resolved plan when the optional MCP policy is absent or malformed.
const policyFromEnv = (env) => {
  if (!env.V2_STAGE_POLICY) return null;
  try {
    const parsed = JSON.parse(env.V2_STAGE_POLICY);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

export const contextFromEnv = (env) => {
  const role = env.V2_MCP_ROLE;
  assertMcpRole(role);
  const mode = env.V2_MCP_MODE || 'stage';
  if (!['stage', 'discussion', 'conflict'].includes(mode)) {
    throw new Error('Invalid MCP mode');
  }
  const scope = Object.freeze({
    executionId: env.V2_EXECUTION_ID || null,
    intentId: env.V2_INTENT_ID || null,
    projectId: env.V2_PROJECT_ID || null,
    stageId: env.V2_STAGE_ID || null,
    stageInstanceId: env.V2_STAGE_INSTANCE_ID || null,
    sectionIndex: env.V2_SECTION_INDEX ? Number(env.V2_SECTION_INDEX) : null,
    stageAttempt: env.V2_STAGE_ATTEMPT ? Number(env.V2_STAGE_ATTEMPT) : 0,
    validationRound: Number(env.V2_VALIDATION_ROUND) || 0,
    unitSlug: env.V2_UNIT_SLUG || null,
    model: env.V2_RESOLVED_MODEL || null,
    reviewerAgent: env.V2_REVIEWER_AGENT || null,
    agentRef: env.V2_AGENT_REF || null,
    checkpointOwner: env.V2_CHECKPOINT_OWNER !== '0',
    canAsk: env.V2_ASK_QUESTION !== '0',
    policy: policyFromEnv(env),
  });
  if (!scope.intentId || !scope.projectId) throw new Error('MCP requires intentId and projectId');
  if (
    (scope.sectionIndex !== null &&
      (!Number.isInteger(scope.sectionIndex) || scope.sectionIndex < 0)) ||
    !Number.isInteger(scope.stageAttempt) ||
    scope.stageAttempt < 0
  ) {
    throw new Error('Invalid MCP section or attempt');
  }
  if (mode === 'stage') {
    if (!scope.stageId || !scope.stageInstanceId) {
      throw new Error('Stage MCP requires stageId and stageInstanceId');
    }
  } else {
    if (scope.stageId || scope.stageInstanceId) throw new Error('Non-stage MCP has stage context');
    if (
      mode === 'discussion' &&
      (role !== 'reader' || scope.unitSlug || scope.sectionIndex !== null)
    ) {
      throw new Error('Discussion MCP requires an intent-level reader');
    }
    if (mode === 'conflict' && role !== 'reviewer') {
      throw new Error('Conflict MCP requires reviewer role');
    }
  }
  if (mode !== 'discussion' && (!scope.executionId || !env.V2_PROCESS_TABLE)) {
    throw new Error('MCP requires executionId and process table');
  }
  return { scope, role, mode };
};

export const validateStartupContext = async ({
  scope,
  mode,
  store,
  openGraph,
  closeGraphSource,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) => {
  // Discussion assistance can run before any execution exists. Its reader
  // exposes only the business graph and does not construct a process bridge.
  if (mode !== 'discussion') {
    const execution = await retryStartupRead(
      () => store.getExecution(scope.executionId, { consistentRead: true }),
      sleep,
    );
    if (
      !execution ||
      execution.executionId !== scope.executionId ||
      execution.projectId !== scope.projectId ||
      execution.intentId !== scope.intentId
    ) {
      throw new Error('MCP execution scope mismatch or missing execution');
    }
    if (mode === 'stage') {
      const stage = await retryStartupRead(
        () =>
          store.getStage(scope.executionId, scope.stageInstanceId, {
            consistentRead: true,
          }),
        sleep,
      );
      if (
        !stage ||
        stage.executionId !== scope.executionId ||
        stage.stageInstanceId !== scope.stageInstanceId ||
        stage.stageId !== scope.stageId ||
        (stage.unitSlug ?? null) !== scope.unitSlug ||
        (stage.sectionIndex ?? null) !== scope.sectionIndex
      ) {
        throw new Error('MCP stage scope mismatch or missing stage');
      }
    }
  }
  const owned = await retryStartupRead(async () => {
    const g = await openGraph();
    try {
      return await g
        .V()
        .has('Intent', 'id', scope.intentId)
        .has('project_id', scope.projectId)
        .hasNext();
    } finally {
      await closeGraphSource(g);
    }
  }, sleep);
  if (!owned) throw new Error('MCP intent scope mismatch or missing intent');
};
