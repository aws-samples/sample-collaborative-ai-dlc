import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { GetParametersCommand } from '@aws-sdk/client-ssm';
import { issueAgentCredentialGrant } from '../shared/agent-credential-grants.js';
import { credentialProviderForCli } from '../shared/agent-credentials.js';
import { parseCliModels } from '../shared/cli-models.js';

export const NATIVE_INTERACTION_PROBE_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
export const NATIVE_INTERACTION_PROBE_STATUSES = Object.freeze([
  'INITIALIZING',
  'RUNNING',
  'FIRST_TURN_FINISHED',
  'ANSWERING',
  'ANSWER_TURN_FINISHED',
  'FAILED',
  'CANCELLING',
  'CANCELLED',
]);

const EVENT_FIELDS = ['operation', 'action', 'probeId', 'harness'];
const ACTIONS = ['start', 'status', 'answer', 'cancel'];
const HARNESSES = ['claude', 'codex', 'kiro', 'opencode'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_REFUSALS = [
  'probe_not_found',
  'native_probe_disabled',
  'native_probe_platform',
  'native_probe_invalid',
  'native_probe_credential_unavailable',
  'native_probe_session_mismatch',
  'native_probe_runtime_unhealthy',
  'native_probe_not_answerable',
];
const REPORT_FAILURES = [
  'process-cleanup-incomplete',
  'probe_step_failed',
  'evidence_write_failed',
  'workspace_exists_or_unavailable',
  'native_kiro_resume_session_missing',
  'native_kiro_resume_session_mismatch',
  'native_kiro_acp_failed',
];
const failure = (code, error) => ({ ok: false, code, error });
const runtimeFailure = () => failure('native_probe_failed', 'Native interaction probe failed');

const isRecord = (value) =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const parseEvent = (event) => {
  if (!isRecord(event)) return null;
  const fields = Reflect.ownKeys(event);
  // The direct IAM invocation has exactly four scalar fields. In particular,
  // an API Gateway/Function URL envelope, a caller-supplied grant, an answer,
  // or a runtime/project/credential override cannot become a probe invocation.
  if (
    fields.length !== EVENT_FIELDS.length ||
    fields.some(
      (field) =>
        !EVENT_FIELDS.includes(field) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(event, field), 'value'),
    ) ||
    event.operation !== 'native-interaction-probe' ||
    !ACTIONS.includes(event.action) ||
    typeof event.probeId !== 'string' ||
    !UUID_V4.test(event.probeId) ||
    !HARNESSES.includes(event.harness)
  ) {
    return null;
  }
  return {
    action: event.action,
    probeId: event.probeId.toLowerCase(),
    harness: event.harness,
  };
};

const readRuntimeJson = async (body) => {
  // AgentCore's Node SDK response is an async-iterable stream. Do not use
  // transformToString(), which buffers the entire response before a size check.
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new Error('Invalid runtime response');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of body) {
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
      throw new Error('Invalid runtime response');
    }
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    bytes += size;
    if (bytes > NATIVE_INTERACTION_PROBE_OUTPUT_LIMIT_BYTES) {
      throw new Error('Runtime response too large');
    }
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
};

const evidenceFields = (value, fields, grant) => {
  if (!isRecord(value)) throw new Error('Invalid runtime evidence');
  const projected = {};
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue;
    const item = value[field];
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) {
      throw new Error('Invalid runtime evidence');
    }
    projected[field] =
      typeof item === 'string' && typeof grant === 'string' && grant.length > 0
        ? item.replaceAll(grant, '[credential removed]')
        : item;
  }
  return projected;
};

const evidenceArray = (value, limit, project) => {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid runtime evidence');
  return value.map(project);
};

const projectSnapshot = (value, grant) => ({
  ...evidenceFields(value, ['bounded'], grant),
  files: evidenceArray(value.files, 128, (file) =>
    evidenceFields(file, ['path', 'bytes', 'sha256', 'content', 'omitted'], grant),
  ),
});

const projectTurn = (value, grant, harness) => ({
  ...evidenceFields(
    value,
    [
      'kind',
      'assistantText',
      'diagnostics',
      'stdoutTail',
      ...(harness === 'kiro'
        ? [
            'requestedSessionId',
            'observedSessionId',
            'identitySource',
            'requestedModel',
            'observedModel',
            'modelSource',
            'modelVerified',
            'sessionLoadAcknowledged',
            'replayedUserChunks',
            'replayedAssistantChunks',
            'priorPromptObserved',
            'priorAssistantObserved',
            'expectedUserPromptSha256',
            'replayedUserPromptSha256',
            'userPromptSource',
            'expectedAssistantSha256',
            'replayedAssistantSha256',
            'protocolPhase',
            'protocolFailure',
            'transportFailure',
            'rpcErrorCode',
            'stopReason',
          ]
        : []),
    ],
    grant,
  ),
  process: evidenceFields(
    value.process,
    ['exitCode', 'signal', 'timedOut', 'outputLimitExceeded', 'cleanupComplete', 'spawnError'],
    grant,
  ),
  before: projectSnapshot(value.before, grant),
  after: projectSnapshot(value.after, grant),
});

