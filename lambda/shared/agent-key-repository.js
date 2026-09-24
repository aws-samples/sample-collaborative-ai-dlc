import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersCommand,
  PutParameterCommand,
  DescribeParametersCommand,
} from '@aws-sdk/client-ssm';

import {
  AGENT_CREDENTIAL_PROVIDERS,
  AGENT_CREDENTIAL_SOURCES,
  KEY_PROVIDERS as PROVIDER_CONFIG,
  assertIdentifier,
  assertProvider,
  assertSource,
  normalizeCredentialBinding,
  isConfiguredCredentialValue,
  withoutTrailingSlashes,
} from './agent-auth-catalog.js';

const normalizeBase = (base) => withoutTrailingSlashes(String(base || ''));

export const listCredentialScopes = async (ssm, { base }) => {
  const prefix = `${normalizeBase(base)}/`;
  if (prefix === '/') throw new Error('Agent credential store is not configured');
  const scopes = new Map([['platform', { source: 'platform' }]]);
  let NextToken;
  do {
    const result = await ssm.send(
      new DescribeParametersCommand({
        ParameterFilters: [{ Key: 'Name', Option: 'BeginsWith', Values: [prefix] }],
        NextToken,
      }),
    );
    for (const parameter of result.Parameters ?? []) {
      const match =
        /^(users|projects)\/([A-Za-z0-9._-]+)\/agent-credentials\/(bedrock-bearer-token|kiro-api-key)$/.exec(
          parameter.Name?.slice(prefix.length),
        );
      if (!match || !parameter.Name.startsWith(prefix)) continue;
      const [, collection, id] = match;
      scopes.set(
        `${collection}:${id}`,
        collection === 'users'
          ? { source: 'user', userId: id }
          : { source: 'space', projectId: id },
      );
    }
    NextToken = result.NextToken;
  } while (NextToken);
  const records = [];
  for (const [id, scope] of scopes) {
    records.push({
      id,
      type: 'CredentialScope',
      ...scope,
      credentialStatus: await readCredentialScopeStatus(ssm, { base, ...scope }),
    });
  }
  return records;
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

const scopePaths = ({ base, source, projectId, userId }) =>
  Object.fromEntries(
    AGENT_CREDENTIAL_PROVIDERS.map((provider) => [
      provider,
      agentCredentialPath({ base, source, provider, projectId, userId }),
    ]),
  );

const deleteParameterIfPresent = async (ssm, path) => {
  try {
    await ssm.send(new DeleteParameterCommand({ Name: path }));
    return true;
  } catch (error) {
    if (error?.name === 'ParameterNotFound') return false;
    throw error;
  }
};

// Broker-only read path. API Lambdas call the metadata broker and deliberately
// have no ssm:GetParameter(s) permission on agent credential paths.
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
      await deleteParameterIfPresent(ssm, path);
    }
    cleared.push(provider);
  }
  return { saved: true, written, cleared };
};

export const deleteCredentialScope = async (
  ssm,
  { base, source, projectId = null, userId = null },
) => {
  const normalizedSource = assertSource(source);
  if (normalizedSource === 'platform') {
    throw new Error('Platform agent credentials cannot be deleted as a scope');
  }
  const deleted = [];
  const missing = [];
  for (const provider of AGENT_CREDENTIAL_PROVIDERS) {
    const path = agentCredentialPath({
      base,
      source: normalizedSource,
      provider,
      projectId,
      userId,
    });
    if (await deleteParameterIfPresent(ssm, path)) deleted.push(provider);
    else missing.push(provider);
  }
  return { deleted, missing };
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
