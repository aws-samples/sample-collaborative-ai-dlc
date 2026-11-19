// Deployment backfill of the SSO claims the sign-in trigger records. Cognito
// still holds each federated user's claims from their latest sign-in, so one
// pass copies them for users who have not signed in since the trigger started
// recording. A copy that already exists is never replaced: it comes from a
// sign-in and is at least as recent. Safe to retry.

import { ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ssoClaimsFromAttributes } from '../shared/sso-roles.js';

const attrsToMap = (attributes = []) =>
  Object.fromEntries(attributes.map(({ Name, Value }) => [Name, Value]));

export const backfillSsoClaims = async ({ cognito, userPoolId, store }) => {
  if (!userPoolId) throw new Error('COGNITO_USER_POOL_ID is required');
  let scanned = 0;
  let written = 0;
  let kept = 0;
  let PaginationToken;
  do {
    const page = await cognito.send(
      new ListUsersCommand({ UserPoolId: userPoolId, Limit: 60, PaginationToken }),
    );
    for (const user of page.Users ?? []) {
      scanned += 1;
      const claims = ssoClaimsFromAttributes(attrsToMap(user.Attributes));
      if (!claims) continue;
      if (await store.backfillSsoClaims(claims)) written += 1;
      else kept += 1;
    }
    PaginationToken = page.PaginationToken;
  } while (PaginationToken);
  return { backfilled: true, scanned, written, kept };
};
