// Gateway-side authorization for the built-in MCP, run by the REQUEST/RESPONSE
// interceptor in front of every target. Pure orchestration over injected
// dependencies, deny-by-default:
//   1. the Gateway already authenticated the caller (SigV4, InvokeGateway);
//   2. the control-plane grant is verified (signature, audience, expiry, kid,
//      and not retired by the control plane, failing closed when the
//      retirement records cannot be read) and its mode is one the built-in MCP
//      serves (never an engine-data `execution` grant);
//   3. the runtime's session context must stay inside the grant, including the
//      signed release-policy digest;
//   4. for a tool call, the target must be known and the tool allowed —
//      for `aidlc` by the role's catalog for this stage/policy, for a customer
//      target by its registry rule against the signed grant alone
//      (gateway-custom-targets.js) — checked before any data access;
//   5. execution, stage leg and intent→project ownership are re-read with
//      consistent reads and must still be ACTIVE (per-call revocation).
// These reads are preflight only: the process store's transactional ownership
// guards stay authoritative for every write.
import { MCP_GRANT_MODES } from '../gateway-grant.js';
import { toolsForRole } from './server.js';
import { validateStartupContext } from './startup-context.js';
import {
  GRANT_HEADER,
  SESSION_HEADER,
  decodeGatewaySession,
  scopeFromGrantAndSession,
} from './gateway-session.js';
import { GatewayContextError, headerMapFrom, singleHeader } from './gateway-context.js';
import { customToolAllowed } from './gateway-custom-targets.js';

export const AIDLC_TARGET = 'aidlc';
export const TARGET_TOOL_SEPARATOR = '___';
// JSON-RPC error code of a Gateway denial; its message is the reason code.
export const GATEWAY_DENIAL_CODE = -32001;

// What the agent is told for a denial. Identifiers stay in the audit record only.
const DENIAL_TEXT = {
  scope_not_active: 'Tool call denied: this stage is no longer active. Stop and end your turn.',
  grant_expired: 'Tool call denied: this session has expired. Stop and end your turn.',
  invalid_arguments: 'Tool call denied: the arguments do not match the tool schema.',
  tool_not_allowed_for_role: 'Tool call denied: this tool is not available in this session.',
  lane_outside_grant: 'Tool call denied: this session is limited to its own unit lane.',
};
export const gatewayDenialText = (reason) =>
  (Object.hasOwn(DENIAL_TEXT, reason) && DENIAL_TEXT[reason]) || 'Tool call denied.';

export class GatewayAccessDenied extends Error {
  constructor(reason, auditScope = {}) {
    super('Tool call denied');
    this.name = 'GatewayAccessDenied';
    this.reason = reason;
    this.auditScope = auditScope;
  }
}

// Gateway names tools `<target>___<tool>`; only the first separator splits.
export const splitQualifiedToolName = (qualified) => {
  if (typeof qualified !== 'string' || !qualified) return { target: null, tool: null };
  const index = qualified.indexOf(TARGET_TOOL_SEPARATOR);
  if (index === -1) return { target: null, tool: qualified };
  return {
    target: qualified.slice(0, index),
    tool: qualified.slice(index + TARGET_TOOL_SEPARATOR.length),
  };
};

export const gatewayAuditScope = ({ grant, scope, role, mode }) => ({
  grantId: grant?.grantId ?? null,
  role: role ?? null,
  mode: mode ?? grant?.mode ?? null,
  projectId: scope?.projectId ?? grant?.projectId ?? null,
  intentId: scope?.intentId ?? grant?.intentId ?? null,
  executionId: scope?.executionId ?? grant?.executionId ?? null,
  stageInstanceId: scope?.stageInstanceId ?? null,
  unitSlug: scope?.unitSlug ?? grant?.unitSlug ?? null,
});

