// Gateway-grant and execution/repository checks shared by the services that
// act on an execution's repositories for the runtime (credential broker,
// source-control runtime alias). Pure: callers verify the grant and load the
// execution record themselves.

import { GatewayGrantError } from './gateway-grant.js';
import { canonicalRepo } from './source-control-bindings.js';
import { repoUrl, repoProvider } from './repo-provider.js';

export const ENGINE_GRANT_MODES = Object.freeze(['execution', 'stage', 'conflict']);

export const gatewayScopeDenied = () =>
  new GatewayGrantError('GATEWAY_GRANT_SCOPE_MISMATCH', 'Gateway grant does not match the request');

export const assertEngineGrantFor = (grant, { executionId, projectId }) => {
  if (
    !ENGINE_GRANT_MODES.includes(grant?.mode) ||
    executionId !== grant.executionId ||
    projectId !== grant.projectId
  ) {
    throw gatewayScopeDenied();
  }
  return grant;
};

export const assertGatewayExecution = (grant, execution) => {
  if (
    !execution ||
    execution.projectId !== grant.projectId ||
    execution.intentId !== grant.intentId
  ) {
    throw gatewayScopeDenied();
  }
};

export const executionIncludesRepository = (meta, provider, repository) => {
  if (!meta || !provider || !repository) return false;
  let requested;
  try {
    requested = canonicalRepo(provider, repository);
  } catch {
    return false;
  }
  return (meta.repos ?? []).some((repo) => {
    const expectedProvider = repoProvider(repo, meta?.gitProvider, meta?.repoProviders);
    if (expectedProvider !== provider) return false;
    try {
      return canonicalRepo(provider, repoUrl(repo)) === requested;
    } catch {
      return false;
    }
  });
};
