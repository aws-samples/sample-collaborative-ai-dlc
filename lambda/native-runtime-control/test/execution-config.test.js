import { describe, expect, it, vi } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { createNativeExecutionConfiguration, nativePromptSha256 } from '../execution-config.js';
import { nativeExecutionConfiguration } from '../execution-store.js';
import { prepareBinding } from '../../shared/source-control-bindings.js';
import {
  ACTOR,
  IDENTITY,
  MEMBERSHIP,
  OTHER,
  PROJECT,
  createInput,
  owner,
  request,
  resources,
  setup,
} from './fixtures.js';

const IMAGE = {
  uri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentcore@sha256:${'b'.repeat(64)}`,
  digest: `sha256:${'b'.repeat(64)}`,
};
const environment = () => ({
  AWS_REGION: 'us-east-1',
  NATIVE_RUNTIME_ACCOUNT_ID: '123456789012',
  NATIVE_EXECUTION_IMAGE_URI: IMAGE.uri,
  NATIVE_EXECUTION_IMAGE_DIGEST: IMAGE.digest,
  NATIVE_EXECUTION_PUBLICATION_BUCKET: 'native-publications-dev',
  NATIVE_PACKAGES_BUCKET: 'native-packages-dev',
  SOURCE_CONTROL_BINDINGS_TABLE: 'application-source-bindings-dev',
  AGENT_SETTINGS_SSM_PREFIX: '/aidlc/dev',
  AGENT_CREDENTIAL_METADATA_FUNCTION: 'credential-metadata-dev',
});
const fixture = async ({
  harness = 'codex',
  provider = 'github',
  repository = 'JWThewes/flappy-bird',
} = {}) => {
  const preparation = setup();
  const created = await preparation.store.create(createInput({ request: request({ harness }) }));
  await preparation.store.prepare(IDENTITY);
  const { row: owned } = await preparation.store.claim({
    ...IDENTITY,
    bindingId: created.row.bindingId,
  });
  const draft = await preparation.store.ready({ ...owner(owned), resources: resources(owned) });
  const state = {
    draft,
    env: environment(),
    project: {
      projectIdentity: MEMBERSHIP.projectIdentity,
      cliModels: [],
      tierModels: [],
    },
    repos: [{ providers: [provider], repositories: [repository] }],
    binding: prepareBinding({
      projectId: PROJECT,
      provider,
      repo: repository,
      authType: `${provider}-oauth`,
      credentialRef: `oauth#${provider}#repo-owner`,
      connectionUserId: 'repo-owner',
      capabilities: { repositoryWrite: true },
    }),
    globals: {},
    bindings: {
      bedrock: { provider: 'bedrock', source: 'user', userId: ACTOR },
      kiro: { provider: 'kiro', source: 'space' },
    },
  };
  const graph = {
    V: vi.fn((id) => {
      const chain = {};
      for (const name of ['has', 'limit', 'project', 'by', 'out', 'hasLabel']) {
        chain[name] = vi.fn(() => chain);
      }
      chain.toList = vi.fn(async () => {
        await state.graphHook?.(id);
        return structuredClone(
          id === undefined ? (state.project ? [state.project] : []) : state.repos,
        );
      });
      return chain;
    }),
  };
  const ddb = {
    send: vi.fn(async (command) => {
      expect(command).toBeInstanceOf(GetCommand);
      expect(command.input).toMatchObject({
        TableName: state.env.SOURCE_CONTROL_BINDINGS_TABLE,
        ConsistentRead: true,
        Key: { projectId: PROJECT, bindingKey: `${provider}#${repository.toLowerCase()}` },
      });
      await state.bindingHook?.();
      return { Item: structuredClone(state.binding) };
    }),
  };
  const ssm = {
    send: vi.fn(async (command) => {
      expect(command).toBeInstanceOf(GetParameterCommand);
      expect(command.input.WithDecryption).toBe(false);
      expect(['/aidlc/dev/cli-models', '/aidlc/dev/tier-models']).toContain(command.input.Name);
      await state.modelHook?.();
      return { Parameter: { Value: state.globals[command.input.Name] ?? '{}' } };
    }),
  };
  const resolveBindings = vi.fn(async () => {
    await state.metadataHook?.();
    return state.bindings;
  });
  const resolve = (input = {}) =>
    createNativeExecutionConfiguration({
      ddb,
      ssm,
      graph,
      env: state.env,
      resolveBindings,
    })({ draft: state.draft, actorId: ACTOR, ...input });
  return { ...state, state, ddb, ssm, graph, resolveBindings, resolve };
};

