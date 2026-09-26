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
// The external ID is minted once per user (codecommit-connection.js) and copied
// onto each binding at verification. This is the standard confused-deputy guard:
// a repository owner's trust policy admits only the external ID they were shown
// while connecting, the platform resolves that ID from the caller's own
// connection (never from a request), and at runtime presents only the one
// stored on the binding it is serving, so a third party cannot list or bind
// that role ARN from their own project.
import { randomUUID } from 'node:crypto';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { parseCodeCommitRepo } from './git-providers/codecommit-repo.js';

const SESSION_DURATION_SECONDS = 900; // STS minimum; ample for one git op or API burst.
const ROLE_ARN = /^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;

// External ID handed to the tenant for their role trust policy. Minted once per
// user (not derived from the project: the trust policy must exist before the
// project does, since repository discovery already needs the role) and stored
// on the binding like a GitHub App installation id. The confused-deputy
// guarantee is that the platform only ever presents an external id it resolved
// itself, never one supplied at request time.
const EXTERNAL_ID_PREFIX = 'aidlc:';
const EXTERNAL_ID = /^aidlc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const newCodeCommitExternalId = () => `${EXTERNAL_ID_PREFIX}${randomUUID()}`;

export const isCodeCommitExternalId = (value) => EXTERNAL_ID.test(String(value ?? '').trim());

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

// The permissions policy a tenant attaches to their role: exactly what the
// session policies can ask for, never more. ListRepositories only accepts
// Resource "*" (it lists names and ids, nothing else); every other action,
// BatchGetRepositories included, is limited to the repositories the space may
// use. No codecommit:* : the platform never creates, renames or deletes a
// repository, and the role should not allow it either.
// https://docs.aws.amazon.com/codecommit/latest/userguide/auth-and-access-control-permissions-reference.html
const REPOSITORY_PLACEHOLDER = 'arn:aws:codecommit:<region>:<account-id>:<repository-name>';
const REPOSITORY_ACTIONS = [
  'codecommit:BatchGetRepositories',
  'codecommit:GitPull',
  'codecommit:GitPush',
  ...READ_API_ACTIONS,
  ...WRITE_API_ACTIONS,
];

export const codeCommitPermissionsPolicy = ({
  repositoryArns = [REPOSITORY_PLACEHOLDER],
} = {}) => ({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'ListRepositoriesInAccount',
      Effect: 'Allow',
      Action: 'codecommit:ListRepositories',
      Resource: '*',
    },
    {
      Sid: 'UseSelectedRepositories',
      Effect: 'Allow',
      Action: REPOSITORY_ACTIONS,
      Resource: repositoryArns.length === 1 ? repositoryArns[0] : repositoryArns,
    },
  ],
});

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
  externalId,
  repoArn = null,
  access = 'write',
  executionId = null,
  durationSeconds = SESSION_DURATION_SECONDS,
}) => {
  if (!isCodeCommitRoleArn(roleArn)) {
    throw Object.assign(new Error('Invalid IAM role ARN'), { code: 'BINDING_INVALID' });
  }
  if (!isCodeCommitExternalId(externalId)) {
    throw Object.assign(new Error('Invalid CodeCommit external ID'), { code: 'BINDING_INVALID' });
  }
  const policy = codeCommitSessionPolicy({ repoArn, access });
  let result;
  try {
    result = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: sessionName(executionId),
        ExternalId: externalId,
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
    expiration: c.Expiration ? new Date(c.Expiration) : undefined,
    assumedRoleArn: result.AssumedRoleUser?.Arn || null,
  };
};

// The trust policy a tenant must attach to their role. Rendered for the UI so
// the operator copies exact JSON instead of reconstructing it from prose.
// `principals` are the platform execution roles that assume tenant roles: the
// credential broker (runtime git + API), the source-control API (bind-time
// verification and project operations) and the codecommit API (repository
// discovery while connecting).
export const codeCommitTrustPolicy = ({ principals, externalId }) => {
  const list = [principals].flat().filter(Boolean);
  if (list.length === 0) throw new Error('At least one platform principal is required');
  if (!isCodeCommitExternalId(externalId)) throw new Error('Invalid CodeCommit external ID');
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowCollaborativeAIDLC',
        Effect: 'Allow',
        Principal: { AWS: list.length === 1 ? list[0] : list },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'sts:ExternalId': externalId } },
      },
    ],
  };
};

export { READ_API_ACTIONS, WRITE_API_ACTIONS, SESSION_DURATION_SECONDS };

export default {
  newCodeCommitExternalId,
  isCodeCommitExternalId,
  isCodeCommitRoleArn,
  roleAccountId,
  codeCommitSessionPolicy,
  assumeCodeCommitRole,
  codeCommitTrustPolicy,
  codeCommitPermissionsPolicy,
};
