import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { GetParameterCommand, GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  handleNativeInteractionProbe,
  NATIVE_INTERACTION_PROBE_OUTPUT_LIMIT_BYTES,
  NATIVE_INTERACTION_PROBE_STATUSES,
} from '../native-interaction-probe.js';

const { issuer, eventLogger } = vi.hoisted(() => ({
  issuer: vi.fn(),
  eventLogger: vi.fn(),
}));
vi.mock('../../shared/agent-credential-grants.js', () => ({
  issueAgentCredentialGrant: issuer,
}));
vi.mock('../../shared/safe-event-logger.js', () => ({
  logSafeEventIfEnabled: eventLogger,
}));

const PROBE_ID = 'd6adee21-de10-4f91-89b9-31d5be5a001a';
const OTHER_ID = '5d64c3b9-00cc-47bb-af74-123456789abc';
const CORE_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/core';
const GRANT = 'sensitive-issued-grant.signature';
const SECRET = 'sensitive-credential-value';
const ACTIONS = ['start', 'status', 'answer', 'cancel'];
const PROVIDERS = { claude: 'bedrock', codex: 'bedrock', kiro: 'kiro', opencode: 'bedrock' };
const event = (override = {}) => ({
  operation: 'native-interaction-probe',
  action: 'start',
  probeId: PROBE_ID,
  harness: 'claude',
  ...override,
});
const runtimeResult = (override = {}) => ({
  ok: true,
  probeId: PROBE_ID,
  harness: 'claude',
  status: 'INITIALIZING',
  turns: [],
  initialization: [],
  experiment: 'native-question-answer-v1',
  version: '2.9.0',
  packageId: `sha256:${'a'.repeat(64)}`,
  humanAuthority: 'not-tested-synthetic-operator-fixture',
  recovery: 'not-tested',
  model: 'global.anthropic.model',
  ...override,
});
const snapshot = (override = {}) => ({ files: [], bounded: false, ...override });
const turn = (override = {}) => ({
  kind: 'synthetic-test-start',
  assistantText: 'Should the page title be "Blue Lake" or "Green Meadow"?',
  diagnostics: '',
  stdoutTail: '{"type":"hook_result","status":"completed"}',
  before: snapshot(),
  after: snapshot({
    files: [
      {
        path: 'aidlc/spaces/default/intents/probe/intent.md',
        bytes: 20,
        sha256: 'b'.repeat(64),
        content: 'Title: awaiting answer',
      },
    ],
  }),
  process: {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    cleanupComplete: true,
    spawnError: null,
  },
  ...override,
});
const response = (value = runtimeResult()) => ({
  statusCode: 200,
  contentType: 'application/json',
  response: Readable.from([Buffer.from(JSON.stringify(value))]),
});
const safeFailure = {
  ok: false,
  code: 'native_probe_failed',
  error: 'Native interaction probe failed',
};

