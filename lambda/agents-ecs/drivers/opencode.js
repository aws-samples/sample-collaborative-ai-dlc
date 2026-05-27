// Driver: OpenCode CLI (opencode)
// Handles authentication, settings, ACP command, and steering paths for the
// OpenCode agent CLI running against AWS Bedrock.
//
// Authentication: OpenCode requires a Bedrock bearer token stored in SSM
//   (set via Kiro SSO or the Admin UI). The ECS task IAM role does NOT grant
//   Bedrock permissions — the bearer token is the only authentication path.
//   If no token is configured (or the SSM value is "placeholder"), authenticate()
//   throws and OpenCode will not be advertised as available.
// Steering: OpenCode reads from .opencode/instructions.md (single file).
// ACP: opencode acp (JSON-RPC 2.0 over stdio — same protocol as kiro-cli)

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const CLI_NAME = 'opencode';
const CLI_DISPLAY = 'OpenCode';

// OpenCode global config location
const OPENCODE_CONFIG_DIR = path.join(process.env.HOME || '/root', '.config', 'opencode');
const OPENCODE_CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');

// Module-level cache for the bearer token (populated by authenticate())
let _cachedBearerToken = null;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Write the opencode.json provider config for amazon-bedrock, optionally load
 * a bearer token from SSM, and verify the opencode CLI is available.
 *
 * Called by pool-worker.js at startup — idempotent.
 */
async function authenticate(env) {
  if (!env.AWS_REGION && !env.BEDROCK_REGION) {
    throw new Error('[driver:opencode] AWS_REGION (or BEDROCK_REGION) must be set for Bedrock');
  }

  const region = env.BEDROCK_REGION || env.AWS_REGION || 'us-east-1';
  const model =
    env.OPENCODE_MODEL || env.BEDROCK_MODEL || 'amazon-bedrock/us.anthropic.claude-sonnet-4-6';

  // Load bearer token from SSM if configured (set via Kiro SSO or Admin UI)
  // REQUIRED: the ECS task IAM role does not grant Bedrock permissions.
  // If no token is set, OpenCode cannot authenticate — throw to mark as unavailable.
  const ssmPath = env.BEDROCK_BEARER_TOKEN_SSM_PATH;
  if (ssmPath && _cachedBearerToken === null) {
    try {
      const ssm = new SSMClient({ region });
      const result = await ssm.send(
        new GetParameterCommand({ Name: ssmPath, WithDecryption: true }),
      );
      const value = result.Parameter?.Value || '';
      _cachedBearerToken = value && value !== 'placeholder' ? value : '';
      if (_cachedBearerToken) {
        console.log('[driver:opencode] Bedrock bearer token loaded from SSM');
      } else {
        console.log('[driver:opencode] No bearer token in SSM');
      }
    } catch (err) {
      console.warn('[driver:opencode] Could not load bearer token from SSM:', err.message);
      _cachedBearerToken = '';
    }
  }

  if (!_cachedBearerToken) {
    throw new Error(
      '[driver:opencode] No Bedrock bearer token configured — set one via Kiro SSO login or the Admin UI settings. OpenCode requires a bearer token; IAM role auth is not supported.',
    );
  }

  // Write global opencode.json configuring the amazon-bedrock provider
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      'amazon-bedrock': {
        options: { region },
      },
    },
    model,
  };

  try {
    fs.mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(OPENCODE_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log(
      `[driver:opencode] Wrote config to ${OPENCODE_CONFIG_FILE} (region=${region}, model=${model})`,
    );
  } catch (err) {
    throw new Error(`[driver:opencode] Failed to write opencode.json: ${err.message}`);
  }

  // Verify `opencode` CLI is present and executable
  try {
    execFileSync('opencode', ['--version'], { stdio: 'pipe' });
  } catch {
    throw new Error('[driver:opencode] "opencode" CLI not found or not executable');
  }

  console.log('[driver:opencode] Authentication ready (bearer token from SSM)');
  return true;
}

