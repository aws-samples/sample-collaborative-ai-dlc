// AgentCore Gateway Lambda target for the built-in `aidlc` MCP tools.
//
// Every call is authorized independently and deny-by-default:
//   1. the Gateway already authenticated the caller (SigV4, InvokeGateway);
//   2. the control-plane grant is verified (signature, audience, expiry, kid);
//   3. the runtime's session context must stay inside the grant, including the
//      signed release-policy digest;
//   4. execution, stage leg and intent→project ownership are re-read with
//      consistent reads, and must still be ACTIVE (per-call revocation);
//   5. the tool must be in the role's catalog for this stage/policy, and its
//      arguments must match the tool's zod shape (unknown keys are dropped,
//      exactly as on the local stdio server);
//   6. scope is taken only from 2–4, never from tool arguments.
// The existing graph-writer / process-bridge handlers then run unchanged, and
// every decision — allow, deny, or handler failure — is audited with its scope.
import { z } from 'zod';
import { buildToolHandlers, toolSchemas, toolsForRole } from '../shared/mcp/server.js';
import { validateStartupContext } from '../shared/mcp/startup-context.js';
import {
  GRANT_HEADER,
  SESSION_HEADER,
  decodeGatewaySession,
  scopeFromGrantAndSession,
} from '../shared/mcp/gateway-session.js';

export const TARGET_TOOL_SEPARATOR = '___';

// What the agent is told. Identifiers stay in the audit record only.
const DENIAL_TEXT = {
  scope_not_active: 'Tool call denied: this stage is no longer active. Stop and end your turn.',
  grant_expired: 'Tool call denied: this session has expired. Stop and end your turn.',
  invalid_arguments: 'Tool call denied: the arguments do not match the tool schema.',
  tool_not_allowed_for_role: 'Tool call denied: this tool is not available in this session.',
  lane_outside_grant: 'Tool call denied: this session is limited to its own unit lane.',
};
const DEFAULT_DENIAL_TEXT = 'Tool call denied.';
// Grant modes that may open an MCP tool session. Any other verified mode (an
// `execution` grant for engine data access) is signed for a different use and
// must never reach a tool handler.
const TOOL_GRANT_MODES = new Set(['stage', 'conflict', 'discussion']);

export class ToolAccessDenied extends Error {
  constructor(reason, auditScope = {}) {
    super('Tool call denied');
    this.name = 'ToolAccessDenied';
    this.reason = reason;
    this.auditScope = auditScope;
  }
}

export const toolNameFrom = (custom) => {
  const qualified = custom?.bedrockAgentCoreToolName;
  if (typeof qualified !== 'string') return null;
  const index = qualified.indexOf(TARGET_TOOL_SEPARATOR);
  return index === -1 ? qualified : qualified.slice(index + TARGET_TOOL_SEPARATOR.length);
};

// Gateway forwards allow-listed request headers to Lambda targets in the client
// context (verified live: an object of lowercase names; a JSON string is also
// accepted). Header names are case-insensitive on the wire, so normalize here.
export const propagatedHeadersFrom = (custom) => {
  const raw = custom?.bedrockAgentCorePropagatedHeaders;
  let headers = raw;
  if (typeof raw === 'string') {
    try {
      headers = JSON.parse(raw);
    } catch {
      headers = null;
    }
  }
  if (!headers || typeof headers !== 'object') return {};
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value[0] : value,
    ]),
  );
};

const scopeAudit = ({ grant, scope, role, mode }) => ({
  grantId: grant?.grantId ?? null,
  role: role ?? null,
  mode: mode ?? grant?.mode ?? null,
  projectId: scope?.projectId ?? grant?.projectId ?? null,
  intentId: scope?.intentId ?? grant?.intentId ?? null,
  executionId: scope?.executionId ?? grant?.executionId ?? null,
  stageInstanceId: scope?.stageInstanceId ?? null,
  unitSlug: scope?.unitSlug ?? grant?.unitSlug ?? null,
});

// The process bridge was written for a long-lived MCP child: it rehydrates the
// stage's recorded authorizations in the background and records graph-read
// accounting fire-and-forget. A Lambda may freeze once it returns, so this
// wrapper makes the call wait for both before responding.
const settleBridge = (bridge) => {
  if (!bridge) return { bridge: null, settle: async () => {} };
  const pending = new Set();
  const track = (promise) => {
    const settled = Promise.resolve(promise).catch(() => {});
    pending.add(settled);
    settled.finally(() => pending.delete(settled));
    return promise;
  };
  const wrapped = Object.create(bridge);
  if (typeof bridge.recordGraphRead === 'function') {
    wrapped.recordGraphRead = (input) => track(bridge.recordGraphRead(input));
  }
  return {
    bridge: wrapped,
    ready: () => bridge.rehydrateAuthorizations?.(),
    settle: async () => {
      while (pending.size) await Promise.all(pending);
    },
  };
};

