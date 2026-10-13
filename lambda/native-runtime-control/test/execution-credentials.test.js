import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { createNativeExecutionCredentials } from '../execution-credentials.js';
import { nativePreparedConfigurationPins, nativePromptSha256 } from '../execution-config.js';
import { prepareBinding } from '../../shared/source-control-bindings.js';
import { ACTOR, MEMBERSHIP, OTHER, PROJECT, owner, resources, setup } from './fixtures.js';

const spies = vi.hoisted(() => ({
  git: vi.fn(),
  source: vi.fn(),
}));
vi.mock('../../shared/source-control-credentials.js', () => ({
  resolveBindingCredential: spies.git,
}));
vi.mock('../execution-source.js', async (original) => ({
  ...(await original()),
  resolveNativeSourceCommit: spies.source,
}));
const MODEL = 'unit-test-model-credential';
const GIT = 'unit-test-source-credential';
const IMAGE = {
  uri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentcore@sha256:${'b'.repeat(64)}`,
  digest: `sha256:${'b'.repeat(64)}`,
};
const SOURCE = { branch: 'develop', commit: 'c'.repeat(40) };
const fixture = async () => {
  const f = setup();
  const claimed = await f.claimed();
  const draft = await f.store.ready({ ...owner(claimed), resources: resources(claimed) });
  const env = {
    AWS_REGION: 'us-east-1',
    NATIVE_RUNTIME_ACCOUNT_ID: '123456789012',
    NATIVE_EXECUTION_IMAGE_URI: IMAGE.uri,
    NATIVE_EXECUTION_IMAGE_DIGEST: IMAGE.digest,
    NATIVE_EXECUTION_PUBLICATION_BUCKET: 'native-publications-dev',
    NATIVE_PACKAGES_BUCKET: 'native-packages-dev',
    SOURCE_CONTROL_BINDINGS_TABLE: 'app-bindings',
    NATIVE_RUNTIME_BINDINGS_TABLE: 'native-bindings',
    AGENT_SETTINGS_SSM_PREFIX: '/aidlc/dev',
  };
  const binding = prepareBinding({
    projectId: PROJECT,
    provider: 'github',
    repo: 'jwthewes/flappy-bird',
    authType: 'github-oauth',
    credentialRef: 'oauth#github#repo-owner',
    connectionUserId: 'repo-owner',
    capabilities: { repositoryWrite: true },
  });
  const configuration = {
    ...nativePreparedConfigurationPins(draft),
    model: 'openai.test',
    repository: {
      provider: 'github',
      repository: 'jwthewes/flappy-bird',
      branch: null,
      bindingRevision: binding.revision,
    },
    credentialBinding: { provider: 'bedrock', source: 'user', userId: ACTOR },
    image: structuredClone(IMAGE),
    publicationBucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
    packageBucket: env.NATIVE_PACKAGES_BUCKET,
    accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
  };
  const preparation = Object.fromEntries(
    [
      'bindingId',
      'version',
      'requestFingerprint',
      'executionRoleArn',
      'accessPointArn',
      'fileSystemId',
      'rootDirectory',
      'mountPath',
      'runtimeArn',
      'runtimeVersion',
      'runtimeEndpoint',
    ].map((key) => [key, draft[key]]),
  );
  preparation.image = { uri: draft.imageUri, digest: draft.imageDigest };
  const row = {
    scope: { projectId: draft.projectId, executionId: draft.executionId },
    bindingId: draft.bindingId,
    version: 3,
    epoch: 1,
    attemptId: '90000000-0000-4000-8000-000000000001',
    runtimeSessionId: '90000000-0000-4000-8000-000000000002',
    startedBy: ACTOR,
    configuration,
    preparation,
    status: 'UPGRADING',
    cancelRequested: false,
    target: {
      runtimeArn: draft.runtimeArn,
      runtimeId: draft.runtimeId,
      runtimeVersion: '2',
      imageDigest: IMAGE.digest,
      endpoint: `exec_${nativePromptSha256('90000000-0000-4000-8000-000000000001').slice(0, 32)}`,
      rolePolicySha256: 'a'.repeat(64),
    },
  };
  row.target.endpointArn = `${row.target.runtimeArn}/runtime-endpoint/${row.target.endpoint}`;
  const state = {
    env,
    draft,
    row,
    binding,
    model: MODEL,
    connection: {
      userId: 'repo-owner',
      provider: 'github',
      providerInstance: 'github#public',
      parameterName: '/aidlc/dev/git-token/repo-owner/github',
      status: 'active',
      createdAt: '2026-09-29T10:00:00Z',
      generation: OTHER,
    },
  };
  const executionStore = {
    get: vi.fn(async (scope) => {
      expect(scope).toEqual(row.scope);
      await state.executionHook?.();
      return structuredClone(state.row);
    }),
  };
  const preparationStore = {
    get: vi.fn(async (scope) => {
      expect(scope).toEqual(row.scope);
      await state.preparationHook?.();
      return structuredClone(state.draft);
    }),
  };
  const ddb = {
    send: vi.fn(async (command) => {
      expect(command).toBeInstanceOf(GetCommand);
      expect(command.input.ConsistentRead).toBe(true);
      if (command.input.TableName === 'native-bindings') {
        expect(command.input.Key.sk).toBe('REVOCATION');
        await state.revocationHook?.(command.input.Key);
        const item = state.revocations?.[command.input.Key.pk];
        return item ? { Item: structuredClone(item) } : {};
      }
      if (command.input.TableName === 'app-bindings') {
        expect(command.input.Key).toEqual({
          projectId: PROJECT,
          bindingKey: 'github#jwthewes/flappy-bird',
        });
        await state.bindingHook?.();
        return { Item: structuredClone(state.binding) };
      }
      expect(command.input.TableName).toBe('git-connections');
      expect(command.input.Key).toEqual({
        userId: 'repo-owner',
        providerInstance: 'github#public',
      });
      return { Item: structuredClone(state.connection) };
    }),
  };
  const ssm = {
    send: vi.fn(async (command) => {
      expect(command).toBeInstanceOf(GetParameterCommand);
      expect(command.input.WithDecryption).toBe(true);
      await state.modelHook?.(command.input.Name);
      return { Parameter: { Value: state.model } };
    }),
  };
  const secrets = {
    send: vi.fn(() => {
      throw new Error('Unexpected Secrets Manager read');
    }),
  };
  const getMembershipSnapshot = vi.fn(async (_projectId, userId) => {
    const override = await state.membershipHook?.(userId);
    return override === undefined ? { ...MEMBERSHIP, membershipId: `edge-${userId}` } : override;
  });
  const request = {
    ...row.scope,
    attemptId: row.attemptId,
    epoch: row.epoch,
  };
  const invoke = (payload = request, overrides = {}) =>
    createNativeExecutionCredentials({
      executionStore,
      preparationStore,
      ddb,
      ssm,
      secrets,
      env,
      getMembershipSnapshot,
      ...overrides,
    })(payload);
  return {
    state,
    executionStore,
    preparationStore,
    ddb,
    ssm,
    secrets,
    getMembershipSnapshot,
    request,
    invoke,
  };
};

beforeEach(() => {
  vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'git-connections');
  vi.stubEnv('GIT_CONNECTIONS_TABLE', '');
  spies.git.mockReset().mockResolvedValue({
    username: 'x-access-token',
    token: GIT,
    refresh: () => 'must-not-be-returned',
    actor: 'must-not-be-returned',
  });
  spies.source.mockReset().mockResolvedValue(SOURCE);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('controller-only native credential facade', () => {
  it('resolves credentials for the pinned saved prompt while retaining the immutable creation request', async () => {
    const f = await fixture();
    const original = structuredClone(f.state.draft.request);
    f.state.draft.promptDraft = { revision: 2, text: 'The corrected prompt before Start' };
    f.state.draft.version += 2;
    f.state.row.preparation.version = f.state.draft.version;
    f.state.row.preparation.promptRevision = 2;
    f.state.row.configuration.promptSha256 = nativePromptSha256(f.state.draft.promptDraft.text);
    expect(await f.invoke()).toMatchObject({ ok: true });
    expect(f.state.draft.request).toEqual(original);
    f.state.draft.promptDraft.text = 'Changed after admission';
    expect(await f.invoke()).toMatchObject({
      ok: false,
      code: 'NATIVE_EXECUTION_CREDENTIALS_CHANGED',
    });
  });

  const continuation = async () => {
    const f = await fixture();
    const response = {
      commandId: '80000000-0000-4000-8000-000000000001',
      interactionId: 'a'.repeat(64),
      contentSha256: 'b'.repeat(64),
      sequence: 2,
      actorId: 'another-project-member',
      text: 'Make the pipes blue.',
      textSha256: nativePromptSha256('Make the pipes blue.'),
    };
    Object.assign(f.state.row, {
      status: 'DISPATCHING',
      sourceBranch: SOURCE.branch,
      sourceCommit: SOURCE.commit,
      turnSequence: 2,
      interaction: { id: response.interactionId },
      interactionContentSha256: response.contentSha256,
      response: {
        commandId: response.commandId,
        interactionId: response.interactionId,
        contentSha256: response.contentSha256,
        sequence: 2,
        actorId: response.actorId,
        textSha256: response.textSha256,
        deliveryStatus: 'pending',
      },
    });
    f.executionStore.response = vi.fn(async () => structuredClone(response));
    return { ...f, response };
  };

  it('refreshes the original starter binding for a reply by a different project member', async () => {
    const f = await continuation();
    const result = await f.invoke();
    expect(result.ok).toBe(true);
    expect(result.model).toEqual({ provider: 'bedrock', value: MODEL });
    expect(f.ssm.send.mock.calls.map(([command]) => command.input.Name)).toEqual([
      '/aidlc/dev/users/member-one/agent-credentials/bedrock-bearer-token',
      '/aidlc/dev/users/member-one/agent-credentials/bedrock-bearer-token',
    ]);
    expect(spies.source).not.toHaveBeenCalled();
    expect(f.executionStore.response).toHaveBeenCalledWith(
      expect.objectContaining({ turnSequence: 2, startedBy: ACTOR }),
      f.response.interactionId,
    );
  });

  it.each(['missing', 'changed-command', 'changed-text'])(
    'does not read secrets for a continuation whose protected response is %s',
    async (change) => {
      const f = await continuation();
      if (change === 'missing') f.executionStore.response.mockResolvedValue(null);
      if (change === 'changed-command') f.response.commandId = OTHER;
      if (change === 'changed-text') f.response.text = 'Different response';
      expect(await f.invoke()).toMatchObject({
        ok: false,
        code: 'NATIVE_EXECUTION_CREDENTIALS_CHANGED',
      });
      expect(f.ssm.send).not.toHaveBeenCalled();
      expect(spies.git).not.toHaveBeenCalled();
    },
  );

  it('rejects a continuation whose delivery was already acknowledged', async () => {
    const f = await continuation();
    f.state.row.response.deliveryStatus = 'delivered';
    expect(await f.invoke()).toMatchObject({
      ok: false,
      code: 'NATIVE_EXECUTION_CREDENTIALS_CHANGED',
    });
    expect(f.ssm.send).not.toHaveBeenCalled();
  });

  describe('protected runtime image policy', () => {
    const OLD = {
      uri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentcore@sha256:${'a'.repeat(64)}`,
      digest: `sha256:${'a'.repeat(64)}`,
    };
    const pinOld = (f) => {
      f.state.row.configuration.image = structuredClone(OLD);
      f.state.row.target.imageDigest = OLD.digest;
      f.state.row.target.runtimeVersion = '3';
    };
    const revoke = (f, digest) => {
      f.state.revocations = {
        [`NATIVE_RUNTIME_IMAGE#${digest}`]: {
          pk: `NATIVE_RUNTIME_IMAGE#${digest}`,
          sk: 'REVOCATION',
          schemaVersion: 1,
          digest,
          revokedAt: 1_790_000_000_000,
          revokedBy: 'operator',
          reasonCode: 'vulnerable_image',
        },
      };
    };

    it('renews a resumable reply with its retained older pin after a deployment', async () => {
      const f = await continuation();
      pinOld(f);
      const result = await f.invoke();
      expect(result.ok).toBe(true);
      expect(result.model).toEqual({ provider: 'bedrock', value: MODEL });
    });

    it('does not follow a pin into another repository', async () => {
      const f = await continuation();
      pinOld(f);
      f.state.row.configuration.image = {
        uri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/other@${OLD.digest}`,
        digest: OLD.digest,
      };
      expect(await f.invoke()).toMatchObject({
        ok: false,
        code: 'NATIVE_EXECUTION_CREDENTIALS_CHANGED',
      });
      expect(f.ssm.send).not.toHaveBeenCalled();
      expect(spies.git).not.toHaveBeenCalled();
    });

    it.each(['current', 'retained'])('blocks renewal after revoking the %s pin', async (kind) => {
      const f = await continuation();
      if (kind === 'retained') pinOld(f);
      revoke(f, kind === 'retained' ? OLD.digest : IMAGE.digest);
      expect(await f.invoke()).toEqual({
        ok: false,
        code: 'NATIVE_EXECUTION_CREDENTIALS_IMAGE_REVOKED',
      });
      expect(f.ssm.send).not.toHaveBeenCalled();
      expect(spies.git).not.toHaveBeenCalled();
    });

    it('withholds resolved secrets when a revocation lands during the slow provider path', async () => {
      const f = await continuation();
      pinOld(f);
      f.state.modelHook = (name) => {
        if (f.ssm.send.mock.calls.length === 1) revoke(f, OLD.digest);
        return name;
      };
      const result = await f.invoke();
      expect(result).toEqual({ ok: false, code: 'NATIVE_EXECUTION_CREDENTIALS_IMAGE_REVOKED' });
      expect(JSON.stringify(result)).not.toContain(MODEL);
      expect(JSON.stringify(result)).not.toContain(GIT);
    });

    it('fails closed when revocation state is unavailable', async () => {
      const f = await continuation();
      f.state.revocationHook = () => {
        throw new Error('throttled');
      };
      expect(await f.invoke()).toEqual({
        ok: false,
        code: 'NATIVE_EXECUTION_CREDENTIALS_UNAVAILABLE',
      });
      expect(f.ssm.send).not.toHaveBeenCalled();
    });
  });

  it('returns only the pinned model/source credentials and safe scope IDs', async () => {
    const f = await fixture();
    expect(await f.invoke()).toEqual({
      ok: true,
      ...f.request,
      bindingId: f.state.draft.bindingId,
      runtimeSessionId: f.state.row.runtimeSessionId,
      model: { provider: 'bedrock', value: MODEL },
      git: { username: 'x-access-token', password: GIT },
      source: SOURCE,
    });
    expect(spies.git).toHaveBeenCalledWith({
      ddb: f.ddb,
      ssm: f.ssm,
      secrets: f.secrets,
      binding: f.state.binding,
      requiredAccess: 'read',
    });
    expect(spies.source).toHaveBeenCalledWith({
      provider: 'github',
      repository: 'jwthewes/flappy-bird',
      branch: null,
      token: GIT,
    });
    expect(f.ssm.send.mock.calls.map(([command]) => command.input.Name)).toEqual([
      '/aidlc/dev/users/member-one/agent-credentials/bedrock-bearer-token',
      '/aidlc/dev/users/member-one/agent-credentials/bedrock-bearer-token',
    ]);
    expect(f.executionStore.get).toHaveBeenCalledTimes(2);
    expect(f.preparationStore.get).toHaveBeenCalledTimes(2);
  });

  it.each(['space', 'platform'])('reads only the pinned %s model binding', async (source) => {
    const f = await fixture();
    f.state.row.configuration.credentialBinding = { provider: 'bedrock', source };
    expect((await f.invoke()).ok).toBe(true);
    const path =
      source === 'space'
        ? `/aidlc/dev/projects/${PROJECT}/agent-credentials/bedrock-bearer-token`
        : '/aidlc/dev/bedrock-bearer-token';
    expect(f.ssm.send.mock.calls.every(([command]) => command.input.Name === path)).toBe(true);
  });

  it.each([
    [
      'request project',
      (f) => {
        f.request.projectId = OTHER;
      },
    ],
    [
      'request execution',
      (f) => {
        f.request.executionId = OTHER;
      },
    ],
    [
      'old attempt',
      (f) => {
        f.request.attemptId = OTHER;
      },
    ],
    [
      'old epoch',
      (f) => {
        f.request.epoch = 2;
      },
    ],
    [
      'runtime role assertion',
      (f) => {
        f.request.role = 'trusted-worker';
      },
    ],
    [
      'caller credential',
      (f) => {
        f.request.credentialBinding = { source: 'platform' };
      },
    ],
    [
      'REQUESTED',
      (f) => {
        f.state.row.status = 'REQUESTED';
      },
    ],
    [
      'RUNNING',
      (f) => {
        f.state.row.status = 'RUNNING';
      },
    ],
    [
      'DISPATCHING without source pins',
      (f) => {
        f.state.row.status = 'DISPATCHING';
      },
    ],
    [
      'UPGRADING without verified target',
      (f) => {
        delete f.state.row.target;
      },
    ],
    [
      'target image mismatch',
      (f) => {
        f.state.row.target.imageDigest = `sha256:${'0'.repeat(64)}`;
      },
    ],
    [
      'cancelled',
      (f) => {
        f.state.row.cancelRequested = true;
      },
    ],
    [
      'missing execution',
      (f) => {
        f.state.row = null;
      },
    ],
    [
      'different starter credential',
      (f) => {
        f.state.row.configuration.credentialBinding.userId = 'collaborator';
      },
    ],
    [
      'foreign publication bucket',
      (f) => {
        f.state.row.configuration.publicationBucket = 'foreign-bucket';
      },
    ],
    [
      'foreign package bucket',
      (f) => {
        f.state.row.configuration.packageBucket = 'foreign-bucket';
      },
    ],
    [
      'unconfigured image',
      (f) => {
        f.state.row.configuration.image.digest = `sha256:${'f'.repeat(64)}`;
      },
    ],
    [
      'recreated preparation binding',
      (f) => {
        f.state.draft.bindingId = OTHER;
      },
    ],
    [
      'changed preparation version',
      (f) => {
        f.state.draft.version += 1;
      },
    ],
    [
      'changed prepared prompt',
      (f) => {
        f.state.draft.request.prompt += 'tampered';
      },
    ],
    [
      'changed package pin',
      (f) => {
        f.state.draft.candidate.materializationId = `sha256:${'f'.repeat(64)}`;
      },
    ],
    [
      'recreated project',
      (f) => {
        f.state.draft.projectIdentity = 'new-project';
      },
    ],
    [
      'inactive source binding',
      (f) => {
        f.state.binding.status = 'invalid';
      },
    ],
    [
      'revised source binding',
      (f) => {
        f.state.binding.revision = OTHER;
      },
    ],
    [
      'deleted connection',
      (f) => {
        f.state.connection = { ...f.state.connection, status: 'deleted' };
      },
    ],
  ])('denies %s before obtaining any credential', async (_label, mutate) => {
    const f = await fixture();
    mutate(f);
    expect((await f.invoke()).ok).toBe(false);
    expect(spies.git).not.toHaveBeenCalled();
    expect(f.ssm.send).not.toHaveBeenCalled();
  });

  it('requires current starter and delegator membership, with no missing-reader bypass', async () => {
    const f = await fixture();
    expect((await f.invoke(f.request, { getMembershipSnapshot: undefined })).ok).toBe(false);
    for (const denied of [ACTOR, 'repo-owner']) {
      f.state.membershipHook = (userId) => (userId === denied ? null : undefined);
      expect((await f.invoke()).ok).toBe(false);
    }
    expect(f.ssm.send).not.toHaveBeenCalled();
  });

  it.each(['', 'placeholder'])(
    'does not fall back when the pinned credential is unavailable (%s)',
    async (value) => {
      const f = await fixture();
      f.state.model = value;
      expect(await f.invoke()).toEqual({
        ok: false,
        code: 'NATIVE_EXECUTION_MODEL_CREDENTIAL_UNAVAILABLE',
      });
      expect(f.ssm.send).toHaveBeenCalledTimes(1);
      expect(spies.git).not.toHaveBeenCalled();
    },
  );

  it('accepts in-place model token rotation and returns the newly read value', async () => {
    const f = await fixture();
    spies.git.mockImplementation(async () => {
      f.state.model = 'rotated-model-token';
      return { username: 'x-access-token', token: GIT };
    });
    expect((await f.invoke()).model).toEqual({ provider: 'bedrock', value: 'rotated-model-token' });
  });

  it('denies disappearance of the pinned model during provider resolution without fallback', async () => {
    const f = await fixture();
    spies.git.mockImplementation(async () => {
      f.state.model = '';
      return { username: 'x-access-token', token: GIT };
    });
    expect(await f.invoke()).toEqual({
      ok: false,
      code: 'NATIVE_EXECUTION_MODEL_CREDENTIAL_UNAVAILABLE',
    });
    expect(new Set(f.ssm.send.mock.calls.map(([command]) => command.input.Name)).size).toBe(1);
  });

  it('handles ParameterNotFound as a disappeared pinned credential, never a platform fallback', async () => {
    const f = await fixture();
    f.ssm.send.mockRejectedValue(
      Object.assign(new Error('private missing path'), { name: 'ParameterNotFound' }),
    );
    expect(await f.invoke()).toEqual({
      ok: false,
      code: 'NATIVE_EXECUTION_MODEL_CREDENTIAL_UNAVAILABLE',
    });
    expect(f.ssm.send).toHaveBeenCalledTimes(1);
    expect(spies.git).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after slow branch resolution before returning any credential', async () => {
    const f = await fixture();
    spies.source.mockImplementation(async () => {
      f.state.row.cancelRequested = true;
      return SOURCE;
    });
    expect((await f.invoke()).ok).toBe(false);
  });

  it.each([
    [
      'cancel',
      (f) => {
        f.state.row.cancelRequested = true;
      },
    ],
    [
      'takeover epoch',
      (f) => {
        f.state.row.epoch++;
      },
    ],
    [
      'attempt',
      (f) => {
        f.state.row.attemptId = OTHER;
      },
    ],
    [
      'dispatch status',
      (f) => {
        f.state.row.status = 'RUNNING';
      },
    ],
    [
      'execution generation',
      (f) => {
        f.state.row.version++;
      },
    ],
    [
      'binding revision',
      (f) => {
        f.state.binding.revision = OTHER;
      },
    ],
    [
      'binding deletion',
      (f) => {
        f.state.binding = null;
      },
    ],
    [
      'binding replacement with unchanged UUID',
      (f) => {
        f.state.binding.connectionUserId = 'replacement-owner';
      },
    ],
    [
      'connection revocation',
      (f) => {
        f.state.connection.status = 'deleted';
      },
    ],
    [
      'connection recreation',
      (f) => {
        f.state.connection.generation = 'new-generation';
      },
    ],
    [
      'preparation change',
      (f) => {
        f.state.draft.version++;
      },
    ],
    [
      'starter membership removal',
      (f) => {
        f.state.membershipHook = (id) => (id === ACTOR ? null : undefined);
      },
    ],
    [
      'delegator membership removal',
      (f) => {
        f.state.membershipHook = (id) => (id === 'repo-owner' ? null : undefined);
      },
    ],
    [
      'membership remove/re-add',
      (f) => {
        f.state.membershipHook = () => ({ ...MEMBERSHIP, membershipId: 'new-edge' });
      },
    ],
  ])('suppresses credentials for %s during a slow source lookup', async (_label, mutate) => {
    const f = await fixture();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    spies.git.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { username: 'x-access-token', token: GIT };
    });
    const pending = f.invoke();
    await entered.promise;
    mutate(f);
    release.resolve();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(MODEL);
    expect(JSON.stringify(result)).not.toContain(GIT);
  });

  it('returns controller-pinned source values without re-resolving a moving branch', async () => {
    const f = await fixture();
    f.state.row.sourceBranch = 'release/old';
    f.state.row.sourceCommit = 'd'.repeat(64);
    f.state.row.status = 'DISPATCHING';
    expect((await f.invoke()).source).toEqual({ branch: 'release/old', commit: 'd'.repeat(64) });
    expect(spies.source).not.toHaveBeenCalled();
  });

  it.each([
    { sourceCommit: 'd'.repeat(40) },
    { sourceBranch: 'develop' },
    { sourceBranch: '-bad', sourceCommit: 'd'.repeat(40) },
    { sourceBranch: 'develop', sourceCommit: 'not-a-sha' },
  ])('denies partial or invalid source pins', async (pins) => {
    const f = await fixture();
    Object.assign(f.state.row, pins);
    expect((await f.invoke()).ok).toBe(false);
    expect(spies.source).not.toHaveBeenCalled();
  });

  it('does not leak raw model/provider errors or request data to logs/responses', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    );
    const f = await fixture();
    for (const code of ['CONNECTION_CHANGED', 'arbitrary-secret-code']) {
      spies.git.mockRejectedValue(
        Object.assign(new Error(`password=${GIT}`), { code, cause: MODEL }),
      );
      const result = await f.invoke();
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(GIT);
      expect(JSON.stringify(result)).not.toContain(MODEL);
      expect(JSON.stringify(result)).not.toContain(
        code === 'arbitrary-secret-code' ? code : 'password',
      );
    }
    expect(logs.every((log) => log.mock.calls.length === 0)).toBe(true);
  });
});
