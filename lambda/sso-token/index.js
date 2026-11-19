import { Logger } from '@aws-lambda-powertools/logger';
import { evaluateSsoRoles, parseRoleConfig, ssoClaimsFromAttributes } from '../shared/sso-roles.js';
import { membershipStore } from '../shared/space-membership.js';

const logger = new Logger({ persistentKeys: { component: 'sso-token' } });

// A refresh does not contact the identity provider, so the claims are those of
// the sign-in that started the session and are already recorded.
const REFRESH_SOURCE = 'TokenGeneration_RefreshTokens';

export const createHandler =
  ({ store = membershipStore } = {}) =>
  async (event, context) => {
    if (context) logger.addContext(context);
    const attributes = event.request?.userAttributes || {};
    const result = evaluateSsoRoles(attributes, parseRoleConfig());
    if (!result.federated) return event;

    // Record before admission: a user who lost the required claim must not
    // keep the business roles of an earlier sign-in. A failed write fails the
    // sign-in rather than leaving a stale copy unnoticed.
    if (event.triggerSource !== REFRESH_SOURCE) {
      const claims = ssoClaimsFromAttributes(attributes);
      if (!claims) throw new Error('Federated user attributes are incomplete');
      await store.recordSsoClaims(claims);
    }

    if (!result.admitted) {
      logger.warn('federated sign-in denied', {
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

export const handler = createHandler();
