import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyNativeFirstWait,
  configureNativeClaudeSessionEnd,
  createNativeExecutor,
  NATIVE_CODEX_MAX_THREADS,
  nativeExecutionInvocation,
  nativeFirstTurnPrompt,
} from '../native/executor.js';
import { runNativeCommand } from '../native/command-runner.js';
import { inspectNativeInitialization } from '../native/initialization-evidence.js';
import { nativePublicationScope } from '../../shared/native-publication.js';
import { kiroPromptHash } from '../native/kiro-prompt.js';
import { nativeAnswerText } from '../../shared/native-pending-input.js';

const projectId = randomUUID();
const executionId = randomUUID();
const bindingId = randomUUID();
const env = {
  NATIVE_RUNTIME_MODE: 'isolated',
  NATIVE_RUNTIME_PROJECT_ID: projectId,
  NATIVE_RUNTIME_EXECUTION_ID: executionId,
  NATIVE_RUNTIME_BINDING_ID: bindingId,
  AWS_SECRET_ACCESS_KEY: 'ambient-secret-must-not-forward',
  AIDLC_UNATTENDED: '1',
};
const payload = () => ({
  command: 'native-start',
  schemaVersion: 1,
  projectId,
  executionId,
  bindingId,
  attemptId: randomUUID(),
  runtimeSessionId: randomUUID(),
  epoch: 1,
  configuration: {
    harness: 'codex',
    model: 'configured-model',
    prompt:
      '# Fix the pipe visualization\n\n\nPipes are looking boring - let’s make them more cool!',
    repository: {
      provider: 'github',
      repository: 'owner/flappy-bird',
      branch: 'main',
      commit: 'a'.repeat(40),
    },
    packageVersion: '2.9.0',
  },
});
const nativeIntentPath = 'aidlc/spaces/design/intents/260929-real-pipe-request';
const questionPath = `${nativeIntentPath}/ideation/intent-capture/intent-capture-questions.md`;
const nativeFiles = {
  'aidlc/active-space': 'design\n',
  'aidlc/spaces/design/intents/active-intent': '260929-real-pipe-request\n',
  [`${nativeIntentPath}/aidlc-state.md`]:
    '# AI-DLC State Tracking\n- [-] intent-capture — EXECUTE\n' +
    '- **Current Stage**: intent-capture\n- **Status**: Running\n',
  [`${nativeIntentPath}/.aidlc-engine/active-directive.json`]: JSON.stringify({
    version: 2,
    kind: 'run-stage',
    stage: 'intent-capture',
    cursor_harness: 'codex',
    active_attempt: { status: 'settled' },
  }),
  [questionPath]:
    '# Intent Capture Questions\n\n## Q1. Which pipe appearance do you want?\n\nA. Retro\nX. Other\n\n[Answer]:\n',
};
let temp;
let root;
let homeRoot;
let fixture;
let activeExecutors;
beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-executor-')));
  root = join(temp, 'mount');
  homeRoot = join(temp, 'homes');
  await fs.mkdir(root, { mode: 0o700 });
  fixture = join(temp, 'inert-turn.mjs');
  // A real local subprocess; no harness, network, AWS or model is invoked.
  await fs.writeFile(
    fixture,
    `
    import { mkdir, writeFile, readFile } from 'node:fs/promises';
    import { dirname } from 'node:path';
    const mode = process.argv[2];
    const stdin = await readFile(0, 'utf8').catch(() => '');
    if (mode !== 'no-session') console.log(JSON.stringify({type:'thread.started',thread_id:'test-harness-session'}));
    console.log(JSON.stringify({type:'turn.started'}));
    if (mode === 'wait') { setInterval(() => {}, 1000); }
    else {
      for (const [path, bytes] of Object.entries(${JSON.stringify(nativeFiles)})) {
        await mkdir(dirname(path), {recursive:true, mode:0o700});
        await writeFile(path, bytes);
      }
      if (mode === 'secret') await writeFile('leaked.txt', process.env.AWS_BEARER_TOKEN_BEDROCK);
      if (mode === 'overflow') {
        console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'X'.repeat(400000)}}));
      }
      if (mode === 'unknown') await writeFile(${JSON.stringify(`${nativeIntentPath}/.aidlc-engine/active-directive.json`)}, '{"version":999}');
      console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Here is the proposal. Which option do you prefer?'}}));
      console.log(JSON.stringify({type:'turn.completed',usage:{}}));
    }
  `,
  );
  activeExecutors = [];
});
afterEach(async () => {
  for (const { executor, request } of activeExecutors) {
    if (executor.isBusy()) await executor.cancel(request);
    await executor.settle();
  }
  await fs.rm(temp, { recursive: true, force: true });
});
const cleanCommand = {
  exitCode: 0,
  signal: null,
  spawnError: null,
  timedOut: false,
  outputLimitExceeded: false,
  cleanupComplete: true,
  stdout: '',
  stderr: '',
};
const make = (options = {}) => {
  const request = options.request ?? payload();
  const prepare = vi.fn(async ({ project }) => {
    const directory = join(root, 'packages');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(join(directory, 'aidlc'), 'inert-package');
    await fs.mkdir(join(project, 'src'), { mode: 0o700 });
    await fs.writeFile(join(project, 'src/game.bin'), Buffer.from([0, 255, 13, 10]));
    return {
      package: {
        directory,
        binaryPath: join(directory, 'aidlc'),
        version: '2.9.0',
        packageId: `sha256:${'b'.repeat(64)}`,
      },
      repositoryCommit: request.configuration.repository.commit,
      authEnv: {
        AWS_BEARER_TOKEN_BEDROCK: 'known-model-credential',
        AWS_REGION: 'us-east-1',
        AWS_SECRET_ACCESS_KEY: 'must-not-forward',
      },
    };
  });
  const publish = vi.fn(async (input) => ({
    uploaded: true,
    receipt: {
      id: (input.sequence === 1 ? 'c' : 'e').repeat(64),
      sequence: input.sequence,
      manifest: {
        key: 'native-executions/test/manifest.json',
        versionId: 'immutable-version',
        sha256: (input.sequence === 1 ? 'c' : 'e').repeat(64),
        bytes: 123,
      },
      question: input.questionPath
        ? {
            path: input.questionPath,
            sha256: input.files.find((f) => f.path === input.questionPath).sha256,
          }
        : null,
      outcome: input.outcome,
      nativeSessionId: input.nativeSessionId,
      filesCount: input.files.length,
    },
  }));
  const publishInteraction = vi.fn(async (input) => {
    const id = (input.sequence === 1 ? 'd' : 'f').repeat(64);
    return {
      id,
      sequence: input.sequence,
      nativeSessionId: input.nativeSessionId,
      publicationId: input.publicationId,
      object: {
        key: `${nativePublicationScope(input.identity).prefix}interactions/${id}.json`,
        versionId: 'interaction-version',
        sha256: id,
        bytes: 123,
      },
    };
  });
  const commandRunner = vi.fn(async (input) => {
    if (input.timeoutMs !== null) return cleanCommand;
    return runNativeCommand({
      ...input,
      command: process.execPath,
      args: [fixture, options.mode ?? 'question'],
      stdoutBytes: 4096,
    });
  });
  const ports = {
    env,
    root,
    homeRoot,
    prepare,
    prepareContinuation: vi.fn(async ({ payload: dispatch }) => ({
      authEnv: { AWS_BEARER_TOKEN_BEDROCK: dispatch.credentials.model.value },
      forbiddenBytes: [dispatch.credentials.model.value],
    })),
    publish,
    publishInteraction,
    commandRunner,
    inspectMount: vi.fn(async () => ({})),
    inspectInitialization: vi.fn(async () => ({ ok: true })),
    ...options.ports,
  };
  const executor = createNativeExecutor(ports);
  activeExecutors.push({ executor, request });
  return { executor, request, ports };
};

