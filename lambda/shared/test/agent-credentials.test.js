import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import {
  AGENT_CLI_PROVIDER,
  AGENT_CREDENTIAL_ENV_NAMES,
  AGENT_CREDENTIAL_PROVIDERS,
  AWS_TEMPORARY_CREDENTIAL_ENV_NAMES,
  EXTERNAL_ID_ENTROPY_BYTES,
  agentCredentialPath,
  availableClisForBindings,
  bedrockExternalIdPath,
  bedrockRoleIsCrossAccount,
  credentialSourcesFromBindings,
  credentialValueKind,
  credentialValueKindSafe,
  deleteCredentialScope,
  describeBedrockBinding,
  ensureBedrockExternalId,
  generateExternalId,
  isConfiguredCredentialValue,
  looksLikeRoleBindingValue,
  parseRoleBindingValue,
  prepareBedrockBindingWrite,
  readBedrockExternalId,
  readCredentialBindingValue,
  readCredentialScopeStatus,
  resolveEffectiveCredentialBindings,
  validateCredentialScopeUpdate,
  writeCredentialScope,
} from '../agent-credentials.js';

// specs/bedrock-iam-role-credential-mode — req-single-parameter-encoding,
// req-credential-delivery-env. The bedrock parameter holds either a plain bearer
// string or a JSON role object; discrimination is positional and a malformed
// role-shaped value is an error, never silently a bearer token.
describe('bedrock binding value discrimination', () => {
  const ROLE_ARN = 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference';

  it('scrubs the three AWS temporary-credential names alongside every provider name', () => {
    expect(AWS_TEMPORARY_CREDENTIAL_ENV_NAMES).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]);
    expect(AGENT_CREDENTIAL_ENV_NAMES).toEqual([
      'AWS_BEARER_TOKEN_BEDROCK',
      'KIRO_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]);
  });

  it('parses a role object with and without an external id', () => {
    expect(parseRoleBindingValue(JSON.stringify({ roleArn: ROLE_ARN }))).toEqual({
      roleArn: ROLE_ARN,
      externalId: null,
    });
    expect(
      parseRoleBindingValue(`  ${JSON.stringify({ roleArn: ROLE_ARN, externalId: 'abc-123' })}  `),
    ).toEqual({ roleArn: ROLE_ARN, externalId: 'abc-123' });
    expect(credentialValueKind(JSON.stringify({ roleArn: ROLE_ARN }))).toBe('role');
  });

  it('accepts every aws partition in the role ARN and enforces the 2048 ceiling', () => {
    for (const arn of [
      'arn:aws-cn:iam::111122223333:role/aidlc-bedrock-inference',
      'arn:aws-us-gov:iam::111122223333:role/path/to/aidlc-bedrock-inference',
    ]) {
      expect(parseRoleBindingValue(JSON.stringify({ roleArn: arn })).roleArn).toBe(arn);
    }
    const tooLong = `arn:aws:iam::111122223333:role/${'a'.repeat(2048)}`;
    expect(() => parseRoleBindingValue(JSON.stringify({ roleArn: tooLong }))).toThrow(
      /at most 2048 characters/,
    );
  });

  it.each([
    ['not JSON at all', '{ nope'],
    ['an empty object', '{}'],
    ['a null roleArn', '{"roleArn":null}'],
    ['an object with no roleArn', JSON.stringify({ externalId: 'abc-123' })],
    ['a non-IAM ARN', JSON.stringify({ roleArn: 'arn:aws:sts::111122223333:role/x' })],
    ['a malformed account id', JSON.stringify({ roleArn: 'arn:aws:iam::123:role/x' })],
    ['an ARN with no role name', JSON.stringify({ roleArn: 'arn:aws:iam::111122223333:role/' })],
    ['a one-character external id', JSON.stringify({ roleArn: ROLE_ARN, externalId: 'a' })],
    [
      'an external id outside the STS charset',
      JSON.stringify({ roleArn: ROLE_ARN, externalId: 'has space' }),
    ],
    [
      'an over-long external id',
      JSON.stringify({ roleArn: ROLE_ARN, externalId: 'a'.repeat(1225) }),
    ],
    ['a non-string external id', JSON.stringify({ roleArn: ROLE_ARN, externalId: 42 })],
  ])('rejects %s with a typed error that never echoes the value', (_label, value) => {
    let thrown;
    try {
      credentialValueKind(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('BEDROCK_ROLE_BINDING_INVALID');
    expect(thrown.message).not.toContain(value);
  });

  it('treats any other non-empty value as a bearer token and never parses it', () => {
    // A JSON-looking value that does NOT start with a brace stays a bearer token.
    for (const value of ['ABSKQmVkcm9jaw==', 'arn:aws:iam::111122223333:role/x', '[1,2]', 'null']) {
      expect(looksLikeRoleBindingValue(value)).toBe(false);
      expect(credentialValueKind(value)).toBe('bearer');
    }
  });

  it('leaves isConfiguredCredentialValue semantics unchanged', () => {
    expect(isConfiguredCredentialValue('placeholder')).toBe(false);
    expect(isConfiguredCredentialValue('   ')).toBe(false);
    expect(isConfiguredCredentialValue('')).toBe(false);
    expect(isConfiguredCredentialValue(JSON.stringify({ roleArn: ROLE_ARN }))).toBe(true);
    expect(credentialValueKind('placeholder')).toBeNull();
    expect(credentialValueKind('')).toBeNull();
  });

  it('never reports a malformed role-shaped value as a usable bearer token on a read path', () => {
    expect(credentialValueKindSafe('{ nope')).toBe('role');
    expect(credentialValueKindSafe('placeholder')).toBeNull();
    expect(credentialValueKindSafe('token')).toBe('bearer');
  });
});

// specs/bedrock-iam-role-credential-mode — req-single-parameter-encoding,
// req-role-credential-mode, req-configured-semantics.
describe('credential scope write validation', () => {
  const ROLE_ARN = 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference';
  const roleValue = JSON.stringify({ roleArn: ROLE_ARN });

  it.each(['platform', 'space'])('accepts a valid role binding at %s scope', (source) => {
    expect(
      validateCredentialScopeUpdate({ source, update: { bedrockBearerToken: roleValue } }),
    ).toBeNull();
  });

  it('rejects a role binding at user scope, naming the unsupported scope', () => {
    const invalid = validateCredentialScopeUpdate({
      source: 'user',
      update: { bedrockBearerToken: roleValue },
    });
    expect(invalid).toMatchObject({ code: 'BEDROCK_ROLE_SCOPE_UNSUPPORTED' });
    expect(invalid.error).toContain('user scope');
    expect(invalid.issues[0]).toContain('space and platform scope only');
  });

  it('rejects a malformed role binding with a typed code and no value echo', () => {
    const invalid = validateCredentialScopeUpdate({
      source: 'platform',
      update: { bedrockBearerToken: '{"roleArn":"nope"}' },
    });
    expect(invalid).toMatchObject({ code: 'BEDROCK_ROLE_BINDING_INVALID' });
    expect(JSON.stringify(invalid)).not.toContain('nope');
  });

  it.each([
    ['a bearer token at user scope', 'user', 'ABSKQmVkcm9jaw=='],
    ['a bearer token at platform scope', 'platform', 'ABSKQmVkcm9jaw=='],
    ['an empty clear at user scope', 'user', ''],
    ['a bearer-shaped ARN string', 'user', ROLE_ARN],
  ])('leaves %s untouched', (_label, source, bedrockBearerToken) => {
    expect(validateCredentialScopeUpdate({ source, update: { bedrockBearerToken } })).toBeNull();
  });

  it('ignores an update that does not touch the bedrock field', () => {
    expect(
      validateCredentialScopeUpdate({ source: 'user', update: { kiroApiKey: 'k' } }),
    ).toBeNull();
    expect(validateCredentialScopeUpdate({ source: 'user' })).toBeNull();
  });
});

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
      [
        '/app/dev/users/u-1/agent-credentials/bedrock-bearer-token',
        '/app/dev/users/u-1/agent-credentials/kiro-api-key',
      ],
      ['/app/dev/projects/p-1/agent-credentials/bedrock-bearer-token'],
    ]);
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
      bedrockMode: null,
      bedrockRoleArn: null,
      bedrockExternalIdSet: false,
      bedrockExternalId: null,
    });
  });

  // specs/bedrock-iam-role-credential-mode — req-configured-semantics. The legacy
  // boolean means "a BEARER token is set" and must keep that exact meaning, so a
  // role binding reads false. isConfiguredCredentialValue alone would report true,
  // telling both credential cards a secret exists when none does.
  it('reports bedrockBearerTokenSet false for a role binding while kiro is unaffected', async () => {
    values.set(
      '/app/dev/bedrock-bearer-token',
      JSON.stringify({ roleArn: 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference' }),
    );
    values.set('/app/dev/kiro-api-key', 'kiro-value');

    expect(await readCredentialScopeStatus(ssm, { base: '/app/dev', source: 'platform' })).toEqual({
      bedrockBearerTokenSet: false,
      kiroApiKeySet: true,
      bedrockMode: 'role',
      bedrockRoleArn: 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference',
      bedrockExternalIdSet: false,
      bedrockExternalId: null,
    });
  });

  // specs/bedrock-iam-role-credential-mode Phase 2 — req-configured-semantics.
  // The mode-aware fields are what let a card report a role-only scope as
  // configured. This is the completion criterion named in task 11.
  it('reports mode role with a populated ARN and no bearer secret for a role binding', async () => {
    values.set(
      '/app/dev/bedrock-bearer-token',
      JSON.stringify({
        roleArn: 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference',
        externalId: 'abc123-external',
      }),
    );

    const status = await readCredentialScopeStatus(ssm, { base: '/app/dev', source: 'platform' });

    expect(status.bedrockBearerTokenSet).toBe(false);
    expect(status.bedrockMode).toBe('role');
    expect(status.bedrockRoleArn).toBe('arn:aws:iam::111122223333:role/aidlc-bedrock-inference');
    // The external ID is NOT a secret. req-external-id-lifecycle is explicit that an
    // earlier "never returned to a client" revision was REVERSED: AWS does not treat
    // it as one, and an operator cannot write sts:ExternalId without seeing it. It IS
    // tenant-identifying, so the rule design.md actually states is a gated read path,
    // not absence from this payload — the gate is readCredentialScopeStatusViaBroker's
    // `includeBindingDetail`, asserted in that module's own tests.
    //
    // The value must come from the BINDING, because that is what the broker sends to
    // STS. The standalone staging parameter is not authoritative: it survives a
    // rebind to a role that sends a different external ID, or none.
    expect(status.bedrockExternalIdSet).toBe(true);
    expect(status.bedrockExternalId).toBe('abc123-external');
  });

  // A malformed role-shaped value must NOT report bearer. Reporting bearer would
  // tell the operator a usable secret is present while the binding is broken.
  it('reports mode role with a null ARN for a malformed role-shaped value', async () => {
    values.set('/app/dev/bedrock-bearer-token', '{"roleArn":"not-an-arn"}');

    const status = await readCredentialScopeStatus(ssm, { base: '/app/dev', source: 'platform' });

    expect(status.bedrockMode).toBe('role');
    expect(status.bedrockRoleArn).toBe(null);
    expect(status.bedrockBearerTokenSet).toBe(false);
  });

  it('still resolves a role binding as a configured effective binding', async () => {
    // The binding EXISTS and is usable even though no bearer secret is set — the
    // two questions are distinct, which is the whole point of the recomputation.
    values.set(
      '/app/dev/bedrock-bearer-token',
      JSON.stringify({ roleArn: 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference' }),
    );

    const bindings = await resolveEffectiveCredentialBindings(ssm, {
      base: '/app/dev',
      projectId: 'p-1',
      userId: 'u-1',
    });

    expect(bindings.bedrock).toEqual({ provider: 'bedrock', source: 'platform' });
    expect(
      availableClisForBindings({ installed: ['claude', 'opencode', 'codex', 'kiro'], bindings }),
    ).toEqual(['claude', 'opencode', 'codex']);
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
    ).toEqual({
      bedrockBearerTokenSet: true,
      kiroApiKeySet: true,
      bedrockMode: 'bearer',
      bedrockRoleArn: null,
      bedrockExternalIdSet: false,
      bedrockExternalId: null,
    });

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
    // Stored OUTSIDE agent-credentials/, so the provider loop cannot reach it. If
    // teardown misses it, the value outlives the space and a space recreated with
    // the same id inherits an external ID no trust policy references.
    const externalIdPath = '/app/dev/projects/p-1/bedrock-external-id';
    values.set(bedrockPath, 'space-bedrock');
    values.set(kiroPath, 'space-kiro');
    values.set(externalIdPath, 'space-external-id');

    await expect(
      deleteCredentialScope(ssm, {
        base: '/app/dev',
        source: 'space',
        projectId: 'p-1',
      }),
    ).resolves.toEqual({ deleted: ['bedrock', 'kiro'], missing: [], externalIdDeleted: true });
    expect(values.has(bedrockPath)).toBe(false);
    expect(values.has(kiroPath)).toBe(false);
    expect(values.has(externalIdPath)).toBe(false);

    await expect(
      deleteCredentialScope(ssm, {
        base: '/app/dev',
        source: 'space',
        projectId: 'p-1',
      }),
    ).resolves.toEqual({
      deleted: [],
      missing: ['bedrock', 'kiro'],
      externalIdDeleted: false,
    });
  });
});

// specs/bedrock-iam-role-credential-mode Phase 2 — req-external-id-lifecycle.
// The platform generates the external ID, so the generator must be a CSPRNG with
// at least 128 bits of entropy and must never produce a value the write path
// would reject.
describe('external ID generation', () => {
  const ROLE_ARN = 'arn:aws:iam::444455556666:role/aidlc-bedrock-cross';
  it('draws at least 128 bits of entropy from the injected CSPRNG', () => {
    expect(EXTERNAL_ID_ENTROPY_BYTES).toBeGreaterThanOrEqual(16);

    const calls = [];
    const fake = (n) => {
      calls.push(n);
      return Buffer.alloc(n, 7);
    };
    generateExternalId(fake);

    // The byte count is requested from the CSPRNG in ONE draw — a loop of small
    // draws would still satisfy a length assertion while weakening the source.
    expect(calls).toEqual([EXTERNAL_ID_ENTROPY_BYTES]);
  });

  it('never generates a value the storage validator would reject', () => {
    // The real parser the broker and the write path both run, not a copy of its
    // regex: this is what guarantees a generated ID can always be stored and read
    // back. 200 draws exercises the alphabet, including the base64url characters
    // that a stricter charset would refuse.
    //
    // Asserted through parseRoleBindingValue rather than
    // validateCredentialScopeUpdate, because that validator now REFUSES a
    // client-supplied external ID outright (req-external-id-lifecycle) — the
    // server attaches its own value after validation, so the parser is the gate a
    // generated value must survive.
    for (let i = 0; i < 200; i += 1) {
      const externalId = generateExternalId();
      expect(
        parseRoleBindingValue(JSON.stringify({ roleArn: ROLE_ARN, externalId })),
      ).toStrictEqual({ roleArn: ROLE_ARN, externalId });
    }
  });

  it('generates a distinct value per call so one is never shared across scopes', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateExternalId()));
    expect(seen.size).toBe(100);
  });
});

