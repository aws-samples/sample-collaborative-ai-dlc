import { readFileSync } from 'node:fs';
import { isAuthorized } from '@cedar-policy/cedar-wasm/nodejs';
import { fetchMembershipRole } from './space-membership.js';

// The policy lives in policies/space.cedar, resolved beside this module or
// beside a Lambda bundle (scripts/package-cedar.mjs copies it). A missing file
// fails at load time rather than granting anything.
export const SPACE_POLICY_URL = new URL('./policies/space.cedar', import.meta.url);
const policies = { staticPolicies: readFileSync(SPACE_POLICY_URL, 'utf8') };

const evaluateRole = (membershipRole) => {
  const principal = { type: 'User', id: 'caller' };
  const entities = [
    { uid: principal, attrs: { membershipRole: membershipRole || '' }, parents: [] },
  ];
  return Object.fromEntries(
    ['read', 'write', 'manage'].map((action) => {
      const answer = isAuthorized({
        principal,
        action: { type: 'Action', id: action },
        resource: { type: 'Space', id: 'space' },
        context: {},
        policies,
        entities,
      });
      if (answer.type !== 'success' || answer.response.diagnostics.errors.length) {
        throw new Error('Space permission evaluation failed');
      }
      return [action, answer.response.decision === 'allow'];
    }),
  );
};

// This policy depends only on membershipRole. Evaluate each fixed role once in
// the service, not three WASM calls per keystroke. Membership itself is NEVER
// cached: callers must still read it consistently before selecting a decision.
const decisions = new Map(
  ['owner', 'member', 'viewer', ''].map((role) => [role, Object.freeze(evaluateRole(role))]),
);
export const spacePermissions = (membershipRole) =>
  decisions.get(membershipRole) ?? decisions.get('');

export const fetchSpacePermissions = async (g, spaceId, userId) => {
  const role = await fetchMembershipRole(g, spaceId, userId);
  return { role, permissions: spacePermissions(role) };
};

export const VIEWER_DENIED = {
  error: 'You have view-only access to this space.',
  code: 'SPACE_WRITE_FORBIDDEN',
};
