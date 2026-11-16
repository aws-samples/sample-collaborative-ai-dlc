// Platform-admin SSO business-role mappings (Admin → Users tab).
// Backed by the cognito-users Lambda:
//   GET /admin/sso-mappings                 — connections + saved mappings + catalog
//   PUT /admin/sso-mappings/{providerId}    — save one connection's mapping
// Both endpoints are platform-admin gated on the backend. Mappings map a
// business role to the exact IdP values (groups, roles, or IDs) received
// through the connection's configured source attribute.

import { api } from './api';
import type { BusinessRole } from './projects';

export interface SsoMappingProvider {
  providerId: string;
  displayName: string;
  /** The OIDC claim / SAML attribute the connection reads (claims.roles). Empty when SSO setup is incomplete. */
  sourceAttribute: string;
  roleMappings: Record<string, string[]>;
  /** Revision of the loaded mapping; echoed back on save so a stale save is rejected instead of overwriting newer edits. Null before the first save. */
  revision: string | null;
}

export interface SsoMappingsResponse {
  providers: SsoMappingProvider[];
  businessRoles: BusinessRole[];
}

export const ssoRoleMappingsService = {
  get: () => api.get<SsoMappingsResponse>('/admin/sso-mappings'),
  save: (
    providerId: string,
    roleMappings: Record<string, string[]>,
    expectedRevision: string | null,
  ) =>
    api.put<{ providerId: string; roleMappings: Record<string, string[]>; revision: string }>(
      `/admin/sso-mappings/${encodeURIComponent(providerId)}`,
      { roleMappings, expectedRevision },
    ),
};
