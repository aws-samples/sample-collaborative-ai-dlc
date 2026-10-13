// API-side metadata resolution only. The API supplies a consistently read,
// protected READY draft and its authenticated Cognito sub; never request-body
// identity, platform META, runtime state, credential values, or image overrides.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import gremlin from 'gremlin';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { resolveEffectiveCredentialBindingsViaBroker } from '../shared/agent-credential-metadata.js';
import {
  credentialProviderForCli,
  normalizeCredentialBinding,
} from '../shared/agent-credentials.js';
import {
  ACTIVE,
  AUTH_TYPE_PROVIDER,
  appCredentialRef,
  bindingKeyFor,
  canonicalRepo,
  getBinding,
  oauthCredentialRef,
} from '../shared/source-control-bindings.js';
import { workflowSourceIdentity } from '../shared/workflow-source-bindings.js';
import { describeNativePackagePin } from '../shared/native-package-pin.js';
import { mergeCliModels } from '../shared/cli-models.js';
import { mergeTierModels } from '../shared/tier-models.js';
import { resolveStageModel } from '../shared/model-resolver.js';
import { canonicalJson } from '../shared/workflow-checkpoint.js';
import { nativeExecutionConfiguration } from './execution-store.js';
import { ID, UUID, UUID_V4, matches, nativeDraftRequest, pinPackageJob } from './store.js';
import { nativeDraftPrompt } from './draft-prompt.js';

const __ = gremlin.process.statics;
const T = gremlin.process.t;
const MESSAGES = Object.freeze({
  INVALID: 'Native execution configuration is invalid',
  UNAVAILABLE: 'Native execution configuration is unavailable',
  NOT_READY: 'Prepare the native workspace before starting',
  PROMPT_REQUIRED: 'Add a prompt before starting native execution',
  PROJECT_CHANGED: 'The project changed; reload the native intent before starting',
  REPOSITORY_REQUIRED: 'Link one application repository in project source-control settings',
  REPOSITORY_AMBIGUOUS:
    'The first native milestone requires exactly one linked application repository',
  REPOSITORY_INVALID:
    'Set a supported provider and a valid repository identity in project source-control settings',
  SOURCE_CONTROL_REQUIRED:
    'Verify the application repository source-control binding before starting',
  SOURCE_CONTROL_CHANGED: 'The application repository binding changed; reload before starting',
  CREDENTIAL_REQUIRED: 'Configure a credential for the selected coding harness before starting',
  CREDENTIAL_INVALID: 'The selected coding harness credential binding could not be verified',
});

export class NativeExecutionConfigurationError extends Error {
  constructor(suffix = 'INVALID') {
    const safe = Object.hasOwn(MESSAGES, suffix) ? suffix : 'INVALID';
    super(MESSAGES[safe]);
    this.name = 'NativeExecutionConfigurationError';
    this.code = `NATIVE_EXECUTION_CONFIG_${safe}`;
  }
}
const fail = (suffix) => {
  throw new NativeExecutionConfigurationError(suffix);
};
const plain = (value) =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const field = (value, name) => (value instanceof Map ? value.get(name) : value?.[name]);
const single = (value) => {
  if (!Array.isArray(value) || value.length > 1) fail('PROJECT_CHANGED');
  return value[0];
};
export const nativePromptSha256 = (prompt) =>
  createHash('sha256').update(prompt, 'utf8').digest('hex');

// The execution image is deliberately separate from the preparation image:
// an existing draft retains its preparation pins while the controller records
// an explicit upgrade to this deployment's execution-capable image.
export const nativeExecutionDeployment = (env) => {
  const deployment = {
    image: {
      uri: env.NATIVE_EXECUTION_IMAGE_URI,
      digest: env.NATIVE_EXECUTION_IMAGE_DIGEST,
    },
    publicationBucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
    packageBucket: env.NATIVE_PACKAGES_BUCKET,
    accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
  };
  const region = env.AWS_REGION;
  if (
    !matches(deployment.accountId, /^[0-9]{12}$/) ||
    !matches(region, /^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/) ||
    !matches(deployment.image.digest, /^sha256:[a-f0-9]{64}$/) ||
    !matches(
      deployment.image.uri,
      /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/,
    ) ||
    !deployment.image.uri.startsWith(`${deployment.accountId}.dkr.ecr.${region}.`) ||
    !deployment.image.uri.endsWith(`@${deployment.image.digest}`) ||
    deployment.image.uri
      .split('/')
      .slice(1)
      .join('/')
      .split('@')[0]
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    [deployment.publicationBucket, deployment.packageBucket].some(
      (value) =>
        !matches(value, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/) ||
        value.includes('..') ||
        value.includes('.-') ||
        value.includes('-.') ||
        /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(value),
    )
  )
    fail('UNAVAILABLE');
  return deployment;
};

