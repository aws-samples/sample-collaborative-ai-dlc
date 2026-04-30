// Driver: Claude Agent ACP (@zed-industries/claude-agent-acp)
// Handles authentication, settings, ACP command, and steering paths for the
// Claude agent running via the Zed claude-agent-acp ACP adapter.
//
// Authentication: Requires a Bedrock bearer token stored in SSM (set via Kiro SSO
//   or the Admin UI). The ECS task IAM role does NOT grant Bedrock permissions —
//   the bearer token is the only authentication path. If no token is configured
//   (or the SSM value is "placeholder"), authenticate() throws and Claude will not
//   be advertised as available.
// Steering: claude-agent-acp reads from .claude/CLAUDE.md (single file).
// ACP: claude-agent-acp (JSON-RPC 2.0 over stdio — same protocol as kiro-cli)

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const CLI_NAME = 'claude';
const CLI_DISPLAY = 'Claude';

// Module-level cache for the bearer token (populated by authenticate())
let _cachedBearerToken = null;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Pre-seed ~/.claude.json so the Claude Agent SDK skips the interactive
 * onboarding flow. Without this, the SDK may prompt for login or block
 * on first-run checks when running non-interactively in ECS.
 *
 * The file only needs to exist with hasCompletedOnboarding=true.
 * The actual auth credentials come from AWS_BEARER_TOKEN_BEDROCK +
 * CLAUDE_CODE_USE_BEDROCK=1 env vars set at ACP spawn time.
 */
function _preseedClaudeJson() {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(claudeJsonPath)) {
    try {
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        hasCompletedOnboarding: true,
        // installMethod tells Claude Code it was installed as a package (not CLI login)
        installMethod: 'package',
        // numStartups > 0 prevents first-run prompts
        numStartups: 1,
      }, null, 2), 'utf8');
      console.log('[driver:claude] Pre-seeded ~/.claude.json (hasCompletedOnboarding=true)');
    } catch (err) {
      // Non-fatal: if we can't write, the SDK will create its own file or error
      console.warn('[driver:claude] Could not pre-seed ~/.claude.json:', err.message);
    }
  }
}

/**
 * Verify claude-agent-acp is available, Bedrock env vars are configured, and
 * optionally load a bearer token from SSM (set via the Admin UI).
 *
 * Called by pool-worker.js at startup — idempotent.
 */
async function authenticate(env) {
  if (!env.AWS_REGION && !env.BEDROCK_REGION) {
    throw new Error('[driver:claude] AWS_REGION (or BEDROCK_REGION) must be set for Bedrock');
  }

  // Load bearer token from SSM if configured (set via Kiro SSO or Admin UI)
  // REQUIRED: the ECS task IAM role does not grant Bedrock permissions.
  // If no token is set, Claude cannot authenticate — throw to mark as unavailable.
  const ssmPath = env.BEDROCK_BEARER_TOKEN_SSM_PATH;
  if (ssmPath && _cachedBearerToken === null) {
    try {
      const ssm = new SSMClient({ region: env.AWS_REGION || 'us-east-1' });
      const result = await ssm.send(new GetParameterCommand({ Name: ssmPath, WithDecryption: true }));
      const value = result.Parameter?.Value || '';
      // 'placeholder' is the sentinel stored by Terraform when no token is set
      _cachedBearerToken = (value && value !== 'placeholder') ? value : '';
      if (_cachedBearerToken) {
        console.log('[driver:claude] Bedrock bearer token loaded from SSM');
      } else {
        console.log('[driver:claude] No bearer token in SSM');
      }
    } catch (err) {
      console.warn('[driver:claude] Could not load bearer token from SSM:', err.message);
      _cachedBearerToken = '';
    }
  }

  if (!_cachedBearerToken) {
    throw new Error('[driver:claude] No Bedrock bearer token configured — set one via Kiro SSO login or the Admin UI settings. Claude requires a bearer token; IAM role auth is not supported.');
  }

  // Verify claude-agent-acp is present and executable
  try {
    execFileSync('claude-agent-acp', ['--version'], { stdio: 'pipe' });
  } catch (err) {
    throw new Error('[driver:claude] "claude-agent-acp" not found or not executable. Install with: npm install -g @zed-industries/claude-agent-acp');
  }

  // Pre-seed ~/.claude.json to skip interactive onboarding in the non-interactive
  // ECS container. Must be done after token validation so we only write the file
  // when we know the driver is actually going to be used.
  _preseedClaudeJson();

  console.log('[driver:claude] Authentication ready (bearer token from SSM)');
  return true;
}

// ---------------------------------------------------------------------------
// Post-auth settings configuration
// ---------------------------------------------------------------------------

/**
 * All Bedrock config is applied via env vars at ACP spawn time.
 */