const fixture = () => {
  const ssm = { send: vi.fn().mockResolvedValue({ Parameters: [] }) };
  const agentcore = { send: vi.fn().mockImplementation(async () => response()) };
  const issueGrant = vi.fn().mockResolvedValue(GRANT);
  const env = {
    NATIVE_INTERACTION_PROBE_ENABLED: 'true',
    AGENT_SETTINGS_SSM_PREFIX: '/collab/dev',
  };
  const options = { env, ssm, agentcore, issueGrant, runtimeTarget: { agentRuntimeArn: CORE_ARN } };
  return {
    ...options,
    options,
    run: (input = event()) => handleNativeInteractionProbe(input, options),
    payload: () =>
      JSON.parse(Buffer.from(agentcore.send.mock.calls.at(-1)[0].input.payload).toString()),
  };
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('native interaction probe operator boundary', () => {
  it.each([undefined, null, false, true, 'TRUE', 'true ', 'false', '1'])(
    'is disabled without the exact opt-in string (%s)',
    async (enabled) => {
      const f = fixture();
      f.env.NATIVE_INTERACTION_PROBE_ENABLED = enabled;
      expect(await f.run()).toEqual({
        ok: false,
        code: 'native_probe_disabled',
        error: 'Native interaction probe is disabled',
      });
      expect(f.ssm.send).not.toHaveBeenCalled();
      expect(f.issueGrant).not.toHaveBeenCalled();
      expect(f.agentcore.send).not.toHaveBeenCalled();
    },
  );

  it('defaults to the process environment with no probe opt-in', async () => {
    vi.stubEnv('NATIVE_INTERACTION_PROBE_ENABLED', undefined);
    const f = fixture();
    const { env: _env, ...options } = f.options;
    expect(await handleNativeInteractionProbe(event(), options)).toMatchObject({
      code: 'native_probe_disabled',
    });
    expect(f.issueGrant).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['array', [event()]],
    ['encoded event', JSON.stringify(event())],
    ['HTTP body', { httpMethod: 'POST', body: JSON.stringify(event()) }],
    ['nested payload', { payload: event() }],
    ['missing operation', { action: 'start', probeId: PROBE_ID, harness: 'claude' }],
    [
      'missing action',
      { operation: 'native-interaction-probe', probeId: PROBE_ID, harness: 'claude' },
    ],
    ['wrong operation', event({ operation: 'capabilities' })],
    ['wrong action', event({ action: 'run-stage' })],
    ['wrong harness', event({ harness: 'copilot' })],
    ['prototype harness', event({ harness: 'toString' })],
    ['wrong case harness', event({ harness: 'Claude' })],
    ['numeric UUID', event({ probeId: 123 })],
    ['UUID v1', event({ probeId: PROBE_ID.replace('-4f91-', '-1f91-') })],
    ['UUID variant', event({ probeId: PROBE_ID.replace('-89b9-', '-79b9-') })],
    ['padded UUID', event({ probeId: ` ${PROBE_ID}` })],
    ['path UUID', event({ probeId: `../${PROBE_ID}` })],
    ['inherited fields', Object.create(event())],
  ])('rejects %s before settings, grants, or runtime calls', async (_label, input) => {
    const f = fixture();
    expect(await f.run(input)).toMatchObject({ ok: false, code: 'native_probe_invalid' });
    expect(f.ssm.send).not.toHaveBeenCalled();
    expect(f.issueGrant).not.toHaveBeenCalled();
    expect(f.agentcore.send).not.toHaveBeenCalled();
  });

  it.each([
    'httpMethod',
    'requestContext',
    'headers',
    'body',
    'rawPath',
    'version',
    'routeKey',
    'Records',
    'answer',
    'prompt',
    'projectId',
    'actorId',
    'userId',
    'requestedCli',
    'executionId',
    'credentialBinding',
    'credentialBindings',
    'agentCredentialGrant',
    'runtimeSessionId',
    'runtimeTarget',
    'agentRuntimeArn',
    'qualifier',
    'cliModels',
    'env',
    'constructor',
    '__proto__',
  ])('rejects the extra field %s on every action', async (field) => {
    const f = fixture();
    for (const action of ACTIONS) {
      expect(await f.run(event({ action, [field]: SECRET }))).toMatchObject({
        code: 'native_probe_invalid',
      });
    }
    expect(f.ssm.send).not.toHaveBeenCalled();
    expect(f.issueGrant).not.toHaveBeenCalled();
    expect(f.agentcore.send).not.toHaveBeenCalled();
  });

  it('rejects hidden fields and accessors without evaluating them', async () => {
    const f = fixture();
    const getter = vi.fn(() => 'start');
    for (const input of [
      Object.defineProperty(event(), 'secret', { value: SECRET }),
      Object.defineProperty(event(), 'action', { get: getter }),
      { ...event(), [Symbol('extra')]: SECRET },
    ]) {
      expect(await f.run(input)).toMatchObject({ code: 'native_probe_invalid' });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(f.issueGrant).not.toHaveBeenCalled();
  });
});

describe('probe session and credential binding', () => {
  it.each(Object.entries(PROVIDERS))(
    'issues a verifiable native-probe grant through the real SSM issuer for %s',
    async (harness, provider) => {
      const actual = await vi.importActual('../../shared/agent-credential-grants.js');
      const secret = 'probe-test-signing-key-with-at-least-32-bytes';
      const f = fixture();
      f.env.AGENT_CREDENTIAL_GRANT_SECRET_PARAM = `/probe-tests/${harness}/grant-signing-key`;
      f.options.issueGrant = actual.issueAgentCredentialGrant;
      f.ssm.send.mockImplementation(async (command) => {
        if (command instanceof GetParametersCommand) return { Parameters: [] };
        expect(command).toBeInstanceOf(GetParameterCommand);
        expect(command.input).toEqual({
          Name: f.env.AGENT_CREDENTIAL_GRANT_SECRET_PARAM,
          WithDecryption: true,
        });
        return { Parameter: { Value: secret } };
      });
      f.agentcore.send.mockImplementation(async () => response(runtimeResult({ harness })));
      expect(await f.run(event({ harness }))).toEqual(runtimeResult({ harness }));
      const token = f.payload().agentCredentialGrant;
      expect(actual.verifyAgentCredentialGrant(token, secret)).toMatchObject({
        purpose: 'native-probe',
        projectId: null,
        executionId: PROBE_ID,
        bindings: [{ provider, source: 'platform' }],
      });
      expect(f.ssm.send).toHaveBeenCalledTimes(2);
    },
  );

  it.each(Object.entries(PROVIDERS))(
    'uses only the %s platform binding with a fresh grant for start and answer',
    async (harness, provider) => {
      const f = fixture();
      f.agentcore.send.mockImplementation(async () => response(runtimeResult({ harness })));
      f.ssm.send.mockResolvedValue({
        Parameters: [
          {
            Name: '/collab/dev/cli-models',
            Type: 'String',
            Value: JSON.stringify({ claude: 'global.anthropic.model', codex: 'openai.test' }),
          },
          { Name: '/collab/dev/bedrock-bearer-token', Value: SECRET },
        ],
      });
      for (const action of ['start', 'answer']) {
        expect(await f.run(event({ action, harness }))).toEqual(runtimeResult({ harness }));
        expect(f.issueGrant).toHaveBeenLastCalledWith(
          f.ssm,
          {
            purpose: 'native-probe',
            executionId: PROBE_ID,
            projectId: null,
            bindings: [{ provider, source: 'platform' }],
          },
          { env: f.env },
        );
        const command = f.agentcore.send.mock.calls.at(-1)[0];
        expect(command).toBeInstanceOf(InvokeAgentRuntimeCommand);
        expect(command.input).toEqual({
          agentRuntimeArn: CORE_ARN,
          runtimeSessionId: `aidlc-native-probe-${PROBE_ID}`,
          contentType: 'application/json',
          accept: 'application/json',
          payload: expect.any(Buffer),
        });
        expect(f.payload()).toEqual({
          command: 'native-interaction-probe',
          action,
          probeId: PROBE_ID,
          requestedCli: harness,
          executionId: PROBE_ID,
          credentialBinding: { provider, source: 'platform' },
          agentCredentialGrant: GRANT,
          cliModels: { claude: 'global.anthropic.model', codex: 'openai.test' },
        });
        const read = f.ssm.send.mock.calls.at(-1)[0];
        expect(read).toBeInstanceOf(GetParametersCommand);
        expect(read.input).toEqual({
          Names: ['/collab/dev/cli-models'],
          WithDecryption: false,
        });
      }
      expect(f.issueGrant).toHaveBeenCalledTimes(2);
      expect(f.agentcore.send).toHaveBeenCalledTimes(2);
    },
  );

  it('maps the same UUID spelling to the same session, but never aliases different UUIDs', async () => {
    const f = fixture();
    f.agentcore.send.mockImplementation(async (command) => {
      const { probeId } = JSON.parse(Buffer.from(command.input.payload).toString());
      return response(runtimeResult({ probeId }));
    });
    for (const probeId of [PROBE_ID, PROBE_ID.toUpperCase(), OTHER_ID]) {
      expect(await f.run(event({ probeId }))).toMatchObject({
        ok: true,
        probeId: probeId.toLowerCase(),
      });
    }
    expect(f.agentcore.send.mock.calls.map(([command]) => command.input.runtimeSessionId)).toEqual([
      `aidlc-native-probe-${PROBE_ID}`,
      `aidlc-native-probe-${PROBE_ID}`,
      `aidlc-native-probe-${OTHER_ID}`,
    ]);
  });

  it('uses the fixed runtime target and copies no other target fields', async () => {
    const f = fixture();
    f.options.runtimeTarget = {
      agentRuntimeArn: CORE_ARN,
      qualifier: 'trusted-revision',
      payload: SECRET,
      runtimeSessionId: 'untrusted-session',
    };
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.agentcore.send.mock.calls[0][0].input).toMatchObject({
      agentRuntimeArn: CORE_ARN,
      qualifier: 'trusted-revision',
      runtimeSessionId: `aidlc-native-probe-${PROBE_ID}`,
    });
    expect(f.payload()).not.toHaveProperty('runtimeTarget');
    expect(JSON.stringify(f.payload())).not.toContain(SECRET);
  });

  it('uses only parsed global models and tolerates missing model configuration', async () => {
    const f = fixture();
    for (const value of [
      undefined,
      '{invalid',
      JSON.stringify({ codex: 'amazon-bedrock/not-codex', secret: SECRET }),
    ]) {
      f.ssm.send.mockResolvedValue({
        Parameters: value === undefined ? [] : [{ Name: '/collab/dev/cli-models', Value: value }],
      });
      expect(await f.run()).toMatchObject({ ok: true });
      expect(f.payload().cliModels).toEqual({});
    }
  });

  it('fails closed for missing configuration and never reads a root-level settings path', async () => {
    for (const override of [
      { runtimeTarget: null },
      { runtimeTarget: { agentRuntimeArn: '' } },
      { env: { NATIVE_INTERACTION_PROBE_ENABLED: 'true' } },
      { ssm: null },
      { agentcore: null },
    ]) {
      const f = fixture();
      expect(
        await handleNativeInteractionProbe(event(), { ...f.options, ...override }),
      ).toMatchObject({
        code: 'native_probe_not_configured',
      });
      expect(f.ssm.send).not.toHaveBeenCalled();
      expect(f.issueGrant).not.toHaveBeenCalled();
      expect(f.agentcore.send).not.toHaveBeenCalled();
    }
  });

  it('refuses SecureString model settings without issuing a grant', async () => {
    const f = fixture();
    f.ssm.send.mockResolvedValue({
      Parameters: [{ Name: '/collab/dev/cli-models', Type: 'SecureString', Value: SECRET }],
    });
    expect(await f.run()).toEqual(safeFailure);
    expect(f.issueGrant).not.toHaveBeenCalled();
    expect(f.agentcore.send).not.toHaveBeenCalled();
  });
});

describe('credential-independent status and cancellation', () => {
  it.each(Object.keys(PROVIDERS))(
    'keeps %s status and cancel usable while SSM and the issuer are unavailable',
    async (harness) => {
      const f = fixture();
      f.ssm.send.mockRejectedValue(new Error(SECRET));
      f.issueGrant.mockRejectedValue(new Error(SECRET));
      delete f.env.AGENT_SETTINGS_SSM_PREFIX;
      const report = runtimeResult({
        harness,
        turns: [turn({ assistantText: 'The words null and undefined must remain intact.' })],
      });
      f.agentcore.send.mockImplementation(async () => response(report));
      for (const action of ['status', 'cancel']) {
        expect(await f.run(event({ action, harness }))).toEqual(report);
        expect(f.payload()).toEqual({
          command: 'native-interaction-probe',
          action,
          probeId: PROBE_ID,
          requestedCli: harness,
          executionId: PROBE_ID,
        });
        expect(f.agentcore.send.mock.calls.at(-1)[0].input).toMatchObject({
          agentRuntimeArn: CORE_ARN,
          runtimeSessionId: `aidlc-native-probe-${PROBE_ID}`,
        });
      }
      expect(f.ssm.send).not.toHaveBeenCalled();
      expect(f.issueGrant).not.toHaveBeenCalled();
    },
  );

  it.each(['status', 'cancel'])('needs neither an SSM client nor issuer for %s', async (action) => {
    const f = fixture();
    expect(
      await handleNativeInteractionProbe(event({ action }), {
        ...f.options,
        ssm: null,
        issueGrant: null,
        env: { NATIVE_INTERACTION_PROBE_ENABLED: 'true' },
      }),
    ).toEqual(runtimeResult());
    expect(f.ssm.send).not.toHaveBeenCalled();
    expect(f.issueGrant).not.toHaveBeenCalled();
    expect(f.payload()).not.toHaveProperty('agentCredentialGrant');
    expect(f.payload()).not.toHaveProperty('credentialBinding');
    expect(f.payload()).not.toHaveProperty('cliModels');
  });

  it.each(['status', 'cancel'])(
    'still rejects runtime identity mismatches and oversized responses for %s',
    async (action) => {
      const f = fixture();
      for (const body of [
        JSON.stringify(runtimeResult({ probeId: OTHER_ID })),
        JSON.stringify(runtimeResult({ harness: 'kiro' })),
        ' '.repeat(NATIVE_INTERACTION_PROBE_OUTPUT_LIMIT_BYTES + 1),
      ]) {
        f.agentcore.send.mockResolvedValue({ response: Readable.from([Buffer.from(body)]) });
        expect(await f.run(event({ action }))).toEqual(safeFailure);
      }
      expect(f.ssm.send).not.toHaveBeenCalled();
      expect(f.issueGrant).not.toHaveBeenCalled();
    },
  );

  it.each(['status', 'cancel'])(
    'still requires a configured runtime target for %s',
    async (action) => {
      const f = fixture();
      f.options.runtimeTarget = null;
      expect(await f.run(event({ action }))).toMatchObject({ code: 'native_probe_not_configured' });
      expect(f.agentcore.send).not.toHaveBeenCalled();
      expect(f.ssm.send).not.toHaveBeenCalled();
      expect(f.issueGrant).not.toHaveBeenCalled();
    },
  );

  it.each(['start', 'answer'])(
    'does not let %s bypass an unavailable grant issuer',
    async (action) => {
      const f = fixture();
      f.issueGrant.mockRejectedValue(new Error(SECRET));
      expect(await f.run(event({ action }))).toEqual(safeFailure);
      expect(f.issueGrant).toHaveBeenCalledOnce();
      expect(f.agentcore.send).not.toHaveBeenCalled();
    },
  );
});

describe('bounded status results without secrets', () => {
  it.each(NATIVE_INTERACTION_PROBE_STATUSES)('accepts the runtime status %s', async (status) => {
    const f = fixture();
    const report = runtimeResult({ status });
    f.agentcore.send.mockResolvedValue(response(report));
    expect(await f.run()).toEqual(report);
  });

  it('returns only known report fields and a typed resumable flag', async () => {
    const f = fixture();
    f.agentcore.send.mockResolvedValue(
      response(
        runtimeResult({
          status: 'FIRST_TURN_FINISHED',
          resumable: true,
          finished: SECRET,
          agentCredentialGrant: GRANT,
          credentialBinding: { secret: SECRET },
          credentials: { token: SECRET },
          stdout: `${SECRET} ${GRANT}`,
          question: SECRET,
          error: SECRET,
          stack: SECRET,
          metadata: { [SECRET]: GRANT },
        }),
      ),
    );
    const result = await f.run();
    expect(result).toEqual(runtimeResult({ status: 'FIRST_TURN_FINISHED', resumable: true }));
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(GRANT);
  });

  it('preserves a failed runtime status with a fixed safe error', async () => {
    const f = fixture();
    f.agentcore.send.mockResolvedValue(
      response(runtimeResult({ ok: false, status: 'FAILED', error: SECRET, stack: GRANT })),
    );
    expect(await f.run()).toEqual(
      runtimeResult({
        ok: false,
        status: 'FAILED',
        error: 'Native interaction probe failed',
      }),
    );
  });

  it('preserves both turns and native evidence without claiming qualification', async () => {
    const f = fixture();
    const report = runtimeResult({
      status: 'ANSWER_TURN_FINISHED',
      resumable: true,
      turns: [
        turn(),
        turn({
          kind: 'synthetic-test-answer',
          assistantText: 'The title is Blue Lake. Please review the next workflow gate.',
        }),
      ],
      qualification: 'requires-evidence-review',
      initialization: [{ command: 'use', ok: true, exitCode: 0, stdout: '{}', stderr: '' }],
      filesystem: {
        schemaVersion: 1,
        ok: true,
        checks: [{ id: 'codex-hooks', status: 'passed', message: 'Hooks verified' }],
      },
    });
    f.agentcore.send.mockResolvedValue(response(report));
    expect(await f.run(event({ action: 'status' }))).toEqual(report);
  });

  it('forwards ACP model and replay evidence without inventing a successful continuation', async () => {
    const f = fixture();
    const report = runtimeResult({
      harness: 'kiro',
      status: 'FAILED',
      failure: 'native_kiro_acp_failed',
      resumable: false,
      turns: [
        turn({
          identitySource: 'kiro-acp-session-load',
          requestedModel: 'auto',
          observedModel: 'different-model',
          modelVerified: false,
          modelSource: 'session/load.models',
          sessionLoadAcknowledged: true,
          priorPromptObserved: true,
          priorAssistantObserved: true,
          expectedUserPromptSha256: 'b'.repeat(64),
          replayedUserPromptSha256: 'b'.repeat(64),
          userPromptSource: 'retained-first-turn',
          expectedAssistantSha256: 'a'.repeat(64),
          replayedAssistantSha256: 'a'.repeat(64),
          replayedUserChunks: 2,
          replayedAssistantChunks: 4,
          protocolPhase: 'model',
          protocolFailure: 'native_kiro_acp_model_unverified',
          rpcErrorCode: null,
          stopReason: null,
        }),
      ],
    });
    f.agentcore.send.mockImplementation(async () => response(report));
    expect(await f.run(event({ action: 'status', harness: 'kiro' }))).toEqual(report);
  });

  it.each(['native_kiro_resume_session_missing', 'native_kiro_resume_session_mismatch'])(
    'preserves Kiro identity evidence and %s through the operator projection',
    async (failure) => {
      const f = fixture();
      const report = runtimeResult({
        harness: 'kiro',
        status: 'FAILED',
        failure,
        resumable: false,
        turns: [
          turn({
            requestedSessionId: null,
            observedSessionId: 'kiro-session-A',
            identitySource: 'kiro-session-list',
          }),
          turn({
            kind: 'synthetic-test-answer',
            requestedSessionId: 'kiro-session-A',
            observedSessionId:
              failure === 'native_kiro_resume_session_missing' ? null : 'kiro-session-B',
            identitySource: 'kiro-session-list',
          }),
        ],
      });
      f.agentcore.send.mockResolvedValue(response(report));
      expect(await f.run(event({ action: 'status', harness: 'kiro' }))).toEqual(report);
    },
  );

  it('redacts grants in Kiro identity fields and keeps those fields Kiro-only', async () => {
    const f = fixture();
    const identity = {
      requestedSessionId: `requested-${GRANT}`,
      observedSessionId: `observed-${GRANT}`,
      identitySource: GRANT,
    };
    f.agentcore.send.mockResolvedValue(
      response(runtimeResult({ harness: 'kiro', turns: [turn(identity)] })),
    );
    const kiro = await f.run(event({ harness: 'kiro' }));
    expect(kiro.turns[0]).toMatchObject({
      requestedSessionId: 'requested-[credential removed]',
      observedSessionId: 'observed-[credential removed]',
      identitySource: '[credential removed]',
    });
    expect(JSON.stringify(kiro)).not.toContain(GRANT);
    f.agentcore.send.mockResolvedValue(response(runtimeResult({ turns: [turn(identity)] })));
    expect((await f.run()).turns[0]).toEqual(turn());
  });

  it('drops unknown nested fields and removes the grant from every forwarded evidence string', async () => {
    const f = fixture();
    const report = runtimeResult({
      turns: [
        turn({
          assistantText: `Title question ${GRANT}`,
          diagnostics: '[credential removed]',
          stdoutTail: `{"diagnostic":"${GRANT}"}`,
          credentials: { token: SECRET },
          process: { ...turn().process, agentCredentialGrant: GRANT },
          before: snapshot({ credentials: { token: SECRET } }),
          after: snapshot({
            files: [
              {
                path: `aidlc/spaces/default/intents/${GRANT}/intent.md`,
                bytes: 42,
                sha256: 'b'.repeat(64),
                content: `Artifact ${GRANT}`,
                credentials: { token: SECRET },
              },
            ],
          }),
        }),
      ],
      initialization: [
        {
          command: 'use',
          ok: true,
          exitCode: 0,
          stdout: GRANT,
          stderr: '',
          env: { token: SECRET },
        },
      ],
      filesystem: {
        schemaVersion: 1,
        ok: true,
        credentials: SECRET,
        checks: [{ id: 'check', status: 'passed', message: GRANT, secret: SECRET }],
      },
    });
    f.agentcore.send.mockResolvedValue(response(report));
    const result = await f.run();
    expect(result.ok).toBe(true);
    expect(result.turns[0].assistantText).toBe('Title question [credential removed]');
    expect(result.turns[0].stdoutTail).toBe('{"diagnostic":"[credential removed]"}');
    expect(result.turns[0].after.files[0].content).toBe('Artifact [credential removed]');
    expect(result.turns[0].after.files[0].path).toContain('[credential removed]');
    expect(result.initialization[0].stdout).toBe('[credential removed]');
    expect(result.filesystem.checks[0].message).toBe('[credential removed]');
    expect(JSON.stringify(result)).not.toContain(GRANT);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each([
    'probe_not_found',
    'native_probe_disabled',
    'native_probe_platform',
    'native_probe_invalid',
    'native_probe_credential_unavailable',
    'native_probe_session_mismatch',
    'native_probe_runtime_unhealthy',
    'native_probe_not_answerable',
  ])('preserves the safe runtime refusal %s without exception details', async (reason) => {
    const f = fixture();
    f.agentcore.send.mockResolvedValue(
      response({ ok: false, reason, error: SECRET, grant: GRANT }),
    );
    expect(await f.run()).toEqual({ ok: false, reason });
  });

  it.each([
    ['unsafe qualification', runtimeResult({ qualification: 'fully-qualified' })],
    ['unsafe human authority', runtimeResult({ humanAuthority: 'approved' })],
    ['unsafe recovery claim', runtimeResult({ recovery: 'passed' })],
    ['unknown refusal', { ok: false, reason: SECRET }],
    ['too many turns', runtimeResult({ turns: [turn(), turn(), turn()] })],
    ['malformed turn', runtimeResult({ turns: [{ assistantText: 'not a complete turn' }] })],
    ['nested scalar', runtimeResult({ turns: [turn({ diagnostics: { secret: SECRET } })] })],
    [
      'oversized file list',
      runtimeResult({
        turns: [turn({ before: snapshot({ files: Array.from({ length: 129 }, () => ({})) }) })],
      }),
    ],
  ])('rejects %s', async (_label, report) => {
    const f = fixture();
    f.agentcore.send.mockResolvedValue(response(report));
    expect(await f.run()).toEqual(safeFailure);
  });

  it.each([
    null,
    [],
    SECRET,
    runtimeResult({ probeId: OTHER_ID }),
    runtimeResult({ harness: 'kiro' }),
    runtimeResult({ ok: SECRET }),
    runtimeResult({ status: SECRET }),
    { ok: true },
  ])('rejects malformed or mismatched runtime identity/status: %j', async (value) => {
    const f = fixture();
    f.agentcore.send.mockResolvedValue(response(value));
    expect(await f.run()).toEqual(safeFailure);
  });

  it('accepts a JSON body at exactly 2 MiB and rejects the next byte before consuming more', async () => {
    const f = fixture();
    const json = JSON.stringify(runtimeResult());
    const atLimit = Buffer.from(json.padEnd(NATIVE_INTERACTION_PROBE_OUTPUT_LIMIT_BYTES, ' '));
    f.agentcore.send.mockResolvedValue({ response: Readable.from([atLimit]) });
    expect(await f.run()).toEqual(runtimeResult());

    const closed = vi.fn();
    const beyondLimit = vi.fn();
    async function* tooLarge() {
      try {
        yield atLimit;
        yield Buffer.from(' ');
        beyondLimit();
        yield Buffer.from(SECRET);
      } finally {
        closed();
      }
    }
    f.agentcore.send.mockResolvedValue({ response: tooLarge() });
    expect(await f.run()).toEqual(safeFailure);
    expect(closed).toHaveBeenCalledOnce();
    expect(beyondLimit).not.toHaveBeenCalled();
  });

  it('counts bytes rather than string characters', async () => {
    const f = fixture();
    const value = runtimeResult({
      ignored: 'é'.repeat(NATIVE_INTERACTION_PROBE_OUTPUT_LIMIT_BYTES / 2),
    });
    f.agentcore.send.mockResolvedValue(response(value));
    expect(await f.run()).toEqual(safeFailure);
  });

  it.each([
    ['empty body', []],
    ['invalid JSON', [Buffer.from(`invalid ${SECRET}`)]],
    ['invalid UTF-8', [Buffer.from([0xff])]],
    ['object-mode chunk', [{ secret: SECRET }]],
  ])('rejects %s without reflecting content', async (_label, chunks) => {
    const f = fixture();
    f.agentcore.send.mockResolvedValue({ response: Readable.from(chunks) });
    expect(await f.run()).toEqual(safeFailure);
  });

  it('does not fall back to an unbounded SDK transform helper', async () => {
    const f = fixture();
    const transformToString = vi.fn().mockResolvedValue(SECRET);
    f.agentcore.send.mockResolvedValue({ response: { transformToString } });
    expect(await f.run()).toEqual(safeFailure);
    expect(transformToString).not.toHaveBeenCalled();
  });

  it.each([{ statusCode: 500 }, { contentType: 'text/event-stream' }])(
    'rejects unexpected runtime response metadata: %j',
    async (override) => {
      const f = fixture();
      const body = Readable.from([Buffer.from(SECRET)]);
      f.agentcore.send.mockResolvedValue({ ...response(), response: body, ...override });
      expect(await f.run()).toEqual(safeFailure);
      expect(body.destroyed).toBe(true);
    },
  );

  it.each(['settings', 'grant', 'invoke', 'stream'])(
    'scrubs %s exceptions without logging or forwarding their text',
    async (step) => {
      const f = fixture();
      const error = Object.assign(new Error(`${SECRET} ${GRANT}`), { metadata: SECRET });
      if (step === 'settings') f.ssm.send.mockRejectedValue(error);
      if (step === 'grant') f.issueGrant.mockRejectedValue(error);
      if (step === 'invoke') f.agentcore.send.mockRejectedValue(error);
      if (step === 'stream') {
        f.agentcore.send.mockResolvedValue({
          response: {
            async *[Symbol.asyncIterator]() {
              yield Buffer.from('{"ok":');
              throw error;
            },
          },
        });
      }
      expect(await f.run()).toEqual(safeFailure);
      if (step === 'settings') expect(f.issueGrant).not.toHaveBeenCalled();
      if (step === 'settings' || step === 'grant') expect(f.agentcore.send).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined, ''])(
    'never invokes the runtime without an issued grant (%s)',
    async (grant) => {
      const f = fixture();
      f.issueGrant.mockResolvedValue(grant);
      expect(await f.run()).toEqual(safeFailure);
      expect(f.agentcore.send).not.toHaveBeenCalled();
    },
  );
});

describe('agents Lambda direct operator route', () => {
  const ssmMock = mockClient(SSMClient);
  const agentcoreMock = mockClient(BedrockAgentCoreClient);

  beforeEach(() => {
    ssmMock.reset();
    agentcoreMock.reset();
    eventLogger.mockReset();
    issuer.mockReset().mockResolvedValue(GRANT);
    vi.stubEnv('NATIVE_INTERACTION_PROBE_ENABLED', 'true');
    vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/collab/dev');
    vi.stubEnv('AGENTCORE_RUNTIME_ARN', CORE_ARN);
    ssmMock.on(GetParametersCommand).resolves({ Parameters: [] });
    agentcoreMock.on(InvokeAgentRuntimeCommand).callsFake(async () => response());
  });

  afterEach(() => {
    ssmMock.reset();
    agentcoreMock.reset();
  });

  it('branches before generic event logging and uses the protected core target and issuer', async () => {
    const { handler } = await import('../index.js');
    expect(await handler(event())).toEqual(runtimeResult());
    expect(eventLogger).not.toHaveBeenCalled();
    const input = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
    expect(input.agentRuntimeArn).toBe(CORE_ARN);
    expect(input).not.toHaveProperty('qualifier');
    expect(issuer).toHaveBeenCalledExactlyOnceWith(
      expect.any(SSMClient),
      {
        purpose: 'native-probe',
        projectId: null,
        executionId: PROBE_ID,
        bindings: [{ provider: 'bedrock', source: 'platform' }],
      },
      { env: process.env },
    );
    expect(JSON.parse(Buffer.from(input.payload).toString()).agentCredentialGrant).toBe(GRANT);
  });

  it.each(['status', 'cancel'])(
    'routes %s before logging without consulting SSM or the issuer',
    async (action) => {
      const { handler } = await import('../index.js');
      vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', undefined);
      ssmMock.rejects(new Error(SECRET));
      issuer.mockRejectedValue(new Error(SECRET));
      expect(await handler(event({ action }))).toEqual(runtimeResult());
      expect(eventLogger).not.toHaveBeenCalled();
      expect(ssmMock.calls()).toHaveLength(0);
      expect(issuer).not.toHaveBeenCalled();
      const input = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
      expect(JSON.parse(Buffer.from(input.payload).toString())).toEqual({
        command: 'native-interaction-probe',
        action,
        probeId: PROBE_ID,
        requestedCli: 'claude',
        executionId: PROBE_ID,
      });
    },
  );

  it('rejects gateway fields before event logging, even with a claimed platform-admin identity', async () => {
    const { handler } = await import('../index.js');
    expect(
      await handler(
        event({
          httpMethod: 'POST',
          requestContext: {
            authorizer: { claims: { sub: 'pretend-actor', 'cognito:groups': 'platform-admin' } },
          },
          body: JSON.stringify({ answer: SECRET }),
        }),
      ),
    ).toMatchObject({ code: 'native_probe_invalid' });
    expect(eventLogger).not.toHaveBeenCalled();
    expect(issuer).not.toHaveBeenCalled();
    expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });

  it('does not decode HTTP body content into an operator invocation or add a UI route', async () => {
    const { handler } = await import('../index.js');
    const result = await handler({
      httpMethod: 'POST',
      path: '/agents/native-interaction-probe',
      body: JSON.stringify(event()),
    });
    expect(result.statusCode).toBe(404);
    expect(issuer).not.toHaveBeenCalled();
    expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });
});
