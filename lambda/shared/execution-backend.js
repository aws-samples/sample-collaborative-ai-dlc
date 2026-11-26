// Backend identity is stored on META, never inferred from a workflow or harness.
// Only absent legacy identity defaults to platform; corrupt/unknown values fail
// closed. Capabilities describe backend support, not user permissions/run state.
export const executionBackend = (meta) =>
  meta?.executionBackend === undefined ? 'platform' : meta.executionBackend;

export const isPlatformExecution = (meta) => executionBackend(meta) === 'platform';

export const requireExecutionBackend = (value = 'platform') => {
  if (value !== 'platform' && value !== 'native') {
    throw new TypeError('executionBackend must be "platform" or "native"');
  }
  return value;
};

const PLATFORM_CAPABILITIES = Object.freeze({
  artifactEdit: true,
  artifactVerify: true,
  quorumEdit: true,
  answerRevision: true,
  workflowRewind: true,
  workflowRecompose: true,
  workflowCompose: true,
  unitPullRequests: true,
  parallelUnits: true,
  nativeExport: true,
  derive: true,
  stageSkipping: true,
});

const NATIVE_PILOT_CAPABILITIES = Object.freeze(
  Object.fromEntries(Object.keys(PLATFORM_CAPABILITIES).map((key) => [key, false])),
);

export const executionCapabilities = (meta) =>
  isPlatformExecution(meta) ? PLATFORM_CAPABILITIES : NATIVE_PILOT_CAPABILITIES;

export const executionBackendFields = (meta) => ({
  executionBackend: executionBackend(meta),
  executionCapabilities: executionCapabilities(meta),
});

const failure = (statusCode, code, error, details = {}) => ({
  statusCode,
  body: { error, code, ...details },
});

// Native dispatch does not exist yet. Keep this closed until the package,
// authority boundary, recovery, and all four harnesses have been qualified.
const unavailable = () =>
  failure(409, 'execution_backend_unavailable', 'Native execution is not available yet', {
    executionBackend: 'native',
  });

export const backendSelectionError = (data, meta) => {
  if (!Object.hasOwn(data ?? {}, 'executionBackend')) return null;
  const requested = data.executionBackend;
  if (requested !== 'platform' && requested !== 'native') {
    return failure(
      400,
      'invalid_execution_backend',
      'executionBackend must be "platform" or "native"',
    );
  }
  if (meta && requested !== executionBackend(meta)) {
    return failure(409, 'execution_backend_immutable', 'This execution cannot switch backends');
  }
  return requested === 'native' ? unavailable() : null;
};

const routeCapability = (method, path) => {
  // The feedback GET also refreshes stored provider observations.
  if (path?.endsWith('/feedback')) return 'unitPullRequests';
  if (method === 'GET') return null;
  if (path?.endsWith('/content')) return 'artifactEdit';
  if (path?.endsWith('/verify')) return 'artifactVerify';
  if (path?.endsWith('/quorum-edit') || /\/quorum-edits\/[^/]+\/decision$/.test(path ?? '')) {
    return 'quorumEdit';
  }
  if (path?.endsWith('/revise')) return 'answerRevision';
  if (path?.endsWith('/rewind')) return 'workflowRewind';
  if (path?.endsWith('/recompose')) return 'workflowRecompose';
  if (path?.endsWith('/compose') || path?.endsWith('/compose-report-upload')) {
    return 'workflowCompose';
  }
  if (path?.endsWith('/repair')) return 'parallelUnits';
  if (path?.endsWith('/export')) return 'nativeExport';
  if (path?.endsWith('/derive')) return 'derive';
  return null;
};

// Called after project authorization and a consistent META read, before any
// route can write a gate, mutate files, launch work, or retire an execution.
// New native mutation routes must be explicitly dispatched here when ready.
export const executionRequestError = ({ meta, method, path }) => {
  if (isPlatformExecution(meta)) return null;
  const backend = executionBackend(meta);
  const readOnly =
    (method === 'GET' && !path?.endsWith('/feedback')) ||
    (method === 'POST' && path?.endsWith('/realtime-token'));
  if (readOnly) return null;
  if (backend !== 'native') {
    return failure(409, 'invalid_execution_backend', 'Stored execution backend is invalid');
  }
  const capability = routeCapability(method, path);
  if (capability && !executionCapabilities(meta)[capability]) {
    return failure(
      409,
      'unsupported_execution_capability',
      'This action is not supported by native execution',
      { executionBackend: backend, capability },
    );
  }
  return unavailable();
};
