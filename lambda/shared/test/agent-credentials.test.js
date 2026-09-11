import { beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import {
  agentCredentialPath,
  availableClisForBindings,
  credentialSourcesFromBindings,
  deleteCredentialScope,
  readCredentialBindingValue,
  readCredentialScopeStatus,
  resolveEffectiveCredentialBindings,
  writeCredentialScope,
} from '../agent-credentials.js';

describe('agent credentials', () => {
  const ssm = mockClient(SSMClient);
  const values = new Map();

  beforeEach(() => {
    ssm.reset();
    values.clear();
    ssm.on(GetParametersCommand).callsFake((input) => ({
      Parameters: input.Names.filter((name) => values.has(name)).map((name) => ({
        Name: name,
        Value: values.get(name),
      })),
    }));
    ssm.on(GetParameterCommand).callsFake((input) => {
      if (values.has(input.Name)) {
        return { Parameter: { Name: input.Name, Value: values.get(input.Name) } };
      }
      const error = new Error('missing');
      error.name = 'ParameterNotFound';
      throw error;
    });
    ssm.on(PutParameterCommand).callsFake((input) => {
      values.set(input.Name, input.Value);
      return {};
    });
    ssm.on(DeleteParameterCommand).callsFake((input) => {
      if (!values.has(input.Name)) {
        const error = new Error('missing');
        error.name = 'ParameterNotFound';
        throw error;
      }
      values.delete(input.Name);
      return {};
    });
  });

  it('builds platform, space, and user paths', () => {
    expect(agentCredentialPath({ base: '/app/dev', source: 'platform', provider: 'bedrock' })).toBe(
      '/app/dev/bedrock-bearer-token',
    );
    expect(
      agentCredentialPath({
        base: '/app/dev',
        source: 'space',
        provider: 'kiro',
        projectId: 'p-1',
      }),
    ).toBe('/app/dev/projects/p-1/agent-credentials/kiro-api-key');
    expect(
      agentCredentialPath({
        base: '/app/dev',
        source: 'user',
        provider: 'bedrock',
        userId: 'u-1',
      }),
    ).toBe('/app/dev/users/u-1/agent-credentials/bedrock-bearer-token');
  });

  it.each([
    ['/app/dev/', '/app/dev'],
    ['/app/dev///', '/app/dev'],
    ['/app//dev///', '/app//dev'],
    ['/app/dev/ ', '/app/dev/ '],
    [123, '123'],
  ])('removes only trailing slashes from base %j', (base, prefix) => {
    expect(agentCredentialPath({ base, source: 'platform', provider: 'bedrock' })).toBe(
      `${prefix}/bedrock-bearer-token`,
    );
  });

  it.each([undefined, null, '', false, 0, '/', '///'])(
    'rejects an empty normalized base %j',
    (base) => {
      expect(() => agentCredentialPath({ base, source: 'platform', provider: 'bedrock' })).toThrow(
        'Agent credential store is not configured',
      );
    },
  );

  it('handles long slash sequences without excessive backtracking', () => {
    // Isolate synchronous work so a regressed regex cannot hang the test runner.
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { strict as assert } from 'node:assert';
          import { agentCredentialPath } from ${JSON.stringify(new URL('../agent-credentials.js', import.meta.url).href)};
          const slashes = '/'.repeat(1_000_000);
          for (const [base, prefix] of [
            ['/app' + slashes + 'dev', '/app' + slashes + 'dev'],
            ['/app' + slashes + 'dev///', '/app' + slashes + 'dev'],
            ['/app/dev' + slashes, '/app/dev'],
          ]) {
            assert.equal(
              agentCredentialPath({ base, source: 'platform', provider: 'bedrock' }),
              prefix + '/bedrock-bearer-token',
            );
          }
        `,
      ],
      { timeout: 5_000, stdio: 'pipe' },
    );
  }, 10_000);

  it('resolves each provider independently with user over space over platform', async () => {
    values.set('/app/dev/bedrock-bearer-token', 'platform-bedrock');
    values.set('/app/dev/kiro-api-key', 'platform-kiro');
    values.set('/app/dev/projects/p-1/agent-credentials/bedrock-bearer-token', 'space-bedrock');
    values.set('/app/dev/users/u-1/agent-credentials/kiro-api-key', 'user-kiro');

    const bindings = await resolveEffectiveCredentialBindings(ssm, {
      base: '/app/dev',
      projectId: 'p-1',
      userId: 'u-1',
    });

    expect(bindings).toEqual({
      bedrock: { provider: 'bedrock', source: 'space' },
      kiro: { provider: 'kiro', source: 'user', userId: 'u-1' },
    });
    expect(credentialSourcesFromBindings(bindings)).toEqual({
      bedrock: 'space',
      kiro: 'user',
    });
    expect(
      availableClisForBindings({
        installed: ['kiro', 'claude', 'opencode', 'codex'],
        bindings,
      }),
    ).toEqual(['kiro', 'claude', 'opencode', 'codex']);
    const reads = ssm.commandCalls(GetParametersCommand).map((call) => call.args[0].input.Names);
    expect(reads).toEqual([
      ['/app/dev/bedrock-auth', '/app/dev/projects/p-1/agent-credentials/bedrock-iam'],
      [
        '/app/dev/users/u-1/agent-credentials/bedrock-bearer-token',
        '/app/dev/users/u-1/agent-credentials/kiro-api-key',
      ],
      ['/app/dev/projects/p-1/agent-credentials/bedrock-bearer-token'],
    ]);
  });

  it('enforces IAM for new Bedrock runs while preserving Kiro and pinned key runs', async () => {
    const iam = { roleArn: 'arn:aws:iam::222222222222:role/Inference', region: 'eu-west-1' };
    values.set('/app/dev/bedrock-auth', JSON.stringify({ mode: 'iam', iam }));
    values.set('/app/dev/users/u-1/agent-credentials/bedrock-bearer-token', 'old-personal-key');
    values.set('/app/dev/projects/p-1/agent-credentials/bedrock-bearer-token', 'old-space-key');
    values.set('/app/dev/users/u-1/agent-credentials/kiro-api-key', 'personal-kiro');
    const bindings = await resolveEffectiveCredentialBindings(ssm, {
      base: '/app/dev',
      projectId: 'p-1',
      userId: 'u-1',
    });
    expect(bindings).toEqual({
      bedrock: { provider: 'bedrock', source: 'platform', authType: 'iam', iam },
      kiro: { provider: 'kiro', source: 'user', userId: 'u-1' },
    });
    expect(
      ssm.commandCalls(GetParametersCommand).flatMap((call) => call.args[0].input.Names),
    ).not.toEqual(
      expect.arrayContaining(['/app/dev/users/u-1/agent-credentials/bedrock-bearer-token']),
    );
    expect(
      await readCredentialBindingValue(ssm, {
        base: '/app/dev',
        binding: { provider: 'bedrock', source: 'user', userId: 'u-1' },
      }),
    ).toBe('old-personal-key');
  });

  it('pins a space IAM role and region independently of later configuration changes', async () => {
    const platform = { roleArn: 'arn:aws:iam::222222222222:role/Platform', region: 'us-east-1' };
    const space = { roleArn: 'arn:aws:iam::333333333333:role/Space', region: 'eu-west-1' };
    values.set('/app/dev/bedrock-auth', JSON.stringify({ mode: 'iam', iam: platform }));
    values.set('/app/dev/projects/p-1/agent-credentials/bedrock-iam', JSON.stringify(space));
    const pinned = await resolveEffectiveCredentialBindings(ssm, {
      base: '/app/dev',
      projectId: 'p-1',
      userId: 'u-1',
    });
    await writeCredentialScope(ssm, {
      base: '/app/dev',
      source: 'space',
      projectId: 'p-1',
      update: { bedrockIam: null },
    });
    const next = await resolveEffectiveCredentialBindings(ssm, {
      base: '/app/dev',
      projectId: 'p-1',
      userId: 'u-1',
    });
    expect(pinned.bedrock).toEqual({
      provider: 'bedrock',
      source: 'space',
      authType: 'iam',
      iam: space,
    });
    expect(next.bedrock.iam).toEqual(platform);
  });

  it('rejects personal IAM and key writes under IAM, without touching stored keys', async () => {
    const iam = { roleArn: 'arn:aws:iam::222222222222:role/Inference', region: 'eu-west-1' };
    values.set('/app/dev/bedrock-auth', JSON.stringify({ mode: 'iam', iam }));
    for (const update of [{ bedrockIam: iam }, { bedrockBearerToken: 'new-key' }]) {
      await expect(
        writeCredentialScope(ssm, {
          base: '/app/dev',
          source: 'user',
          userId: 'u-1',
          update,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_BEDROCK_AUTH' });
    }
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
    await writeCredentialScope(ssm, {
      base: '/app/dev',
      source: 'user',
      userId: 'u-1',
      update: { kiroApiKey: 'kiro' },
    });
    expect(values.get('/app/dev/users/u-1/agent-credentials/kiro-api-key')).toBe('kiro');
  });

  it('never falls back to keys when IAM configuration is corrupt', async () => {
    values.set('/app/dev/bedrock-auth', '{"mode":"iam"}');
    values.set('/app/dev/bedrock-bearer-token', 'platform-key');
    await expect(
      resolveEffectiveCredentialBindings(ssm, {
        base: '/app/dev',
        projectId: 'p-1',
        userId: 'u-1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BEDROCK_AUTH' });
  });

  it('treats placeholder and missing parameters as unset', async () => {
    values.set('/app/dev/bedrock-bearer-token', 'placeholder');
    const status = await readCredentialScopeStatus(ssm, {
      base: '/app/dev',
      source: 'platform',
    });
    expect(status).toEqual({
      bedrockBearerTokenSet: false,
      kiroApiKeySet: false,
    });
  });

  it('writes, rotates, and clears user credentials without returning values', async () => {
    await writeCredentialScope(ssm, {
      base: '/app/dev',
      source: 'user',
      userId: 'u-1',
      update: { bedrockBearerToken: 'secret-value', kiroApiKey: 'kiro-value' },
    });
    expect(
      await readCredentialScopeStatus(ssm, {
        base: '/app/dev',
        source: 'user',
        userId: 'u-1',
      }),
    ).toEqual({ bedrockBearerTokenSet: true, kiroApiKeySet: true });

    await writeCredentialScope(ssm, {
      base: '/app/dev',
      source: 'user',
      userId: 'u-1',
      update: { bedrockBearerToken: '' },
    });
    expect(
      await readCredentialBindingValue(ssm, {
        base: '/app/dev',
        projectId: 'p-1',
        binding: { provider: 'bedrock', source: 'user', userId: 'u-1' },
      }),
    ).toBe('');
  });

  it('keeps the platform parameter and resets it to placeholder on clear', async () => {
    await writeCredentialScope(ssm, {
      base: '/app/dev',
      source: 'platform',
      update: { kiroApiKey: '' },
    });
    expect(values.get('/app/dev/kiro-api-key')).toBe('placeholder');
  });

  it('deletes a non-platform scope idempotently', async () => {
    const bedrockPath = '/app/dev/projects/p-1/agent-credentials/bedrock-bearer-token';
    const kiroPath = '/app/dev/projects/p-1/agent-credentials/kiro-api-key';
    values.set(bedrockPath, 'space-bedrock');
    values.set(kiroPath, 'space-kiro');

    await expect(
      deleteCredentialScope(ssm, {
        base: '/app/dev',
        source: 'space',
        projectId: 'p-1',
      }),
    ).resolves.toEqual({ deleted: ['bedrock', 'kiro'], missing: [] });
    expect(values.has(bedrockPath)).toBe(false);
    expect(values.has(kiroPath)).toBe(false);

    await expect(
      deleteCredentialScope(ssm, {
        base: '/app/dev',
        source: 'space',
        projectId: 'p-1',
      }),
    ).resolves.toEqual({ deleted: [], missing: ['bedrock', 'kiro'] });
  });
});
