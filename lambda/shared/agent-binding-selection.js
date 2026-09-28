import { assertScopeAvailable } from './agent-auth-inventory.js';
import {
  authError,
  normalizeRequestedProviders,
  credentialChangeAffects,
} from './agent-auth-contracts.js';
import { AUTH_SELECTION_STRATEGIES } from './agent-auth-selection-strategies.js';
export { connectionBinding } from './agent-auth-selection-strategies.js';

// Called inside the metadata broker: key set-state and control records are read
// there, never by callers that have no secret-read permission.
export const resolvePolicyBindings = async ({
  repository,
  resolveLegacy,
  projectId,
  userId,
  reserve = false,
  providers,
  strategies = AUTH_SELECTION_STRATEGIES,
}) => {
  const requested = normalizeRequestedProviders(providers);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const policy = await repository.getPolicy();
    const legacyBindings = await resolveLegacy(requested);
    const bindings = Object.fromEntries(
      requested.map((provider) => [provider, legacyBindings[provider] ?? null]),
    );
    if (requested.includes('bedrock')) {
      const strategy = strategies[policy.mode];
      if (!strategy)
        throw authError('AGENT_AUTH_MODE_UNAVAILABLE', 'Authentication provider has not shipped');
      const spaceSelection = projectId ? await repository.getSpaceSelection(projectId) : null;
      bindings.bedrock = await strategy({
        policy,
        legacyBindings: bindings,
        spaceSelection,
        projectId,
        userId,
        repository,
      });
    }
    if (policy.pendingReview) {
      const pending = await repository.getReview(policy.pendingReview);
      if (
        Object.values(bindings).some((binding) =>
          credentialChangeAffects(pending?.candidate, binding, projectId),
        )
      ) {
        throw authError(
          'AGENT_AUTH_CHANGE_IN_PROGRESS',
          'The selected credential is being updated; retry after its reviewed change finishes',
        );
      }
    }
    await assertScopeAvailable({
      repository,
      bindings: Object.values(bindings).filter(Boolean),
      projectId,
    });
    // An absent/cleared legacy credential stays absent; never invent readiness.
    try {
      if (reserve) await repository.claimSelection(policy.revision, { projectId, bindings });
      else if ((await repository.getPolicy()).revision !== policy.revision) continue;
      return bindings;
    } catch (error) {
      if (
        !['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(error?.name)
      )
        throw error;
    }
  }
  throw authError(
    'AGENT_AUTH_POLICY_CHANGED',
    'Authentication policy changed during selection; retry the operation',
  );
};
