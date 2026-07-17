// Platform-admin user management (Admin → User Management card).
// Backed by the cognito-users Lambda:
//   GET /admin/users                                — directory + role flags
//   PUT /admin/users/{username}/platform-admin      — grant/revoke the role
// Both endpoints are platform-admin gated on the backend.

import { api } from './api';
import type { CognitoUser } from './projects';

export interface AdminUser extends CognitoUser {
  // Cognito username — the key for group operations (distinct from the sub).
  username: string;
  platformAdmin: boolean;
}

export const adminUsersService = {
  list: () => api.get<AdminUser[]>('/admin/users'),
  setPlatformAdmin: (username: string, isAdmin: boolean) =>
    api.put<{ username: string; platformAdmin: boolean }>(
      `/admin/users/${encodeURIComponent(username)}/platform-admin`,
      { isAdmin },
    ),
};
