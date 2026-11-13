// AgentCore Gateway Lambda target for the built-in `aidlc` MCP tools.
//
// The Gateway's REQUEST interceptor has already authorized the call: it
// verified the control-plane grant, bound the runtime's session to it, checked
// the role's tool catalog and re-read the execution, stage leg and intent
// ownership as ACTIVE. It replaces every caller header with the trusted
// context this target reads, and only the Gateway role may invoke it.
// This target therefore:
//   1. requires that context and validates it strictly (version, exact fields,
//      types, size, policy digest, expiry) — anything else is denied;
//   2. re-checks the role's tool catalog from the context (cheap, pure; defence
//      in depth against a mis-wired target);
//   3. parses arguments against the tool's zod shape (unknown keys are dropped,
//      exactly as on the local stdio server) and pins a lane session to its unit;
//   4. takes scope only from the context, never from tool arguments.
// The existing graph-writer / process-bridge handlers then run unchanged; the
// process store's transactional ownership guards stay authoritative for every
// write. Every decision — allow, deny, or handler failure — is audited.
import { z } from 'zod';
import { buildToolHandlers, toolSchemas } from '../shared/mcp/server.js';
import { decodeGatewayContext } from '../shared/mcp/gateway-context.js';
import {
  AIDLC_TARGET,
  gatewayAuditScope,
  gatewayDenialText,
  splitQualifiedToolName,
  toolAllowedForContext,
} from '../shared/mcp/gateway-authorization.js';

export class ToolAccessDenied extends Error {
  constructor(reason, auditScope = {}) {
    super('Tool call denied');
    this.name = 'ToolAccessDenied';
    this.reason = reason;
    this.auditScope = auditScope;
  }
}

export const toolNameFrom = (custom) => {
  const { target, tool } = splitQualifiedToolName(custom?.bedrockAgentCoreToolName);
  return target === null || target === AIDLC_TARGET ? tool : null;
};

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
  now = Date.now,
}) => {
  const authorize = ({ custom, args }) => {
    const tool = toolNameFrom(custom);
    if (!tool) throw new ToolAccessDenied('missing_tool_name');
    let context;
    try {
      // Gateway forwards allow-listed request headers to Lambda targets in the
      // client context: an object of lowercase names (a JSON string is also
      // accepted); names are matched case-insensitively.
      context = decodeGatewayContext(custom?.bedrockAgentCorePropagatedHeaders, {
        processTable,
        now,
      });
    } catch (error) {
      throw new ToolAccessDenied(
        error?.reason === 'context_expired'
          ? 'grant_expired'
          : (error?.reason ?? 'context_invalid'),
      );
    }
    const { scope, role, mode } = context;
    const auditScope = gatewayAuditScope({ grant: context.grant, scope, role, mode });
    if (!toolAllowedForContext(context, AIDLC_TARGET, tool)) {
      throw new ToolAccessDenied('tool_not_allowed_for_role', auditScope);
    }
    const schemas = toolSchemas(z, scope.policy, {
      crossUnitFindings: role === 'reviewer' && scope.crossUnitFindings === true,
    });
    const parsed = z.object(schemas[tool].shape).safeParse(args);
    if (!parsed.success) throw new ToolAccessDenied('invalid_arguments', auditScope);
    if (scope.unitSlug && parsed.data.unitSlug && parsed.data.unitSlug !== scope.unitSlug) {
      throw new ToolAccessDenied('lane_outside_grant', auditScope);
    }
    const store = mode === 'discussion' ? null : createStore();
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
        authorized = authorize({ custom, args });
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
          content: [{ type: 'text', text: gatewayDenialText(reason) }],
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
