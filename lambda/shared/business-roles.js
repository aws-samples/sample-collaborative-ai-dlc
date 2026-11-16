// Stable IDs are shared by assignments, the UI catalog, and future permission policies.
export const BUSINESS_ROLES = Object.freeze(
  [
    { id: 'product-owner', name: 'Product Owner / Product Manager' },
    { id: 'business-analyst', name: 'Business Analyst' },
    { id: 'architect', name: 'Architect' },
    { id: 'ux-ui-designer', name: 'UX/UI Designer' },
    { id: 'developer', name: 'Developer' },
    { id: 'qa-tester', name: 'QA / Tester' },
    { id: 'security-compliance', name: 'Security / Compliance' },
    { id: 'operations-devops', name: 'Operations / DevOps' },
    { id: 'delivery-manager', name: 'Delivery Manager' },
  ].map(Object.freeze),
);

const roleIds = new Set(BUSINESS_ROLES.map(({ id }) => id));

const normalizeRoleList = (roles, field) => {
  if (
    !Array.isArray(roles) ||
    roles.length > BUSINESS_ROLES.length ||
    roles.some((role) => !roleIds.has(role))
  ) {
    throw Object.assign(
      new Error(`${field} must be a list of up to nine known business role IDs`),
      {
        statusCode: 400,
      },
    );
  }
  return [...new Set(roles)].toSorted();
};

export const normalizeLocalRoles = (roles) => normalizeRoleList(roles, 'localRoles');
export const normalizeExcludedRoles = (roles) => normalizeRoleList(roles, 'excludedRoles');

/**
 * Validate a business-role mapping saved from the Platform admin UI:
 * known role IDs only, exact non-empty IdP values, duplicates removed.
 * Roles mapped to no values are dropped — a missing entry grants nothing.
 */
export const normalizeRoleMappings = (mappings) => {
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    throw Object.assign(new Error('roleMappings must be an object keyed by business role ID'), {
      statusCode: 400,
    });
  }
  const result = {};
  for (const [roleId, values] of Object.entries(mappings)) {
    if (!roleIds.has(roleId)) {
      throw Object.assign(new Error(`Unknown business role "${roleId}"`), { statusCode: 400 });
    }
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
      throw Object.assign(new Error(`roleMappings.${roleId} must be a list of IdP values`), {
        statusCode: 400,
      });
    }
    const trimmed = values.map((value) => value.trim());
    if (trimmed.some((value) => !value)) {
      throw Object.assign(new Error(`roleMappings.${roleId} must not contain empty values`), {
        statusCode: 400,
      });
    }
    const unique = [...new Set(trimmed)].toSorted();
    if (unique.length > 0) result[roleId] = unique;
  }
  return result;
};

/** Business roles granted by the IdP claim values under the saved mapping (OR across values). */
export const computeSsoBusinessRoles = (claimValues, roleMappings) => {
  const claims = new Set(claimValues || []);
  return Object.entries(roleMappings || {})
    .filter(([, values]) => (values || []).some((value) => claims.has(value)))
    .map(([roleId]) => roleId)
    .toSorted();
};

/**
 * roles in this space = (SSO roles − excluded SSO roles) + roles added in this space.
 * A local assignment stays active even when the same role is excluded from SSO.
 */
export const combineMemberRoles = ({ ssoRoles = [], localRoles = [], excludedRoles = [] }) => {
  const excluded = new Set(excludedRoles);
  return [
    ...new Set([...ssoRoles.filter((role) => !excluded.has(role)), ...localRoles]),
  ].toSorted();
};
