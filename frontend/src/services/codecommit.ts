import { api } from './api';
import type { GitRepo } from './gitProvider';

// CodeCommit connect flow (the `codecommit-role` auth type). No OAuth: the
// tenant creates an IAM role in the repository account and trusts the platform
// with the caller's external id. The backend mints that id once per user and
// resolves it from the user's connection on every call; the UI only displays it
// and never sends it back. Everything the UI needs to walk a user through the
// handshake comes from three routes on the codecommit Lambda.

export interface CodeCommitConnectInfo {
  externalId: string;
  principals: string[];
  trustPolicy: Record<string, unknown>;
}

export interface CodeCommitRoleConnection {
  roleArn: string;
  // Display only: the caller's own external id, rendered in the trust policy.
  externalId: string;
  region: string;
}

export interface CodeCommitRepo extends GitRepo {
  arn: string;
  accountId: string;
  region: string;
}

export interface CodeCommitRepoList {
  accountId: string;
  region: string;
  repositories: CodeCommitRepo[];
}

// Regions where CodeCommit is offered (GA return, Nov 2025). Kept as a plain
// list for the region picker; the backend validates the shape, not membership,
// so a region missing here can still be typed in.
export const CODECOMMIT_REGIONS: readonly string[] = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-south-1',
  'ap-east-1',
  'sa-east-1',
  'me-south-1',
  'me-central-1',
  'af-south-1',
  'il-central-1',
];

export const CODECOMMIT_EXTERNAL_ID_PATTERN = /^aidlc:[0-9a-f-]{36}$/;
export const IAM_ROLE_ARN_PATTERN =
  /^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;

export const codecommitService = {
  // The caller's external id (stable across calls) and the trust policy to
  // paste on the tenant role.
  connectInfo: () => api.get<CodeCommitConnectInfo>('/codecommit/connect-info'),

  // Proves the handshake (trust policy + the caller's external id) and lists
  // what the role can see in the region. A 424 means the trust policy is not in
  // place yet. The external id is resolved server-side, never sent.
  listRepos: ({ roleArn, region }: Pick<CodeCommitRoleConnection, 'roleArn' | 'region'>) =>
    api.post<CodeCommitRepoList>('/codecommit/repos', { roleArn, region }),
};