describe('native first-turn executor', () => {
  const reply = (request, head, changes = {}) => ({
    ...request,
    command: 'native-continue',
    sequence: head.sequence + 1,
    requestId: randomUUID(),
    priorInteractionId: head.interaction.id,
    priorPublicationId: head.receipt.id,
    text: 'Use the colorful proposal.\n',
    credentials: { model: { provider: 'bedrock', value: 'new-model-credential' } },
    ...changes,
  });

  it.each(['codex', 'claude', 'opencode', 'kiro'])(
    'captures plan choices and gate replies in three serial %s turns without duplicate effects',
    async (harness) => {
      const request = payload();
      request.configuration.harness = harness;
      request.configuration.model = {
        claude: 'us.anthropic.configured',
        codex: 'openai.configured',
        kiro: 'configured-kiro-model',
        opencode: 'amazon-bedrock/us.anthropic.configured',
      }[harness];
      let turns = 0;
      // Scripted transport evidence, not a package or live-model support claim.
      const plans = [
        'compose',
        'bugfix',
        'classic',
        'enterprise',
        'express',
        'feature',
        'infra',
        'mvp',
        'poc',
        'refactor',
        'security-patch',
        'workshop',
      ];
      const labels = () => (turns === 1 ? plans : ['Approve', 'Request Changes']);
      const responseText = () => `Proposal ${turns}. Which option? ${labels().join(' / ')}`;
      const events = () => {
        const text = responseText();
        if (harness === 'codex')
          return [
            { type: 'thread.started', thread_id: 'native-session' },
            { type: 'turn.started' },
            { type: 'item.completed', item: { type: 'agent_message', id: 'reply', text } },
            { type: 'turn.completed' },
          ];
        if (harness === 'claude')
          return [
            {
              type: 'assistant',
              session_id: 'native-session',
              message: { role: 'assistant', content: [{ type: 'text', text }] },
            },
            {
              type: 'result',
              session_id: 'native-session',
              subtype: 'success',
              is_error: false,
              result: text,
            },
          ];
        if (harness === 'opencode')
          return [
            { type: 'text', sessionID: 'native-session', part: { type: 'text', text } },
            { type: 'step_finish', sessionID: 'native-session', part: { reason: 'stop' } },
          ];
        return [
          {
            schemaVersion: 1,
            transport: 'kiro-acp',
            ok: true,
            sessionId: 'native-session',
            modelVerified: true,
            stopReason: 'end_turn',
            text,
            historyMode: 'latest-turn',
            priorPromptObserved: true,
            priorAssistantObserved: true,
          },
        ];
      };
      const { executor, ports } = make({ request });
      const prepare = ports.prepare.getMockImplementation();
      ports.prepare.mockImplementation(async (input) => {
        const result = await prepare(input);
        if (harness === 'claude') {
          await fs.mkdir(join(input.project, '.claude'), { mode: 0o700 });
          await fs.writeFile(
            join(input.project, '.claude/settings.json'),
            JSON.stringify({
              hooks: {
                SessionEnd: [
                  { hooks: [{ type: 'command', command: 'aidlc engine hook session-end' }] },
                ],
              },
            }),
          );
        }
        if (harness === 'kiro') {
          await fs.mkdir(join(input.project, '.kiro/skills/aidlc'), {
            recursive: true,
            mode: 0o700,
          });
          await fs.writeFile(
            join(input.project, '.kiro/skills/aidlc/SKILL.md'),
            'Native skill\n$ARGUMENTS\n',
            { mode: 0o600 },
          );
          result.authEnv = { KIRO_API_KEY: 'inert-kiro-key' };
        }
        return result;
      });
      ports.prepareContinuation.mockImplementation(async ({ payload: dispatch }) => ({
        authEnv: {
          [harness === 'kiro' ? 'KIRO_API_KEY' : 'AWS_BEARER_TOKEN_BEDROCK']:
            dispatch.credentials.model.value,
        },
      }));
      ports.commandRunner.mockImplementation(async (input) => {
        if (input.timeoutMs === null) {
          turns++;
          if (turns < 3) {
            await fs.writeFile(
              join(root, 'project/.native-control/pending-question.json'),
              JSON.stringify({
                version: 1,
                questions: [
                  { prompt: 'Which option?', options: labels().map((label) => ({ label })) },
                ],
              }),
            );
          }
          if (turns === 2) {
            for (const [path, content] of Object.entries({
              'aidlc/active-space': 'design\n',
              'aidlc/spaces/design/intents/active-intent': '260929-real-pipe-request\n',
              [`${nativeIntentPath}/aidlc-state.md`]:
                '- **Current Stage**: requirements-analysis\n- [?] requirements-analysis — EXECUTE\n',
            })) {
              await fs.mkdir(join(root, 'project', path, '..'), { recursive: true, mode: 0o700 });
              await fs.writeFile(join(root, 'project', path), content);
            }
          }
          // Only the streaming callback receives output, not result.stdout.
          for (const event of events())
            input.onStdoutChunk(Buffer.from(`${JSON.stringify(event)}\n`));
        }
        return cleanCommand;
      });
      await executor.start({ ...request, sequence: 1 });
      const first = await executor.settle();
      expect(first).toMatchObject({ status: 'publication_ready', sequence: 1 });
      const firstInput = ports.publishInteraction.mock.calls[0][0].pendingInput;
      expect(firstInput.questions[0].options.map((option) => option.label)).toEqual(plans);
      const secondReply = reply(request, first, {
        text: nativeAnswerText(firstInput, { answers: [{ selectedOptions: [11] }] }),
      });
      expect(secondReply.text).toBe('workshop');
      await executor.continue(secondReply);
      const second = await executor.settle();
      expect(second).toMatchObject({ status: 'publication_ready', sequence: 2 });
      await executor.continue(secondReply);
      await executor.settle();
      expect(turns).toBe(2);
      const secondInput = ports.publishInteraction.mock.calls[1][0].pendingInput;
      expect(secondInput.kind).toBe('approval');
      const answer = nativeAnswerText(secondInput, {
        answers: [{ selectedOptions: [1], freeText: 'Keep offline support.' }],
      });
      await executor.continue(reply(request, second, { text: answer }));
      expect(await executor.settle()).toMatchObject({ status: 'publication_ready', sequence: 3 });
      expect(turns).toBe(3);
      expect(ports.prepare).toHaveBeenCalledOnce();
      const resume = ports.commandRunner.mock.calls.at(-1)[0];
      const flag = {
        codex: 'resume',
        claude: '--resume',
        opencode: '--session',
        kiro: '--resume-id',
      }[harness];
      expect(resume.args[resume.args.indexOf(flag) + 1]).toBe('native-session');
      if (harness === 'kiro') {
        expect(resume.args[resume.args.indexOf('--prior-user-prompt-sha256') + 1]).toBe(
          kiroPromptHash(secondReply.text),
        );
        expect(resume.args).toContain('latest-turn');
      } else expect(resume.stdin).toBe('Request Changes\n\nKeep offline support.');
      for (const [command] of ports.commandRunner.mock.calls.filter(
        ([c]) => c.timeoutMs === null,
      )) {
        const modelFlag = harness === 'codex' ? '-m' : '--model';
        expect(command.args[command.args.indexOf(modelFlag) + 1]).toBe(request.configuration.model);
      }
      expect(ports.publishInteraction.mock.calls[2][0].pendingInput).toBeNull();
    },
  );

  it('rejects noninitial sequence and cancels an idle published owner before any continuation', async () => {
    const { executor, request, ports } = make();
    await expect(executor.start({ ...request, sequence: 2 })).rejects.toMatchObject({
      code: 'native_execution_request_invalid',
    });
    await executor.start({ ...request, sequence: 1 });
    const first = await executor.settle();
    await executor.cancel(request);
    await expect(executor.continue(reply(request, first))).rejects.toMatchObject({
      code: 'native_execution_cancelled',
    });
    expect(ports.prepareContinuation).not.toHaveBeenCalled();
  });

  it('continues serially in the same session and workspace with immutable prior receipts', async () => {
    const { executor, request, ports } = make();
    await executor.start(request);
    const first = await executor.settle();
    const original = structuredClone(first);
    const next = reply(request, first);
    expect(await executor.continue(next)).toMatchObject({
      accepted: true,
      duplicate: false,
      sequence: 2,
      requestId: next.requestId,
    });
    const second = await executor.settle();
    expect(second).toMatchObject({
      status: 'publication_ready',
      sequence: 2,
      nativeSessionId: first.nativeSessionId,
      receipt: { id: 'e'.repeat(64), sequence: 2 },
      interaction: { publicationId: 'e'.repeat(64), sequence: 2 },
    });
    expect(first).toEqual(original);
    expect(ports.prepare).toHaveBeenCalledOnce();
    expect(ports.prepareContinuation).toHaveBeenCalledOnce();
    expect(ports.commandRunner).toHaveBeenCalledTimes(5);
    const resumed = ports.commandRunner.mock.calls.at(-1)[0];
    expect(resumed.args.slice(0, 3)).toEqual(['exec', 'resume', first.nativeSessionId]);
    expect(resumed.stdin).toBe(next.text);
    expect(resumed.timeoutMs).toBeNull();
    expect(resumed.env.CODEX_HOME).toBe(ports.commandRunner.mock.calls[3][0].env.CODEX_HOME);
    expect(resumed.env.AWS_BEARER_TOKEN_BEDROCK).toBe('new-model-credential');
    expect(ports.publishInteraction.mock.calls[0][0].messages).toEqual([
      { type: 'text', text: 'Here is the proposal. Which option do you prefer?' },
    ]);
    for (const call of ports.publishInteraction.mock.calls)
      expect(Object.keys(call[0].identity)).toHaveLength(6);
    const durable = await fs.readFile(
      join(root, `.native-control/first-turn/request-${next.requestId}.json`),
      'utf8',
    );
    expect(durable).not.toContain(next.text.trim());
    expect(durable).not.toContain('credential');
    expect(JSON.stringify(second)).not.toContain('Which option');
  });

  it('deduplicates the same request during execution and afterwards, ignoring credential rotation', async () => {
    const { executor, request, ports } = make();
    await executor.start(request);
    const first = await executor.settle();
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    const prepare = ports.prepareContinuation.getMockImplementation();
    ports.prepareContinuation.mockImplementation(async (input) => {
      started.resolve();
      await gate.promise;
      return prepare(input);
    });
    const next = reply(request, first);
    const ack = await executor.continue(next);
    await started.promise;
    expect(
      await executor.continue({ ...next, credentials: { model: { value: 'rotated' } } }),
    ).toEqual({ ...ack, duplicate: true });
    await expect(executor.continue({ ...next, text: 'different' })).rejects.toMatchObject({
      code: 'native_execution_reply_conflict',
    });
    await expect(executor.continue({ ...next, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'native_execution_busy',
    });
    gate.resolve();
    await executor.settle();
    expect(await executor.continue(next)).toEqual({ ...ack, duplicate: true });
    expect(ports.prepareContinuation).toHaveBeenCalledOnce();
    expect(ports.commandRunner).toHaveBeenCalledTimes(5);
  });
  it('poisons uncertain admission after the immutable request is written but next-status persistence fails', async () => {
    const { executor, request, ports } = make();
    await executor.start(request);
    const first = await executor.settle();
    const next = reply(request, first);
    const statusPath = join(root, '.native-control/first-turn/status.json');
    // A real local rename failure after request-file fsync; no mocked model,
    // cloud call or timing-dependent race is required to exercise this gap.
    await fs.unlink(statusPath);
    await fs.mkdir(statusPath, { mode: 0o700 });
    await expect(executor.continue(next)).rejects.toMatchObject({
      code: 'native_execution_reply_admission_unconfirmed',
    });
    const record = JSON.parse(
      await fs.readFile(
        join(root, `.native-control/first-turn/request-${next.requestId}.json`),
        'utf8',
      ),
    );
    expect(record.ack).toMatchObject({ sequence: 2, accepted: true });
    expect(await executor.status(request)).toMatchObject({
      status: 'stopped_needs_review',
      sequence: 2,
      code: 'native_execution_reply_admission_unconfirmed',
    });
    await expect(executor.continue(next)).rejects.toMatchObject({
      code: 'native_execution_existing_owner',
    });
    expect(executor.isBusy()).toBe(true);
    expect(ports.prepareContinuation).not.toHaveBeenCalled();
    expect(ports.commandRunner).toHaveBeenCalledTimes(4);
  });

  it('rejects stale heads, changed configuration, unknown attempts and cold owners before any writer', async () => {
    const { executor, request, ports } = make();
    await executor.start(request);
    const first = await executor.settle();
    const next = reply(request, first);
    for (const changes of [
      { sequence: 3 },
      { priorInteractionId: '0'.repeat(64) },
      { priorPublicationId: '0'.repeat(64) },
    ])
      await expect(executor.continue({ ...next, ...changes })).rejects.toMatchObject({
        code: 'native_execution_reply_conflict',
      });
    for (const changes of [
      { attemptId: randomUUID() },
      { configuration: { ...next.configuration, model: 'other' } },
    ])
      await expect(executor.continue({ ...next, ...changes })).rejects.toMatchObject({
        code: 'native_execution_owner_conflict',
      });
    await expect(createNativeExecutor(ports).continue(next)).rejects.toMatchObject({
      code: 'native_execution_existing_owner',
    });
    expect(ports.prepareContinuation).not.toHaveBeenCalled();
    expect(ports.commandRunner).toHaveBeenCalledTimes(4);
  });

  it('checks the fresh cancellation fence again before resumed model invocation', async () => {
    const assertActive = vi.fn(async () => {});
    const { executor, request, ports } = make({ ports: { assertActive } });
    await executor.start(request);
    const first = await executor.settle();
    assertActive.mockRejectedValue(
      Object.assign(new Error('no'), { code: 'native_execution_cancelled' }),
    );
    await executor.continue(reply(request, first));
    expect(await executor.settle()).toMatchObject({ status: 'cancelled', sequence: 2 });
    expect(ports.commandRunner).toHaveBeenCalledTimes(4);
    expect(ports.publish).toHaveBeenCalledOnce();
  });

  it('publishes files before the paired interaction and exposes neither until both finish', async () => {
    const gate = Promise.withResolvers();
    const { executor, request, ports } = make();
    const original = ports.publishInteraction.getMockImplementation();
    ports.publishInteraction.mockImplementation(async (input) => {
      await gate.promise;
      return original(input);
    });
    await executor.start(request);
    await vi.waitFor(() => expect(ports.publishInteraction).toHaveBeenCalledOnce());
    expect(ports.publish).toHaveBeenCalledOnce();
    expect(await executor.status(request)).not.toHaveProperty('receipt');
    expect(await executor.status(request)).not.toHaveProperty('interaction');
    gate.resolve();
    expect(await executor.settle()).toMatchObject({
      status: 'publication_ready',
      sequence: 1,
      interaction: { publicationId: 'c'.repeat(64), nativeSessionId: 'test-harness-session' },
    });
  });

  it('does not publish a mismatched interaction as a completed head', async () => {
    const { executor, request, ports } = make();
    const original = ports.publishInteraction.getMockImplementation();
    ports.publishInteraction.mockImplementation(async (input) => ({
      ...(await original(input)),
      publicationId: '0'.repeat(64),
    }));
    await executor.start(request);
    expect(await executor.settle()).toMatchObject({
      status: 'failed',
      code: 'native_execution_interaction_unconfirmed',
    });
  });
  it('captures existing Kiro directories from the verified checkout before the first setup command', async () => {
    const { executor, request, ports } = make();
    const prepare = ports.prepare.getMockImplementation();
    const bytes = Buffer.from('\uFEFF# Tracked Kiro rules\r\nKeep exact bytes.\r\n');
    const path = join(root, 'project/.kiro/steering/core-workflow.md');
    let originalIdentity;
    ports.prepare.mockImplementation(async (input) => {
      const result = await prepare(input);
      await fs.mkdir(join(input.project, '.kiro/steering'), { recursive: true });
      await fs.writeFile(path, bytes);
      originalIdentity = await fs.lstat(join(input.project, '.kiro'), { bigint: true });
      return result;
    });
    const run = ports.commandRunner.getMockImplementation();
    ports.commandRunner.mockImplementation(async (input) => {
      if (input.args[0] === 'use') {
        // A setup-created directory must not be retrospectively admitted.
        await fs.mkdir(join(root, 'project/.claude'));
      }
      return run(input);
    });
    ports.inspectInitialization.mockImplementation(async ({ harnessBaseline }) => {
      expect(harnessBaseline.harness).toBe('codex');
      expect(harnessBaseline.directories).toEqual([
        {
          directory: '.kiro',
          identity: {
            dev: String(originalIdentity.dev),
            ino: String(originalIdentity.ino),
            uid: String(originalIdentity.uid),
          },
        },
      ]);
      expect(await fs.readFile(path)).toEqual(bytes);
      return { ok: false, checks: [{ id: 'harness-layout', status: 'failed' }] };
    });
    await executor.start(request);
    expect(await executor.settle()).toMatchObject({
      status: 'failed',
      code: 'native_execution_initialization_unverified',
      initializationChecks: [{ id: 'harness-layout', status: 'failed' }],
    });
    expect(ports.inspectInitialization).toHaveBeenCalledOnce();
    expect(ports.commandRunner).toHaveBeenCalledTimes(3);
    expect(ports.publish).not.toHaveBeenCalled();
    expect(await fs.readFile(path)).toEqual(bytes);
  });

  it('rejects a setup-created unexpected directory with the actual inspector before any model spawn', async () => {
    const { executor, request, ports } = make({
      ports: { inspectInitialization: vi.fn(inspectNativeInitialization) },
    });
    ports.commandRunner.mockImplementation(async (input) => {
      if (input.args.includes('--harness')) {
        await fs.mkdir(join(root, 'project/.codex'));
        await fs.mkdir(join(root, 'project/.kiro'));
      }
      return cleanCommand;
    });
    await executor.start(request);
    const result = await executor.settle();
    expect(result.code).toBe('native_execution_initialization_unverified');
    expect(result.initializationChecks).toContainEqual({ id: 'harness-layout', status: 'failed' });
    expect(ports.inspectInitialization.mock.calls[0][0].harnessBaseline.directories).toEqual([]);
    expect(ports.commandRunner).toHaveBeenCalledTimes(3);
    expect(ports.publish).not.toHaveBeenCalled();
  });

  it('rejects an unsafe checkout baseline before executing even the package installer', async () => {
    const { executor, request, ports } = make();
    const prepare = ports.prepare.getMockImplementation();
    ports.prepare.mockImplementation(async (input) => {
      const result = await prepare(input);
      await fs.symlink(root, join(input.project, '.kiro'));
      return result;
    });
    await executor.start(request);
    expect(await executor.settle()).toMatchObject({
      status: 'failed',
      code: 'native_execution_initialization_unverified',
      initializationChecks: [{ id: 'harness-layout', status: 'failed' }],
      initializationBaselineReason: 'baseline-directory-unsafe',
    });
    expect(await createNativeExecutor(ports).status(request)).toMatchObject({
      status: 'failed',
      initializationBaselineReason: 'baseline-directory-unsafe',
      recovered: true,
    });
    expect(ports.commandRunner).not.toHaveBeenCalled();
    expect(ports.inspectInitialization).not.toHaveBeenCalled();
    expect(ports.publish).not.toHaveBeenCalled();
  });

  it('retains only bounded fixed initialization diagnostics in status and after restart', async () => {
    const secret = 'known-model-credential';
    const checks = [
      { id: 'inputs', status: 'passed', message: temp },
      { id: 'harness-layout', status: 'failed', message: secret, path: root },
      { id: secret, status: 'failed' },
      { id: 'version-pin', status: secret },
      { id: 'harness-layout', status: 'passed' },
    ];
    const initializationChecks = [
      { id: 'inputs', status: 'passed' },
      { id: 'harness-layout', status: 'failed' },
    ];
    const { executor, request, ports } = make({
      ports: { inspectInitialization: vi.fn(async () => ({ ok: false, checks, raw: secret })) },
    });
    await executor.start(request);
    const result = await executor.settle();
    expect(result).toMatchObject({
      status: 'failed',
      code: 'native_execution_initialization_unverified',
      initializationChecks,
    });
    expect(ports.commandRunner).toHaveBeenCalledTimes(3);
    expect(ports.publish).not.toHaveBeenCalled();
    expect(JSON.stringify(await executor.status(request))).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(root);
    const path = join(root, '.native-control/first-turn/status.json');
    const savedBytes = await fs.readFile(path, 'utf8');
    expect(savedBytes).not.toContain(secret);
    expect(savedBytes).not.toContain(root);
    expect(JSON.parse(savedBytes).initializationChecks).toEqual(initializationChecks);
    const saved = JSON.parse(savedBytes);
    // Local status files do not confer authority and are sanitized again.
    await fs.writeFile(
      path,
      JSON.stringify({
        ...saved,
        initializationChecks: checks,
        initializationBaselineReason: secret,
        raw: secret,
      }),
    );
    const restarted = createNativeExecutor(ports);
    const recovered = await restarted.status(request);
    expect(recovered).toMatchObject({
      projectId: request.projectId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      status: 'failed',
      code: 'native_execution_initialization_unverified',
      initializationChecks,
      recovered: true,
    });
    expect(JSON.stringify(recovered)).not.toContain(secret);
    expect(JSON.stringify(recovered)).not.toContain(root);
    expect(recovered).not.toHaveProperty('initializationBaselineReason');
    expect(ports.prepare).toHaveBeenCalledOnce();
    expect(ports.commandRunner).toHaveBeenCalledTimes(3);
  });

  it('refuses publication when a completed assistant session cannot be verified', async () => {
    const { executor, request, ports } = make({ mode: 'no-session' });
    await executor.start(request);
    expect(await executor.settle()).toMatchObject({
      status: 'failed',
      code: 'native_execution_output_incomplete',
    });
    expect(ports.publish).not.toHaveBeenCalled();
    expect(ports.publishInteraction).not.toHaveBeenCalled();
    expect(await createNativeExecutor(ports).status(request)).toMatchObject({
      status: 'stopped_needs_review',
    });
  });
  it('denies the model when the latest pre-spawn fence is cancelled', async () => {
    const assertActive = vi.fn(async () => {
      throw Object.assign(new Error('native_execution_cancelled'), {
        code: 'native_execution_cancelled',
      });
    });
    const { executor, request, ports } = make({ ports: { assertActive } });
    await executor.start(request);
    expect(await executor.settle()).toMatchObject({
      status: 'cancelled',
      code: 'native_execution_cancelled',
    });
    expect(assertActive).toHaveBeenCalledWith({
      writerGeneration: 1,
      identity: Object.fromEntries(
        ['projectId', 'executionId', 'bindingId', 'attemptId', 'epoch', 'runtimeSessionId'].map(
          (key) => [key, request[key]],
        ),
      ),
      signal: expect.any(AbortSignal),
    });
    expect(
      ports.commandRunner.mock.calls.filter(([input]) => input.timeoutMs === null),
    ).toHaveLength(0);
    expect(ports.publish).not.toHaveBeenCalled();
  });

  it('calls the runner in the fence continuation without an intervening await', async () => {
    const events = [];
    const assertActive = vi.fn(() => ({
      // oxlint-disable-next-line unicorn/no-thenable -- Test the exact await continuation ordering.
      then(resolve) {
        events.push('fence');
        resolve();
        queueMicrotask(() => events.push('later-microtask'));
      },
    }));
    const { executor, request, ports } = make({ ports: { assertActive } });
    const original = ports.commandRunner.getMockImplementation();
    ports.commandRunner.mockImplementation((input) => {
      if (input.timeoutMs === null) events.push('spawn');
      return original(input);
    });
    await executor.start(request);
    expect(await executor.settle()).toMatchObject({ status: 'publication_ready' });
    expect(events).toEqual(['fence', 'spawn', 'later-microtask']);
  });

  it('checks local cancellation synchronously after a delayed ACTIVE fence response', async () => {
    const gate = Promise.withResolvers();
    const assertActive = vi.fn(() => gate.promise);
    const { executor, request, ports } = make({ ports: { assertActive } });
    await executor.start(request);
    await vi.waitFor(() => expect(assertActive).toHaveBeenCalledOnce());
    await executor.cancel(request);
    gate.resolve();
    expect(await executor.settle()).toMatchObject({ status: 'cancelled' });
    expect(
      ports.commandRunner.mock.calls.filter(([input]) => input.timeoutMs === null),
    ).toHaveLength(0);
  });
  it('quickly acknowledges and durably deduplicates a real local subprocess; publishes exact files before wait', async () => {
    const { executor, request, ports } = make();
    const ack = await executor.start(request);
    expect(ack).toMatchObject({ accepted: true, status: 'preparing', duplicate: false });
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(executor.isBusy()).toBe(true);
    expect(await executor.start(structuredClone(request))).toMatchObject({
      accepted: true,
      duplicate: true,
    });
    const result = await executor.settle();
    expect(result).toMatchObject({
      status: 'publication_ready',
      receipt: { id: 'c'.repeat(64) },
      nativeSessionId: 'test-harness-session',
      outcome: 'WAITING_FOR_INPUT',
      waitEvidence: { nativeIntentPath, pendingQuestions: 1, authority: 'workflow-evidence-only' },
    });
    expect(executor.isBusy()).toBe(false);
    expect(ports.prepare).toHaveBeenCalledTimes(1);
    expect(ports.commandRunner).toHaveBeenCalledTimes(4);
    expect(ports.publish).toHaveBeenCalledTimes(1);
    const published = ports.publish.mock.calls[0][0];
    expect(published.files.find((f) => f.path === questionPath).content).toEqual(
      Buffer.from(nativeFiles[questionPath]),
    );
    expect(published.files.find((f) => f.path === 'src/game.bin').content).toEqual(
      Buffer.from([0, 255, 13, 10]),
    );
    const owner = JSON.parse(
      await fs.readFile(join(root, '.native-control/first-turn/owner.json')),
    );
    expect(owner.identity.attemptId).toBe(request.attemptId);
    expect(JSON.stringify(owner)).not.toContain(request.configuration.prompt);
    expect(JSON.stringify(owner)).not.toContain('known-model-credential');
    expect(await executor.start(request)).toMatchObject({
      duplicate: true,
      status: 'publication_ready',
    });
    expect(ports.commandRunner).toHaveBeenCalledTimes(4);
  });

  it('uses exact real request with no invented scope or probe task and isolates auth/model environment', async () => {
    const { executor, request, ports } = make();
    await executor.start(request);
    request.configuration.prompt = 'caller mutation must not affect execution';
    await executor.settle();
    const model = ports.commandRunner.mock.calls.at(-1)[0];
    expect(model.stdin).toContain(payload().configuration.prompt);
    expect(model.stdin).toBe(
      nativeFirstTurnPrompt({ harness: 'codex', request: payload().configuration.prompt }),
    );
    expect(model.stdin).not.toContain('caller mutation');
    expect(model.stdin).not.toContain('/aidlc poc');
    expect(model).toMatchObject({ timeoutMs: null, outputLimitAction: 'truncate' });
    expect(model.env.AWS_BEARER_TOKEN_BEDROCK).toBe('known-model-credential');
    expect(model.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(model.env).not.toHaveProperty('AIDLC_UNATTENDED');
    expect(model.env.CODEX_HOME).toContain(homeRoot);
    expect(model.env.AIDLC_INSTALL_ROOT).toBe(join(root, 'machine/data'));
    expect(
      ports.commandRunner.mock.calls
        .slice(0, 3)
        .every(([command]) => command.timeoutMs === 300_000),
    ).toBe(true);
  });

  it('continues draining capture overflow until normal child exit and publishes whole question bytes', async () => {
    const { executor, request, ports } = make({ mode: 'overflow' });
    await executor.start(request);
    expect(await executor.settle()).toMatchObject({
      status: 'publication_ready',
      outputTruncated: true,
    });
    expect(
      ports.publish.mock.calls[0][0].files.find((f) => f.path === questionPath).content,
    ).toEqual(Buffer.from(nativeFiles[questionPath]));
  });

  it('cancels an unlimited real subprocess and never publishes a partial turn', async () => {
    const { executor, request, ports } = make({ mode: 'wait' });
    await executor.start(request);
    await vi.waitFor(() => expect(ports.commandRunner).toHaveBeenCalledTimes(4));
    expect(await executor.cancel(request)).toMatchObject({ status: 'cancelling' });
    expect(executor.isBusy()).toBe(true);
    expect(await executor.settle()).toMatchObject({ status: 'cancelled' });
    expect(executor.isBusy()).toBe(false);
    expect(ports.publish).not.toHaveBeenCalled();
  });

  it('never relaunches a durable owner in another executor instance or accepts another attempt', async () => {
    const { executor, request, ports } = make();
    await executor.start(request);
    await executor.settle();
    const restarted = createNativeExecutor(ports);
    expect(await restarted.start(request)).toMatchObject({
      accepted: false,
      status: 'stopped_needs_review',
      code: 'native_execution_existing_owner',
    });
    expect(await restarted.status(request)).toMatchObject({
      status: 'publication_ready',
      recovered: true,
      outcome: 'WAITING_FOR_INPUT',
      receipt: { id: 'c'.repeat(64) },
    });
    await expect(restarted.start({ ...request, attemptId: randomUUID() })).rejects.toMatchObject({
      code: 'native_execution_owner_conflict',
    });
    await expect(
      executor.start({
        ...request,
        configuration: { ...request.configuration, model: 'different' },
      }),
    ).rejects.toMatchObject({ code: 'native_execution_owner_conflict' });
    expect(ports.commandRunner).toHaveBeenCalledTimes(4);
  });

  it('only one competing factory claims the durable owner', async () => {
    const { executor, request, ports } = make();
    const competing = createNativeExecutor(ports);
    const starts = await Promise.allSettled([executor.start(request), competing.start(request)]);
    expect(starts.filter((r) => r.status === 'fulfilled' && r.value.accepted)).toHaveLength(1);
    await Promise.all([executor.settle(), competing.settle()]);
    expect(ports.prepare).toHaveBeenCalledTimes(1);
  });

  it.each(['projectId', 'executionId', 'bindingId', 'epoch'])(
    'rejects mismatched %s before touching a workspace',
    async (key) => {
      const { executor, request, ports } = make();
      await expect(
        executor.start({ ...request, [key]: key === 'epoch' ? 2 : randomUUID() }),
      ).rejects.toMatchObject({ code: 'native_execution_scope_mismatch' });
      expect(ports.inspectMount).not.toHaveBeenCalled();
      expect(await fs.readdir(root)).toEqual([]);
    },
  );

  it('fails publication on credential bytes without redaction, raw errors or raw stdout in status', async () => {
    const { executor, request, ports } = make({ mode: 'secret' });
    await executor.start(request);
    const result = await executor.settle();
    expect(result).toMatchObject({ status: 'failed', code: 'native_snapshot_credential_content' });
    expect(JSON.stringify(result)).not.toContain('known-model-credential');
    expect(ports.publish).not.toHaveBeenCalled();
  });

  it('unknown native formats stop for review instead of treating CLI success as completion', async () => {
    const { executor, request, ports } = make({ mode: 'unknown' });
    await executor.start(request);
    expect(await executor.settle()).toMatchObject({
      status: 'publication_ready',
      outcome: 'STOPPED',
    });
    expect(ports.publish.mock.calls[0][0].outcome).toBe('STOPPED');
  });

  it('does not expose a receipt before upload completes and never claims authority commit', async () => {
    let complete;
    const gate = new Promise((resolve) => {
      complete = resolve;
    });
    const publish = vi.fn(async () => gate);
    const { executor, request } = make({ ports: { publish } });
    await executor.start(request);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(await executor.status(request)).toMatchObject({ status: 'publishing' });
    expect(await executor.status(request)).not.toHaveProperty('outcome');
    complete({ committed: false });
    expect(await executor.settle()).toMatchObject({
      status: 'failed',
      code: 'native_execution_publication_unconfirmed',
    });
  });

  it('sanitizes port errors and refuses residue instead of deleting or replacing it', async () => {
    const { executor, request, ports } = make();
    await fs.mkdir(join(root, 'project'), { mode: 0o700 });
    await fs.writeFile(join(root, 'project/keep'), 'existing');
    await expect(executor.start(request)).rejects.toMatchObject({
      code: 'native_execution_start_failed',
    });
    expect(await executor.status(request)).toMatchObject({ status: 'stopped_needs_review' });
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(await fs.readFile(join(root, 'project/keep'), 'utf8')).toBe('existing');
  });

  it('halts snapshot/publication and remains busy when process cleanup cannot be established', async () => {
    const runner = vi.fn(async () => ({ ...cleanCommand, cleanupComplete: false }));
    const snapshot = vi.fn();
    const { executor, request, ports } = make({ ports: { commandRunner: runner, snapshot } });
    await executor.start(request);
    expect(await executor.settle()).toMatchObject({
      status: 'stopped_needs_review',
      code: 'native_execution_cleanup_incomplete',
    });
    expect(executor.isBusy()).toBe(true);
    expect(snapshot).not.toHaveBeenCalled();
    expect(ports.publish).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('rejects unverified package version, checkout commit and missing credentials before executing commands', async () => {
    const { executor, request, ports } = make({
      ports: { prepare: async () => ({ package: { version: 'wrong' } }) },
    });
    await executor.start(request);
    expect(await executor.settle()).toMatchObject({
      status: 'failed',
      code: 'native_execution_preparation_invalid',
    });
    expect(ports.commandRunner).not.toHaveBeenCalled();
  });
});

describe('native invocation and first-wait classification', () => {
  it('sets only the generated Claude SessionEnd hook timeout and preserves native settings', async () => {
    const project = join(root, 'claude-project');
    await fs.mkdir(join(project, '.claude'), { recursive: true, mode: 0o700 });
    const settings = {
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'aidlc engine hook session-end' }] }],
        Other: [{ keep: true }],
      },
    };
    const path = join(project, '.claude/settings.json');
    await fs.writeFile(path, JSON.stringify(settings));
    await configureNativeClaudeSessionEnd(project);
    settings.hooks.SessionEnd[0].hooks[0].timeout = 30;
    expect(JSON.parse(await fs.readFile(path))).toEqual(settings);
    await configureNativeClaudeSessionEnd(project);
    expect(JSON.parse(await fs.readFile(path))).toEqual(settings);
  });

  it('refuses unsafe or ambiguous Claude hook configuration', async () => {
    const project = join(root, 'claude-project');
    await fs.mkdir(join(project, '.claude'), { recursive: true, mode: 0o700 });
    const path = join(project, '.claude/settings.json');
    const settings = {
      hooks: {
        SessionEnd: [
          {
            hooks: [
              { type: 'command', command: 'aidlc engine hook session-end' },
              { type: 'command', command: 'aidlc engine hook session-end' },
            ],
          },
        ],
      },
    };
    await fs.writeFile(path, JSON.stringify(settings));
    await expect(configureNativeClaudeSessionEnd(project)).rejects.toMatchObject({
      code: 'native_execution_claude_settings_invalid',
    });
    expect(JSON.parse(await fs.readFile(path))).toEqual(settings);
    await fs.link(path, join(root, 'linked-settings'));
    await expect(configureNativeClaudeSessionEnd(project)).rejects.toMatchObject({
      code: 'native_execution_claude_settings_invalid',
    });
  });
  it.each([
    ['codex', '$aidlc'],
    ['claude', '/aidlc'],
    ['kiro', '/aidlc'],
    ['opencode', '/aidlc'],
  ])('preserves the exact request and transport annex with the %s marker', (harness, marker) => {
    const request = '\uFEFF  # Fix the pipes\r\n\r\n$literal `text` — keep trailing space  \n';
    const annex =
      'Platform transport instruction: The request above is the exact user request. ' +
      'Start a new native AI-DLC workflow using its normal filesystem artifacts. ' +
      'Do not invent missing scope, requirements, or human answers. At the first workflow ' +
      'question or approval that needs a person, present the complete proposal and questions ' +
      'in your normal assistant response, preserve any normal workflow artifacts, leave ' +
      'the native workflow waiting, and end this turn. The platform will show your response and files to ' +
      'the user. Do not approve a gate, answer on behalf of the user, or continue past that wait. ' +
      // Task-3: the rendered question spec, so members can select exact options.
      'Whenever you end a turn with a structured question or approval for the user, also write ' +
      'the exact question spec you rendered as JSON to .native-control/pending-question.json in the project ' +
      'directory, replacing any earlier file: {"version":1,"questions":[{"prompt":"...","header":"...",' +
      '"multiSelect":false,"options":[{"label":"...","description":"..."}]}]}. Use the exact option ' +
      'labels from the spec, without numbers, letters or "(Recommended)", and keep rendering the ' +
      "question normally in your response. The user's reply will contain the exact selected " +
      'label(s); record it with the workflow command that question requires.' +
      // The stateless intake plan offer is answered through `next`, never `report`.
      " If the question was the engine's plan offer made before any workflow state exists " +
      '(no aidlc-state.md yet), then when the user replies, record their choice by re-running ' +
      'the engine with the chosen plan in front of the original request text, passed unchanged ' +
      'as one shell-safe argument: `aidlc engine orchestrate next compose <original request>` for ' +
      'compose, or `aidlc engine orchestrate next --scope <plan> <original request>` for a named ' +
      'plan. Do not use report for that answer.';
    expect(nativeFirstTurnPrompt({ harness, request })).toBe(`${marker} ${request}\n\n${annex}`);
  });
  it.each([undefined, null, '', 'CODEX', 'unknown', ['codex'], {}])(
    'refuses an unsupported prompt harness: %j',
    (harness) => {
      expect(() => nativeFirstTurnPrompt({ harness, request: 'real request' })).toThrow(
        'native_execution_harness_invalid',
      );
    },
  );
  it('requires callers to supply the harness explicitly', () => {
    expect(() => nativeFirstTurnPrompt()).toThrow('native_execution_harness_invalid');
    expect(() => nativeFirstTurnPrompt('old one-argument call')).toThrow(
      'native_execution_harness_invalid',
    );
  });
  it.each(['codex', 'claude', 'kiro', 'opencode'])(
    'builds the %s invocation without model caps',
    (harness) => {
      const invocation = nativeExecutionInvocation({
        harness,
        prompt: nativeFirstTurnPrompt({ harness, request: 'real request' }),
        model: 'configured-model',
        project: '/mnt/native/project',
      });
      expect(invocation.args.join(' ')).not.toMatch(/max-turns|max-tokens|budget|timeout/);
      expect(invocation.stdin ?? invocation.args.at(-1)).toContain('real request');
      if (harness === 'kiro') expect(invocation.args).toContain('--production');
    },
  );

  it('bounds concurrent codex sub-agents on first turns and resumes only', () => {
    const base = { prompt: 'p', model: 'configured-model', project: '/mnt/native/project' };
    for (const nativeSessionId of [null, 'native-session']) {
      const { args } = nativeExecutionInvocation({ ...base, harness: 'codex', nativeSessionId });
      const at = args.indexOf(`agents.max_threads=${NATIVE_CODEX_MAX_THREADS}`);
      expect(NATIVE_CODEX_MAX_THREADS).toBe(4);
      expect(at).toBeGreaterThan(0);
      expect(args[at - 1]).toBe('-c');
    }
    for (const harness of ['claude', 'kiro', 'opencode'])
      expect(nativeExecutionInvocation({ ...base, harness }).args.join(' ')).not.toContain(
        'max_threads',
      );
  });

  const asSnapshot = (files = nativeFiles) => ({
    files: Object.entries(files).map(([path, content]) => ({
      path,
      content: Buffer.from(content),
      sha256: createHash('sha256').update(content).digest('hex'),
      role: path === questionPath ? 'question' : 'state',
    })),
  });
  it('never surfaces an unchanged old question or a filled multiline answer', () => {
    const snapshot = asSnapshot();
    expect(
      classifyNativeFirstWait({ snapshot, harness: 'codex', beforeFiles: snapshot.files }).kind,
    ).toBe('stopped_needs_review');
    const answered = asSnapshot({
      ...nativeFiles,
      [questionPath]: nativeFiles[questionPath] + 'Retro pipes.\n',
    });
    expect(classifyNativeFirstWait({ snapshot: answered, harness: 'codex' }).kind).toBe(
      'stopped_needs_review',
    );
  });
  it('requires agreeing native state/directive, active intent, and exact question files', () => {
    expect(classifyNativeFirstWait({ snapshot: asSnapshot(), harness: 'kiro' }).kind).toBe(
      'stopped_needs_review',
    );
    expect(classifyNativeFirstWait({ snapshot: { files: [] }, harness: 'codex' }).kind).toBe(
      'stopped_needs_review',
    );
    const changed = asSnapshot({ ...nativeFiles, 'aidlc/active-space': '../other' });
    expect(classifyNativeFirstWait({ snapshot: changed, harness: 'codex' }).kind).toBe(
      'stopped_needs_review',
    );
  });
});