export const nativeExecutionRepository = (provider, repository) => {
  try {
    // The existing strict source identity validator rejects URLs, credentials,
    // traversal, controls and unsupported providers before canonicalRepo.
    const identity = workflowSourceIdentity(provider, repository);
    return {
      provider: identity.provider,
      repository: canonicalRepo(provider, identity.repository),
    };
  } catch {
    fail('REPOSITORY_INVALID');
  }
};

export const assertNativeCodeBinding = (binding, { projectId, provider, repository, revision }) => {
  if (
    !plain(binding) ||
    binding.projectId !== projectId ||
    binding.provider !== provider ||
    binding.status !== ACTIVE ||
    !matches(binding.revision, UUID) ||
    binding.bindingKey !== bindingKeyFor(provider, repository) ||
    binding.purpose === 'workflow-source' ||
    AUTH_TYPE_PROVIDER[binding.authType] !== provider
  )
    fail('SOURCE_CONTROL_REQUIRED');
  const bound = nativeExecutionRepository(binding.provider, binding.repo);
  if (
    bound.repository !== repository ||
    (binding.canonicalRepo !== undefined && binding.canonicalRepo !== repository)
  )
    fail('SOURCE_CONTROL_CHANGED');
  if (revision !== undefined && binding.revision !== revision) fail('SOURCE_CONTROL_CHANGED');
  if (binding.authType === 'github-app') {
    if (
      !matches(String(binding.installationId ?? ''), /^[1-9][0-9]{0,19}$/) ||
      binding.credentialRef !== appCredentialRef(binding.installationId)
    )
      fail('SOURCE_CONTROL_REQUIRED');
  } else if (
    !matches(binding.connectionUserId, ID) ||
    binding.credentialRef !== oauthCredentialRef(provider, binding.connectionUserId)
  )
    fail('SOURCE_CONTROL_REQUIRED');
  return structuredClone(binding);
};

export const readNativeCodeBinding = async (ddb, env, scope) => {
  if (!matches(env.SOURCE_CONTROL_BINDINGS_TABLE, /^[A-Za-z0-9_.-]{3,255}$/)) fail('UNAVAILABLE');
  // getBinding historically reads process.env. Keep injected deployments
  // explicit without mutating process-global environment in a shared API.
  const reader = {
    send(command) {
      if (!(command instanceof GetCommand) || command.input.ConsistentRead !== true)
        fail('INVALID');
      return ddb.send(
        new GetCommand({
          ...command.input,
          TableName: env.SOURCE_CONTROL_BINDINGS_TABLE,
        }),
      );
    },
  };
  const binding = await getBinding(reader, scope.projectId, scope.provider, scope.repository);
  return assertNativeCodeBinding(binding, scope);
};

export const nativePreparedConfigurationPins = (draft) => {
  if (!plain(draft) || draft.status !== 'READY') fail('NOT_READY');
  try {
    const request = nativeDraftRequest(draft.request);
    if (
      !matches(draft.projectId, ID) ||
      !matches(draft.executionId, UUID_V4) ||
      !matches(draft.bindingId, UUID_V4) ||
      request.intentId !== draft.executionId ||
      draft.harness !== request.harness ||
      draft.executionBackend !== 'native' ||
      draft.isolation !== 'execution' ||
      !matches(draft.createdBy, ID) ||
      typeof draft.projectIdentity !== 'string' ||
      !draft.projectIdentity.trim() ||
      draft.requestFingerprint !==
        `sha256:${nativePromptSha256(
          canonicalJson({
            projectId: draft.projectId,
            actorId: draft.createdBy,
            projectIdentity: draft.projectIdentity,
            request,
          }),
        )}`
    )
      fail('INVALID');
    const pin = describeNativePackagePin(draft.candidate.packagePin, draft.candidate.attestation);
    const checked = pinPackageJob(
      {
        state: 'SUCCEEDED',
        projectId: draft.projectId,
        jobId: request.packageJobId,
        sourceId: request.sourceId,
        bindingRevision: request.bindingRevision,
        requestedRelease: draft.candidate.requestedRelease,
        candidate: draft.candidate,
        archiveReceipt: draft.archiveReceipt,
      },
      {
        projectId: draft.projectId,
        request,
        binding: {
          projectId: draft.projectId,
          sourceId: request.sourceId,
          revision: request.bindingRevision,
          ...pin.identity.source,
        },
      },
    );
    if (
      !isDeepStrictEqual(checked.candidate, draft.candidate) ||
      !isDeepStrictEqual(checked.archiveReceipt, draft.archiveReceipt)
    )
      fail('INVALID');
    const prompt = nativeDraftPrompt(draft).text;
    if (!prompt.trim()) fail('PROMPT_REQUIRED');
    return {
      harness: request.harness,
      promptSha256: nativePromptSha256(prompt),
      packageId: pin.packageId,
      materializationId: pin.materializationId,
      source: {
        sourceId: request.sourceId,
        bindingRevision: request.bindingRevision,
        packageJobId: request.packageJobId,
      },
    };
  } catch (error) {
    if (error instanceof NativeExecutionConfigurationError) throw error;
    fail('INVALID');
  }
};