const projectRuntimeResult = (value, { probeId, harness }, grant) => {
  if (isRecord(value) && value.ok === false && RUNTIME_REFUSALS.includes(value.reason)) {
    return { ok: false, reason: value.reason };
  }
  // Model credentials exist only in AgentCore: its native probe must redact
  // them before returning assistant text, diagnostics and artifact snapshots.
  // Keep only the report's known fields, and additionally remove the grant
  // from every forwarded string. Reports remain evidence requiring review.
  if (
    !isRecord(value) ||
    typeof value.ok !== 'boolean' ||
    value.probeId !== probeId ||
    value.harness !== harness ||
    !NATIVE_INTERACTION_PROBE_STATUSES.includes(value.status)
  ) {
    throw new Error('Invalid runtime result');
  }
  const result = evidenceFields(
    value,
    ['ok', 'probeId', 'harness', 'status', 'version', 'packageId', 'model'],
    grant,
  );
  if (!value.ok) result.error = 'Native interaction probe failed';
  if (typeof value.resumable === 'boolean') result.resumable = value.resumable;
  if (typeof value.evidenceTruncated === 'boolean')
    result.evidenceTruncated = value.evidenceTruncated;
  for (const [field, expected] of Object.entries({
    experiment: 'native-question-answer-v1',
    qualification: 'requires-evidence-review',
    humanAuthority: 'not-tested-synthetic-operator-fixture',
    recovery: 'not-tested',
  })) {
    if (value[field] !== undefined) {
      if (value[field] !== expected) throw new Error('Invalid runtime qualification');
      result[field] = expected;
    }
  }
  if (value.failure !== undefined) {
    result.failure = REPORT_FAILURES.includes(value.failure) ? value.failure : 'probe_step_failed';
  }
  if (value.turns !== undefined) {
    result.turns = evidenceArray(value.turns, 2, (turn) => projectTurn(turn, grant, harness));
  }
  if (value.initialization !== undefined) {
    result.initialization = evidenceArray(value.initialization, 4, (step) =>
      evidenceFields(step, ['command', 'ok', 'exitCode', 'stdout', 'stderr'], grant),
    );
  }
  if (value.filesystem !== undefined) {
    result.filesystem = {
      ...evidenceFields(value.filesystem, ['schemaVersion', 'ok'], grant),
      checks: evidenceArray(value.filesystem.checks, 64, (check) =>
        evidenceFields(check, ['id', 'status', 'message'], grant),
      ),
    };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > NATIVE_INTERACTION_PROBE_OUTPUT_LIMIT_BYTES) {
    throw new Error('Runtime result too large');
  }
  return result;
};

/**
 * Direct Lambda/IAM control plane for the disposable experiment.
 *
 * The caller supplies trusted clients and coreRuntimeTarget() as runtimeTarget.
 * issueGrant is injectable for local tests; production uses the existing SSM
 * issuer. No event field supplies configuration, credentials, or a free prompt.
 * The runtime owns the fixed synthetic answer and asynchronous probe work.
 * IAM-authorized status/cancel remain usable when model credentials or their
 * SSM/broker dependencies are unavailable; only start/answer issue grants.
 */
export const handleNativeInteractionProbe = async (
  event,
  { env = process.env, ssm, agentcore, runtimeTarget, issueGrant = issueAgentCredentialGrant } = {},
) => {
  if (env.NATIVE_INTERACTION_PROBE_ENABLED !== 'true') {
    return failure('native_probe_disabled', 'Native interaction probe is disabled');
  }
  const input = parseEvent(event);
  if (!input) return failure('native_probe_invalid', 'Invalid native interaction probe request');

  if (!runtimeTarget?.agentRuntimeArn || !agentcore?.send) {
    return failure('native_probe_not_configured', 'Native interaction probe is not configured');
  }

  try {
    const payload = {
      command: 'native-interaction-probe',
      action: input.action,
      probeId: input.probeId,
      requestedCli: input.harness,
      executionId: input.probeId,
    };
    let agentCredentialGrant = null;
    if (input.action === 'start' || input.action === 'answer') {
      const prefix = (env.AGENT_SETTINGS_SSM_PREFIX || '').replace(/\/+$/, '');
      if (!prefix || !ssm?.send) {
        return failure('native_probe_not_configured', 'Native interaction probe is not configured');
      }
      const modelsPath = `${prefix}/cli-models`;
      const settings = await ssm.send(
        new GetParametersCommand({ Names: [modelsPath], WithDecryption: false }),
      );
      const parameter = settings.Parameters?.find((item) => item.Name === modelsPath);
      if (parameter?.Type && parameter.Type !== 'String') {
        throw new Error('Invalid model settings');
      }
      const credentialBinding = {
        provider: credentialProviderForCli(input.harness),
        source: 'platform',
      };
      agentCredentialGrant = await issueGrant(
        ssm,
        {
          purpose: 'native-probe',
          executionId: input.probeId,
          projectId: null,
          bindings: [credentialBinding],
        },
        { env },
      );
      if (typeof agentCredentialGrant !== 'string' || !agentCredentialGrant) {
        throw new Error('Invalid grant');
      }
      payload.credentialBinding = credentialBinding;
      payload.cliModels = parseCliModels(parameter?.Value || '{}');
      payload.agentCredentialGrant = agentCredentialGrant;
    }

    const response = await agentcore.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: runtimeTarget.agentRuntimeArn,
        ...(runtimeTarget.qualifier ? { qualifier: runtimeTarget.qualifier } : {}),
        runtimeSessionId: `aidlc-native-probe-${input.probeId}`,
        contentType: 'application/json',
        accept: 'application/json',
        payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    if (
      (response.statusCode !== undefined &&
        (!Number.isInteger(response.statusCode) ||
          response.statusCode < 200 ||
          response.statusCode >= 300)) ||
      (response.contentType !== undefined &&
        !/^application\/json(?:\s*;.*)?$/i.test(response.contentType))
    ) {
      response.response?.destroy?.();
      throw new Error('Invalid runtime response');
    }
    return projectRuntimeResult(
      await readRuntimeJson(response.response),
      input,
      agentCredentialGrant,
    );
  } catch {
    // Never return or log raw exception messages, SDK metadata or stack traces.
    return runtimeFailure();
  }
};
