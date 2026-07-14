// MCP secret resolver — sibling of auth-resolver.js. The custom-MCP config the
// runtime receives holds only `${VAR}` REFERENCES (no secret values); the actual
// values live in SSM SecureString, one parameter per referenced var, scoped by
// tier:
//   global  → /{project}/{env}/mcp-secrets/{VAR}
//   project → /{project}/{env}/projects/{projectId}/mcp-secrets/{VAR}
//
// At stage start (and at verify time) we resolve the referenced vars from SSM and
// hand back a flat `secretEnv = { VAR: value }` map. The runtime injects that into
// the CHILD process env; the CLI natively expands `${VAR}` in its MCP config,
// reading from that env — so the literal secret never touches the on-disk config.
//
// The two tiers are carried as SEPARATE maps until AFTER resolution. The tier IS
// the provenance: a server in the global map resolves from the global prefix, a
// server in the project map from the project prefix. There is NO cross-tier
// fallback — a project ref that names a global-only secret resolves to NOTHING and
// fails closed. This prevents a project admin from pulling a platform-wide secret
// into their session by guessing its name (confused-deputy / cross-tenant leak).
//
// Authoritative order of operations (mirrored by run-stage AND verify-mcp):
//   1. Survivors      — global servers whose name the project does NOT override.
//   2. Refs           — extractSecretRefs over survivors ONLY (an overridden
//                       global server never drives a read or a fail-closed).
//   3. Collision guard — a `${VAR}` name in BOTH tiers' refs is a hard error (the
//                       child env is one flat namespace; "project wins" would make
//                       a surviving global server silently expand to a project val).
//   4. Resolve         — each tier's refs from its OWN prefix; a referenced var
//                       with no value in its tier is a hard error (fail closed).
//
// ── THREAT MODEL: what this DOES and does NOT protect ──────────────────────────
// What you get:
//   • Encryption at rest — values live only in SSM SecureString (KMS), never in
//     Neptune, the DynamoDB process META, run-stage payloads, or the on-disk CLI
//     config (which keeps the literal `${VAR}` token).
//   • No cleartext in the graph / config file / UI — GET returns set-state only;
//     verify returns { ok, tools?, error? }; values are never echoed back.
//   • Tier isolation — a project ref can only resolve from its own project prefix;
//     no cross-tier fallback, and a name used by both a surviving global and a
//     surviving project server fails closed.
//   • Per-secret rotate / clear / audit; least-privilege IAM per path family.
//
// What you do NOT get — runtime confidentiality FROM the agent process itself:
//   • (a) The agent can read the values. They live in the agent CLI's process
//     env, so a shell/tool call the agent makes (e.g. `echo $CONTEXT7_API_KEY`)
//     can observe them. The agent is inside the trust boundary here.
//   • (b) No per-server scoping. The child env is ONE flat namespace, so every
//     stdio MCP server the CLI spawns inherits EVERY resolved secret — not just
//     its own. Server A can read server B's key.
//   This is inherent to CLI-native `${VAR}` expansion: the only way to scope a
//   secret per-server would be to substitute the literal value back INTO the
//   config file (or per-process env we control), which would defeat the
//   never-on-disk property we chose as the stronger guarantee. So (a)/(b) are an
//   accepted trade-off, not an oversight. If runtime confidentiality from the
//   agent is ever required, that needs a different mechanism (e.g. a broker the
//   MCP server calls, not env injection).
//
// Pure-ish: the SSM getter is injected for tests.

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import mcpValidatorPkg from '../shared/mcp-validator.js';

const { extractSecretRefs } = mcpValidatorPkg;

// Reserved child-process env-var names an MCP `${VAR}` ref may NOT shadow.
//
// The resolved secret values are injected into the SAME flat child env the CLI
// drivers use for auth (see run-stage.js childEnv + drivers.js envForAuth). If a
// user could name a ref `KIRO_API_KEY` / `AWS_BEARER_TOKEN_BEDROCK` / an AWS
// credential var, the CLI's `${VAR}` expansion would resolve it from that env —
// and depending on merge order either the platform's real token leaks into the
// custom MCP server, or the tier's SSM value silently loses to the platform one.
// Either way the "every `${VAR}` resolves ONLY from its tier's SSM value"
// invariant breaks. We therefore FAIL CLOSED on any ref whose name is reserved,
// rather than rely on env merge ordering. The var name is fully attacker-chosen,
// so this is a hard security boundary, not a convenience check.
export const RESERVED_MCP_ENV_KEYS = new Set([
  // Agent CLI auth (the tokens that must never reach a custom MCP server).
  'AWS_BEARER_TOKEN_BEDROCK',
  'KIRO_API_KEY',
  // Bedrock / region control the drivers set.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'IS_SANDBOX',
  'AWS_REGION',
  'BEDROCK_REGION',
  // AWS credential env (defense-in-depth: the container/task role).
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  // Package-manager / system env the runtime controls (OFF_MOUNT_CACHE_ENV +
  // the process essentials a hijack could weaponize).
  'npm_config_cache',
  'YARN_CACHE_FOLDER',
  'PNPM_HOME',
  'PIP_CACHE_DIR',
  'UV_CACHE_DIR',
  'TMPDIR',
  'PATH',
  'HOME',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
]);

