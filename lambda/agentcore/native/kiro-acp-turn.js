// One native Kiro turn. The outer runner owns the process group and cleanup.
// Bounded probe defaults remain; production opts out of model deadlines and
// cumulative capture cutoffs without removing protocol/frame validation.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { kiroPromptHash, resolveKiroPromptEvidence } from './kiro-prompt.js';

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const validSessionId = (value) => typeof value === 'string' && SESSION_ID.test(value);
const TEXT_LIMIT = 512 * 1024;
const validText = (value, max) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
export const kiroAssistantHash = (text) =>
  createHash('sha256').update(text.replaceAll('\r\n', '\n').trim()).digest('hex');

export const createKiroAcpTurn = ({
  project,
  prompt,
  sessionId = null,
  model = null,
  expectedUserPromptSha256,
  userPromptSource,
  priorAssistantSha256 = null,
  production = false,
  historyMode = 'all',
}) => {
  if (
    !validText(project, 4096) ||
    !isAbsolute(project) ||
    !validText(prompt, production ? 128 * 1024 : 16 * 1024) ||
    typeof production !== 'boolean' ||
    !['all', 'latest-turn'].includes(historyMode) ||
    (sessionId !== null && !validSessionId(sessionId)) ||
    (model !== null && !validText(model, 256)) ||
    typeof expectedUserPromptSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedUserPromptSha256) ||
    !['literal', 'aidlc-skill-expansion', 'retained-first-turn'].includes(userPromptSource) ||
    (sessionId !== null &&
      (typeof priorAssistantSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(priorAssistantSha256)))
  )
    throw new Error('Invalid native Kiro ACP arguments');

  const report = {
    schemaVersion: 1,
    transport: 'kiro-acp',
    ok: false,
    sessionId: null,
    identitySource: sessionId ? 'kiro-acp-session-load' : 'kiro-acp-session-new',
    requestedModel: model,
    observedModel: null,
    modelSource: null,
    modelVerified: false,
    sessionLoadAcknowledged: false,
    replayedUserChunks: 0,
    replayedAssistantChunks: 0,
    priorPromptObserved: false,
    priorAssistantObserved: false,
    expectedUserPromptSha256,
    replayedUserPromptSha256: null,
    userPromptSource,
    expectedAssistantSha256: priorAssistantSha256,
    replayedAssistantSha256: null,
    protocolPhase: 'initialize',
    protocolFailure: null,
    transportFailure: null,
    rpcErrorCode: null,
    stopReason: null,
    text: '',
    historyMode,
  };
  let expectedId = sessionId;
  let newUpdateId = null;
  let replayedUserText = '';
  let replayedAssistantText = '';
  let promptActive = false;
  let replayRole = null;
  let replayTruncated = false;
  const fail = (code) => {
    report.protocolFailure = code;
    throw Object.assign(new Error(code), { code });
  };
  const append = (before, text) => {
    if (Buffer.byteLength(before) + Buffer.byteLength(text) > TEXT_LIMIT) {
      if (production) {
        report.textTruncated = true;
        const bytes = Buffer.from(text).subarray(
          0,
          Math.max(0, TEXT_LIMIT - Buffer.byteLength(before)),
        );
        return before + new TextDecoder().decode(bytes, { stream: true });
      }
      fail('native_kiro_acp_text_limit');
    }
    return before + text;
  };
  const onUpdate = (params) => {
    if (!record(params) || !validSessionId(params.sessionId) || !record(params.update))
      fail('native_kiro_acp_invalid_update');
    if (
      expectedId ? params.sessionId !== expectedId : newUpdateId && newUpdateId !== params.sessionId
    )
      fail('native_kiro_acp_session_update_mismatch');
    if (!expectedId) newUpdateId = params.sessionId;
    const { sessionUpdate, content } = params.update;
    if (content?.type !== 'text' || typeof content.text !== 'string') return;
    if (report.protocolPhase === 'load') {
      const replayAppend = (before, value) => {
        if (historyMode !== 'latest-turn') return append(before, value);
        if (Buffer.byteLength(before) + Buffer.byteLength(value) <= TEXT_LIMIT)
          return before + value;
        // Older turns may be large; drain them until the latest turn is known.
        // An oversized latest turn is still refused before session/prompt.
        replayTruncated = true;
        return before;
      };
      if (sessionUpdate === 'user_message_chunk') {
        if (historyMode === 'latest-turn' && replayRole === 'assistant') {
          replayedUserText = '';
          replayedAssistantText = '';
          report.replayedUserChunks = 0;
          report.replayedAssistantChunks = 0;
          replayTruncated = false;
        }
        replayRole = 'user';
        replayedUserText = replayAppend(replayedUserText, content.text);
        report.replayedUserChunks++;
      } else if (sessionUpdate === 'agent_message_chunk') {
        replayRole = 'assistant';
        replayedAssistantText = replayAppend(replayedAssistantText, content.text);
        if (content.text.trim()) report.replayedAssistantChunks++;
      }
    } else if (report.protocolPhase === 'prompt' && sessionUpdate === 'agent_message_chunk') {
      report.text = append(report.text, content.text);
    }
  };
  const onPermission = (params) => {
    // This operator fixture already runs with --trust-all-tools. This is tool
    // permission only, never authority for an AI-DLC human workflow approval.
    const option =
      promptActive &&
      report.protocolPhase === 'prompt' &&
      params?.sessionId === expectedId &&
      Array.isArray(params.options)
        ? params.options.find(
            (item) => item?.kind === 'allow_once' && validText(item.optionId, 256),
          )
        : null;
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  };
  const execute = async (client) => {
    try {
      const initialized = await client.request('initialize', {
        protocolVersion: 1,
        clientInfo: {
          name: production ? 'aidlc-native-kiro' : 'aidlc-native-kiro-probe',
          version: '1',
        },
        clientCapabilities: {},
      });
      if (initialized?.protocolVersion !== 1) fail('native_kiro_acp_protocol_version');
      if (initialized.agentCapabilities?.loadSession !== true)
        fail('native_kiro_acp_load_unsupported');
      report.protocolPhase = sessionId ? 'load' : 'new';
      const session = await client.request(
        sessionId ? 'session/load' : 'session/new',
        { cwd: project, mcpServers: [], ...(sessionId ? { sessionId } : {}) },
        { timeoutMs: 120_000 },
      );
      if (!record(session)) fail('native_kiro_acp_invalid_session');
      if (sessionId) {
        if (session.sessionId !== undefined && session.sessionId !== sessionId)
          fail('native_kiro_acp_session_update_mismatch');
        report.sessionLoadAcknowledged = true;
        report.sessionId = sessionId;
        report.replayedUserPromptSha256 = kiroPromptHash(replayedUserText);
        report.priorPromptObserved =
          !replayTruncated &&
          report.replayedUserChunks > 0 &&
          report.replayedUserPromptSha256 === expectedUserPromptSha256;
        report.replayedAssistantSha256 = kiroAssistantHash(replayedAssistantText);
        report.priorAssistantObserved =
          !replayTruncated &&
          report.replayedAssistantChunks > 0 &&
          report.replayedAssistantSha256 === priorAssistantSha256;
      } else {
        if (
          !validSessionId(session.sessionId) ||
          (newUpdateId && newUpdateId !== session.sessionId)
        )
          fail('native_kiro_acp_invalid_session');
        expectedId = session.sessionId;
        report.sessionId = expectedId;
      }
      report.protocolPhase = 'model';
      const selected = session.models?.currentModelId;
      report.observedModel = validText(selected, 256) ? selected : null;
      report.modelSource = sessionId ? 'session/load.models' : 'session/new.models';
      const advertised =
        Array.isArray(session.models?.availableModels) &&
        session.models.availableModels.some((item) => item?.modelId === selected);
      report.modelVerified = Boolean(
        report.observedModel && advertised && (model === null || selected === model),
      );
      if (!report.modelVerified) fail('native_kiro_acp_model_unverified');
      if (sessionId && (!report.priorPromptObserved || !report.priorAssistantObserved)) {
        report.protocolPhase = 'history';
        fail('native_kiro_acp_history_unverified');
      }
      report.protocolPhase = 'prompt';
      promptActive = true;
      const finished = await client.request(
        'session/prompt',
        { sessionId: expectedId, prompt: [{ type: 'text', text: prompt }] },
        { timeoutMs: production ? null : 600_000 },
      );
      report.stopReason = validText(finished?.stopReason, 128) ? finished.stopReason : null;
      // oxlint-disable-next-line no-underscore-dangle -- ACP defines the _meta field.
      if (report.stopReason !== 'end_turn' || finished?._meta?.kiro?.turnFailureReason)
        fail('native_kiro_acp_turn_not_finished');
      if (!report.text.trim()) fail('native_kiro_acp_empty_response');
      report.ok = true;
      report.protocolPhase = 'finished';
    } catch (error) {
      report.protocolFailure ||= 'native_kiro_acp_request_failed';
      report.transportFailure =
        typeof error?.code === 'string' && /^KIRO_ACP_[A-Z_]{1,40}$/.test(error.code)
          ? error.code
          : null;
      report.rpcErrorCode = Number.isSafeInteger(error?.rpcCode) ? error.rpcCode : null;
    } finally {
      promptActive = false;
    }
    // Bounded private evidence permits distinguishing replay encoding from
    // missing history. The caller redacts it before persistence or API output.
    report.replayUserTail = replayedUserText.slice(-16 * 1024);
    report.replayAssistantTail = replayedAssistantText.slice(-16 * 1024);
    return report;
  };
  return { execute, onUpdate, onPermission };
};

