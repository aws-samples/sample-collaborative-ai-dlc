import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';

export const AGENT_CREDENTIAL_PROVIDERS = ['bedrock', 'kiro'];
export const AGENT_CREDENTIAL_SOURCES = ['user', 'space', 'platform'];

export const AGENT_CLI_PROVIDER = {
  kiro: 'kiro',
  claude: 'bedrock',
  opencode: 'bedrock',
  codex: 'bedrock',
};

const PROVIDER_CONFIG = {
  bedrock: {
    parameterName: 'bedrock-bearer-token',
    inputField: 'bedrockBearerToken',
    setField: 'bedrockBearerTokenSet',
    envName: 'AWS_BEARER_TOKEN_BEDROCK',
  },
  kiro: {
    parameterName: 'kiro-api-key',
    inputField: 'kiroApiKey',
    setField: 'kiroApiKeySet',
    envName: 'KIRO_API_KEY',
  },
};

const normalizeBase = (base) => String(base || '').replace(/\/+$/, '');

const assertIdentifier = (value, label) => {
  const normalized = String(value || '');
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
};

const assertProvider = (provider) => {
  if (!AGENT_CREDENTIAL_PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported agent credential provider: ${provider}`);
  }
  return provider;
};

const assertSource = (source) => {
  if (!AGENT_CREDENTIAL_SOURCES.includes(source)) {
    throw new Error(`Unsupported agent credential source: ${source}`);
  }
  return source;
};

export const credentialProviderForCli = (cli) => AGENT_CLI_PROVIDER[cli] ?? null;

export const credentialEnvName = (provider) => PROVIDER_CONFIG[assertProvider(provider)].envName;

export const isConfiguredCredentialValue = (value) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized !== '' && normalized !== 'placeholder';
};

export const agentCredentialPath = ({
  base,
  source,
  provider,
  projectId = null,
  userId = null,
}) => {
  const prefix = normalizeBase(base);
  if (!prefix) throw new Error('Agent credential store is not configured');
  const config = PROVIDER_CONFIG[assertProvider(provider)];
  switch (assertSource(source)) {
    case 'platform':
      return `${prefix}/${config.parameterName}`;
    case 'space':
      return `${prefix}/projects/${assertIdentifier(projectId, 'projectId')}/agent-credentials/${
        config.parameterName
      }`;
    case 'user':
      return `${prefix}/users/${assertIdentifier(userId, 'userId')}/agent-credentials/${
        config.parameterName
      }`;
    default:
      throw new Error(`Unsupported agent credential source: ${source}`);
  }
};

export const normalizeCredentialBinding = (binding) => {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const provider = assertProvider(binding.provider);
  const source = assertSource(binding.source);
  return {
    provider,
    source,
    ...(source === 'user' ? { userId: assertIdentifier(binding.userId, 'userId') } : {}),
  };
};

const scopePaths = ({ base, source, projectId, userId }) =>
  Object.fromEntries(
    AGENT_CREDENTIAL_PROVIDERS.map((provider) => [
      provider,
      agentCredentialPath({ base, source, provider, projectId, userId }),
    ]),
  );

const fetchValues = async (ssm, paths) => {
  const names = [...new Set(Object.values(paths))];
  if (names.length === 0) return {};
  const result = await ssm.send(
    new GetParametersCommand({
      Names: names,
      WithDecryption: true,
    }),
  );
  return Object.fromEntries(
    (result.Parameters || []).map((parameter) => [parameter.Name, parameter.Value || '']),
  );
};

export const readCredentialScopeStatus = async (
  ssm,
  { base, source, projectId = null, userId = null },
) => {
  const paths = scopePaths({ base, source, projectId, userId });
  const values = await fetchValues(ssm, paths);
  return Object.fromEntries(
    AGENT_CREDENTIAL_PROVIDERS.map((provider) => [
      PROVIDER_CONFIG[provider].setField,
      isConfiguredCredentialValue(values[paths[provider]]),
    ]),
  );
};

export const writeCredentialScope = async (
  ssm,
  { base, source, projectId = null, userId = null, update = {} },
) => {
  assertSource(source);
  const written = [];
  const cleared = [];
  for (const provider of AGENT_CREDENTIAL_PROVIDERS) {
    const field = PROVIDER_CONFIG[provider].inputField;
    if (typeof update[field] !== 'string') continue;
    const path = agentCredentialPath({ base, source, provider, projectId, userId });
    const value = update[field].trim();
    if (value) {
      await ssm.send(
        new PutParameterCommand({
          Name: path,
          Value: value,
          Type: 'SecureString',
          Overwrite: true,
        }),
      );
      written.push(provider);
      continue;
    }
    if (source === 'platform') {
      await ssm.send(
        new PutParameterCommand({
          Name: path,
          Value: 'placeholder',
          Type: 'SecureString',
          Overwrite: true,
        }),
      );
    } else {
      try {
        await ssm.send(new DeleteParameterCommand({ Name: path }));
      } catch (error) {
        if (error?.name !== 'ParameterNotFound') throw error;
      }
    }
    cleared.push(provider);
  }
  return { saved: true, written, cleared };
};

export const resolveEffectiveCredentialBindings = async (ssm, { base, projectId, userId }) => {
  const sources = {
    user: scopePaths({ base, source: 'user', userId }),
    space: scopePaths({ base, source: 'space', projectId }),
    platform: scopePaths({ base, source: 'platform' }),
  };
  const bindings = {};
  const unresolved = new Set(AGENT_CREDENTIAL_PROVIDERS);
  for (const source of AGENT_CREDENTIAL_SOURCES) {
    const paths = Object.fromEntries(
      [...unresolved].map((provider) => [provider, sources[source][provider]]),
    );
    const values = await fetchValues(ssm, paths);
    for (const provider of unresolved) {
      const path = sources[source][provider];
      if (!isConfiguredCredentialValue(values[path])) continue;
      bindings[provider] = {
        provider,
        source,
        ...(source === 'user' ? { userId: assertIdentifier(userId, 'userId') } : {}),
      };
      unresolved.delete(provider);
    }
    if (unresolved.size === 0) break;
  }
  for (const provider of unresolved) bindings[provider] = null;
  return bindings;
};

export const readCredentialBindingValue = async (ssm, { base, binding, projectId = null }) => {
  const normalized = normalizeCredentialBinding(binding);
  if (!normalized) return '';
  const path = agentCredentialPath({
    base,
    source: normalized.source,
    provider: normalized.provider,
    projectId,
    userId: normalized.userId,
  });
  try {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: path,
        WithDecryption: true,
      }),
    );
    const value = result.Parameter?.Value || '';
    return isConfiguredCredentialValue(value) ? value : '';
  } catch (error) {
    if (error?.name === 'ParameterNotFound') return '';
    throw error;
  }
};

export const credentialSourcesFromBindings = (bindings = {}) => ({
  bedrock: bindings.bedrock?.source ?? null,
  kiro: bindings.kiro?.source ?? null,
});

export const availableClisForBindings = ({ installed = [], bindings = {} } = {}) =>
  installed.filter((cli) => {
    const provider = credentialProviderForCli(cli);
    return provider && bindings[provider];
  });

export default {
  agentCredentialPath,
  availableClisForBindings,
  credentialEnvName,
  credentialProviderForCli,
  credentialSourcesFromBindings,
  isConfiguredCredentialValue,
  normalizeCredentialBinding,
  readCredentialBindingValue,
  readCredentialScopeStatus,
  resolveEffectiveCredentialBindings,
  writeCredentialScope,
};
