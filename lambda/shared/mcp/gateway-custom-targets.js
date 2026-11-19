// Customer MCP servers behind the AgentCore Gateway (Terraform
// `mcp_gateway_custom_targets`): the access registry the REQUEST/RESPONSE
// interceptor enforces, and the caller envelope it forwards to them.
//
// The registry names each target and who may call it; it carries no endpoint
// and no credential (the Gateway injects the outbound credential from
// AgentCore Identity). Access is decided from the SIGNED grant only:
//   - only `stage` grants reach a customer target (discussion and conflict
//     sessions have no stage the rule could name, so they are denied);
//   - the grant's projectId must be listed (exact match);
//   - the grant's stageId must be listed, unless the rule names no stages;
//   - the tool must be listed, unless the rule names no tools.
// Role, persona, agentRef and attempt metadata are runtime assertions; nothing
// here reads them, so they can never unlock a customer tool.

// Same separator as gateway-authorization.js (which imports this module).
const TARGET_TOOL_SEPARATOR = '___';
export const CUSTOM_TARGETS_ENV = 'MCP_GATEWAY_CUSTOM_TARGETS';
// Lambda environment variables share a 4 KB budget; Terraform enforces the same
// bound on the registry it writes (modules/compute/agentcore/mcp-gateway-targets.tf).
export const MAX_CUSTOM_TARGETS_BYTES = 2048;
export const CUSTOMER_CALLER_HEADER = 'x-aidlc-caller';
export const CUSTOMER_CALLER_VERSION = 1;
// Gateway header values are limited to 4 KB.
const MAX_HEADER_BYTES = 4096;

// The Gateway target name pattern, narrowed to lowercase so a name can never
// contain the `___` that separates target and tool. Kept in sync with the
// Terraform validation.
export const CUSTOM_TARGET_NAME = /^[a-z0-9](?:-?[a-z0-9]){0,31}$/;
const RESERVED_TARGET_NAMES = new Set(['aidlc']);

// Grant-derived fields only: nothing the runtime asserts, no policy.
const CALLER_FIELDS = Object.freeze([
  'projectId',
  'intentId',
  'executionId',
  'stageId',
  'unitSlug',
  'sectionIndex',
  'grantId',
  'expiresAt',
]);

export class GatewayCustomTargetsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayCustomTargetsError';
  }
}

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const stringSet = (value, { nullable }) => {
  if (value === null && nullable) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item === '')
  ) {
    throw new GatewayCustomTargetsError('Custom MCP target registry is invalid');
  }
  return Object.freeze(new Set(value));
};

// Parse the registry JSON Terraform writes. Unset or empty means no customer
// targets. Anything malformed throws: the interceptor then denies every request
// rather than guessing which targets exist.
export const parseCustomTargets = (raw) => {
  if (raw === undefined || raw === null || raw === '') return new Map();
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_CUSTOM_TARGETS_BYTES) {
    throw new GatewayCustomTargetsError('Custom MCP target registry is invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayCustomTargetsError('Custom MCP target registry is invalid');
  }
  if (!isPlainObject(parsed)) {
    throw new GatewayCustomTargetsError('Custom MCP target registry is invalid');
  }
  const targets = new Map();
  for (const [name, rule] of Object.entries(parsed)) {
    if (
      !CUSTOM_TARGET_NAME.test(name) ||
      RESERVED_TARGET_NAMES.has(name) ||
      !isPlainObject(rule) ||
      Object.keys(rule).toSorted().join() !== 'projectIds,stageIds,tools'
    ) {
      throw new GatewayCustomTargetsError('Custom MCP target registry is invalid');
    }
    targets.set(
      name,
      Object.freeze({
        projectIds: stringSet(rule.projectIds, { nullable: false }),
        stageIds: stringSet(rule.stageIds, { nullable: true }),
        tools: stringSet(rule.tools, { nullable: true }),
      }),
    );
  }
  return targets;
};

export const customTargetsFromEnv = (env = process.env) =>
  parseCustomTargets(env[CUSTOM_TARGETS_ENV]);

// The one predicate for customer tools, shared by tools/call enforcement and
// tools/list filtering. `grant` is the verified grant.
export const customToolAllowed = (targets, grant, target, tool) => {
  const rule = targets.get(target);
  return (
    Boolean(rule) &&
    grant?.mode === 'stage' &&
    typeof tool === 'string' &&
    tool !== '' &&
    !tool.includes(TARGET_TOOL_SEPARATOR) &&
    rule.projectIds.has(grant.projectId) &&
    (rule.stageIds === null || rule.stageIds.has(grant.stageId)) &&
    (rule.tools === null || rule.tools.has(tool))
  );
};

// The only header a customer target receives. Versioned base64url JSON of the
// grant-derived fields; the customer server may use it for space/stage scoping
// only after it authenticated the request as coming from the Gateway (the
// outbound OAuth client or API key), and must not trust it otherwise.
// Every other allowed request, while customer targets exist, carries this fixed
// value instead: should the Gateway forward a method other than a stage's
// tools/call to a customer target, a caller-supplied x-aidlc-caller never
// survives. Customer servers treat it as unauthenticated (no caller).
export const NO_CUSTOMER_CALLER = Buffer.from(
  JSON.stringify({ v: CUSTOMER_CALLER_VERSION, none: true }),
).toString('base64url');

export const encodeCustomerCaller = (grant) => {
  const payload = { v: CUSTOMER_CALLER_VERSION };
  for (const field of CALLER_FIELDS) payload[field] = grant?.[field] ?? null;
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  if (Buffer.byteLength(encoded) > MAX_HEADER_BYTES) {
    throw new GatewayCustomTargetsError('Customer caller context is too large');
  }
  return { [CUSTOMER_CALLER_HEADER]: encoded };
};
