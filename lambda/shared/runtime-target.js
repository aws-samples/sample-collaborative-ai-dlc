import { executionBackend } from './execution-backend.js';

// Resolves WHERE an intent's runtime sessions live from the execution META row.
//
// The environment snapshot stamped on META at intent creation is the source of
// truth: runtime ARN + endpoint (which runtime version serves the intent) and,
// for revisions hosted on the AgentCore Instances compute type, the capacity
// provider that owns the sessions' persistent EBS volumes. Callers that only
// need SDK input use runtimeTargetInput; callers that manage session lifecycle
// (shared/runtime-session.js) read capacityProviderArn from the full target.
export const resolveRuntimeTarget = (meta, fallbackRuntimeArn = '') => {
  // This is the platform resolver. Native runtime authority must come from
  // the protected per-run binding, never agent-writable META or the fallback.
  const backend = executionBackend(meta);
  if (backend !== 'platform') {
    throw Object.assign(
      new Error(
        backend === 'native'
          ? 'Native execution requires its protected runtime binding'
          : 'Stored execution backend is invalid',
      ),
      {
        code:
          backend === 'native' ? 'native_runtime_binding_required' : 'invalid_execution_backend',
      },
    );
  }
  const snapshot = meta?.environment ?? meta?.environmentSnapshot ?? null;
  return {
    agentRuntimeArn: snapshot?.runtimeArn || fallbackRuntimeArn || '',
    qualifier: snapshot?.runtimeEndpoint || undefined,
    // null on microVM-backed runtimes: their session storage is released by
    // the service, there is no volume to manage.
    capacityProviderArn: snapshot?.capacityProviderArn || null,
  };
};

// SDK-shaped subset ({ agentRuntimeArn, qualifier? }) for Invoke/Stop calls.
export const runtimeTargetInput = (meta, fallbackRuntimeArn = '') => {
  const target = resolveRuntimeTarget(meta, fallbackRuntimeArn);
  return {
    agentRuntimeArn: target.agentRuntimeArn,
    ...(target.qualifier ? { qualifier: target.qualifier } : {}),
  };
};

// SDK input from a full target (drops capacityProviderArn, which the
// Invoke/Stop APIs do not accept).
export const runtimeSdkInput = (target) => ({
  agentRuntimeArn: target?.agentRuntimeArn ?? '',
  ...(target?.qualifier ? { qualifier: target.qualifier } : {}),
});

export default { resolveRuntimeTarget, runtimeTargetInput, runtimeSdkInput };