const readProject = async (g, draft) => {
  const rows = await g
    .V()
    .has('Project', 'id', draft.projectId)
    .limit(2)
    .project('projectIdentity', 'cliModels', 'tierModels')
    .by(T.id)
    .by(__.values('cli_models').fold())
    .by(__.values('tier_models').fold())
    .toList();
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    field(rows[0], 'projectIdentity') !== draft.projectIdentity
  )
    fail('PROJECT_CHANGED');
  return {
    cliModels: single(field(rows[0], 'cliModels')),
    tierModels: single(field(rows[0], 'tierModels')),
  };
};
const readRepository = async (g, draft) => {
  const rows = await g
    .V(draft.projectIdentity)
    .out('HAS_REPO')
    .hasLabel('Repository')
    .limit(2)
    .project('repositories', 'providers')
    .by(__.values('url').fold())
    .by(__.values('provider').fold())
    .toList();
  if (!Array.isArray(rows)) fail('REPOSITORY_INVALID');
  if (rows.length === 0) fail('REPOSITORY_REQUIRED');
  if (rows.length !== 1) fail('REPOSITORY_AMBIGUOUS');
  const repositories = field(rows[0], 'repositories');
  const providers = field(rows[0], 'providers');
  if (
    !Array.isArray(repositories) ||
    repositories.length !== 1 ||
    !Array.isArray(providers) ||
    providers.length !== 1
  )
    fail('REPOSITORY_INVALID');
  return nativeExecutionRepository(providers[0], repositories[0]);
};
const readModels = async (ssm, env, name) => {
  const prefix = env.AGENT_SETTINGS_SSM_PREFIX;
  if (!prefix) return {};
  if (!matches(prefix, /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)) fail('UNAVAILABLE');
  try {
    // These are the ONLY SSM reads on the API path. Never decrypt a secret.
    const result = await ssm.send(
      new GetParameterCommand({
        Name: `${prefix}/${name}`,
        WithDecryption: false,
      }),
    );
    return result.Parameter?.Value || '{}';
  } catch {
    // Match current intents' best-effort metadata fallback.
    return {};
  }
};

export const createNativeExecutionConfiguration =
  ({
    ddb,
    ssm,
    graph,
    env = process.env,
    resolveBindings = resolveEffectiveCredentialBindingsViaBroker,
  }) =>
  async ({ draft, actorId }) => {
    try {
      if (!matches(actorId, ID) || !ddb?.send || !ssm?.send) fail('INVALID');
      const deployment = nativeExecutionDeployment(env);
      const pins = nativePreparedConfigurationPins(draft);
      const g = await (typeof graph === 'function' ? graph() : graph);
      if (!g?.V) fail('UNAVAILABLE');
      const project = await readProject(g, draft);
      const repository = await readRepository(g, draft);
      const bindingScope = { projectId: draft.projectId, ...repository };
      const binding = await readNativeCodeBinding(ddb, env, bindingScope);
      const [cliModels, tierModels, bindings] = await Promise.all([
        readModels(ssm, env, 'cli-models'),
        readModels(ssm, env, 'tier-models'),
        resolveBindings(
          { projectId: draft.projectId, userId: actorId },
          { functionName: env.AGENT_CREDENTIAL_METADATA_FUNCTION },
        ),
      ]);
      const provider = credentialProviderForCli(pins.harness);
      if (!bindings?.[provider]) fail('CREDENTIAL_REQUIRED');
      let credentialBinding;
      try {
        credentialBinding = normalizeCredentialBinding(bindings[provider]);
      } catch {
        fail('CREDENTIAL_INVALID');
      }
      if (
        credentialBinding?.provider !== provider ||
        (credentialBinding.source === 'user' && credentialBinding.userId !== actorId)
      )
        fail('CREDENTIAL_INVALID');
      // No agent tier is invented for the native workflow. Flat project/global
      // defaults and the existing legacy fallback apply, then runtime defaults.
      const model =
        resolveStageModel({
          cli: pins.harness,
          cliModels: mergeCliModels(project.cliModels, cliModels),
          tierModels: mergeTierModels(project.tierModels, tierModels),
          env,
        }) ?? null;
      await readProject(g, draft);
      if (!isDeepStrictEqual(await readRepository(g, draft), repository))
        fail('SOURCE_CONTROL_CHANGED');
      const current = await readNativeCodeBinding(ddb, env, {
        ...bindingScope,
        revision: binding.revision,
      });
      if (!isDeepStrictEqual(current, binding)) fail('SOURCE_CONTROL_CHANGED');
      return nativeExecutionConfiguration({
        ...pins,
        model,
        credentialBinding,
        ...deployment,
        repository: { ...repository, branch: null, bindingRevision: binding.revision },
      });
    } catch (error) {
      if (error instanceof NativeExecutionConfigurationError) throw error;
      fail('UNAVAILABLE');
    }
  };
