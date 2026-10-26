// Runtime env: platform-wide variables exported to every agent CLI the runtime
// spawns (cli/spawn.js), and so to the tools and MCP servers it starts. Each is
// an SSM parameter (SecureString for secrets) directly under
// RUNTIME_ENV_SSM_PATH, named after the variable:
//   {RUNTIME_ENV_SSM_PATH}/{VAR}  e.g. /collaborative-ai-dlc/beta/runtime-env/FOO
//
// Unlike MCP secrets these are not tier-scoped or referenced by a config: every
// agent in every project can read every value. Only store what all of them may
// use.
//
// The dispatcher refreshes the map before each command (http-server.js), at most
// once per TTL, so a rotation is picked up within a minute. Spawns read the
// cached map synchronously. A variable never overrides one the runtime sets
// itself: reserved names are skipped, and the invocation's env wins in spawn.
import { Logger } from '@aws-lambda-powertools/logger';
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import mcpValidatorPkg from '../shared/mcp-validator.js';
import { RESERVED_MCP_ENV_KEYS } from './mcp-secret-resolver.js';
import { SAFE_AMBIENT_ENV } from './cli/environment.js';

const { SECRET_VAR_NAME } = mcpValidatorPkg;
const logger = new Logger({ persistentKeys: { component: 'agentcore', module: 'runtime-env' } });

export const RUNTIME_ENV_TTL_MS = 60_000;

// Names the runtime controls on every child, beyond the MCP reserved set.
const RESERVED = new Set([
  ...RESERVED_MCP_ENV_KEYS,
  ...SAFE_AMBIENT_ENV,
  'DYLD_INSERT_LIBRARIES',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'BOTO_CONFIG',
]);

// Back-off after a failed read, so a throttled or unreachable SSM isn't retried
// (and waited on) by every command.
export const RUNTIME_ENV_RETRY_MS = 10_000;

let cache = { env: {}, loadedAt: null, failedAt: null };
let inFlight = null;
let sharedClient = null;

const ssmClient = () =>
  (sharedClient ??= new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' }));

const fetchAll = async (ssm, path) => {
  const params = [];
  let token;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({
        Path: path,
        Recursive: false,
        WithDecryption: true,
        MaxResults: 10,
        NextToken: token,
      }),
    );
    params.push(...(res.Parameters ?? []));
    token = res.NextToken;
  } while (token);
  return params;
};

// Parameters -> { VAR: value }, dropping invalid and reserved names.
export const toRuntimeEnv = (params, path) => {
  const env = {};
  for (const { Name, Value } of params) {
    const name = String(Name ?? '').slice(path.length + 1);
    if (!SECRET_VAR_NAME.test(name)) {
      logger.warn('runtime env: skipping invalid variable name', { parameter: Name });
    } else if (RESERVED.has(name)) {
      logger.warn('runtime env: skipping reserved variable name', { name });
    } else if (typeof Value === 'string') {
      env[name] = Value;
    }
  }
  return env;
};

/**
 * Refresh the cached runtime env when it is older than the TTL. Concurrent
 * callers share one refresh. A failed read keeps the last good map (empty
 * before the first) and is retried after the back-off. No path configured:
 * always empty, no SSM call.
 */
export const loadRuntimeEnv = async ({
  path = process.env.RUNTIME_ENV_SSM_PATH || '',
  ssm,
  now = Date.now,
  ttlMs = RUNTIME_ENV_TTL_MS,
  retryMs = RUNTIME_ENV_RETRY_MS,
} = {}) => {
  const base = path.replace(/\/+$/, '');
  if (!base) return cache.env;
  if (cache.loadedAt !== null && now() - cache.loadedAt < ttlMs) return cache.env;
  if (cache.failedAt !== null && now() - cache.failedAt < retryMs) return cache.env;
  inFlight ??= (async () => {
    try {
      const env = toRuntimeEnv(await fetchAll(ssm ?? ssmClient(), base), base);
      cache = { env, loadedAt: now(), failedAt: null };
      logger.info('runtime env loaded', { names: Object.keys(env) });
    } catch (e) {
      cache = { ...cache, failedAt: now() };
      logger.error('runtime env: SSM read failed; keeping the previous values', e, { path: base });
    } finally {
      inFlight = null;
    }
  })();
  await inFlight;
  return cache.env;
};

export const currentRuntimeEnv = () => cache.env;

// Test seam.
export const resetRuntimeEnv = () => {
  cache = { env: {}, loadedAt: null, failedAt: null };
  inFlight = null;
};

export default { loadRuntimeEnv, currentRuntimeEnv, toRuntimeEnv, resetRuntimeEnv };
