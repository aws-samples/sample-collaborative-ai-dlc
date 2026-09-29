// Resolves WHERE an intent's runtime sessions live from the execution META row.
//
// The environment snapshot stamped on META at intent creation is the source of
// truth: runtime ARN + endpoint (which runtime version serves the intent) and,
// for revisions hosted on the AgentCore Instances compute type, the capacity
// provider that owns the sessions' persistent EBS volumes. Callers that only
// need SDK input use runtimeTargetInput; callers that manage session lifecycle
// (shared/runtime-session.js) read capacityProviderArn from the full target.
export const resolveRuntimeTarget = (meta, fallbackRuntimeArn = '') => {
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

export default { resolveRuntimeTarget, runtimeTargetInput };
