// Runtime backend: AgentCore Instances (EC2 managed instances in this account,
// arm64 or x86_64).
//
// Runtime input: the per-architecture capacity provider (created lazily) and
// the persistent EBS volume it declares, mounted at /mnt/workspace in place of
// managed session storage. No networkConfiguration — the runtime inherits the
// provider's VPC and the control plane rejects both together.
//
// Validation sessions: the first invocation of an Instances runtime provisions
// an EC2 instance and can exceed client timeouts while it boots, so ONE session
// per revision is reused across polls (a new session per poll would restart the
// cold start every time and stop the instance that was provisioning). The
// retry budget is bounded. A session keeps its EBS volume across stop/idle/
// lifetime, so ending a validation attempt RELEASES the session through the
// shared runtime-session module — a failed release is queued for retry there.

import { releaseSession, stopSession } from '../../shared/runtime-session.js';
import { WORKSPACE_VOLUME_NAME, ensureCapacityProvider } from './capacity-provider.js';

// Invoke errors that mean "the instance is still coming up" rather than "the
// runtime is broken". The poller adds its own control-plane transients.
export const INSTANCES_TRANSIENT_ERRORS = new Set([
  'TimeoutError',
  'RequestTimeout',
  'ServiceUnavailableException',
  'RuntimeClientError',
]);

export const createInstancesBackend = ({ architecture = 'x86_64' } = {}) => ({
  type: 'instances',
  architecture,

  build: {
    platform: architecture === 'x86_64' ? 'linux/amd64' : 'linux/arm64',
    // One CodeBuild project serves both architectures: the default fleet is
    // arm64, x86_64 builds run on an x86 fleet via per-build overrides.
    codeBuildOverrides:
      architecture === 'x86_64'
        ? {
            environmentTypeOverride: 'LINUX_CONTAINER',
            imageOverride: 'aws/codebuild/amazonlinux-x86_64-standard:5.0',
          }
        : {},
  },

  // Returns { pending: true } while the capacity provider is still CREATING so
  // the poller re-enters on the next tick; throws when creation failed.
  async prepareRuntime({ controlClient }) {
    const provider = await ensureCapacityProvider({ controlClient, architecture });
    if (provider.pending) return { pending: true };
    return {
      pending: false,
      capacityProviderArn: provider.capacityProviderArn,
      runtimeParams: {
        capacityProviderConfiguration: { capacityProviderArn: provider.capacityProviderArn },
        filesystemConfigurations: [
          {
            capacityProviderVolume: {
              volumeName: WORKSPACE_VOLUME_NAME,
              mountPath: '/mnt/workspace',
            },
          },
        ],
      },
    };
  },

  validation: {
    reuseSession: true,
    // The poller runs every minute.
    maxAttempts: Number(process.env.MANAGED_INSTANCES_VALIDATION_MAX_POLLS || 30),
    isTransientInvokeError: (error) => INSTANCES_TRANSIENT_ERRORS.has(error?.name),
  },

  // End of a validation attempt on a terminal outcome: stop, then delete the
  // session so its EBS volume goes with it. Validation sessions are
  // disposable — see the retention policy in shared/runtime-session.js.
  async releaseValidationSession({
    runtimeClient,
    revision,
    sessionId,
    cleanupStore,
    environmentId,
  }) {
    await stopSession({
      client: runtimeClient,
      target: { agentRuntimeArn: revision.runtimeArn, qualifier: revision.runtimeEndpoint },
      sessionId,
    });
    const outcome = await releaseSession({
      client: runtimeClient,
      capacityProviderArn: revision.capacityProviderArn,
      sessionId,
      cleanupStore,
      source: 'environment-validation',
      context: { environmentId, revisionId: revision.revisionId },
    });
    return { ...outcome, retained: !outcome.released };
  },
});

export default { createInstancesBackend, INSTANCES_TRANSIENT_ERRORS };
