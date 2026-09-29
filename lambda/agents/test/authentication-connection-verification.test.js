import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionVerifier } from '../authentication-connection-verification.js';
import { connectionBinding } from '../../shared/agent-auth-selection-strategies.js';
import { normalizeConnection } from '../../shared/agent-auth-contracts.js';
import { verifyAgentCredentialGrant } from '../../shared/agent-credential-grants.js';
import { TEST_CONNECTION_MODE } from '../../shared/test/helpers/auth-modes.js';

// Verification is reached only through a registered mode, so register a synthetic one.
vi.mock('../../shared/agent-auth-modes.js', async (importOriginal) =>
  (await import('../../shared/test/helpers/auth-modes.js')).withAuthModes(importOriginal),
);

const MODE = TEST_CONNECTION_MODE.id;
const SECRET = 'verification-grant-secret'.repeat(2);
const runtimeTarget = Object.freeze({
  agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/test',
  qualifier: 'revision_r_1',
});
const verifyingRuntime = {
  ok: true,
  agentAuthProtocol: 2,
  agentAuthModes: ['keys', MODE],
  agentAuthVerification: [MODE],
};
const reply = (value) => ({
  response: {
    transformToString: async () => (typeof value === 'string' ? value : JSON.stringify(value)),
  },
});

let agentcore;
let ssm;
let logger;
let repository;
let replies;
const payloads = () =>
  agentcore.send.mock.calls.map(([command]) => JSON.parse(command.input.payload));
const sessions = () => agentcore.send.mock.calls.map(([command]) => command.input.runtimeSessionId);
const verify = (request = {}) =>
  createConnectionVerifier({ agentcore, ssm, repository, logger })({
    mode: MODE,
    mechanism: 'oauth-machine',
    configuration: { region: ' eu-west-1 ' },
    projectId: 'p1',
    runtimeTarget,
    ...request,
  });