const run = async () => {
  const { createKiroAcpClient } = await import('./kiro-acp-client.js');
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      prompt: { type: 'string' },
      'resume-id': { type: 'string' },
      model: { type: 'string' },
      'prior-user-prompt-sha256': { type: 'string' },
      'prior-assistant-sha256': { type: 'string' },
      production: { type: 'boolean', default: false },
      'history-mode': { type: 'string', default: 'all' },
    },
    strict: true,
    allowPositionals: false,
  });
  // Freeze the expected expansion before the first model turn. A resumed turn
  // uses that retained hash and never rereads an agent-writable skill file.
  const promptEvidence = values['resume-id']
    ? {
        userPromptSha256: values['prior-user-prompt-sha256'],
        userPromptSource: 'retained-first-turn',
      }
    : await resolveKiroPromptEvidence({ project: values.project, prompt: values.prompt });
  const turn = createKiroAcpTurn({
    project: values.project,
    prompt: values.prompt,
    sessionId: values['resume-id'] ?? null,
    model: values.model ?? null,
    expectedUserPromptSha256: promptEvidence.userPromptSha256,
    userPromptSource: promptEvidence.userPromptSource,
    priorAssistantSha256: values['prior-assistant-sha256'] ?? null,
    production: values.production,
    historyMode: values['history-mode'],
  });
  const child = spawn(
    '/usr/local/bin/kiro-cli',
    [
      'acp',
      '--agent-engine',
      'v2',
      '--agent',
      'aidlc',
      '--trust-all-tools',
      ...(values.model ? ['--model', values.model] : []),
    ],
    {
      cwd: values.project,
      env: process.env,
      shell: false,
      // Remain in the outer command runner's group, including Kiro descendants.
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let childClosed = false;
  let childFailed = false;
  const closed = new Promise((resolve) => {
    child.once('close', (code) => {
      childClosed = true;
      childFailed = code !== 0;
      resolve();
    });
    child.once('error', () => {
      childFailed = true;
      child.stdin.destroy();
      child.stdout.destroy();
      resolve();
    });
  });
  // The outer runner captures/bounds/redacts this stream. Never log credentials
  // or raw ACP frames; only the final allowlisted diagnostic is written below.
  child.stderr.on('error', () => {});
  child.stderr.pipe(process.stderr, { end: false });
  const client = createKiroAcpClient({
    input: child.stdout,
    output: child.stdin,
    onUpdate: turn.onUpdate,
    onPermission: turn.onPermission,
    ...(values.production ? { maxInputBytes: null, maxOutputBytes: null } : {}),
  });
  const report = await turn.execute(client);
  client.dispose();
  child.stdin.end();
  let timer;
  await Promise.race([
    closed,
    new Promise((resolve) => {
      timer = setTimeout(resolve, 30_000);
    }),
  ]);
  clearTimeout(timer);
  if (!childClosed) {
    // Evidence must not call a forcibly terminated ACP process a clean success.
    report.ok = false;
    report.protocolFailure ||= 'native_kiro_acp_shutdown_incomplete';
    child.kill('SIGKILL');
  } else if (childFailed) {
    report.ok = false;
    report.protocolFailure ||= 'native_kiro_acp_process_failed';
  }
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(report)}\n`, resolve));
  // The outer runner always verifies that the entire process group disappears.
  process.exit(report.ok ? 0 : 1);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch(() => {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        transport: 'kiro-acp',
        ok: false,
        protocolFailure: 'native_kiro_acp_wrapper_failed',
      })}\n`,
      () => process.exit(1),
    );
  });
}
