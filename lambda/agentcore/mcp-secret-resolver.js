import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  computeSurvivors,
  resolveMcpSecrets as resolveLocal,
  RESERVED_MCP_ENV_KEYS as sharedReservedKeys,
  isReservedMcpEnvKey as isReservedSharedKey,
} from '../shared/mcp-secret-policy.js';
import { CREDENTIAL_ADAPTER_ENV_NAMES } from './credential-material-registry.js';

export { computeSurvivors };
export const RESERVED_MCP_ENV_KEYS = new Set([
  ...sharedReservedKeys,
  ...CREDENTIAL_ADAPTER_ENV_NAMES,
]);
// The shared predicate bound to the agentcore-extended set, so every agentcore
// check keeps the shared case rules (lowercase-stored names match any case).
export const isReservedMcpEnvKey = (name) => isReservedSharedKey(name, RESERVED_MCP_ENV_KEYS);

const assertLocal = () => {
  if (process.env.ENGINE_DATA_FUNCTION)
    throw new Error('Direct MCP secret resolution is disabled in engine-data mode');
};
const defaultGetParam = (client) => async (name) => {
  assertLocal();
  try {
    const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return res.Parameter?.Value ?? null;
  } catch {
    return null;
  }
};

export const resolveMcpSecrets = async (args = {}) => {
  assertLocal();
  return resolveLocal({
    ...args,
    reservedEnvKeys: [...CREDENTIAL_ADAPTER_ENV_NAMES, ...(args.reservedEnvKeys ?? [])],
    getParam:
      args.getParam ??
      defaultGetParam(new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' })),
  });
};

export default { computeSurvivors, resolveMcpSecrets, RESERVED_MCP_ENV_KEYS, isReservedMcpEnvKey };
