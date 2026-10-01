// Runtime backend: serverless microVMs (the platform default, arm64).
//
// Runtime input: network placement from the deployment configuration plus
// managed session storage at /mnt/workspace. Validation sessions are cheap to
// start, so each poll uses a fresh one and stops it on any outcome; the service
// releases the session storage itself, there is nothing to release explicitly.

import { stopSession } from '../../shared/runtime-session.js';

const parseJsonEnv = (name, fallback) => {
  try {
    const value = process.env[name];
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

export const createMicrovmsBackend = ({ architecture = 'arm64' } = {}) => ({
  type: 'microvms',
  architecture,

  build: {
    platform: 'linux/arm64',
    // The CodeBuild project's default fleet is arm64 — no overrides.
    codeBuildOverrides: {},
  },

  // Resolves everything CreateAgentRuntime needs from this backend. microVMs
  // have no external dependency to provision, so this never returns pending.
  async prepareRuntime() {
    const networkMode = process.env.MANAGED_RUNTIME_NETWORK_MODE || 'PUBLIC';
    const subnets = parseJsonEnv('MANAGED_RUNTIME_SUBNETS', []);
    const securityGroups = parseJsonEnv('MANAGED_RUNTIME_SECURITY_GROUPS', []);
    return {
      pending: false,
      capacityProviderArn: null,
      runtimeParams: {
        networkConfiguration: {
          networkMode,
          ...(networkMode === 'VPC' ? { networkModeConfig: { subnets, securityGroups } } : {}),
        },
        filesystemConfigurations: [{ sessionStorage: { mountPath: '/mnt/workspace' } }],
      },
    };
  },

  validation: {
    // A new session per poll; nothing to persist between polls.
    reuseSession: false,
    maxAttempts: 1,
    // Only the generic control-plane transients are retried (decided by the
    // poller); a microVM cold start does not exceed client timeouts.
    isTransientInvokeError: () => false,
  },

  // End of a validation attempt: stop the session. Session storage is
  // service-managed — nothing else to do.
  async releaseValidationSession({ runtimeClient, revision, sessionId }) {
    await stopSession({
      client: runtimeClient,
      target: { agentRuntimeArn: revision.runtimeArn, qualifier: revision.runtimeEndpoint },
      sessionId,
    });
    return { released: true, retained: false };
  },
});

export default { createMicrovmsBackend };
