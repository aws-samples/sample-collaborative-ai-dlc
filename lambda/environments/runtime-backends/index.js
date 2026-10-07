// The one dispatch on compute type. index.js and status.js ask for the backend
// of an environment and then only talk to the backend contract:
//
//   backend.type / backend.architecture
//   backend.build.platform                  IMAGE_PLATFORM for the image build
//   backend.build.codeBuildOverrides        StartBuild overrides (fleet/image)
//   backend.prepareRuntime({ controlClient })
//       → { pending: true } | { pending: false, runtimeParams, capacityProviderArn }
//   backend.validation.reuseSession         one session per revision vs per poll
//   backend.validation.maxAttempts          retry budget for transient invokes
//   backend.validation.isTransientInvokeError(error)
//   backend.releaseValidationSession({ runtimeClient, revision, sessionId, cleanupStore, environmentId })
//       resolves once the session is released or durably queued; throws
//       SessionReleaseHandoffError otherwise (the caller keeps the session id)
//
// Adding a compute type means adding a file here, not editing the poller.

import { computeOf } from '../compute-model.js';
import { createInstancesBackend } from './instances.js';
import { createMicrovmsBackend } from './microvms.js';

const FACTORIES = {
  microvms: createMicrovmsBackend,
  instances: createInstancesBackend,
};

export const runtimeBackendFor = (environment) => {
  const { type, architecture } = computeOf(environment);
  const factory = FACTORIES[type];
  if (!factory) throw new Error(`Unknown compute type: ${type}`);
  return factory({ architecture });
};

export default { runtimeBackendFor };
