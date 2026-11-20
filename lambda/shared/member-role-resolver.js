import {
  businessRoleMappingView,
  combineMemberRoles,
  computeSsoBusinessRoles,
} from './business-roles.js';
import { evaluateSsoClaims, parseRoleConfig } from './sso-roles.js';
import { membershipStore } from './space-membership.js';

// SSO business roles come from the claims recorded at each member's latest
// federated sign-in, plus the infrastructure baseline and saved additions for
// the provider. Admission uses the current configuration, like the sign-in
// trigger. Claim and mapping reads are memoized across members within one
// request; read failures propagate as errors instead of degrading to empty
// role lists.
export const createSsoRoleResolver = ({ store = membershipStore } = {}) => {
  const config = parseRoleConfig();
  const ssoEnabled = Object.keys(config.providers || {}).length > 0;
  const mappings = new Map();
  const claims = new Map();
  const mappingFor = async (providerId) => {
    if (!mappings.has(providerId)) {
      mappings.set(
        providerId,
        store
          .getRoleMappings(providerId)
          .then(
            (additions) =>
              businessRoleMappingView(config.providers[providerId], additions)
                .effectiveRoleMappings,
          ),
      );
    }
    return mappings.get(providerId);
  };
  const forUser = async (userId) => {
    if (!ssoEnabled) return [];
    if (!claims.has(userId)) claims.set(userId, store.getSsoClaims(userId));
    const recorded = await claims.get(userId);
    // No copy: the member has not signed in through SSO, so no SSO roles.
    if (!recorded) return [];
    // Values only count under the source attribute they were mapped from. A
    // removed or changed source invalidates the copy until the next sign-in,
    // so values from the old attribute never match the current mappings.
    const sourceAttribute = config.providers?.[recorded.providerName]?.roleClaim;
    if (!sourceAttribute || recorded.sourceAttribute !== sourceAttribute) return [];
    const result = evaluateSsoClaims(
      {
        identity: { providerName: recorded.providerName },
        claimValues: recorded.claimValues || [],
      },
      config,
    );
    if (!result.admitted) return [];
    return computeSsoBusinessRoles(
      result.claimValues,
      await mappingFor(result.identity.providerName),
    );
  };
  return {
    forUser,
    forMembers: async (userIds) => {
      const roles = new Map();
      for (const id of userIds) roles.set(id, await forUser(id));
      return roles;
    },
  };
};

// Resolve the whole space before applying fallback rules. The membership store
// reads strongly consistently; failed claim or mapping reads must propagate.
export const resolveSpaceMemberRoles = async ({
  spaceId,
  store = membershipStore,
  resolveRoles,
}) => {
  const members = [];
  let token;
  do {
    const page = await store.listMembers(spaceId, token);
    for (let offset = 0; offset < page.items.length; offset += 5) {
      members.push(
        ...(await Promise.all(
          page.items.slice(offset, offset + 5).map(async (member) => {
            if (!['owner', 'member', 'viewer'].includes(member.membershipRole))
              throw new Error('Invalid space membership');
            const ssoRoles = await resolveRoles.forUser(member.userId);
            return {
              ...member,
              effectiveRoles: combineMemberRoles({
                ssoRoles,
                localRoles: member.localRoles || [],
                excludedRoles: member.excludedRoles || [],
              }),
            };
          }),
        )),
      );
    }
    token = page.nextToken;
  } while (token);
  return members;
};
