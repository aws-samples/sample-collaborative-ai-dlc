export const resolveRuntimeTarget = (meta, fallbackRuntimeArn = '') => {
  const snapshot = meta?.environment ?? meta?.environmentSnapshot ?? null;
  return {
    agentRuntimeArn: snapshot?.runtimeArn || fallbackRuntimeArn || '',
    qualifier: snapshot?.runtimeEndpoint || undefined,
  };
};

export const runtimeTargetInput = (meta, fallbackRuntimeArn = '') => {
  const target = resolveRuntimeTarget(meta, fallbackRuntimeArn);
  return {
    agentRuntimeArn: target.agentRuntimeArn,
    ...(target.qualifier ? { qualifier: target.qualifier } : {}),
  };
};

export default { resolveRuntimeTarget, runtimeTargetInput };
