import { evaluateSsoRoles, parseRoleConfig } from '../shared/sso-roles.js';

export const handler = async (event) => {
  const attributes = event.request?.userAttributes || {};
  const result = evaluateSsoRoles(attributes, parseRoleConfig());
  if (!result.federated) return event;
  if (!result.admitted) {
    console.warn('[sso-token] federated sign-in denied', {
      provider: result.identity?.providerName,
      reason: result.reason,
    });
    throw new Error('SSO_ACCESS_DENIED');
  }

  event.response = event.response || {};
  event.response.claimsOverrideDetails = {
    claimsToAddOrOverride: {
      'custom:identity_provider': result.identity.providerName,
      'custom:role_source': 'sso',
    },
    groupOverrideDetails: {
      groupsToOverride: result.roles,
    },
  };
  return event;
};
