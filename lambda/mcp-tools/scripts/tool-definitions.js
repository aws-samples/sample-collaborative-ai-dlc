import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AUTHOR_TOOLS,
  CHECKPOINT_TOOLS,
  REVIEWER_TOOLS,
  WORKSPACE_DETECTION_TOOLS,
  toolSchemas,
} from '../../shared/mcp/server.js';

export const GATEWAY_TOOL_NAMES = Object.freeze([
  ...new Set([
    ...AUTHOR_TOOLS,
    ...REVIEWER_TOOLS,
    ...WORKSPACE_DETECTION_TOOLS,
    ...CHECKPOINT_TOOLS,
  ]),
]);

// AgentCore Gateway accepts a restricted schema (type, description, properties,
// required, items). The tools Lambda re-validates every call against the full
// zod shape, so dropping enum/bounds here loosens nothing that is enforced.
const toGatewaySchema = (schema) => {
  const out = { type: schema.type ?? 'string' };
  if (schema.description) out.description = schema.description;
  if (out.type === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => [key, toGatewaySchema(value)]),
    );
    if (schema.required?.length) out.required = [...schema.required];
  }
  if (out.type === 'array') out.items = toGatewaySchema(schema.items ?? {});
  return out;
};

// The policy that adds every optional field, so the target accepts any argument
// set some release may send; the proxy decides which subset each session sees.
const SUPERSET_POLICY = { loopBack: 'human-offered' };

export const gatewayToolDefinitions = () => {
  const schemas = toolSchemas(z, SUPERSET_POLICY);
  return GATEWAY_TOOL_NAMES.map((name) => ({
    name,
    description: schemas[name].description,
    inputSchema: toGatewaySchema(
      zodToJsonSchema(z.object(schemas[name].shape), { $refStrategy: 'none' }),
    ),
  }));
};