// describeBedrockBinding is on the settings READ path, so it must be total: a
// settings page has to render for any stored byte sequence rather than 500.
describe('describeBedrockBinding is total', () => {
  it('returns a shape and never throws for hostile or empty stored values', () => {
    const hostile = [
      undefined,
      null,
      '',
      '   ',
      'placeholder',
      'a-plain-bearer-token',
      '{',
      '{}',
      '[]',
      '[{"roleArn":"arn:aws:iam::111122223333:role/x"}]',
      '{"roleArn":""}',
      '{"roleArn":"not-an-arn"}',
      '{"roleArn":123}',
      `{"roleArn":"arn:aws:iam::111122223333:role/${'x'.repeat(4000)}"}`,
      '{"roleArn":"arn:aws:iam::111122223333:role/x","externalId":" "}',
    ];
    for (const value of hostile) {
      const described = describeBedrockBinding(value);
      expect(Object.keys(described).toSorted()).toEqual([
        'externalId',
        'externalIdSet',
        'mode',
        'roleArn',
      ]);
      expect([null, 'bearer', 'role']).toContain(described.mode);
      expect(typeof described.externalIdSet).toBe('boolean');
      // A broken binding must never be reported as a usable bearer secret.
      if (typeof value === 'string' && value.trim().startsWith('{')) {
        expect(described.mode).toBe('role');
      }
    }
  });
});