beforeEach(() => {
  vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', SECRET);
  replies = [reply(verifyingRuntime), reply({ verified: true, account: 'fixture' })];
  agentcore = {
    send: vi.fn(async () => {
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  ssm = { send: vi.fn(async () => ({ Parameter: { Value: SECRET } })) };
  logger = { error: vi.fn() };
  repository = { getPolicy: vi.fn(async () => ({ mode: 'keys', revision: 4 })) };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('unsaved connection verification', () => {
  it('probes, authorizes and checks one binding on the same fresh runtime session', async () => {
    expect(await verify()).toEqual({
      statusCode: 200,
      body: { verified: true, account: 'fixture' },
    });
    const [probe, check] = payloads();
    expect(probe).toEqual({ command: 'capabilities' });
    const expected = connectionBinding(
      normalizeConnection({
        id: check.credentialBinding.connectionId,
        revision: 1,
        mode: MODE,
        backend: 'bedrock',
        mechanism: 'oauth-machine',
        source: 'space',
        projectId: 'p1',
        configuration: { region: 'eu-west-1' },
      }),
      4,
    );
    expect(check.credentialBinding.connectionId).toMatch(
      new RegExp(`^${MODE}-verification-[0-9a-f-]{36}$`),
    );
    expect(check).toMatchObject({
      command: 'verify-connection',
      projectId: 'p1',
      credentialBinding: expected,
    });
    expect(verifyAgentCredentialGrant(check.agentCredentialGrant, SECRET)).toMatchObject({
      purpose: 'verify-connection',
      projectId: 'p1',
      executionId: null,
      bindings: [expected],
    });
    // Qualification reused the probe, so a deployment between calls cannot split the image.
    expect(agentcore.send).toHaveBeenCalledTimes(2);
    for (const [command] of agentcore.send.mock.calls)
      expect(command.input).toMatchObject(runtimeTarget);
    const [first] = sessions();
    expect(sessions()).toEqual([first, first]);
    replies = [reply(verifyingRuntime), reply({ verified: true })];
    await verify({ projectId: null });
    expect(sessions()[2]).not.toBe(first);
    expect(payloads()[3]).toMatchObject({
      projectId: null,
      credentialBinding: { source: 'platform' },
    });
  });

  it('reports runtimes that cannot verify the mode without minting a grant', async () => {
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', '');
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET_PARAM', '/collab/test/grant-secret');
    for (const runtime of [
      { ok: true, agentAuthProtocol: 2, agentAuthModes: ['keys'] },
      { ...verifyingRuntime, agentAuthVerification: ['another-mode'] },
      { ...verifyingRuntime, agentAuthVerification: `${MODE}-v2` },
      { clis: [] },
    ]) {
      agentcore.send.mockClear();
      replies = [reply(runtime)];
      expect(await verify()).toEqual({
        statusCode: 200,
        body: {
          verified: false,
          code: 'AGENT_AUTH_RUNTIME_UNSUPPORTED',
          error:
            'Publish an environment whose runtime supports connection verification for this mode',
        },
      });
      expect(payloads()).toEqual([{ command: 'capabilities' }]);
    }
    expect(ssm.send).not.toHaveBeenCalled();
  });

  it('passes structured runtime results through and reports an empty one', async () => {
    const denial = { verified: false, code: 'TEST_ACCESS_DENIED', error: 'Denied by the fixture' };
    replies = [reply(verifyingRuntime), reply(denial)];
    expect(await verify()).toEqual({ statusCode: 200, body: denial });
    replies = [reply(verifyingRuntime), { response: null }];
    expect(await verify()).toEqual({
      statusCode: 200,
      body: { verified: false, error: 'Empty response from runtime' },
    });
  });

  it('needs a runtime and rejects invalid configuration before invoking it', async () => {
    expect(await verify({ runtimeTarget: { agentRuntimeArn: '' } })).toEqual({
      statusCode: 503,
      body: { error: 'Agent runtime is not configured' },
    });
    expect(await verify({ configuration: { region: 'eu-west-1', secret: 'x' } })).toEqual({
      statusCode: 400,
      body: { error: 'Connection configuration contains unsupported fields' },
    });
    expect(await verify({ mechanism: 'api-key' })).toMatchObject({ statusCode: 400 });
    expect(agentcore.send).not.toHaveBeenCalled();
  });

  it('maps each failure stage to a 502 without runtime or provider diagnostics', async () => {
    const privateError = (name = 'Error') =>
      Object.assign(new Error('private diagnostics'), {
        name,
        $metadata: { requestId: 'req-1' },
      });
    const cases = [
      {
        setup: () => repository.getPolicy.mockRejectedValueOnce(privateError()),
        error: 'Could not prepare the connection check',
        stage: 'configuration',
        calls: 0,
      },
      {
        setup: () => (replies = [privateError()]),
        error: 'Could not invoke the runtime',
        stage: 'runtime',
        calls: 1,
      },
      {
        setup: () => (replies = [reply(verifyingRuntime), privateError('RuntimeClientError')]),
        error: 'The runtime rejected the connection check',
        stage: 'runtime',
        calls: 2,
      },
      {
        setup: () => {
          vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', '');
          vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET_PARAM', '');
        },
        error: 'Could not authorize the connection check',
        stage: 'authorization',
        calls: 1,
      },
      {
        setup: () => (replies = [reply(verifyingRuntime), reply('private diagnostics')]),
        error: 'unreadable connection check result',
        stage: 'response',
        calls: 2,
      },
    ];
    for (const { setup, error, stage, calls } of cases) {
      agentcore.send.mockClear();
      logger.error.mockClear();
      vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', SECRET);
      replies = [reply(verifyingRuntime), reply({ verified: true })];
      setup();
      const result = await verify();
      expect(result.statusCode, stage).toBe(502);
      expect(result.body.error).toContain(error);
      expect(JSON.stringify(result.body)).not.toContain('private');
      expect(agentcore.send).toHaveBeenCalledTimes(calls);
      expect(logger.error).toHaveBeenCalledWith(
        'Connection verification request failed',
        expect.objectContaining({ mode: MODE, stage }),
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private');
    }
  });
});
