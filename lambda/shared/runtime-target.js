import { executionBackend } from './execution-backend.js';

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
