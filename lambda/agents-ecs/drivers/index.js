// Driver registry — discovers and loads agent CLI drivers.
//
// At startup, pool-worker calls discoverInstalledDrivers() which probes every
// known driver to see if its CLI binary is present on PATH. Only installed CLIs
// are attempted — no environment variable or deploy-time configuration needed.
//
// All drivers must implement:
//   authenticate(env)              — CLI auth (SSM key, bearer token, etc.)
//   configureSettings(env)         — post-auth settings
//   getMode()                      — 'acp' (JSON-RPC stdio) | 'print' (one-shot -p flag)
//   getAcpCommand()                — command + args to spawn
//   getEnvForAcpProcess(baseEnv)   — extra env vars for the spawned process
//   getAdditionalSteeringPaths(workspaceDir)
//
// Each driver may optionally implement:
//   isInstalled()                  — returns true if the CLI binary is present.
//                                    If not implemented, the driver is always attempted.

'use strict';

const { execFileSync } = require('child_process');

const kiro = require('./kiro');
const claude = require('./claude');
const opencode = require('./opencode');

const DRIVERS = { kiro, claude, opencode };
const SUPPORTED_DRIVERS = Object.keys(DRIVERS);

function getDriver(cliName) {
  const name = (cliName || '').toLowerCase().trim();
  const driver = DRIVERS[name];
  if (!driver) {
    throw new Error(`[drivers] Unknown CLI driver "${name}"`);
  }
  // Default getMode() to 'acp' for drivers that don't declare it
  if (!driver.getMode) driver.getMode = () => 'acp';
  return driver;
}

/**
 * Probe every known driver and return the names of those whose CLI binary
 * is present on PATH. Called once at pool-worker startup — no env var needed.
 */
function discoverInstalledDrivers() {
  const installed = [];
  for (const [name, driver] of Object.entries(DRIVERS)) {
    try {
      if (!driver.getMode) driver.getMode = () => 'acp';

      if (typeof driver.isInstalled === 'function') {
        if (driver.isInstalled()) installed.push(name);
      } else {
        // Fall back to probing the first word of the ACP command
        const cmd = driver.getAcpCommand?.()[0];
        if (cmd) {
          execFileSync('which', [cmd], { stdio: 'pipe' });
          installed.push(name);
        }
      }
    } catch (_) {
      // Binary not found — skip silently
    }
  }
  return installed;
}

function getSupportedDriverNames() {
  return [...SUPPORTED_DRIVERS];
}

module.exports = { getDriver, discoverInstalledDrivers, getSupportedDriverNames };
