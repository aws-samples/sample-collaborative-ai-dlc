import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import {
  invoke,
  loadHandler,
  mocks,
  request,
  useSettingsHarness,
} from './helpers/settings-harness.js';

useSettingsHarness();
const { ssm, agentcore } = mocks;
let handler;
beforeAll(async () => {
  handler = await loadHandler();
});

describe('IAM settings on the foundation', () => {
  const configuration = {
    roleArn: 'arn:aws:iam::222222222222:role/Inference',
    region: 'eu-west-1',
    externalId: 'external-fixture',
  };
  const draft = { kind: 'connection-draft', mode: 'iam', configuration };
  it('requires platform admin for IAM activation and refuses personal role inputs', async () => {
    const input = { authenticationChange: { action: 'preview', candidate: draft } };
    expect((await invoke(input, { admin: false })).status).toBe(403);
    expect(
      (await invoke({ bedrockIam: configuration }, { admin: false, personal: true })).status,
    ).toBe(400);
  });
  it('previews without activation, applies the same role, disables Bedrock keys and keeps Kiro independent', async () => {
    const preview = await invoke({ authenticationChange: { action: 'preview', candidate: draft } });
    expect(preview.status).toBe(200);
    expect(preview.data.candidate.connection.configuration).toEqual(configuration);
    expect(preview.data.candidate.connection.id).toMatch(/^iam-/);
    const settings = async () =>
      JSON.parse((await handler({ ...request({}), httpMethod: 'GET' })).body);
    expect((await settings()).authentication.policy.mode).toBe('keys');
    expect(
      (await invoke({ authenticationChange: { action: 'apply', reviewId: preview.data.id } }))
        .status,
    ).toBe(200);
    expect((await settings()).authentication).toMatchObject({
      policy: { mode: 'iam' },
      canManageConnections: true,
      personalMechanisms: [],
      hasOverride: false,
      connection: { configuration, mechanism: 'assume-role' },
    });
    expect((await invoke({ bedrockBearerToken: 'disabled', reviewAction: 'preview' })).status).toBe(
      409,
    );
    expect((await invoke({ kiroApiKey: 'independent', reviewAction: 'preview' })).status).toBe(200);
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
  it('authorizes setup documents for platform admins only and returns both account policies', async () => {
    vi.stubEnv('CREDENTIAL_BROKER_ROLE_ARN', 'arn:aws:iam::111111111111:role/Broker');
    const post = (admin) => ({
      ...request({ mode: 'iam', action: 'setup', config: configuration }, { admin }),
      httpMethod: 'POST',
      path: '/agents/authentication-setup',
    });
    expect((await handler(post(false))).statusCode).toBe(403);
    const result = await handler(post(true));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      applicationAccountId: '111111111111',
      inferenceAccountId: '222222222222',
      config: configuration,
    });
    const setup = { method: 'POST', path: '/agents/authentication-setup' };
    expect(await invoke({ mode: 'iam', action: 'defaults' }, setup)).toEqual({
      status: 200,
      data: { brokerRoleArn: 'arn:aws:iam::111111111111:role/Broker', region: 'us-east-1' },
    });
    expect(
      (
        await invoke(
          { mode: 'iam', action: 'setup', config: { roleArn: 'nope', region: 'eu-west-1' } },
          setup,
        )
      ).status,
    ).toBe(400);
  });

  const verificationRequest = () => ({
    ...request({ mode: 'iam', action: 'verify', config: configuration }),
    httpMethod: 'POST',
    path: '/agents/authentication-setup',
  });
  // The foundation probes capabilities on the same session first; answer as an IAM runtime.
  const verifyingRuntime = {
    ok: true,
    agentAuthProtocol: 2,
    agentAuthModes: ['keys', 'iam'],
    agentAuthVerification: ['iam'],
  };
  const runtime = (check) =>
    agentcore.on(InvokeAgentRuntimeCommand).callsFake(async (input) => {
      const payload = JSON.parse(Buffer.from(input.payload).toString());
      if (payload.command === 'capabilities')
        return { response: { transformToString: async () => JSON.stringify(verifyingRuntime) } };
      return check(payload);
    });

  it('passes a structured runtime IAM denial to the wizard instead of a connectivity error', async () => {
    const denial = {
      verified: false,
      code: 'BEDROCK_IAM_ACCESS_DENIED',
      error: 'AWS denied the credential broker access to the inference role.',
    };
    runtime(async () => ({ response: { transformToString: async () => JSON.stringify(denial) } }));
    const result = await handler(verificationRequest());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(denial);
    const payload = JSON.parse(
      agentcore.commandCalls(InvokeAgentRuntimeCommand)[1].args[0].input.payload,
    );
    expect(payload.command).toBe('verify-connection');
    expect(payload.credentialBinding.configuration).toEqual(configuration);
    expect(payload.agentCredentialGrant).toBeTruthy();
  });

  // An IAM image published before 'verify-connection' advertises the mode but no verifier.
  it('reports an older IAM runtime as unsupported instead of an unknown command', async () => {
    agentcore.on(InvokeAgentRuntimeCommand).resolves({
      response: {
        transformToString: async () =>
          JSON.stringify({ ok: true, agentAuthProtocol: 2, agentAuthModes: ['keys', 'iam'] }),
      },
    });
    const result = await handler(verificationRequest());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      verified: false,
      code: 'AGENT_AUTH_RUNTIME_UNSUPPORTED',
    });
    expect(agentcore.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(1);
  });

  it('distinguishes a runtime rejection from an unreachable runtime', async () => {
    runtime(async () => {
      throw Object.assign(new Error('private runtime diagnostics'), { name: 'RuntimeClientError' });
    });
    const result = await handler(verificationRequest());
    expect(result.statusCode).toBe(502);
    expect(JSON.parse(result.body).error).toContain('runtime rejected');
    expect(result.body).not.toContain('private');
  });

  it('reports authorization failures before invoking the runtime check', async () => {
    runtime(async () => ({ response: { transformToString: async () => '{}' } }));
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', '');
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET_PARAM', '');
    const result = await handler(verificationRequest());
    expect(result.statusCode).toBe(502);
    expect(JSON.parse(result.body).error).toContain('Could not authorize');
    // Only the capability probe reached the runtime.
    const commands = agentcore
      .commandCalls(InvokeAgentRuntimeCommand)
      .map((call) => JSON.parse(call.args[0].input.payload).command);
    expect(commands).toEqual(['capabilities']);
  });

  it('reports an unreadable response separately from runtime invocation failure', async () => {
    runtime(async () => ({ response: { transformToString: async () => 'not JSON' } }));
    const result = await handler(verificationRequest());
    expect(result.statusCode).toBe(502);
    expect(JSON.parse(result.body).error).toContain('unreadable');
  });

  it('rejects an invalid role before any runtime call', async () => {
    const result = await handler({
      ...request({ mode: 'iam', action: 'verify', config: { roleArn: 'x', region: 'eu-west-1' } }),
      httpMethod: 'POST',
      path: '/agents/authentication-setup',
    });
    expect(result.statusCode).toBe(400);
    expect(agentcore.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });
});
