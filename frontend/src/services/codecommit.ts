import { api } from './api';

// CodeCommit is one platform connection, owned by a platform admin: a single
// IAM role in the repository account that trusts the platform principals with
// the deployment's external ID. Space creators never see IAM — they pick a
// provider and repositories like every other provider (the repo list comes
// from the generic path in services/gitProvider.ts).
//
// This module owns the admin-only configuration routes (platform-admin gated
// on the backend). The external ID is minted once per deployment and only ever
// displayed; the UI never sends it back.

export interface CodeCommitAdminConfig {
  // Platform execution-role ARNs the tenant role must trust. Admin-only: never
  // returned to a non-admin (the status route carries no principals).
  principals: string[];
  // The deployment's external ID ("aidlc:<uuid>"), rendered into the trust
  // policy. Display only.
  externalId: string;
  // The trust policy to paste on the role, with the external ID filled in.
  trustPolicy: Record<string, unknown>;
  // The permissions policy (tag variant) with <region> and <account-id>
  // placeholders; the admin card fills them from the values being typed.
  permissionsPolicy: Record<string, unknown>;
  // Regions the platform can reach (the backend's list, so they cannot drift).
  regions: string[];
  // The saved connection, or null when nothing is configured yet.
  roleArn: string | null;
  region: string | null;
}

export interface CodeCommitAdminConfigUpdate {
  roleArn: string;
  region: string;
}

export const IAM_ROLE_ARN_PATTERN =
  /^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;

export const codecommitAdminService = {
  // Current connection + the policies and principals the admin needs. 403 for a
  // non-admin (the backend gates it; this route is only reached from the
  // admin-only Platform Admin page).
  getConfig: () => api.get<CodeCommitAdminConfig>('/codecommit/admin/config'),

  // Test the role and region, then save. The backend assumes the role with the
  // platform external ID and runs one ListRepositories before writing. On a
  // trust failure it returns 424 and writes nothing; the fresh config is
  // returned on success.
  updateConfig: (update: CodeCommitAdminConfigUpdate) =>
    api.put<CodeCommitAdminConfig>('/codecommit/admin/config', update),
};
