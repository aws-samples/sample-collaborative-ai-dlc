import catalog from './business-role-catalog.json' with { type: 'json' };

// Also read by Terraform and the SSO setup script to validate infrastructure mappings.
export const BUSINESS_ROLES = Object.freeze(catalog.map(Object.freeze));

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

// Shared by stage block authoring and workflow placements, without loading
// the workflow policy evaluator into the block CRUD service.
export const normalizeStagePermissions = (permissions) => {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions))
    throw Object.assign(new Error('permissions must contain business role lists'), {
      statusCode: 400,
    });
  if (permissions.automatic !== undefined && typeof permissions.automatic !== 'boolean')
    throw Object.assign(new Error('permissions.automatic must be a boolean'), { statusCode: 400 });
  return {
    decisionMakerRoles: normalizeRoleList(permissions.decisionMakerRoles, 'decisionMakerRoles'),
    contributorRoles: normalizeRoleList(permissions.contributorRoles, 'contributorRoles'),
    ...(permissions.automatic === true ? { automatic: true } : {}),
  };
};

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

/**
 * Keep the infrastructure baseline and UI additions distinct, even when a value
 * belongs to both. Only roleMappings is persisted; the union is calculated on read.
 */
export const businessRoleMappingView = (provider, roleMappings = {}) => {
  const terraformRoleMappings = normalizeRoleMappings(
    Object.fromEntries(
      Object.entries(provider?.roleMappings || {}).filter(([roleId]) => roleIds.has(roleId)),
    ),
  );
  const effectiveRoleMappings = normalizeRoleMappings(
    Object.fromEntries(
      BUSINESS_ROLES.map(({ id }) => [
        id,
        [...(terraformRoleMappings[id] || []), ...(roleMappings[id] || [])],
      ]),
    ),
  );
  return { roleMappings, terraformRoleMappings, effectiveRoleMappings };
};

/** Business roles granted by IdP claim values under the effective mapping (OR across values). */
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