// ---------------------------------------------------------------------------
// Post-auth settings configuration
// ---------------------------------------------------------------------------

/**
 * No additional configuration needed — opencode.json written during
 * authenticate() covers provider, region, and model selection.
 */
function configureSettings(_env) {
  console.log(
    '[driver:opencode] configureSettings: Bedrock config already applied via opencode.json',
  );
}

// ---------------------------------------------------------------------------
// ACP process
// ---------------------------------------------------------------------------

/**
 * Returns the command + args to spawn for the ACP process.
 */
function getAcpCommand() {
  return ['opencode', 'acp'];
}

/**
 * Returns environment variables to pass to the spawned ACP process.
 *
 * AWS_REGION                 — passed explicitly; some SDK paths require it.
 * AWS_BEARER_TOKEN_BEDROCK   — injected when set via Admin UI; per OpenCode's
 *                              auth priority this takes precedence over the
 *                              AWS credential chain.
 */
function getEnvForAcpProcess(baseEnv) {
  const region = baseEnv.BEDROCK_REGION || baseEnv.AWS_REGION || 'us-east-1';
  const extra = { AWS_REGION: region };

  if (_cachedBearerToken) {
    extra.AWS_BEARER_TOKEN_BEDROCK = _cachedBearerToken;
  }

  return extra;
}

// ---------------------------------------------------------------------------
// Project-level config override
// ---------------------------------------------------------------------------

/**
 * Write a .opencode/opencode.json inside the workspace so that any repo-level
 * config (e.g. one pointing at opencode/big-pickle) is overridden by the
 * Bedrock provider and model we actually want to use.
 *
 * OpenCode merges configs in order: global → project. By writing this file
 * AFTER cloning the repo, we guarantee the correct provider wins regardless
 * of what the target repository ships.
 */
function writeProjectConfig(workspaceDir, env) {
  const region = (env && (env.BEDROCK_REGION || env.AWS_REGION)) || 'us-east-1';
  const model =
    (env && (env.OPENCODE_MODEL || env.BEDROCK_MODEL)) ||
    'amazon-bedrock/us.anthropic.claude-sonnet-4-6';

  const configDir = path.join(workspaceDir, '.opencode');
  const configFile = path.join(configDir, 'opencode.json');

  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      'amazon-bedrock': {
        options: { region },
      },
    },
    model,
    instructions: ['.opencode/rules/*.md'],
  };

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
    console.log(
      `[driver:opencode] Wrote project config to ${configFile} (region=${region}, model=${model})`,
    );
  } catch (err) {
    console.error(`[driver:opencode] Failed to write project config: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Steering file paths
// ---------------------------------------------------------------------------

/**
 * Returns the path of the always-loaded entry-point file for this driver.
 * OpenCode reads AGENTS.md from the workspace root natively.
 *
 * @param {string} workspaceDir - absolute path to the workspace root
 * @returns {string}
 */
function getEntryPointPath(workspaceDir) {
  return path.join(workspaceDir, 'AGENTS.md');
}

/**
 * Returns the directory where modular rule files go for this driver.
 * OpenCode loads these via the `instructions` glob in opencode.json.
 *
 * @param {string} workspaceDir - absolute path to the workspace root
 * @returns {string}
 */
function getRulesDir(workspaceDir) {
  return path.join(workspaceDir, '.opencode', 'rules');
}

/**
 * OpenCode reads project instructions from AGENTS.md and .opencode/rules/*.md
 * (via the instructions glob in opencode.json written by writeProjectConfig).
 * The entry-point and rules directory are now written directly by pool-worker
 * via getEntryPointPath() / getRulesDir(). The concat-dir mechanism is
 * retired — returns [] going forward.
 */
function getAdditionalSteeringPaths(_workspaceDir) {
  return [];
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

module.exports = {
  CLI_NAME,
  CLI_DISPLAY,
  authenticate,
  configureSettings,
  getAcpCommand,
  getEnvForAcpProcess,
  writeProjectConfig,
  getEntryPointPath,
  getRulesDir,
  getAdditionalSteeringPaths,
};
