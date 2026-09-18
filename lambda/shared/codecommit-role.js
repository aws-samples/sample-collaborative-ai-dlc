// CodeCommit role-based access — the `codecommit-role` auth type.
//
// Mirrors the `github-app` shape: no user OAuth, the platform mints a
// short-lived credential just in time. Here the tenant creates an IAM role in
// the account that owns the repository and trusts the platform's broker role
// with an external ID; the broker assumes it per request with a SESSION POLICY
// narrowed to one repository ARN and the actions the request needs. The
// effective permission is the intersection of the tenant role's policy and the
// session policy, so a generous tenant role is still clamped per call.
//
// The external ID is derived from the project id. This is the standard
// confused-deputy guard: a repository owner's trust policy admits only the
// external ID of the project they meant to connect, so a third party cannot
// bind that role ARN from their own project.
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { parseCodeCommitRepo } from './git-providers/codecommit-repo.js';

const SESSION_DURATION_SECONDS = 900; // STS minimum; ample for one git op or API burst.
const ROLE_ARN = /^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;

export const codeCommitExternalId = (projectId) => {
  if (!projectId || typeof projectId !== 'string') throw new Error('projectId is required');
  return `aidlc:${projectId}`;
};

export const isCodeCommitRoleArn = (value) => ROLE_ARN.test(String(value ?? '').trim());

export const roleAccountId = (roleArn) => {
  const match = /^arn:[^:]+:iam::(\d{12}):role\//.exec(String(roleArn ?? ''));
  return match ? match[1] : null;
};

// API actions the platform itself performs through the provider module, split
// by the access level the caller asked for. Names are IAM action names, all of
// which accept a repository ARN as Resource
// (https://docs.aws.amazon.com/codecommit/latest/userguide/auth-and-access-control-permissions-reference.html).
const READ_API_ACTIONS = [
  'codecommit:GetRepository',
  'codecommit:GetBranch',
  'codecommit:ListBranches',
  'codecommit:GetFolder',
  'codecommit:GetFile',
  'codecommit:GetBlob',
  'codecommit:GetCommit',
  'codecommit:GetDifferences',
  'codecommit:GetMergeOptions',
  'codecommit:GetMergeCommit',
  'codecommit:GetMergeConflicts',
  'codecommit:ListPullRequests',
  'codecommit:GetPullRequest',
  'codecommit:GetCommentsForPullRequest',
  'codecommit:DescribePullRequestEvents',
  'codecommit:EvaluatePullRequestApprovalRules',
  'codecommit:GetPullRequestApprovalStates',
];

const WRITE_API_ACTIONS = [
  'codecommit:CreatePullRequest',
  'codecommit:UpdatePullRequestStatus',
  'codecommit:UpdatePullRequestTitle',
  'codecommit:UpdatePullRequestDescription',
  'codecommit:PostCommentForPullRequest',
  'codecommit:PostCommentReply',
  'codecommit:MergeBranchesByFastForward',
  'codecommit:MergeBranchesBySquash',
  'codecommit:MergeBranchesByThreeWay',
  'codecommit:MergePullRequestByFastForward',
  'codecommit:MergePullRequestBySquash',
  'codecommit:MergePullRequestByThreeWay',
  'codecommit:DeleteBranch',
];

