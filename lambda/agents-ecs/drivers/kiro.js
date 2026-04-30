// Driver: Kiro CLI (kiro-cli)
// Handles authentication, settings, ACP command, and steering paths for the Kiro agent CLI.
//
// Authentication: KIRO_API_KEY loaded from SSM Parameter Store at startup.
//   The API key is set via the Admin UI and stored as a SecureString in SSM.
//   authenticate() loads the key, caches it, and verifies it with `kiro-cli whoami`.
// Steering: reads from .kiro/steering/ — the native format.
// ACP: kiro-cli acp (JSON-RPC 2.0 over stdio)

'use strict';

const { execSync, execFileSync } = require('child_process');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

// ---------------------------------------------------------------------------
// Identity (used by entrypoint to self-describe)
// ---------------------------------------------------------------------------

const CLI_NAME = 'kiro';
const CLI_DISPLAY = 'Kiro';

// ---------------------------------------------------------------------------
// Cached API key (loaded once from SSM during authenticate())
// ---------------------------------------------------------------------------

let _cachedKiroApiKey = null;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Load KIRO_API_KEY from SSM, cache it, and verify with `kiro-cli whoami`.
 *
 * Follows the same pattern as the Claude driver (BEDROCK_BEARER_TOKEN_SSM_PATH):
 * read from SSM once, cache in module-level variable, inject into ACP subprocess.
 *
 * @param {object} env - process.env
 */
async function authenticate(env) {
  // Load API key from SSM if not yet cached
  const ssmPath = env.KIRO_API_KEY_SSM_PATH;
  if (ssmPath && _cachedKiroApiKey === null) {
    try {
      const ssm = new SSMClient({ region: env.AWS_REGION || 'us-east-1' });
      const result = await ssm.send(new GetParameterCommand({ Name: ssmPath, WithDecryption: true }));
      const value = result.Parameter?.Value || '';
      // 'placeholder' is the sentinel stored by Terraform when no key is set
      _cachedKiroApiKey = (value && value !== 'placeholder') ? value : '';
      if (_cachedKiroApiKey) {
        console.log('[driver:kiro] KIRO_API_KEY loaded from SSM');
      } else {
        console.log('[driver:kiro] No API key in SSM');
      }
    } catch (err) {
      console.warn('[driver:kiro] Could not load API key from SSM:', err.message);
      _cachedKiroApiKey = '';
    }
  }

  if (!_cachedKiroApiKey) {
    throw new Error('No KIRO_API_KEY configured — set one in the Admin → Agent Settings page.');
  }

  // Verify the API key works
  try {
    execFileSync('kiro-cli', ['whoami'], {
      stdio: 'pipe',
      env: { ...process.env, KIRO_API_KEY: _cachedKiroApiKey },
    });
  } catch (err) {
    throw new Error('kiro-cli whoami failed — the configured KIRO_API_KEY is invalid or expired. ' + (err.message || ''));
  }

  console.log('[driver:kiro] Authenticated via API key');
  return true;
}

// ---------------------------------------------------------------------------
// Post-auth settings configuration
// ---------------------------------------------------------------------------

/**
 * Configure kiro-cli settings after authentication.
 * Called by entrypoint.js after authenticate() succeeds.
 */
function configureSettings(env) {
  if (env.KIRO_MODEL) {
    console.log(`[driver:kiro] Setting model: ${env.KIRO_MODEL}`);
    try {
      execSync(`kiro-cli settings chat.defaultModel "${env.KIRO_MODEL}" --global`, { stdio: 'inherit' });
    } catch (err) {
      console.error('[driver:kiro] Failed to set model:', err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// ACP process
// ---------------------------------------------------------------------------

/**
 * Returns the command + args to spawn for the ACP process.
 */
function getAcpCommand() {
  return ['kiro-cli', 'acp'];
}

/**
 * Returns additional environment variables to pass to the spawned ACP process.
 * These are merged on top of the base env in acp-client.js.
 */
function getEnvForAcpProcess(baseEnv) {
  const extra = {
    KIRO_LOG_LEVEL: 'debug',
  };
  if (_cachedKiroApiKey) {
    extra.KIRO_API_KEY = _cachedKiroApiKey;
  }
  return extra;
}

// ---------------------------------------------------------------------------
// Steering file paths
// ---------------------------------------------------------------------------

/**
 * Returns additional workspace paths to copy steering content to,
 * beyond the base .kiro/steering/ directory (which pool-worker handles).
 *
 * For Kiro, .kiro/steering/ is the native location — no extra copies needed.
 *
 * @param {string} workspaceDir - absolute path to the workspace root
 * @returns {Array<{type: 'dir'|'file', dest: string}>}
 */
function getAdditionalSteeringPaths(workspaceDir) {
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
  getAdditionalSteeringPaths,
};