function configureSettings(env) {
  console.log('[driver:claude] configureSettings: Bedrock config applied via env vars at ACP spawn time');
}

// ---------------------------------------------------------------------------
// ACP process
// ---------------------------------------------------------------------------

/**
 * Execution mode for acp-client.js: 'acp' — JSON-RPC 2.0 over stdio.
 * claude-agent-acp speaks the same ACP protocol as kiro-cli and opencode.
 */
function getMode() {
  return 'acp';
}

/**
 * Returns the command to spawn in ACP mode.
 */
function getAcpCommand() {
  return ['claude-agent-acp'];
}

/**
 * Returns environment variables to pass to the spawned ACP process.
 *
 * CLAUDE_CODE_USE_BEDROCK=1    — activates Bedrock mode in the underlying claude CLI.
 * AWS_REGION                   — required; claude does not read ~/.aws/config.
 * AWS_BEARER_TOKEN_BEDROCK     — injected when set via Admin UI; takes priority
 *                                over the IAM role credential chain.
 * ANTHROPIC_MODEL              — pinned primary model inference profile ID.
 * ANTHROPIC_SMALL_FAST_MODEL   — pinned small/fast model inference profile ID.
 * IS_SANDBOX=1                 — tells claude-agent-acp that it is running in a
 *                                non-interactive sandbox (ECS runs as root, which
 *                                normally disables bypassPermissions; IS_SANDBOX
 *                                re-enables it so tools are never blocked waiting
 *                                for a human to approve them).
 */
function getEnvForAcpProcess(baseEnv) {
  const region = baseEnv.BEDROCK_REGION || baseEnv.AWS_REGION || 'us-east-1';

  const extra = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: region,
    // ECS tasks run as root; IS_SANDBOX=1 re-enables bypassPermissions so the
    // agent never blocks waiting for a human permission prompt.
    IS_SANDBOX: '1',
    // Suppress non-essential traffic (telemetry, update checks) that would hang
    // in an ECS private subnet with no route to api.anthropic.com.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Skip SigV4 IAM auth on the AWS BedrockRuntimeClient so all Bedrock calls
    // go through the Anthropic SDK path using the bearer token instead of the
    // ECS task role (which intentionally has no Bedrock permissions).
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',

    // -----------------------------------------------------------------------
    // Strip ECS/IAM credential chain variables from the subprocess.
    //
    // claude-agent-acp MUST authenticate to Bedrock exclusively via
    // AWS_BEARER_TOKEN_BEDROCK. If ECS credential chain vars remain in the
    // environment, the AWS SDK resolves IAM credentials from the container
    // metadata service and uses SigV4 signing — which fails because the ECS
    // task role intentionally has no Bedrock permissions.
    //
    // Setting these to empty string causes the AWS SDK v3 credential chain to
    // skip the corresponding providers (empty string is falsy in JS, so checks
    // like `if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)` fail).
    //
    // MCP servers are NOT affected: their env is passed explicitly in the
    // session/new request (graphMcpEnv in acp-client.js), which includes the
    // ECS credential vars needed for Neptune/DynamoDB/Lambda access.
    // -----------------------------------------------------------------------
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: '',
    AWS_CONTAINER_AUTHORIZATION_TOKEN: '',
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    AWS_SESSION_TOKEN: '',
  };

  if (_cachedBearerToken) {
    extra.AWS_BEARER_TOKEN_BEDROCK = _cachedBearerToken;
  }

  // Do NOT forward ANTHROPIC_MODEL or ANTHROPIC_SMALL_FAST_MODEL here.
  // Those are Bedrock inference profile IDs intended for the claude CLI driver.
  // claude-agent-acp uses the Claude Agent SDK, which selects the model from
  // its own list. Passing a Bedrock profile ID (e.g. "us.anthropic.claude-sonnet-4-6")
  // as ANTHROPIC_MODEL causes the SDK to attempt an invalid model and hang.

  return extra;
}

// ---------------------------------------------------------------------------
// Steering file paths
// ---------------------------------------------------------------------------

/**
 * claude-agent-acp reads project instructions from .claude/CLAUDE.md.
 * We concatenate all steering files from .kiro/steering/ into that single file.
 */
function getAdditionalSteeringPaths(workspaceDir) {
  return [
    {
      type: 'concat-dir',
      src: path.join(workspaceDir, '.kiro', 'steering'),
      dest: path.join(workspaceDir, '.claude', 'CLAUDE.md'),
    },
  ];
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

module.exports = {
  CLI_NAME,
  CLI_DISPLAY,
  authenticate,
  configureSettings,
  getMode,
  getAcpCommand,
  getEnvForAcpProcess,
  getAdditionalSteeringPaths,
};
