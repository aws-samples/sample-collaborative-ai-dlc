const decodeValue = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeClaimEntry = (value) => {
  const decoded = decodeValue(String(value).trim()).trim();
  if (!decoded) return '';
  try {
    const parsed = JSON.parse(decoded);
    if (typeof parsed === 'string') return parsed.trim();
  } catch {
    // Plain claim values are not JSON strings.
  }
  return decoded;
};

const uniqueClaimEntries = (values) => [
  ...new Set(values.map(normalizeClaimEntry).filter(Boolean)),
];

/**
 * Cognito flattens multi-valued IdP claims into an encoded bracket form.
 * Accept that representation as well as arrays and JSON arrays so tests and
 * future trigger versions use the same normalization.
 */
export const parseClaimValues = (raw) => {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return uniqueClaimEntries(raw);
  if (typeof raw !== 'string') return [];

  const value = raw.trim();
  if (!value) return [];
  const decoded = decodeValue(value);
  for (const candidate of new Set([value, decoded])) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parseClaimValues(parsed);
    } catch {
      // Cognito's unquoted bracket form is not JSON.
    }
  }

  const bracketed =
    value.startsWith('[') && value.endsWith(']')
      ? value
      : decoded.startsWith('[') && decoded.endsWith(']')
        ? decoded
        : null;
  if (bracketed) {
    return uniqueClaimEntries(bracketed.slice(1, -1).split(','));
  }
  return uniqueClaimEntries([value]);
};

export const parseFederatedIdentity = (raw) => {
  if (!raw) return null;
  try {
    const identities = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(identities) || identities.length === 0) return null;
    const identity = identities[0];
    const providerName = String(identity?.providerName || '').trim();
    if (!providerName) return null;
    return {
      providerName,
      providerType: String(identity?.providerType || '').trim(),
      providerUserId: String(identity?.userId || '').trim(),
    };
  } catch {
    return null;
  }
};

export const parseRoleConfig = (raw = process.env.SSO_ROLE_CONFIG) => {
  if (!raw) return { providers: {} };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.providers === 'object' ? parsed : { providers: {} };
  } catch {
    throw new Error('SSO role configuration is invalid JSON');
  }
};

export const evaluateSsoRoles = (attributes, config = parseRoleConfig()) => {
  const identity = parseFederatedIdentity(attributes?.identities);
  if (!identity) {
    return {
      federated: false,
      admitted: true,
      identity: null,
      claimValues: [],
      roles: [],
    };
  }

  const provider = config.providers?.[identity.providerName];
  if (!provider) {
    return {
      federated: true,
      admitted: false,
      identity,
      claimValues: [],
      roles: [],
      reason: 'provider-not-configured',
    };
  }

  const claimValues = parseClaimValues(attributes?.['custom:sso_roles']);
  const claimSet = new Set(claimValues);
  const roles = Object.entries(provider.roleMappings || {})
    .filter(([, values]) => values.some((value) => claimSet.has(value)))
    .map(([role]) => role)
    .toSorted();
  const required = provider.requiredClaimValues || [];
  const admitted = required.length === 0 || required.some((value) => claimSet.has(value));

  return {
    federated: true,
    admitted,
    identity,
    claimValues,
    roles,
    reason: admitted ? null : 'required-claim-missing',
  };
};
