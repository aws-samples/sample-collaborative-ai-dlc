import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNativeInteractionProbe,
  nativeProbeInvocation,
  snapshotNativeProbeArtifacts,
  nativeProbeResponse,
  NATIVE_INTERACTION_ANSWER,
  NATIVE_INTERACTION_PROMPT,
} from '../native/interaction-probe.js';
import { createBusyTracker } from '../http-server.js';
import { kiroAssistantHash } from '../native/kiro-acp-turn.js';

const id = '33333333-3333-4333-8333-333333333333';
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const directory = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-interaction-test-')));
  roots.push(root);
  return root;
};
const payload = (action, extra = {}) => ({
  command: 'native-interaction-probe',
  action,
  probeId: id,
  executionId: id,
  requestedCli: 'codex',
  ...extra,
});
const context = {
  availableClis: ['codex', 'claude', 'kiro', 'opencode'],
  env: {
    AWS_BEARER_TOKEN_BEDROCK: 'private-model-key',
    KIRO_API_KEY: 'unused-secret',
    AIDLC_UNATTENDED: '1',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://ambient-role-credentials',
    AGENT_CREDENTIAL_GRANT_SECRET: 'must-not-be-a-child-env',
  },
};
const result = (extra = {}) => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  outputLimitExceeded: false,
  cleanupComplete: true,
  spawnError: null,
  stderr: '',
  stdout:
    JSON.stringify({ type: 'thread.started', thread_id: 'native-thread-1' }) +
    '\n' +
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Blue Lake or Green Meadow?' },
    }),
  ...extra,
});
const setup = async (extra = {}) => {
  const workspaceDir = await directory();
  const localHomeRoot = await directory();
  const busy = createBusyTracker();
  const commandRunner = vi.fn(async () => result());
  const prepareWorkspace = vi.fn(async () => {});
  const probe = createNativeInteractionProbe({
    enabled: true,
    workspaceDir,
    localHomeRoot,
    busy,
    commandRunner,
    prepareWorkspace,
    platform: 'linux',
    arch: 'arm64',
    ...extra,
  });
  return { probe, busy, commandRunner, prepareWorkspace, workspaceDir, localHomeRoot };
};

