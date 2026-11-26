import http from 'node:http';
import { createNativeWorkspaceCheck } from './workspace-check.js';

export const NATIVE_RUNTIME_MAX_BODY = 256 * 1024;
const IDENTITY = [
  'projectId',
  'executionId',
  'bindingId',
  'attemptId',
  'epoch',
  'runtimeSessionId',
];
const identityFor = (env) => ({
  projectId: env.NATIVE_RUNTIME_PROJECT_ID,
  executionId: env.NATIVE_RUNTIME_EXECUTION_ID,
  bindingId: env.NATIVE_RUNTIME_BINDING_ID,
  attemptId: env.NATIVE_EXECUTION_ATTEMPT_ID,
  epoch: Number(env.NATIVE_EXECUTION_EPOCH),
  runtimeSessionId: env.NATIVE_EXECUTION_RUNTIME_SESSION_ID,
});
const executionIdentityValid = (identity) =>
  identity.epoch === 1 &&
  IDENTITY.filter((key) => key !== 'epoch').every(
    (key) =>
      typeof identity[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(identity[key]),
  );
// Preparation-only images do not import SDKs, credential helpers, execution
// modules or create their clients. Production ports are loaded on first use.
const loadExecutor = async (env) => {
  const [{ createNativeExecutor }, { createNativeExecutionPorts }] = await Promise.all([
    import('./executor.js'),
    import('./execution-prepare.js'),
  ]);
  return createNativeExecutor({ env, ...createNativeExecutionPorts({ env }) });
};
const codes = new Set([
  'native_workspace_scope_mismatch',
  'native_workspace_check_busy',
  'native_workspace_owner_mismatch',
  'native_control_directory_invalid',
  'native_control_directory_changed',
  'native_workspace_check_residue',
  'native_workspace_file_invalid',
  'native_workspace_hardlink_failed',
  'native_workspace_rename_failed',
  'native_workspace_readback_failed',
]);
const executionErrors = new Map([
  ['native_execution_scope_mismatch', 400],
  ['native_execution_request_invalid', 400],
  ['native_execution_configuration_invalid', 400],
  ['native_execution_owner_conflict', 409],
  ['native_execution_busy', 409],
  ['native_execution_existing_owner', 409],
  ['native_execution_start_failed', 500],
  ['native_execution_local_record_unavailable', 409],
  ['native_execution_reply_conflict', 409],
  ['native_execution_cancelled', 409],
  ['native_execution_reply_admission_unconfirmed', 409],
]);

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      chunks.length = 0;
      reject(new Error('invalid_request'));
    };
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > NATIVE_RUNTIME_MAX_BODY) return fail();
      if (!failed) chunks.push(chunk);
    });
    request.on('error', fail);
    request.on('aborted', fail);
    request.on('end', () => {
      if (failed) return;
      try {
        const payload = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        );
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail();
        resolve(payload);
      } catch {
        fail();
      }
    });
  });

export const createNativeRuntimeServer = ({
  env = process.env,
  checkWorkspace = createNativeWorkspaceCheck({ env }),
  createExecutor = loadExecutor,
} = {}) => {
  const enabled = env.NATIVE_EXECUTION_ENABLED === 'true';
  const identity = identityFor(env);
  if (enabled && !executionIdentityValid(identity))
    throw new Error('native_execution_options_invalid');
  let executor;
  let executorPromise;
  const getExecutor = async () => {
    executorPromise ??= Promise.resolve()
      .then(() => createExecutor(env))
      .then((created) => {
        if (
          !created ||
          !['start', 'continue', 'status', 'cancel', 'isBusy', 'settle'].every(
            (key) => typeof created[key] === 'function',
          )
        )
          throw new Error('native_execution_options_invalid');
        executor = created;
        return executor;
      });
    return executorPromise;
  };
  let startRequests = 0;
  let busy = false;
  const server = http.createServer(async (request, response) => {
    const send = (status, body) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && request.url === '/ping') {
      return send(200, {
        status: busy || startRequests > 0 || executor?.isBusy() ? 'HealthyBusy' : 'Healthy',
      });
    }
    if (request.method !== 'POST' || request.url !== '/invocations') {
      return send(404, { ok: false, code: 'not_found' });
    }
    let payload;
    try {
      payload = await readBody(request);
    } catch {
      return send(400, { ok: false, code: 'invalid_request' });
    }
    if (
      ['native-start', 'native-continue', 'native-status', 'native-cancel'].includes(
        payload.command,
      )
    ) {
      if (!enabled) return send(403, { ok: false, code: 'native_execution_disabled' });
      if (IDENTITY.some((key) => payload[key] !== identity[key]))
        return send(400, { ok: false, code: 'native_execution_scope_mismatch' });
      const starting = ['native-start', 'native-continue'].includes(payload.command);
      if (
        starting
          ? payload.schemaVersion !== 1
          : Object.keys(payload).some((key) => !['command', ...IDENTITY].includes(key))
      )
        return send(400, { ok: false, code: 'native_execution_request_invalid' });
      if (busy) return send(409, { ok: false, code: 'native_workspace_check_busy' });
      if (starting) startRequests++;
      try {
        const active = await getExecutor();
        const method = starting
          ? payload.command === 'native-start'
            ? 'start'
            : 'continue'
          : payload.command === 'native-status'
            ? 'status'
            : 'cancel';
        return send(200, await active[method](payload));
      } catch (error) {
        const code = executionErrors.has(error?.code) ? error.code : 'native_execution_failed';
        return send(executionErrors.get(code) ?? 500, { ok: false, code });
      } finally {
        if (starting) startRequests--;
      }
    }
    if (payload.command !== 'native-workspace-check')
      return send(400, { ok: false, code: 'native_workspace_scope_mismatch' });
    if (busy || startRequests > 0 || executor?.isBusy())
      return send(409, { ok: false, code: 'native_workspace_check_busy' });
    busy = true;
    try {
      send(200, await checkWorkspace(payload));
    } catch (error) {
      const code = codes.has(error?.code) ? error.code : 'native_workspace_check_failed';
      send(code === 'native_workspace_scope_mismatch' ? 400 : 500, { ok: false, code });
    } finally {
      busy = false;
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 32;
  return server;
};

export const startNativeRuntimeServer = async () => {
  const server = createNativeRuntimeServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(8080, '0.0.0.0', resolve);
  });
  return server;
};