export const createToolGateway = ({
  verifyGrant,
  createStore,
  openGraph,
  closeGraphSource,
  createGraphWriter,
  createGraphManager,
  createProcessBridge,
  broadcastToIntent,
  processTable,
  audit = () => {},
  bridgeOptions = {},
}) => {
  const authorize = async ({ custom, args, graphSource }) => {
    const tool = toolNameFrom(custom);
    if (!tool) throw new ToolAccessDenied('missing_tool_name');
    const headers = propagatedHeadersFrom(custom);
    if (!headers[GRANT_HEADER]) throw new ToolAccessDenied('missing_grant');
    if (!headers[SESSION_HEADER]) throw new ToolAccessDenied('missing_session');

    let grant;
    try {
      grant = await verifyGrant(headers[GRANT_HEADER]);
    } catch (error) {
      throw new ToolAccessDenied(
        error?.code === 'GATEWAY_GRANT_EXPIRED' ? 'grant_expired' : 'grant_invalid',
      );
    }
    if (!TOOL_GRANT_MODES.has(grant?.mode)) {
      throw new ToolAccessDenied('grant_mode_not_allowed', scopeAudit({ grant }));
    }
    let context;
    try {
      context = scopeFromGrantAndSession(grant, decodeGatewaySession(headers[SESSION_HEADER]), {
        processTable,
      });
    } catch {
      throw new ToolAccessDenied('session_outside_grant', scopeAudit({ grant }));
    }
    const { scope, role, mode } = context;
    const auditScope = scopeAudit({ grant, scope, role, mode });
    const allowed = toolsForRole(role, scope.stageId, scope.policy, {
      checkpointOwner: scope.checkpointOwner,
      canAsk: scope.canAsk,
    });
    if (!allowed.includes(tool))
      throw new ToolAccessDenied('tool_not_allowed_for_role', auditScope);
    const parsed = z.object(toolSchemas(z, scope.policy)[tool].shape).safeParse(args);
    if (!parsed.success) throw new ToolAccessDenied('invalid_arguments', auditScope);
    if (scope.unitSlug && parsed.data.unitSlug && parsed.data.unitSlug !== scope.unitSlug) {
      throw new ToolAccessDenied('lane_outside_grant', auditScope);
    }

    const store = mode === 'discussion' ? null : createStore();
    try {
      await validateStartupContext({
        scope,
        mode,
        store,
        openGraph: async () => graphSource(),
        closeGraphSource: async () => {},
        requireActive: true,
      });
    } catch {
      throw new ToolAccessDenied('scope_not_active', auditScope);
    }
    return { tool, scope, store, args: parsed.data, auditScope };
  };

  const invoke = async ({ tool, scope, store, args }, graphSource) => {
    const graph = createGraphManager({
      openGraph: async () => graphSource(),
      createWriter: createGraphWriter,
      closeGraphSource: async () => {},
      scope,
    });
    const { bridge, ready, settle } = settleBridge(
      store
        ? createProcessBridge({
            store,
            graphWriter: {
              recordQuestion: (input) => graph.withWriter((writer) => writer.recordQuestion(input)),
            },
            broadcast: (payload) => broadcastToIntent(scope.intentId, payload),
            scope,
            ...bridgeOptions,
          })
        : null,
    );
    await ready?.();
    try {
      return await buildToolHandlers({ graph, bridge })[tool](args);
    } finally {
      await settle();
    }
  };

  return async (event, lambdaContext) => {
    const custom = lambdaContext?.clientContext?.Custom ?? lambdaContext?.clientContext?.custom;
    const args = event && typeof event === 'object' ? event : {};
    const startedAt = Date.now();
    const requestId = custom?.bedrockAgentCoreAwsRequestId ?? null;
    let source = null;
    const graphSource = async () => {
      source ??= await openGraph();
      return source;
    };
    try {
      let authorized;
      try {
        authorized = await authorize({ custom, args, graphSource });
      } catch (error) {
        const denied = error instanceof ToolAccessDenied;
        const reason = denied ? error.reason : 'authorization_error';
        audit({
          decision: 'deny',
          reason,
          tool: toolNameFrom(custom),
          ...(denied ? error.auditScope : {}),
          requestId,
        });
        return {
          content: [{ type: 'text', text: DENIAL_TEXT[reason] ?? DEFAULT_DENIAL_TEXT }],
          isError: true,
        };
      }
      const record = {
        decision: 'allow',
        tool: authorized.tool,
        ...authorized.auditScope,
        requestId,
      };
      try {
        const result = await invoke(authorized, graphSource);
        audit({
          ...record,
          outcome: result?.isError ? 'tool_error' : 'ok',
          ms: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        audit({
          ...record,
          outcome: 'handler_error',
          error: error?.name ?? 'Error',
          ms: Date.now() - startedAt,
        });
        return { content: [{ type: 'text', text: 'Tool call failed.' }], isError: true };
      }
    } finally {
      if (source) await closeGraphSource(source).catch(() => {});
    }
  };
};