describe('native first-turn configuration', () => {
  it('pins only explicit protected metadata, using the starter and deployment execution image', async () => {
    const f = await fixture();
    const result = await f.resolve();
    expect(result).toEqual({
      harness: 'codex',
      model: null,
      promptSha256: nativePromptSha256(f.draft.request.prompt),
      packageId: f.draft.candidate.packagePin.packageId,
      materializationId: f.draft.candidate.materializationId,
      source: {
        sourceId: f.draft.request.sourceId,
        bindingRevision: f.draft.request.bindingRevision,
        packageJobId: f.draft.request.packageJobId,
      },
      repository: {
        provider: 'github',
        repository: 'jwthewes/flappy-bird',
        branch: null,
        bindingRevision: f.binding.revision,
      },
      credentialBinding: { provider: 'bedrock', source: 'user', userId: ACTOR },
      image: IMAGE,
      publicationBucket: 'native-publications-dev',
      packageBucket: 'native-packages-dev',
      accountId: '123456789012',
    });
    expect(nativeExecutionConfiguration(result)).toEqual(result);
    expect(result.image.digest).not.toBe(f.draft.imageDigest);
    expect(f.resolveBindings).toHaveBeenCalledWith(
      { projectId: PROJECT, userId: ACTOR },
      { functionName: 'credential-metadata-dev' },
    );
    expect(JSON.stringify(result)).not.toContain('credentialRef');
    expect(JSON.stringify(result)).not.toContain(f.draft.request.prompt);
    expect(f.ssm.send).toHaveBeenCalledTimes(2);
    expect(f.ddb.send).toHaveBeenCalledTimes(2);
    expect(f.graph.V).toHaveBeenCalledWith(MEMBERSHIP.projectIdentity);
  });

  it.each(['user', 'space', 'platform'])(
    'retains the effective %s metadata binding without resolving secrets',
    async (source) => {
      const f = await fixture();
      f.state.bindings.bedrock = {
        provider: 'bedrock',
        source,
        ...(source === 'user' ? { userId: ACTOR } : {}),
      };
      expect((await f.resolve()).credentialBinding).toEqual(f.state.bindings.bedrock);
    },
  );

  it.each([
    ['codex', 'bedrock', 'openai.configured'],
    ['claude', 'bedrock', 'us.anthropic.configured'],
    ['opencode', 'bedrock', 'amazon-bedrock/us.anthropic.configured'],
    ['kiro', 'kiro', 'auto'],
  ])(
    'selects the %s provider and model independently of other harness defaults',
    async (harness, provider, model) => {
      const f = await fixture({ harness });
      f.state.globals['/aidlc/dev/cli-models'] = JSON.stringify({ [harness]: model });
      const result = await f.resolve();
      expect(result).toMatchObject({ harness, model, credentialBinding: { provider } });
      expect(result.credentialBinding).toEqual(f.state.bindings[provider]);
    },
  );

  it.each(['kiro', 'codex'])(
    'keeps an unset %s model null despite Bedrock environment defaults',
    async (harness) => {
      const f = await fixture({ harness });
      f.state.env.AGENT_MODEL = 'us.anthropic.only-for-bedrock';
      expect((await f.resolve()).model).toBeNull();
    },
  );

  it('retains the current Claude alias/environment fallback', async () => {
    const f = await fixture({ harness: 'claude' });
    f.state.env.AGENT_MODEL = 'opus';
    f.state.env.AIDLC_MODEL_ALIASES = JSON.stringify({ opus: 'anthropic.configured-alias' });
    expect((await f.resolve()).model).toBe('us.anthropic.configured-alias');
  });

  it.each([
    ['github', 'Owner/Repository'],
    ['gitlab', 'Group/Nested/Repository'],
    ['bitbucket', 'Workspace/Repository'],
  ])(
    'pins an active %s repository binding with provider-default branch left explicit',
    async (provider, repository) => {
      const f = await fixture({ provider, repository });
      expect((await f.resolve()).repository).toEqual({
        provider,
        repository: repository.toLowerCase(),
        branch: null,
        bindingRevision: f.state.binding.revision,
      });
    },
  );

  it('uses a collaborator starter instead of the original draft author', async () => {
    const f = await fixture();
    f.state.bindings.bedrock.userId = 'collaborator';
    expect((await f.resolve({ actorId: 'collaborator' })).credentialBinding.userId).toBe(
      'collaborator',
    );
    expect(f.resolveBindings.mock.calls[0][0].userId).toBe('collaborator');
  });

  it.each([
    ['none', null, 'CREDENTIAL_REQUIRED'],
    [
      'other user',
      { provider: 'bedrock', source: 'user', userId: 'other-member' },
      'CREDENTIAL_INVALID',
    ],
    ['wrong provider', { provider: 'kiro', source: 'space' }, 'CREDENTIAL_INVALID'],
    ['invalid source', { provider: 'bedrock', source: 'reselected' }, 'CREDENTIAL_INVALID'],
  ])('rejects %s credential metadata', async (_label, binding, code) => {
    const f = await fixture();
    f.state.bindings.bedrock = binding;
    await expect(f.resolve()).rejects.toMatchObject({ code: `NATIVE_EXECUTION_CONFIG_${code}` });
  });

  it.each([
    [
      'project beats global',
      { codex: 'openai.project' },
      { codex: 'openai.global' },
      {},
      {},
      'openai.project',
    ],
    ['global fills absent project', {}, { codex: 'openai.global' }, {}, {}, 'openai.global'],
    ['empty project inherits', { codex: '' }, { codex: 'openai.global' }, {}, {}, 'openai.global'],
    [
      'flat beats fallback',
      { codex: 'openai.flat' },
      {},
      { fallback: { codex: 'openai.fallback' } },
      {},
      'openai.flat',
    ],
    [
      'project fallback beats global fallback',
      {},
      {},
      { fallback: { codex: 'openai.project' } },
      { fallback: { codex: 'openai.global' } },
      'openai.project',
    ],
    ['no invented agent tier', {}, {}, { judgment: { codex: 'openai.tier' } }, {}, null],
  ])('resolves models: %s', async (_label, project, global, tiers, globalTiers, expected) => {
    const f = await fixture();
    f.state.project.cliModels = [JSON.stringify(project)];
    f.state.project.tierModels = [JSON.stringify(tiers)];
    f.state.globals['/aidlc/dev/cli-models'] = JSON.stringify(global);
    f.state.globals['/aidlc/dev/tier-models'] = JSON.stringify(globalTiers);
    expect((await f.resolve()).model).toBe(expected);
  });

  it('falls back on unavailable/malformed metadata but never reads credential SSM paths', async () => {
    const f = await fixture();
    f.state.modelHook = () => {
      throw new Error('private transport information');
    };
    expect((await f.resolve()).model).toBeNull();
    expect(f.ssm.send.mock.calls.map(([command]) => command.input.Name).toSorted()).toEqual([
      '/aidlc/dev/cli-models',
      '/aidlc/dev/tier-models',
    ]);
  });

  it.each([
    ['no repository', [], 'REPOSITORY_REQUIRED'],
    [
      'multiple repositories',
      [
        { providers: ['github'], repositories: ['a/one'] },
        { providers: ['github'], repositories: ['b/two'] },
      ],
      'REPOSITORY_AMBIGUOUS',
    ],
    ['missing provider', [{ providers: [], repositories: ['a/one'] }], 'REPOSITORY_INVALID'],
    [
      'URL',
      [{ providers: ['github'], repositories: ['https://evil.example/a/one'] }],
      'REPOSITORY_INVALID',
    ],
    ['traversal', [{ providers: ['github'], repositories: ['a/..'] }], 'REPOSITORY_INVALID'],
    [
      'unsupported host',
      [{ providers: ['self-hosted'], repositories: ['a/one'] }],
      'REPOSITORY_INVALID',
    ],
  ])('fails actionably for %s without guessing', async (_label, repositories, code) => {
    const f = await fixture();
    f.state.repos = repositories;
    await expect(f.resolve()).rejects.toMatchObject({ code: `NATIVE_EXECUTION_CONFIG_${code}` });
    expect(f.resolveBindings).not.toHaveBeenCalled();
  });

  it.each([
    [
      'not ready',
      (f) => {
        f.state.draft.status = 'PREPARING';
      },
    ],
    [
      'changed prompt',
      (f) => {
        f.state.draft.request.prompt += 'tampering';
      },
    ],
    [
      'changed package',
      (f) => {
        f.state.draft.candidate.packagePin.packageId = `sha256:${'0'.repeat(64)}`;
      },
    ],
    [
      'wrong project',
      (f) => {
        f.state.draft.projectId = OTHER;
      },
    ],
    [
      'wrong physical project',
      (f) => {
        f.state.project.projectIdentity = 'recreated';
      },
    ],
    [
      'missing project',
      (f) => {
        f.state.project = null;
      },
    ],
    [
      'bad binding revision',
      (f) => {
        delete f.state.binding.revision;
      },
    ],
    [
      'inactive binding',
      (f) => {
        f.state.binding.status = 'invalid';
      },
    ],
    [
      'foreign binding project',
      (f) => {
        f.state.binding.projectId = OTHER;
      },
    ],
    [
      'binding owner mismatch',
      (f) => {
        f.state.binding.credentialRef = 'oauth#github#someone-else';
      },
    ],
    [
      'foreign image account',
      (f) => {
        f.state.env.NATIVE_EXECUTION_IMAGE_URI = IMAGE.uri.replace('123456789012', '999999999999');
      },
    ],
    [
      'foreign image region',
      (f) => {
        f.state.env.NATIVE_EXECUTION_IMAGE_URI = IMAGE.uri.replace('us-east-1', 'eu-west-1');
      },
    ],
    [
      'image tag',
      (f) => {
        f.state.env.NATIVE_EXECUTION_IMAGE_URI = IMAGE.uri.split('@')[0] + ':latest';
      },
    ],
    [
      'missing publication bucket',
      (f) => {
        delete f.state.env.NATIVE_EXECUTION_PUBLICATION_BUCKET;
      },
    ],
  ])('fails closed for %s', async (_label, mutate) => {
    const f = await fixture();
    mutate(f);
    await expect(f.resolve()).rejects.toHaveProperty('code');
  });

  it.each(['project', 'repository', 'binding', 'cliModels', 'tierModels'])(
    'fences a %s change during slow metadata resolution',
    async (kind) => {
      const f = await fixture();
      f.state.metadataHook = () => {
        if (kind === 'project') f.state.project.projectIdentity = 'recreated';
        if (kind === 'repository') f.state.repos[0].repositories = ['other/repo'];
        if (kind === 'binding') f.state.binding.revision = OTHER;
        if (kind === 'cliModels') f.state.project.cliModels = ['{"codex":"openai.changed"}'];
        if (kind === 'tierModels')
          f.state.project.tierModels = ['{"fallback":{"codex":"openai.changed"}}'];
      };
      await expect(f.resolve()).rejects.toHaveProperty('code');
    },
  );

  it('captures new project/global choices before Start without mutating an earlier snapshot', async () => {
    const f = await fixture();
    f.state.globals['/aidlc/dev/cli-models'] = '{"codex":"openai.first"}';
    const first = await f.resolve();
    f.state.globals['/aidlc/dev/cli-models'] = '{"codex":"openai.second"}';
    expect((await f.resolve()).model).toBe('openai.second');
    f.state.project.cliModels = ['{"codex":"openai.project"}'];
    expect((await f.resolve()).model).toBe('openai.project');
    expect(first.model).toBe('openai.first');
    expect(nativeExecutionConfiguration(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it('does not import platform environment, MCP, rules, tier selection or debug preferences', async () => {
    const f = await fixture();
    const first = await f.resolve();
    // The project query deliberately projects only native model-map owners.
    f.state.project.environmentId = 'managed-other';
    f.state.project.agentCli = 'claude';
    f.state.project.customMcpServers = '{"server":"private"}';
    f.state.project.customRules = ['private-rule.md'];
    f.state.globals['/aidlc/dev/derive-enrichment'] = 'llm';
    f.state.globals['/aidlc/dev/native-debug-archives-enabled'] = 'true';
    f.state.globals['/aidlc/dev/custom-mcp-servers'] = '{"server":"private"}';
    expect(await f.resolve()).toEqual(first);
    expect(f.ssm.send.mock.calls.map(([c]) => c.input.Name)).toEqual([
      '/aidlc/dev/cli-models',
      '/aidlc/dev/tier-models',
      '/aidlc/dev/cli-models',
      '/aidlc/dev/tier-models',
    ]);
  });

  it('does not expose raw dependency errors in API errors', async () => {
    const f = await fixture();
    f.state.metadataHook = () => {
      throw new Error('super-secret-token');
    };
    await expect(f.resolve()).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_CONFIG_UNAVAILABLE',
      message: 'Native execution configuration is unavailable',
    });
    expect(f.draft).toMatchObject(IDENTITY);
  });
});