// Session policy for one repository. `access`:
//   'read'     — git pull + read API
//   'write'    — read + git push + PR/merge/branch API
//   'discover' — ListRepositories/BatchGetRepositories only (Resource must be
//                "*" for ListRepositories per the permissions reference); used
//                once, when the tenant picks a repository to bind.
export const codeCommitSessionPolicy = ({ repoArn, access = 'write' }) => {
  if (access === 'discover') {
    return {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DiscoverRepositories',
          Effect: 'Allow',
          Action: ['codecommit:ListRepositories', 'codecommit:BatchGetRepositories'],
          Resource: '*',
        },
      ],
    };
  }
  const { arn } = parseCodeCommitRepo(repoArn);
  if (!arn) throw new Error('A repository ARN is required for a scoped session policy');
  const statements = [
    { Sid: 'GitRead', Effect: 'Allow', Action: ['codecommit:GitPull'], Resource: arn },
    { Sid: 'ApiRead', Effect: 'Allow', Action: READ_API_ACTIONS, Resource: arn },
  ];
  if (access === 'write') {
    statements.push(
      { Sid: 'GitWrite', Effect: 'Allow', Action: ['codecommit:GitPush'], Resource: arn },
      { Sid: 'ApiWrite', Effect: 'Allow', Action: WRITE_API_ACTIONS, Resource: arn },
    );
  } else if (access !== 'read') {
    throw new Error(`Unsupported CodeCommit access level: ${access}`);
  }
  return { Version: '2012-10-17', Statement: statements };
};

// RoleSessionName: 2–64 chars of [\w+=,.@-]. Keep it attributable in CloudTrail.
const sessionName = (executionId) => {
  const suffix = String(executionId || 'bind')
    .replace(/[^\w+=,.@-]/g, '-')
    .slice(0, 40);
  return `aidlc-${suffix}`.slice(0, 64);
};

// Assume the tenant role. Returns { accessKeyId, secretAccessKey, sessionToken,
// expiration, assumedRoleArn }. Errors are rethrown with a stable `code` so the
// broker can classify them without leaking STS message text.
export const assumeCodeCommitRole = async ({
  sts,
  roleArn,
  projectId,
  repoArn,
  access = 'write',
  executionId = null,
  durationSeconds = SESSION_DURATION_SECONDS,
}) => {
  if (!isCodeCommitRoleArn(roleArn)) {
    throw Object.assign(new Error('Invalid IAM role ARN'), { code: 'BINDING_INVALID' });
  }
  const policy = codeCommitSessionPolicy({ repoArn, access });
  let result;
  try {
    result = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: sessionName(executionId),
        ExternalId: codeCommitExternalId(projectId),
        DurationSeconds: durationSeconds,
        Policy: JSON.stringify(policy),
      }),
    );
  } catch (error) {
    const name = error?.name || '';
    const code =
      name === 'AccessDenied' || name === 'AccessDeniedException'
        ? 'ROLE_ASSUMPTION_DENIED'
        : name === 'MalformedPolicyDocumentException' || name === 'PackedPolicyTooLargeException'
          ? 'SESSION_POLICY_INVALID'
          : 'ROLE_ASSUMPTION_FAILED';
    throw Object.assign(new Error('Unable to assume the CodeCommit access role'), {
      code,
      cause: error,
    });
  }
  const c = result?.Credentials;
  if (!c?.AccessKeyId || !c?.SecretAccessKey || !c?.SessionToken) {
    throw Object.assign(new Error('STS returned an incomplete credential'), {
      code: 'ROLE_ASSUMPTION_FAILED',
    });
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration ? new Date(c.Expiration).toISOString() : null,
    assumedRoleArn: result.AssumedRoleUser?.Arn || null,
  };
};

// The trust policy a tenant must attach to their role. Rendered for the UI so
// the operator copies exact JSON instead of reconstructing it from prose.
export const codeCommitTrustPolicy = ({ brokerRoleArn, projectId }) => ({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AllowCollaborativeAIDLCBroker',
      Effect: 'Allow',
      Principal: { AWS: brokerRoleArn },
      Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'sts:ExternalId': codeCommitExternalId(projectId) } },
    },
  ],
});

export { READ_API_ACTIONS, WRITE_API_ACTIONS, SESSION_DURATION_SECONDS };

export default {
  codeCommitExternalId,
  isCodeCommitRoleArn,
  roleAccountId,
  codeCommitSessionPolicy,
  assumeCodeCommitRole,
  codeCommitTrustPolicy,
};