// Fetch one decrypted SSM SecureString; returns null on a miss/error (distinct
// from '' so an intentionally-empty value could be told apart if ever needed —
// but a missing parameter throws ParameterNotFound, which we map to null).
const defaultGetParam = (client) => async (name) => {
  try {
    const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return res.Parameter?.Value ?? null;
  } catch {
    return null;
  }
};

/**
 * Compute the surviving servers for a merge where the PROJECT tier overrides the
 * GLOBAL tier by name.
 *   survivingGlobal  = global entries whose name is NOT present in project
 *   survivingProject = all project entries
 * Inputs/outputs are name-keyed OBJECTS (the author format). Non-objects → {}.
 */
export const computeSurvivors = (global = {}, project = {}) => {
  const g = global && typeof global === 'object' && !Array.isArray(global) ? global : {};
  const p = project && typeof project === 'object' && !Array.isArray(project) ? project : {};
  const survivingGlobal = {};
  for (const [name, server] of Object.entries(g)) {
    if (!(name in p)) survivingGlobal[name] = server;
  }
  return { survivingGlobal, survivingProject: { ...p } };
};

/**
 * Resolve MCP secret references for the SURVIVING servers of both tiers.
 *
 * @param {object}   args
 * @param {object}   args.survivingGlobal   name-keyed map of surviving global servers
 * @param {object}   args.survivingProject  name-keyed map of surviving project servers
 * @param {function} args.globalPath        (VAR) => SSM parameter name (global prefix)
 * @param {function} args.projectPath       (VAR) => SSM parameter name (project prefix)
 * @param {function} [args.getParam]        injected SSM getter (test seam)
 * @param {object}   [args.overrides]       tier-scoped just-typed values (verify only):
 *                                          { global?: {VAR:val}, project?: {VAR:val} }
 * @returns {Promise<{ secretEnv: Record<string,string> }>}
 * @throws  on a flat-env collision (step 3) or an unresolved ref (step 4).
 */
export const resolveMcpSecrets = async ({
  survivingGlobal = {},
  survivingProject = {},
  globalPath,
  projectPath,
  getParam,
  overrides = {},
  reservedEnvKeys = [],
} = {}) => {
  const get =
    getParam ?? defaultGetParam(new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' }));

  // 2. Refs from survivors only.
  const globalRefs = extractSecretRefs(survivingGlobal).refs;
  const projectRefs = extractSecretRefs(survivingProject).refs;

  // 2b. Reserved-name guard (fail closed). A ref may NOT shadow a reserved child
  // env key — otherwise the CLI's `${VAR}` expansion could resolve a platform
  // auth token (or the injection order could clobber the tier's SSM value). This
  // is independent of env merge ordering ON PURPOSE.
  const reserved = new Set([...RESERVED_MCP_ENV_KEYS, ...reservedEnvKeys]);
  for (const name of [...globalRefs, ...projectRefs]) {
    if (reserved.has(name)) {
      throw new Error(
        `MCP secret reference \`\${${name}}\` uses a reserved runtime variable name and is not ` +
          `allowed — it would collide with the agent's own environment (e.g. platform auth). ` +
          `Rename the variable to something server-specific (e.g. \`\${MYSERVER_API_KEY}\`).`,
      );
    }
  }

  // 3. Flat-env collision guard. The overridden-same-name case is naturally
  // excluded: the overridden global server is not in survivingGlobal, so its refs
  // are not in globalRefs.
  for (const name of globalRefs) {
    if (projectRefs.has(name)) {
      throw new Error(
        `MCP secret reference \`\${${name}}\` is used by BOTH a platform-wide server and a ` +
          `project server. The same variable name cannot carry two tier values — rename one, ` +
          `or override the platform server by name.`,
      );
    }
  }

  const secretEnv = {};
  const overrideGlobal = overrides.global ?? {};
  const overrideProject = overrides.project ?? {};

  // 4. Resolve, tier-bound. No cross-tier fallback. Override (just-typed) value
  // for the tier takes precedence over the saved SSM value; a missing value in the
  // ref's own tier is a hard error.
  const resolveTier = async (refs, pathFor, override, tierLabel) => {
    for (const name of refs) {
      if (Object.prototype.hasOwnProperty.call(override, name)) {
        secretEnv[name] = override[name];
        continue;
      }
      const value = await get(pathFor(name));
      if (value === null || value === undefined) {
        throw new Error(
          `MCP secret \`\${${name}}\` referenced by a ${tierLabel} server is not set. ` +
            `Enter it in the field above (or Save it), then retry.`,
        );
      }
      secretEnv[name] = value;
    }
  };

  await resolveTier(globalRefs, globalPath, overrideGlobal, 'platform-wide');
  await resolveTier(projectRefs, projectPath, overrideProject, 'project');

  return { secretEnv };
};

export default { computeSurvivors, resolveMcpSecrets, RESERVED_MCP_ENV_KEYS };