describe('native cold recovery', () => {
  const CHECKPOINT = '9'.repeat(64);
  // A first turn captures a checkpoint; a successor generation restores it on
  // the same mount. Session capture/restore are injected; the executor's own
  // directory replacement, machine projection and admission run for real.
  const recoverable = async () => {
    let captured;
    const first = make({
      ports: {
        captureRecovery: vi.fn(async () => ({ metadata: { schemaVersion: 1 }, files: [] })),
        publishRecovery: vi.fn(async (input) => {
          captured = input;
          return { sequence: input.sequence, id: CHECKPOINT, manifest: { sha256: CHECKPOINT } };
        }),
      },
    });
    await first.executor.start(first.request);
    const head = await first.executor.settle();
    expect(head.status).toBe('publication_ready');
    const packages = join(root, 'packages');
    const successor = make({
      request: first.request,
      ports: {
        assertRecoveryAdmission: vi.fn(async () => {}),
        loadRecovery: vi.fn(async () => ({
          manifest: {
            sequence: captured.sequence,
            writerGeneration: captured.writerGeneration,
            configurationSha256: captured.configurationSha256,
            publicationId: captured.publicationId,
            interactionId: captured.interactionId,
            nativeSessionId: captured.nativeSessionId,
            harness: captured.harness,
            imageDigest: captured.imageDigest,
            packageId: captured.packageId,
            continuation: captured.continuation,
            filesystem: captured.filesystem,
          },
          files: [],
        })),
        prepareRecovery: vi.fn(async () => ({
          package: {
            directory: packages,
            binaryPath: join(packages, 'aidlc'),
            version: '2.9.0',
            packageId: captured.packageId,
          },
        })),
        restoreRecovery: vi.fn(async ({ project, nativeSessionId, harness }) => {
          // The restored project carries its committed pin, not the machine registry.
          await fs.writeFile(join(project, '.aidlc-version'), '2.9.0\n');
          return { restored: true, nativeSessionId, harness };
        }),
      },
    });
    const input = {
      ...first.request,
      command: 'native-recover',
      writerGeneration: 2,
      recoveryId: randomUUID(),
      sequence: head.sequence,
      checkpoint: { sequence: head.sequence, id: CHECKPOINT },
      publication: head.receipt,
      interaction: head.interaction,
    };
    return { ...successor, input, packages };
  };

  it('re-registers the restored project pin with the rebuilt machine projection', async () => {
    const { executor, input, ports, packages } = await recoverable();
    await executor.recover(input);
    expect(await executor.settle()).toMatchObject({
      status: 'recovery_ready',
      recoveryId: input.recoveryId,
      checkpointId: CHECKPOINT,
    });
    const commands = ports.commandRunner.mock.calls.map(([call]) => call);
    expect(commands.map(({ command, args }) => [command, args])).toEqual([
      [join(packages, 'aidlc'), ['use', '2.9.0', '--from', packages, '--offline', '--json']],
      [
        join(root, 'machine/bin/aidlc'),
        [
          'config',
          '--pin',
          '2.9.0',
          '--project-dir',
          join(root, 'project'),
          '--from',
          packages,
          '--offline',
          '--json',
        ],
      ],
    ]);
    // Both run against the rebuilt machine data, offline, never with model credentials.
    for (const { env: commandEnv } of commands) {
      expect(commandEnv).toMatchObject({
        AIDLC_INSTALL_ROOT: join(root, 'machine/data'),
        AIDLC_BIN_DIR: join(root, 'machine/bin'),
        AIDLC_PROJECT_DIR: join(root, 'project'),
        AIDLC_OFFLINE: '1',
      });
      expect(Object.keys(commandEnv).filter((key) => /TOKEN|SECRET|KEY/.test(key))).toEqual([]);
    }
  });

  it('does not report a recovered owner when the pin cannot be re-registered', async () => {
    const { executor, input, ports } = await recoverable();
    ports.commandRunner.mockImplementation(async ({ args }) =>
      args[0] === 'config' ? { ...cleanCommand, exitCode: 1 } : cleanCommand,
    );
    await executor.recover(input);
    expect(await executor.settle()).toMatchObject({
      status: 'stopped_needs_review',
      code: 'native_execution_recovery_failed',
      recoveryFailureCode: 'native_execution_initialization_failed',
    });
  });
});
