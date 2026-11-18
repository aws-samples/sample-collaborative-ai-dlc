// AgentCore Gateway REQUEST/RESPONSE interceptor for the built-in MCP.
//
// REQUEST: every MCP method the runtime may send is authorized against the
// grant, session and live scope (fail closed). An allowed request is forwarded
// with its ORIGINAL body and ONLY the trusted context headers this interceptor
// derives; caller headers (Authorization, AWS security tokens, the grant and
// session themselves) are never copied, so nothing a caller supplies can
// override the target's credential or forge the context. A denial short-
// circuits with a JSON-RPC error and the target is never invoked.
//
// A tools/call to a customer MCP target (mcp_gateway_custom_targets) is
// forwarded with the minimal caller envelope instead of the built-in context:
// grant-derived fields only, and never Authorization, which would replace the
// credential the Gateway injects from AgentCore Identity. While customer
// targets exist, every other allowed request sets the same header to the fixed
// "no caller" value, so a caller-supplied envelope can never reach a customer
// target whatever method the Gateway forwards to it.
//
// RESPONSE: tools/list is filtered with the same predicate tools/call enforces,
// built-in and customer tools alike, re-derived from the original request
// headers; pagination and every other result field are kept. A denial produced at REQUEST
// time, and every other method's response, passes through unchanged.
import {
  AIDLC_TARGET,
  GATEWAY_DENIAL_CODE,
  GatewayAccessDenied,
  splitQualifiedToolName,
} from '../shared/mcp/gateway-authorization.js';
import { encodeGatewayContext } from '../shared/mcp/gateway-context.js';
import {
  CUSTOMER_CALLER_HEADER,
  NO_CUSTOMER_CALLER,
  encodeCustomerCaller,
} from '../shared/mcp/gateway-custom-targets.js';

export const INTERCEPTOR_VERSION = '1.0';

const SESSION_METHODS = new Set(['initialize', 'ping', 'tools/list']);
const isAllowedMethod = (method) =>
  method === 'tools/call' || SESSION_METHODS.has(method) || method.startsWith('notifications/');

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseBody = (raw) => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const requestIdOf = (body) =>
  isPlainObject(body) && (typeof body.id === 'string' || typeof body.id === 'number')
    ? body.id
    : null;

const denial = (id, reason) => ({
  interceptorOutputVersion: INTERCEPTOR_VERSION,
  mcp: {
    transformedGatewayResponse: {
      statusCode: 200,
      body: { jsonrpc: '2.0', id, error: { code: GATEWAY_DENIAL_CODE, message: reason } },
    },
  },
});

const responseOutput = (response, body) => ({
  interceptorOutputVersion: INTERCEPTOR_VERSION,
  mcp: {
    transformedGatewayResponse: {
      ...(response.statusCode === undefined ? {} : { statusCode: response.statusCode }),
      body,
    },
  },
});

export const createGatewayInterceptor = ({ authorizer, audit = () => {} }) => {
  const onRequest = async (request, body) => {
    if (!isPlainObject(body) || typeof body.method !== 'string') {
      throw new GatewayAccessDenied('invalid_request');
    }
    if (!isAllowedMethod(body.method)) throw new GatewayAccessDenied('method_not_allowed');
    let qualifiedTool;
    if (body.method === 'tools/call') {
      qualifiedTool = body.params?.name;
      if (typeof qualifiedTool !== 'string' || !qualifiedTool) {
        throw new GatewayAccessDenied('missing_tool_name');
      }
    }
    const authorized = await authorizer.authorize(request.headers, { qualifiedTool });
    const customerTarget = Boolean(authorized.target) && authorized.target !== AIDLC_TARGET;
    let headers;
    try {
      headers = customerTarget
        ? encodeCustomerCaller(authorized.grant)
        : {
            ...encodeGatewayContext(authorized),
            ...(authorized.hasCustomTargets
              ? { [CUSTOMER_CALLER_HEADER]: NO_CUSTOMER_CALLER }
              : {}),
          };
    } catch {
      throw new GatewayAccessDenied('context_too_large', authorized.auditScope);
    }
    return {
      record: {
        decision: 'allow',
        ...(customerTarget ? { target: authorized.target } : {}),
        ...authorized.auditScope,
      },
      output: {
        interceptorOutputVersion: INTERCEPTOR_VERSION,
        mcp: { transformedGatewayRequest: { headers, body: request.body } },
      },
    };
  };

  const onResponse = async (request, body, response) => {
    const responseBody = parseBody(response?.body);
    const tools = responseBody?.result?.tools;
    if (
      !isPlainObject(response) ||
      body?.method !== 'tools/list' ||
      !isPlainObject(responseBody) ||
      responseBody.error !== undefined ||
      !Array.isArray(tools)
    ) {
      return { record: null, output: responseOutput(response ?? {}, response?.body) };
    }
    const authorized = await authorizer.authorize(request.headers);
    const visible = tools.filter((entry) => {
      const { target, tool } = splitQualifiedToolName(entry?.name);
      return authorized.allowsTool(target, tool);
    });
    return {
      record: {
        decision: 'filter',
        listed: tools.length,
        visible: visible.length,
        ...authorized.auditScope,
      },
      output: responseOutput(response, {
        ...responseBody,
        result: { ...responseBody.result, tools: visible },
      }),
    };
  };

  return async (event, lambdaContext) => {
    const mcp = isPlainObject(event?.mcp) ? event.mcp : {};
    // The Gateway sends `gatewayResponse: null` on the REQUEST phase.
    const phase = isPlainObject(mcp.gatewayResponse) ? 'RESPONSE' : 'REQUEST';
    const request = isPlainObject(mcp.gatewayRequest) ? mcp.gatewayRequest : {};
    const body = parseBody(request.body);
    const method = isPlainObject(body) && typeof body.method === 'string' ? body.method : null;
    const tool =
      method === 'tools/call' && typeof body.params?.name === 'string' ? body.params.name : null;
    const base = { phase, method, tool, requestId: lambdaContext?.awsRequestId ?? null };
    try {
      if (event?.interceptorInputVersion !== INTERCEPTOR_VERSION) {
        throw new GatewayAccessDenied('unsupported_interceptor_version');
      }
      const { record, output } =
        phase === 'RESPONSE'
          ? await onResponse(request, body, mcp.gatewayResponse)
          : await onRequest(request, body);
      if (record) audit({ ...base, ...record });
      return output;
    } catch (error) {
      const denied = error instanceof GatewayAccessDenied;
      audit({
        ...base,
        decision: 'deny',
        reason: denied ? error.reason : 'authorization_error',
        ...(denied ? error.auditScope : { error: error?.name ?? 'Error' }),
      });
      return denial(requestIdOf(body), denied ? error.reason : 'authorization_error');
    }
  };
};