describe('native interaction experiment', () => {
  it('refuses a missing EFS mount before creating files or starting a harness', async () => {
    const { probe, commandRunner, prepareWorkspace, workspaceDir } = await setup({
      requireEfs: true,
      inspectEfsWorkspace: async () => {
        throw new Error('Not mounted');
      },
    });
    expect(await probe.invoke(payload('start'), context)).toMatchObject({
      status: 'FAILED',
      failure: 'native_efs_mount_unavailable',
    });
    expect(await readdir(workspaceDir)).toEqual([]);
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('keeps active harness stores local when the native project and installation move', async () => {
    const inspectEfsWorkspace = vi.fn(async () => ({
      mountPath: '/mnt/native',
      filesystemType: 'nfs4',
    }));
    const { probe, commandRunner, workspaceDir, localHomeRoot } = await setup({
      requireEfs: true,
      inspectEfsWorkspace,
    });
    await probe.invoke(payload('start'), context);
    await probe.settle();
    const { env, cwd } = commandRunner.mock.calls[0][0];
    expect(cwd).toBe(join(workspaceDir, 'native-interaction-probes', id, 'project'));
    expect(env.AIDLC_INSTALL_ROOT).toBe(
      join(workspaceDir, 'native-interaction-probes', id, 'machine/data'),
    );
    expect(env.AIDLC_BIN_DIR).toBe(
      join(workspaceDir, 'native-interaction-probes', id, 'machine/bin'),
    );
    for (const name of [
      'HOME',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
    ]) {
      expect(env[name]).toContain(join(localHomeRoot, 'probe-'));
      expect(env[name].startsWith(`${workspaceDir}/`)).toBe(false);
    }
    const report = await probe.invoke(payload('status'), context);
    expect(report.storage).toMatchObject({ efsRequired: true, harnessState: 'local-ephemeral' });
    expect(report.recovery).toBe('not-tested');
    expect(inspectEfsWorkspace).toHaveBeenCalledWith({ workspaceDir });
  });

  it('rejects a redirected harness home before writing there or starting a model', async () => {
    const root = await directory();
    const outside = await directory();
    const localHomeRoot = join(root, 'redirected');
    await symlink(outside, localHomeRoot);
    const { probe, commandRunner } = await setup({ localHomeRoot });
    expect(await probe.invoke(payload('start'), context)).toMatchObject({
      status: 'FAILED',
      failure: 'workspace_exists_or_unavailable',
    });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
  });

  it('stops before continuation or evidence writes if the EFS mount disappears', async () => {
    const inspectEfsWorkspace = vi
      .fn()
      .mockResolvedValueOnce({ mountPath: '/mnt/native', filesystemType: 'nfs4' })
      .mockRejectedValueOnce(new Error('Unmounted'));
    const persistReport = vi.fn(async () => {});
    const { probe, commandRunner } = await setup({
      requireEfs: true,
      inspectEfsWorkspace,
      persistReport,
    });
    await probe.invoke(payload('start'), context);
    await probe.settle();
    await probe.invoke(payload('answer'), context);
    await probe.settle();
    expect(await probe.invoke(payload('status'), context)).toMatchObject({
      status: 'FAILED',
      failure: 'native_efs_mount_unavailable',
    });
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(persistReport).toHaveBeenCalledTimes(1);
  });

  it('keeps a previous turn credential redacted after rotation, including artifact paths', async () => {
    const { probe } = await setup({
      prepareWorkspace: async ({ project }) => {
        const intent = join(project, 'aidlc/spaces/default/intents/probe');
        await mkdir(intent, { recursive: true });
        await writeFile(join(intent, 'private-model-key.md'), 'private-model-key');
      },
    });
    await probe.invoke(payload('start'), context);
    await probe.settle();
    await probe.invoke(payload('answer'), {
      ...context,
      env: { AWS_BEARER_TOKEN_BEDROCK: 'rotated-key' },
    });
    await probe.settle();
    const out = await probe.invoke(payload('status'), {});
    expect(out.status).toBe('ANSWER_TURN_FINISHED');
    expect(JSON.stringify(out)).not.toContain('private-model-key');
    expect(out.turns[1].before.files[0].path).toContain('[credential removed]');
  });

  it('cannot start an answer while the previous turn is still saving evidence', async () => {
    let saving;
    let rejectSave;
    const begun = new Promise((resolve) => {
      saving = resolve;
    });
    const held = new Promise((_, reject) => {
      rejectSave = reject;
    });
    const { probe, commandRunner, busy } = await setup({
      persistReport: async () => {
        saving();
        await held;
      },
    });
    await probe.invoke(payload('start'), context);
    await begun;
    expect(await probe.invoke(payload('answer'), context)).toMatchObject({
      reason: 'native_probe_not_answerable',
    });
    expect(busy.status).toBe('HealthyBusy');
    rejectSave(new Error('Synthetic storage failure'));
    await probe.settle();
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(await probe.invoke(payload('status'), {})).toMatchObject({
      status: 'FAILED',
      failure: 'evidence_write_failed',
    });
    expect(busy.status).toBe('Healthy');
  });

  it('keeps status and questions available when JSON escaping makes evidence too large', () => {
    const snapshot = {
      bounded: false,
      files: [{ path: 'intent.json', content: '\0'.repeat(384 * 1024) }],
    };
    const report = {
      status: 'FIRST_TURN_FINISHED',
      turns: [{ assistantText: 'What title?', before: snapshot, after: snapshot }],
    };
    const out = nativeProbeResponse(report);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(1_500_000);
    expect(out).toMatchObject({ status: 'FIRST_TURN_FINISHED', evidenceTruncated: true });
    expect(out.turns[0].assistantText).toBe('What title?');
    expect(out.turns[0].after.files[0]).toEqual({
      path: 'intent.json',
      omitted: 'response-size-limit',
    });
    expect(report.turns[0].after.files[0].content.length).toBe(384 * 1024);
  });
  it('requires a separate answer action, serializes duplicate starts and preserves native session identity', async () => {
    const { probe, busy, commandRunner } = await setup();
    const start = probe.invoke(payload('start'), context);
    const duplicate = probe.invoke(payload('start'), context);
    await Promise.all([start, duplicate]);
    await probe.settle();
    const first = await probe.invoke(payload('status'), context);
    expect(first).toMatchObject({
      status: 'FIRST_TURN_FINISHED',
      resumable: true,
      qualification: 'requires-evidence-review',
      humanAuthority: 'not-tested-synthetic-operator-fixture',
    });
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(commandRunner.mock.calls[0][0].args).toContain(NATIVE_INTERACTION_PROMPT);
    const env = commandRunner.mock.calls[0][0].env;
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('private-model-key');
    for (const name of [
      'KIRO_API_KEY',
      'AGENT_CREDENTIAL_GRANT_SECRET',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AIDLC_UNATTENDED',
    ])
      expect(env[name]).toBeUndefined();
    expect(env.PATH).toContain('/machine/bin:');
    await probe.invoke(payload('answer'), context);
    expect(await probe.invoke(payload('answer'), context)).toMatchObject({
      ok: false,
      reason: 'native_probe_not_answerable',
    });
    await probe.settle();
    expect(commandRunner).toHaveBeenCalledTimes(2);
    expect(commandRunner.mock.calls[1][0].args).toEqual(
      expect.arrayContaining(['resume', 'native-thread-1', NATIVE_INTERACTION_ANSWER]),
    );
    for (const [{ args }] of commandRunner.mock.calls) {
      const configOverrides = args.filter((_, index) => args[index - 1] === '-c');
      expect(configOverrides).toEqual(
        expect.arrayContaining([
          'features.default_mode_request_user_input=false',
          'tools.experimental_request_user_input.enabled=false',
        ]),
      );
    }
    expect(await probe.invoke(payload('status'), context)).toMatchObject({
      status: 'ANSWER_TURN_FINISHED',
      qualification: 'requires-evidence-review',
    });
    expect(busy.status).toBe('Healthy');
  });

  it.each([
    { prompt: 'arbitrary instruction' },
    { projectId: 'real-project' },
    { requestedCli: 'shell' },
    { probeId: '../project' },
    { executionId: 'real-execution' },
  ])('rejects caller-controlled authority or command input: %j', async (extra) => {
    const { probe, commandRunner } = await setup();
    expect(await probe.invoke(payload('start', extra), context)).toMatchObject({
      ok: false,
      reason: 'native_probe_invalid',
    });
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('refuses a different harness on the same session and will not infer a resumable session from prose', async () => {
    const { probe } = await setup({
      commandRunner: async () => result({ stdout: 'Pretend this is session native-thread-1' }),
    });
    await probe.invoke(payload('start'), context);
    await probe.settle();
    expect(await probe.invoke(payload('status', { requestedCli: 'kiro' }), context)).toMatchObject({
      ok: false,
      reason: 'native_probe_session_mismatch',
    });
    expect(await probe.invoke(payload('answer'), context)).toMatchObject({
      ok: false,
      reason: 'native_probe_not_answerable',
    });
  });

  it('halts on incomplete process cleanup and keeps cancellation observable', async () => {
    let entered;
    const running = new Promise((resolve) => {
      entered = resolve;
    });
    const { probe, busy } = await setup({
      commandRunner: async ({ signal }) => {
        entered();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return result({ cleanupComplete: false });
      },
    });
    await probe.invoke(payload('start'), context);
    await running;
    expect(busy.status).toBe('HealthyBusy');
    await probe.invoke(payload('cancel'), context);
    await probe.settle();
    expect(await probe.invoke(payload('status'), context)).toMatchObject({
      status: 'FAILED',
      failure: 'process-cleanup-incomplete',
    });
    expect(await probe.invoke(payload('answer'), context)).toMatchObject({
      ok: false,
      reason: 'native_probe_runtime_unhealthy',
    });
    expect(busy.status).toBe('Healthy');
  });

  it('redacts known model credentials from report and stored CLI evidence', async () => {
    const { probe, workspaceDir } = await setup({
      commandRunner: async () => result({ stderr: 'private-model-key' }),
    });
    await probe.invoke(payload('start'), context);
    await probe.settle();
    const report = await probe.invoke(payload('status'), context);
    expect(JSON.stringify(report)).not.toContain('private-model-key');
    expect(report.turns[0].diagnostics).toBe('[credential removed]');
    const evidence = join(workspaceDir, 'native-interaction-probes', id, 'evidence');
    const turn = (await readdir(evidence)).find((name) => name.startsWith('turn-'));
    expect(await readFile(join(evidence, turn, 'cli.json'), 'utf8')).not.toContain(
      'private-model-key',
    );
  });

  it.each(['codex', 'kiro'])(
    'does not read or write workspace evidence after %s cleanup becomes uncertain',
    async (harness) => {
      const snapshot = vi.fn(async () => ({ files: [], bounded: false }));
      const persistReport = vi.fn();
      const { probe } = await setup({
        snapshot,
        persistReport,
        commandRunner: async () => result({ cleanupComplete: false }),
      });
      await probe.invoke(payload('start', { requestedCli: harness }), context);
      await probe.settle();
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(persistReport).not.toHaveBeenCalled();
      expect(await probe.invoke(payload('status', { requestedCli: harness }), {})).toMatchObject({
        status: 'FAILED',
        failure: 'process-cleanup-incomplete',
        resumable: false,
        turns: [{ after: { files: [], bounded: true } }],
      });
    },
  );

  it('does not use saved filesystem reports as authority after a new runtime starts', async () => {
    const first = await setup();
    await first.probe.invoke(payload('start'), context);
    await first.probe.settle();
    const next = createNativeInteractionProbe({
      enabled: true,
      workspaceDir: first.workspaceDir,
      platform: 'linux',
      arch: 'arm64',
      prepareWorkspace: vi.fn(),
    });
    expect(await next.invoke(payload('answer'), context)).toMatchObject({
      reason: 'native_probe_not_answerable',
    });
    expect(await next.invoke(payload('start'), context)).toMatchObject({
      status: 'FAILED',
      failure: 'workspace_exists_or_unavailable',
    });
  });

  it.each(['claude', 'codex', 'kiro', 'opencode'])(
    'uses native session resumption for %s without platform MCP',
    (harness) => {
      const invocation = nativeProbeInvocation({
        harness,
        prompt: NATIVE_INTERACTION_ANSWER,
        sessionId: 'session-123',
        project: '/tmp/disposable',
        priorAssistantSha256: 'a'.repeat(64),
        priorUserPromptSha256: 'b'.repeat(64),
      });
      expect(invocation.args).toContain('session-123');
      expect(JSON.stringify(invocation)).not.toMatch(
        /mcp-config|V2_MCP|stage-materializer|OPENCODE_CONFIG_CONTENT/,
      );
    },
  );
});

describe('Kiro ACP reporting', () => {
  const firstId = 'kiro-session-A';
  const observed = (sessionId = firstId, extra = {}) =>
    result({
      stdout: JSON.stringify({
        schemaVersion: 1,
        transport: 'kiro-acp',
        ok: true,
        sessionId,
        text: 'Kiro is awaiting the next answer.',
        requestedModel: 'auto',
        observedModel: 'auto',
        modelVerified: true,
        sessionLoadAcknowledged: true,
        priorPromptObserved: true,
        priorAssistantObserved: true,
        expectedUserPromptSha256: 'b'.repeat(64),
        replayedUserPromptSha256: 'b'.repeat(64),
        userPromptSource: 'aidlc-skill-expansion',
        replayedAssistantSha256: kiroAssistantHash('Kiro is awaiting the next answer.'),
        replayedUserChunks: 1,
        replayedAssistantChunks: 1,
        stopReason: 'end_turn',
        ...extra,
      }),
    });
  const startKiro = async (runner = () => observed()) => {
    let turn = 0;
    const commandRunner = vi.fn(async (options) => runner({ ...options, turn: ++turn }));
    const run = await setup({ commandRunner });
    await run.probe.invoke(
      payload('start', { requestedCli: 'kiro', cliModels: { kiro: 'auto' } }),
      context,
    );
    await run.probe.settle();
    return { ...run, commandRunner };
  };
  const answerKiro = async (probe) => {
    await probe.invoke(payload('answer', { requestedCli: 'kiro' }), context);
    await probe.settle();
    return probe.invoke(payload('status', { requestedCli: 'kiro' }));
  };

  it('retains the first expanded prompt hash with the original ID for ACP replay verification', async () => {
    const { probe, commandRunner } = await startKiro();
    expect(await answerKiro(probe)).toMatchObject({
      status: 'ANSWER_TURN_FINISHED',
      resumable: true,
      qualification: 'requires-evidence-review',
      turns: [
        {
          requestedSessionId: null,
          observedSessionId: firstId,
          identitySource: 'kiro-acp-session-new',
        },
        {
          requestedSessionId: firstId,
          observedSessionId: firstId,
          identitySource: 'kiro-acp-session-load',
          observedModel: 'auto',
          modelVerified: true,
          priorPromptObserved: true,
          expectedUserPromptSha256: 'b'.repeat(64),
          replayedUserPromptSha256: 'b'.repeat(64),
          sessionLoadAcknowledged: true,
        },
      ],
    });
    expect(commandRunner).toHaveBeenCalledTimes(2);
    const invocation = commandRunner.mock.calls[1][0];
    expect(invocation.command).toBe(process.execPath);
    for (const argument of [
      '--resume-id',
      firstId,
      '--prior-user-prompt-sha256',
      'b'.repeat(64),
      '--model',
      'auto',
    ])
      expect(invocation.args).toContain(argument);
    expect(invocation.args).not.toContain('--list-sessions');
    expect(invocation.env.KIRO_API_KEY).toBe('unused-secret');
    expect(invocation.env).not.toHaveProperty('AWS_CONTAINER_CREDENTIALS_FULL_URI');
  });

  it('fails A-to-B continuation and retains the original request and evidence', async () => {
    const { probe, commandRunner, workspaceDir } = await startKiro(({ turn }) =>
      observed(turn === 1 ? firstId : 'kiro-session-B'),
    );
    expect(await answerKiro(probe)).toMatchObject({
      status: 'FAILED',
      failure: 'native_kiro_resume_session_mismatch',
      resumable: false,
      turns: [
        { observedSessionId: firstId },
        {
          requestedSessionId: firstId,
          observedSessionId: 'kiro-session-B',
          process: { exitCode: 0, cleanupComplete: true },
          assistantText: 'Kiro is awaiting the next answer.',
        },
      ],
    });
    expect(commandRunner.mock.calls[1][0].args).toContain(firstId);
    expect(commandRunner.mock.calls[1][0].args).not.toContain('kiro-session-B');
    const evidence = join(workspaceDir, 'native-interaction-probes', id, 'evidence');
    const saved = await Promise.all(
      (await readdir(evidence))
        .filter((name) => name.startsWith('turn-'))
        .map((name) => readFile(join(evidence, name, 'cli.json'), 'utf8')),
    );
    expect(saved.some((text) => text.includes('kiro-session-B'))).toBe(true);
    expect(await probe.invoke(payload('answer', { requestedCli: 'kiro' }), context)).toMatchObject({
      reason: 'native_probe_not_answerable',
    });
  });

  it.each([
    ['missing ID', observed(null)],
    ['unsafe ID', observed('../outside')],
    ['malformed JSON', result({ stdout: '{' })],
    ['wrong envelope', result({ stdout: '[]' })],
  ])('fails resumed identity verification for %s', async (_label, response) => {
    const { probe } = await startKiro(({ turn }) => (turn === 1 ? observed() : response));
    expect(await answerKiro(probe)).toMatchObject({
      status: 'FAILED',
      failure: 'native_kiro_resume_session_missing',
      resumable: false,
    });
  });

  it.each([
    ['adapter failure', { ok: false, protocolFailure: 'native_kiro_acp_request_failed' }],
    ['no model acknowledgement', { modelVerified: false }],
    ['model fallback', { observedModel: 'other-model' }],
    ['no load acknowledgement', { sessionLoadAcknowledged: false }],
    ['no original prompt', { priorPromptObserved: false }],
    ['different replayed user text', { replayedUserPromptSha256: 'c'.repeat(64) }],
    ['replaced first-turn prompt hash', { expectedUserPromptSha256: 'c'.repeat(64) }],
    ['no prior assistant text', { replayedAssistantChunks: 0 }],
    ['different prior assistant text', { replayedAssistantSha256: 'a'.repeat(64) }],
  ])('fails even with matching IDs after %s', async (_label, extra) => {
    const { probe } = await startKiro(({ turn }) => observed(firstId, turn === 1 ? {} : extra));
    expect(await answerKiro(probe)).toMatchObject({
      status: 'FAILED',
      failure: 'native_kiro_acp_failed',
      resumable: false,
    });
  });

  it.each([null, undefined, 'invalid', 'a'.repeat(63)])(
    'refuses an answer without a valid first-turn expanded prompt hash: %j',
    async (expectedUserPromptSha256) => {
      const { probe, commandRunner } = await startKiro(() =>
        observed(firstId, { expectedUserPromptSha256 }),
      );
      expect(await probe.invoke(payload('status', { requestedCli: 'kiro' }))).toMatchObject({
        status: 'FAILED',
        failure: 'native_kiro_acp_failed',
        resumable: false,
      });
      expect(
        await probe.invoke(payload('answer', { requestedCli: 'kiro' }), context),
      ).toMatchObject({
        reason: 'native_probe_not_answerable',
      });
      expect(commandRunner).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses answers when Kiro produces no first-turn assistant history to verify', async () => {
    const { probe } = await startKiro(() => observed(firstId, { text: '   ' }));
    expect(await probe.invoke(payload('status', { requestedCli: 'kiro' }))).toMatchObject({
      status: 'FAILED',
      failure: 'native_kiro_acp_failed',
      resumable: false,
    });
    expect(await probe.invoke(payload('answer', { requestedCli: 'kiro' }), context)).toMatchObject({
      reason: 'native_probe_not_answerable',
    });
  });

  it('fails and refuses answers when the first turn has no usable identity', async () => {
    const { probe, commandRunner } = await startKiro(() => observed(null));
    expect(await probe.invoke(payload('status', { requestedCli: 'kiro' }))).toMatchObject({
      status: 'FAILED',
      failure: 'native_kiro_acp_failed',
      resumable: false,
    });
    expect(await probe.invoke(payload('answer', { requestedCli: 'kiro' }), context)).toMatchObject({
      reason: 'native_probe_not_answerable',
    });
    expect(commandRunner).toHaveBeenCalledTimes(1);
  });

  it('compares raw IDs and redacts all model credentials from new evidence fields', async () => {
    const { probe } = await startKiro(({ turn }) =>
      observed(turn === 1 ? context.env.KIRO_API_KEY : context.env.AWS_BEARER_TOKEN_BEDROCK, {
        protocolFailure: turn === 1 ? null : context.env.KIRO_API_KEY,
        modelSource: context.env.AWS_BEARER_TOKEN_BEDROCK,
      }),
    );
    const report = await answerKiro(probe);
    expect(report).toMatchObject({
      status: 'FAILED',
      failure: 'native_kiro_resume_session_mismatch',
      turns: [
        { observedSessionId: '[credential removed]' },
        {
          requestedSessionId: '[credential removed]',
          observedSessionId: '[credential removed]',
          modelSource: '[credential removed]',
          protocolFailure: '[credential removed]',
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(context.env.KIRO_API_KEY);
    expect(JSON.stringify(report)).not.toContain(context.env.AWS_BEARER_TOKEN_BEDROCK);
  });

  it('preserves cancellation when ACP is interrupted', async () => {
    let entered;
    const running = new Promise((resolve) => {
      entered = resolve;
    });
    const { probe } = await startKiro(async ({ turn, signal }) => {
      if (turn === 1) return observed();
      entered();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return result({ exitCode: null, signal: 'SIGTERM', stdout: '' });
    });
    await probe.invoke(payload('answer', { requestedCli: 'kiro' }), context);
    await running;
    await probe.invoke(payload('cancel', { requestedCli: 'kiro' }));
    await probe.settle();
    const report = await probe.invoke(payload('status', { requestedCli: 'kiro' }));
    expect(report).toMatchObject({
      status: 'CANCELLED',
      turns: [
        { observedSessionId: firstId },
        { requestedSessionId: firstId, observedSessionId: null },
      ],
    });
    expect(report).not.toHaveProperty('failure');
  });
});

describe('Claude SessionEnd configuration', () => {
  const settings = () => ({
    companyAnnouncements: ['Native fixture'],
    permissions: {
      allow: [
        'Read',
        'Edit',
        'Write',
        'Bash(date -u *)',
        'Glob',
        'Grep',
        'Task',
        'WebSearch',
        'Bash(aidlc engine *)',
      ],
    },
    env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' },
    hooks: {
      SessionStart: [
        { matcher: '', hooks: [{ type: 'command', command: 'aidlc engine hook session-start' }] },
      ],
      SessionEnd: [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: 'aidlc engine hook session-end' },
            { type: 'command', command: 'other-session-end-hook', timeout: 5 },
          ],
        },
      ],
      Stop: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'aidlc engine hook continue-workflow' }],
        },
      ],
    },
  });
  const start = async (value, mutate = async () => {}) => {
    let project;
    let path;
    const bytes = `${JSON.stringify(value)}\n`;
    const observed = [];
    const commandRunner = vi.fn(async () => {
      observed.push(JSON.parse(await readFile(path, 'utf8')));
      return result({
        stdout: JSON.stringify({
          type: 'result',
          result: 'What title?',
          session_id: 'claude-session-1',
        }),
      });
    });
    const { probe } = await setup({
      commandRunner,
      prepareWorkspace: async (workspace) => {
        project = workspace.project;
        path = join(project, '.claude/settings.json');
        await mkdir(join(project, '.claude'));
        await writeFile(path, bytes, { mode: 0o600 });
        await mutate({ project, path, bytes });
      },
    });
    await probe.invoke(payload('start', { requestedCli: 'claude' }), context);
    await probe.settle();
    return {
      probe,
      path,
      bytes,
      observed,
      commandRunner,
      report: await probe.invoke(payload('status', { requestedCli: 'claude' }), {}),
    };
  };

  it('defaults only the existing native SessionEnd timeout before Claude starts', async () => {
    const original = settings();
    const run = await start(original);
    const expected = structuredClone(original);
    expected.hooks.SessionEnd[0].hooks[0].timeout = 30;
    expect(run.report.status).toBe('FIRST_TURN_FINISHED');
    expect(run.observed).toEqual([expected]);
    expect(JSON.parse(await readFile(run.path, 'utf8'))).toEqual(expected);
    await run.probe.invoke(payload('answer', { requestedCli: 'claude' }), context);
    await run.probe.settle();
    expect(run.observed).toEqual([expected, expected]);
    expect(original.hooks.SessionEnd[0].hooks[0]).not.toHaveProperty('timeout');
  });

  it.each([5, 60, 0, null])(
    'preserves explicit timeout %s without rewriting settings',
    async (timeout) => {
      const original = settings();
      original.hooks.SessionEnd[0].hooks[0].timeout = timeout;
      const run = await start(original);
      expect(run.report.status).toBe('FIRST_TURN_FINISHED');
      expect(run.observed).toEqual([original]);
      expect(await readFile(run.path, 'utf8')).toBe(run.bytes);
    },
  );

  it.each(['missing', 'wrong-command', 'wrong-type', 'ambiguous'])(
    'refuses a %s SessionEnd command before starting Claude',
    async (kind) => {
      const original = settings();
      const target = original.hooks.SessionEnd[0].hooks[0];
      if (kind === 'missing') delete original.hooks.SessionEnd;
      if (kind === 'wrong-command') target.command += ' --extra';
      if (kind === 'wrong-type') target.type = 'prompt';
      if (kind === 'ambiguous')
        original.hooks.SessionEnd.push({ matcher: 'logout', hooks: [{ ...target }] });
      const run = await start(original);
      expect(run.report).toMatchObject({
        status: 'FAILED',
        failure: 'native_claude_session_end_hook_missing_or_ambiguous',
      });
      expect(run.commandRunner).not.toHaveBeenCalled();
      expect(await readFile(run.path, 'utf8')).toBe(run.bytes);
    },
  );

  it.each(['file-symlink', 'directory-symlink', 'hardlink', 'directory', 'replaced-project'])(
    'refuses %s settings without changing the external fixture or starting Claude',
    async (kind) => {
      const outside = await directory();
      const original = `${JSON.stringify(settings())}\n`;
      const external = join(outside, 'settings.json');
      await writeFile(external, original);
      const run = await start(settings(), async ({ project, path, bytes }) => {
        if (kind === 'directory-symlink') {
          await rm(join(project, '.claude'), { recursive: true });
          await symlink(outside, join(project, '.claude'));
        } else if (kind === 'replaced-project') {
          await rename(project, `${project}-original`);
          await mkdir(join(project, '.claude'), { recursive: true, mode: 0o700 });
          await writeFile(path, bytes);
        } else {
          await rm(path);
          if (kind === 'file-symlink') await symlink(external, path);
          if (kind === 'hardlink') await link(external, path);
          if (kind === 'directory') await mkdir(path);
        }
      });
      expect(run.report).toMatchObject({
        status: 'FAILED',
        failure: 'native_claude_session_end_settings_invalid',
      });
      expect(run.commandRunner).not.toHaveBeenCalled();
      expect(await readFile(external, 'utf8')).toBe(original);
    },
  );
});

describe('native artifact snapshots', () => {
  it('keeps native steering keys out of evidence while retaining intent artifacts', async () => {
    const project = await directory();
    const intent = 'aidlc/spaces/default/intents/example';
    await mkdir(join(project, intent, '.aidlc-engine'), { recursive: true });
    await writeFile(join(project, intent, '.aidlc-engine/steering-token-key'), 'native-secret');
    await writeFile(join(project, intent, 'questions.md'), 'What title should the page use?');
    const snapshot = await snapshotNativeProbeArtifacts({ project });
    expect(snapshot.files).toContainEqual({
      path: `${intent}/.aidlc-engine/steering-token-key`,
      omitted: 'internal-key',
    });
    expect(snapshot.files.find((file) => file.path.endsWith('/questions.md')).content).toBe(
      'What title should the page use?',
    );
    expect(JSON.stringify(snapshot)).not.toContain('native-secret');
  });

  it('rejects linked ancestors and hard-linked files', async () => {
    const project = await directory();
    const outside = await directory();
    await mkdir(join(project, 'aidlc/spaces'), { recursive: true });
    await mkdir(join(outside, 'intents'));
    await writeFile(join(outside, 'intents/private.txt'), 'outside-data');
    await symlink(outside, join(project, 'aidlc/spaces/default'));
    await expect(snapshotNativeProbeArtifacts({ project })).rejects.toThrow('unsafe ancestor');
    await rm(join(project, 'aidlc/spaces/default'));
    await mkdir(join(project, 'aidlc/spaces/default/intents'), { recursive: true });
    await link(
      join(outside, 'intents/private.txt'),
      join(project, 'aidlc/spaces/default/intents/linked'),
    );
    await expect(snapshotNativeProbeArtifacts({ project })).rejects.toThrow('private regular file');
  });
  it('captures actual native files and redacts secrets without reading CLI configuration', async () => {
    const project = await directory();
    const intent = join(project, 'aidlc/spaces/default/intents/probe');
    await mkdir(intent, { recursive: true });
    await writeFile(join(intent, 'intent.md'), 'Title: Blue Lake\nprivate-model-key');
    await mkdir(join(project, '.codex'));
    await writeFile(join(project, '.codex/auth.json'), 'private-auth-file');
    const out = await snapshotNativeProbeArtifacts({ project, secrets: ['private-model-key'] });
    expect(out.files).toHaveLength(1);
    expect(out.files[0].content).toBe('Title: Blue Lake\n[credential removed]');
    expect(out.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(out)).not.toContain('private-auth-file');
  });

  it('rejects links into files outside the artifact tree', async () => {
    const project = await directory();
    const intent = join(project, 'aidlc/spaces/default/intents');
    await mkdir(intent, { recursive: true });
    await symlink('/etc/passwd', join(intent, 'outside'));
    await expect(snapshotNativeProbeArtifacts({ project })).rejects.toThrow(
      'Native evidence contains a link',
    );
  });
});