// specs/bedrock-iam-role-credential-mode — req-external-id-lifecycle,
// req-same-and-cross-account, dec-external-id-scope, dec-external-id-storage.
//
// The external ID lives in its own per-scope parameter and is COPIED into the
// binding on a successful save. That indirection is what makes the cross-account
// bootstrap converge: req-binding-preflight refuses to persist a binding whose
// AssumeRole fails, so a value kept only inside the binding would be discarded by
// the very first save and the retry would generate a different one, invalidating
// the trust policy the operator had just written.
describe('bedrock external ID storage and cross-account detection', () => {
  const ssm = mockClient(SSMClient);
  const BASE = '/collab/dev';
  const SAME_ACCOUNT = 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference';
  const OTHER_ACCOUNT = 'arn:aws:iam::444455556666:role/aidlc-bedrock-inference';
  const PLATFORM_ACCOUNT = '111122223333';

  beforeEach(() => {
    ssm.reset();
  });

  it('keeps the external ID outside the credential paths', () => {
    // The parameter must NOT sit under agent-credentials/, which is where the
    // broker's exclusive-read discipline applies. Reading its own generated value
    // back is how an operator recovers it, and that must not require the settings
    // API to hold any read grant on credential material.
    expect(bedrockExternalIdPath({ base: BASE, source: 'platform' })).toBe(
      '/collab/dev/bedrock-external-id',
    );
    expect(bedrockExternalIdPath({ base: BASE, source: 'space', projectId: 'p-1' })).toBe(
      '/collab/dev/projects/p-1/bedrock-external-id',
    );
    for (const path of [
      bedrockExternalIdPath({ base: BASE, source: 'platform' }),
      bedrockExternalIdPath({ base: BASE, source: 'space', projectId: 'p-1' }),
    ]) {
      expect(path).not.toContain('/agent-credentials/');
    }
    // User scope has no role binding at all, so it can never need one.
    expect(() => bedrockExternalIdPath({ base: BASE, source: 'user', userId: 'u-1' })).toThrow();
  });

  it('treats an unknown platform account as cross-account, which is the fail-safe direction', () => {
    expect(
      bedrockRoleIsCrossAccount({ roleArn: SAME_ACCOUNT, platformAccountId: '111122223333' }),
    ).toBe(false);
    expect(
      bedrockRoleIsCrossAccount({ roleArn: OTHER_ACCOUNT, platformAccountId: '111122223333' }),
    ).toBe(true);
    // A superfluous external ID is inert unless a trust policy asks for one; a
    // missing one is a hard AssumeRole denial. So unknown must mean "generate".
    expect(bedrockRoleIsCrossAccount({ roleArn: OTHER_ACCOUNT, platformAccountId: null })).toBe(
      true,
    );
    expect(bedrockRoleIsCrossAccount({ roleArn: 'not-an-arn', platformAccountId: null })).toBe(
      false,
    );
  });

  it('generates once and returns the same value on every later call', async () => {
    ssm
      .on(GetParameterCommand)
      .rejectsOnce(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));
    ssm.on(PutParameterCommand).resolves({});

    const first = await ensureBedrockExternalId(ssm, { base: BASE, source: 'platform' });
    expect(first).toMatch(/^[\w-]{20,}$/);
    const written = ssm.commandCalls(PutParameterCommand)[0].args[0].input;
    expect(written).toMatchObject({
      Name: '/collab/dev/bedrock-external-id',
      Value: first,
      Type: 'SecureString',
      // Conditional, not last-write-wins: SSM itself arbitrates the race between two
      // concurrent saves for one scope, so both callers end up agreeing with the
      // stored value instead of one holding a value that was overwritten.
      Overwrite: false,
    });

    // Now that it exists, a second call must NOT mint a new one — recovering a
    // lost value is a plain read, not a rotation (dec-external-id-not-secret).
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: first } });
    expect(await ensureBedrockExternalId(ssm, { base: BASE, source: 'platform' })).toBe(first);
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(1);
  });

  // The race this exists to close: two saves for one scope both read absent, both
  // generate, and one write loses. The loser must return the WINNER's value — if it
  // returned its own, the operator would paste an external ID that is not stored and
  // STS would answer with the one rejection cause that cannot name a reason.
  it('returns the winner value when a concurrent save already created the parameter', async () => {
    const winner = 'the-value-that-actually-got-stored';
    ssm
      .on(GetParameterCommand)
      .rejectsOnce(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }))
      .resolves({ Parameter: { Value: winner } });
    ssm
      .on(PutParameterCommand)
      .rejects(Object.assign(new Error('exists'), { name: 'ParameterAlreadyExists' }));

    expect(await ensureBedrockExternalId(ssm, { base: BASE, source: 'platform' })).toBe(winner);
  });

  it('reads an absent external ID as null rather than throwing', async () => {
    ssm
      .on(GetParameterCommand)
      .rejects(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));
    expect(await readBedrockExternalId(ssm, { base: BASE, source: 'platform' })).toBe(null);
  });

  it('attaches no external ID to a same-account binding', async () => {
    const prepared = await prepareBedrockBindingWrite(ssm, {
      base: BASE,
      source: 'platform',
      update: { bedrockBearerToken: JSON.stringify({ roleArn: SAME_ACCOUNT }) },
      platformAccountId: PLATFORM_ACCOUNT,
    });
    expect(prepared.crossAccount).toBe(false);
    expect(prepared.externalId).toBe(null);
    expect(JSON.parse(prepared.update.bedrockBearerToken)).toStrictEqual({ roleArn: SAME_ACCOUNT });
    // An unused stored value invites confusion, so nothing is written at all.
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(0);
  });

  it('attaches a generated external ID to a cross-account binding', async () => {
    ssm
      .on(GetParameterCommand)
      .rejects(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));
    ssm.on(PutParameterCommand).resolves({});

    const prepared = await prepareBedrockBindingWrite(ssm, {
      base: BASE,
      source: 'space',
      projectId: 'p-1',
      update: { bedrockBearerToken: JSON.stringify({ roleArn: OTHER_ACCOUNT }) },
      platformAccountId: PLATFORM_ACCOUNT,
    });

    expect(prepared.crossAccount).toBe(true);
    expect(prepared.externalId).toBeTruthy();
    expect(JSON.parse(prepared.update.bedrockBearerToken)).toStrictEqual({
      roleArn: OTHER_ACCOUNT,
      externalId: prepared.externalId,
    });
    expect(ssm.commandCalls(PutParameterCommand)[0].args[0].input.Name).toBe(
      '/collab/dev/projects/p-1/bedrock-external-id',
    );
  });

  it('leaves a bearer token and a cleared value completely untouched', async () => {
    for (const bedrockBearerToken of ['ABSKQmVkcm9jaw==', '', '   ']) {
      const prepared = await prepareBedrockBindingWrite(ssm, {
        base: BASE,
        source: 'platform',
        update: { bedrockBearerToken },
        platformAccountId: PLATFORM_ACCOUNT,
      });
      expect(prepared.update.bedrockBearerToken).toBe(bedrockBearerToken);
      expect(prepared.roleArn).toBe(null);
    }
    // No parameter is touched for a bearer deployment: this path must be inert
    // for every pre-existing installation.
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('refuses to compose a cross-account binding with no external ID', async () => {
    // dec-external-id-scope makes it mandatory cross-account. Reaching this means
    // generation returned nothing, and persisting anyway would trade a legible
    // failure for a confused-deputy exposure.
    ssm
      .on(GetParameterCommand)
      .rejects(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));
    ssm.on(PutParameterCommand).resolves({});

    await expect(
      prepareBedrockBindingWrite(ssm, {
        base: BASE,
        source: 'platform',
        update: { bedrockBearerToken: JSON.stringify({ roleArn: OTHER_ACCOUNT }) },
        platformAccountId: PLATFORM_ACCOUNT,
        randomBytes: () => Buffer.alloc(0),
      }),
    ).rejects.toMatchObject({ code: 'BEDROCK_ROLE_BINDING_INVALID' });
  });

  it('refuses a client-supplied external ID instead of silently replacing it', () => {
    // AWS requires the assuming party to control the value. Overwriting it
    // quietly would leave the operator with a trust policy they believe is right.
    const verdict = validateCredentialScopeUpdate({
      source: 'platform',
      update: {
        bedrockBearerToken: JSON.stringify({
          roleArn: OTHER_ACCOUNT,
          externalId: 'operator-chose',
        }),
      },
    });
    expect(verdict).toMatchObject({ code: 'BEDROCK_EXTERNAL_ID_NOT_ACCEPTED' });
    // A role ARN on its own is still accepted.
    expect(
      validateCredentialScopeUpdate({
        source: 'platform',
        update: { bedrockBearerToken: JSON.stringify({ roleArn: OTHER_ACCOUNT }) },
      }),
    ).toBe(null);
  });
});

// specs/bedrock-iam-role-credential-mode — req-litellm-seam.
//
// The constraining seam for a future non-AWS provider is this static map, not the
// credential mechanism. A bearer token and an IAM role are two shapes of ONE
// provider's stored value, so neither may appear here — a `bedrock-role` entry
// would make the mode part of the provider identity and force every consumer to
// learn about it.
describe('the CLI-to-provider map stays mode-agnostic', () => {
  it('maps each CLI to a provider name carrying no credential mode', () => {
    expect(AGENT_CLI_PROVIDER).toStrictEqual({
      kiro: 'kiro',
      claude: 'bedrock',
      opencode: 'bedrock',
      codex: 'bedrock',
    });
    // LiteLLM will arrive as a new provider BESIDE kiro, so the provider set is
    // what grows — never the mode vocabulary inside a provider.
    expect(AGENT_CREDENTIAL_PROVIDERS).toStrictEqual(['bedrock', 'kiro']);
    for (const provider of Object.values(AGENT_CLI_PROVIDER)) {
      expect(provider).not.toMatch(/role|bearer|sts|token/i);
    }
  });
});
