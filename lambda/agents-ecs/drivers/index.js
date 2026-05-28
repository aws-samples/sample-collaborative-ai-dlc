// Driver registry — discovers and loads agent CLI drivers.
//
// At startup, pool-worker calls discoverInstalledDrivers() which probes every
// known driver to see if its CLI binary is present on PATH. Only installed CLIs
// are attempted — no environment variable or deploy-time configuration needed.
//
// All drivers must implement:
//   authenticate(env)              — CLI auth (SSM key, bearer token, etc.)
//   configureSettings(env)         — post-auth settings
//   getAcpCommand()                — command + args to spawn
//   getEnvForAcpProcess(baseEnv)   — extra env vars for the spawned process
//   getRulesDir(workspaceDir)      — absolute path of the directory holding modular rule files
//
// Each driver may optionally implement (defaults supplied by applyDefaults):
//   getMode()                      — defaults to 'acp' (JSON-RPC stdio); other valid value: 'print'
//   getEntryPointPath(workspaceDir) — defaults to <workspaceDir>/AGENTS.md
//   isInstalled()                  — returns true if the CLI binary is present.
//                                    If not implemented, the driver is probed via `which` on getAcpCommand()[0].

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const kiro = require('./kiro');
const claude = require('./claude');
const opencode = require('./opencode');

const DRIVERS = { kiro, claude, opencode };
const SUPPORTED_DRIVERS = Object.keys(DRIVERS);

// Default implementations applied to every driver that does not provide its own.
// Drivers may override any of these by exporting a function with the same name.
const DEFAULTS = {
  getMode: () => 'acp',
  getEntryPointPath: (workspaceDir) => path.join(workspaceDir, 'AGENTS.md'),
};

// Mutate the driver module to fill in any missing default methods. Idempotent —
// each driver module is a Node singleton, so applying defaults more than once
// is a no-op after the first call.
function applyDefaults(driver) {
  for (const [name, impl] of Object.entries(DEFAULTS)) {
    if (typeof driver[name] !== 'function') driver[name] = impl;
  }
  return driver;
}

function getDriver(cliName) {
  const name = (cliName || '').toLowerCase().trim();
  const driver = DRIVERS[name];
  if (!driver) {
    throw new Error(`[drivers] Unknown CLI driver "${name}"`);
  }
  return applyDefaults(driver);
}

/**
 * Probe every known driver and return the names of those whose CLI binary
 * is present on PATH. Called once at pool-worker startup — no env var needed.
 */
function discoverInstalledDrivers() {
  const installed = [];
  for (const [name, driver] of Object.entries(DRIVERS)) {
    try {
      applyDefaults(driver);

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
    } catch {
      // Binary not found — skip silently
    }
  }
  return installed;
}

function getSupportedDriverNames() {
  return [...SUPPORTED_DRIVERS];
}

module.exports = { getDriver, discoverInstalledDrivers, getSupportedDriverNames };