// The one predicate for "may this session use this tool", shared by tools/call
// enforcement, tools/list filtering and the target's own defensive check.
export const toolAllowedForContext = ({ scope, role }, target, tool) =>
  target === AIDLC_TARGET &&
  typeof tool === 'string' &&
  toolsForRole(role, scope.stageId, scope.policy, {
    checkpointOwner: scope.checkpointOwner,
    canAsk: scope.canAsk,
    describeChanges: scope.describeChanges,
  }).includes(tool);

const NO_CUSTOM_TARGETS = new Map();

const readHeader = (headers, name) => {
  try {
    return singleHeader(headers, name);
  } catch (error) {
    if (error instanceof GatewayContextError) throw new GatewayAccessDenied('ambiguous_header');
    throw error;
  }
};

export const createGatewayAuthorizer = ({
  verifyGrant,
  createStore,
  openGraph,
  closeGraphSource,
  processTable,
  // Returns the customer target registry (parseCustomTargets). A function so a
  // malformed registry fails each request closed instead of the whole Lambda.
  customTargets = () => NO_CUSTOM_TARGETS,
}) => {
  // The predicate tools/call enforces and tools/list filters with.
  const allowsTool = (targets, authorized, target, tool) =>
    target === AIDLC_TARGET
      ? toolAllowedForContext(authorized, target, tool)
      : customToolAllowed(targets, authorized.grant, target, tool);

  // `qualifiedTool` is the Gateway tool name for tools/call, absent for the
  // session-level methods (initialize, tools/list, ping, notifications).
  const authorize = async (rawHeaders, { qualifiedTool } = {}) => {
    const headers = headerMapFrom(rawHeaders);
    const token = readHeader(headers, GRANT_HEADER);
    const session = readHeader(headers, SESSION_HEADER);
    if (!token) throw new GatewayAccessDenied('missing_grant');
    if (!session) throw new GatewayAccessDenied('missing_session');

    let grant;
    try {
      grant = await verifyGrant(token);
    } catch (error) {
      throw new GatewayAccessDenied(
        error?.code === 'GATEWAY_GRANT_EXPIRED' ? 'grant_expired' : 'grant_invalid',
      );
    }
    if (!MCP_GRANT_MODES.includes(grant?.mode)) {
      throw new GatewayAccessDenied('mode_not_allowed', gatewayAuditScope({ grant }));
    }
    let context;
    try {
      context = scopeFromGrantAndSession(grant, decodeGatewaySession(session), { processTable });
    } catch {
      throw new GatewayAccessDenied('session_outside_grant', gatewayAuditScope({ grant }));
    }
    const auditScope = gatewayAuditScope({ grant, ...context });
    const targets = customTargets();

    let target = null;
    if (qualifiedTool !== undefined) {
      const split = splitQualifiedToolName(qualifiedTool);
      target = split.target;
      if (target === AIDLC_TARGET) {
        if (!toolAllowedForContext(context, target, split.tool)) {
          throw new GatewayAccessDenied('tool_not_allowed_for_role', auditScope);
        }
      } else if (!targets.has(target)) {
        throw new GatewayAccessDenied('unknown_target', auditScope);
      } else if (grant.mode !== 'stage') {
        throw new GatewayAccessDenied('mode_not_allowed_for_target', auditScope);
      } else if (!customToolAllowed(targets, grant, target, split.tool)) {
        throw new GatewayAccessDenied('tool_not_allowed_for_target', auditScope);
      }
    }

    try {
      await validateStartupContext({
        scope: context.scope,
        mode: context.mode,
        store: context.mode === 'discussion' ? null : createStore(),
        openGraph,
        closeGraphSource,
        requireActive: true,
      });
    } catch {
      throw new GatewayAccessDenied('scope_not_active', auditScope);
    }
    const authorized = { grant, ...context, auditScope, target };
    return {
      ...authorized,
      hasCustomTargets: targets.size > 0,
      allowsTool: (listedTarget, tool) => allowsTool(targets, authorized, listedTarget, tool),
    };
  };

  return { authorize };
};
