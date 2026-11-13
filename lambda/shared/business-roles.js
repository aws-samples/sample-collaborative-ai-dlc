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

export const normalizeLocalRoles = (roles) => {
  if (
    !Array.isArray(roles) ||
    roles.length > BUSINESS_ROLES.length ||
    roles.some((role) => !roleIds.has(role))
  ) {
    throw Object.assign(
      new Error('localRoles must be a list of up to nine known business role IDs'),
      {
        statusCode: 400,
      },
    );
  }
  return [...new Set(roles)].toSorted();
};
