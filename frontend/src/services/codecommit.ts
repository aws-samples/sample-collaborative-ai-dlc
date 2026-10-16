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
  // The permissions policy, with region and account filled in (tag variant;
  // the setup guide also shows the explicit-ARN alternative).
  permissionsPolicy: Record<string, unknown>;
  // The saved connection, or null when nothing is configured yet.
  roleArn: string | null;
  region: string | null;
}

export interface CodeCommitAdminConfigUpdate {
  roleArn: string;
  region: string;
}

// CodeCommit regions the platform can reach (same list as the backend's
// CODECOMMIT_REGIONS; the backend stays the authority and rejects any other on
// save). China/GovCloud are other partitions the platform roles cannot assume
// into, so they are not offered.
export const CODECOMMIT_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'sa-east-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-north-1',
  'eu-south-1',
  'il-central-1',
  'me-south-1',
  'me-central-1',
  'af-south-1',
  'ap-east-1',
  'ap-south-1',
  'ap-south-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
] as const;

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
