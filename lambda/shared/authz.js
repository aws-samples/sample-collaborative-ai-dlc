// Platform-admin authorization helper.
//
// Platform-wide settings (agent settings, tracker OAuth apps, GitHub auth
// mode, migrations) must only be mutable by members of the Cognito
// `platform-admin` group (terraform/modules/auth/main.tf). API Gateway's
// Cognito user-pool authorizer flattens token claims into strings, so the
// `cognito:groups` claim arrives in one of several shapes depending on the
// token/serialization path:
//
//   - a real array (some proxy/test events):        ['platform-admin', 'member']
//   - a JSON array string:                          '["platform-admin","member"]'
//   - API GW's bracket form (space separated):      '[platform-admin member]'
//   - a comma-joined string:                        'platform-admin,member'
//
// parseGroups normalizes all of these. Fail closed: missing/unparseable
// claims mean "no groups".

const PLATFORM_ADMIN_GROUP = 'platform-admin';

/**
 * Normalize the `cognito:groups` claim into an array of group names.
 * @param {unknown} raw
 * @returns {string[]}
 */
const parseGroups = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((g) => String(g).trim()).filter(Boolean);
  if (typeof raw !== 'string') return [];
  let value = raw.trim();
  if (!value) return [];
  if (value.startsWith('[') && value.endsWith(']')) {
    // Try strict JSON first ('["a","b"]'), then API GW's bracket form ('[a b]').
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((g) => String(g).trim()).filter(Boolean);
      }
    } catch {
      // fall through to bracket-form handling
    }
    value = value.slice(1, -1);
  }
  return value
    .split(/[,\s]+/)
    .map((g) => g.trim())
    .filter(Boolean);
};

/**
 * Extract the caller's Cognito groups from an API Gateway proxy event.
 * @param {object} event
 * @returns {string[]}
 */
const getGroups = (event) =>
  parseGroups(event?.requestContext?.authorizer?.claims?.['cognito:groups']);

/**
 * True when the caller is a member of the platform-admin group.
 * @param {object} event
 * @returns {boolean}
 */
const isPlatformAdmin = (event) => getGroups(event).includes(PLATFORM_ADMIN_GROUP);

/**
 * Guard for admin-only routes. Returns null when the caller is authorized,
 * otherwise a `{ statusCode, body }` descriptor the route should convert into
 * its provider-specific response (via buildResponse).
 *
 * @param {object} event
 * @returns {{ statusCode: number, error: string, code: string } | null}
 */
const requirePlatformAdmin = (event) => {
  if (isPlatformAdmin(event)) return null;
  return {
    statusCode: 403,
    error: 'Platform administrator access required',
    code: 'PLATFORM_ADMIN_REQUIRED',
  };
};

export { PLATFORM_ADMIN_GROUP, parseGroups, getGroups, isPlatformAdmin, requirePlatformAdmin };
export default {
  PLATFORM_ADMIN_GROUP,
  parseGroups,
  getGroups,
  isPlatformAdmin,
  requirePlatformAdmin,
};
