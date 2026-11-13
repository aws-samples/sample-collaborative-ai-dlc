import {
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  GetRolePolicyCommand,
  ListRolePoliciesCommand,
  ListAttachedRolePoliciesCommand,
} from '@aws-sdk/client-iam';
import { CreateAliasCommand, GetAliasCommand } from '@aws-sdk/client-lambda';
import { nativeReviewerAlias, engineFailure } from '../../shared/native-workflow-protocol.js';
import { samePolicy } from '../policies.js';

const absent = (error) => ['NoSuchEntity', 'ResourceNotFoundException'].includes(error?.name);
const conflict = (error) =>
  ['EntityAlreadyExists', 'ResourceConflictException'].includes(error?.name);
const fail = () => {
  throw engineFailure('NATIVE_ENGINE_REVIEW_ROLE_MISMATCH');
};
export const nativeReviewRolePolicy = ({ credentialAlias, repositoryArn }) => ({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'PullQualifiedImage',
      Effect: 'Allow',
      Action: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      Resource: repositoryArn,
    },
    { Sid: 'EcrLogin', Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
    {
      Sid: 'OwnModelCredential',
      Effect: 'Allow',
      Action: 'lambda:InvokeFunction',
      Resource: credentialAlias,
    },
  ],
});

// These roles have no source credentials, storage or engine authority. A
// review receives only its own input/output S3 capabilities. Existing aliases
// and roles are checked, never silently retargeted or widened.
export const createNativeReviewRole =
  ({ iam, lambda, env, authorize }) =>
  async (identity) => {
    const aliasName = nativeReviewerAlias(identity);
    const functionArn = env.NATIVE_EXECUTION_CREDENTIALS_FUNCTION;
    const version = env.NATIVE_EXECUTION_CREDENTIALS_VERSION;
    const boundary = env.NATIVE_WORKFLOW_REVIEW_BOUNDARY;
    if (!functionArn || !/^[1-9][0-9]*$/.test(version ?? '') || !boundary) fail();
    const aliasArn = `${functionArn}:${aliasName}`;
    await authorize();
    let alias;
    try {
      alias = await lambda.send(
        new GetAliasCommand({ FunctionName: functionArn, Name: aliasName }),
      );
    } catch (error) {
      if (!absent(error)) throw error;
      await authorize();
      try {
        await lambda.send(
          new CreateAliasCommand({
            FunctionName: functionArn,
            Name: aliasName,
            FunctionVersion: version,
            Description: 'Captured native reviewer credential boundary',
          }),
        );
      } catch (creation) {
        if (!conflict(creation)) throw creation;
      }
      alias = await lambda.send(
        new GetAliasCommand({ FunctionName: functionArn, Name: aliasName }),
      );
    }
    if (
      alias.AliasArn !== aliasArn ||
      alias.FunctionVersion !== version ||
      Object.keys(alias.RoutingConfig?.AdditionalVersionWeights ?? {}).length
    )
      fail();
    const roleName = `native_${aliasName}`;
    const path = env.NATIVE_WORKFLOW_REVIEW_ROLE_PATH ?? '/';
    const roleArn = `arn:${env.AWS_PARTITION || 'aws'}:iam::${env.NATIVE_RUNTIME_ACCOUNT_ID}:role${path}${roleName}`;
    const trust = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'codebuild.amazonaws.com' },
          Action: 'sts:AssumeRole',
          Condition: {
            StringEquals: { 'aws:SourceAccount': env.NATIVE_RUNTIME_ACCOUNT_ID },
            ArnEquals: { 'aws:SourceArn': env.NATIVE_WORKFLOW_JOB_PROJECT_ARN },
          },
        },
      ],
    };
    const policy = nativeReviewRolePolicy({
      credentialAlias: aliasArn,
      repositoryArn: env.NATIVE_WORKFLOW_IMAGE_REPOSITORY_ARN,
    });
    let role;
    try {
      role = (await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role;
    } catch (error) {
      if (!absent(error)) throw error;
      await authorize();
      try {
        await iam.send(
          new CreateRoleCommand({
            RoleName: roleName,
            Path: path,
            PermissionsBoundary: boundary,
            AssumeRolePolicyDocument: JSON.stringify(trust),
            Tags: [{ Key: 'NativeWorkflowReviewer', Value: aliasName }],
          }),
        );
      } catch (creation) {
        if (!conflict(creation)) throw creation;
      }
      role = (await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role;
    }
    if (
      role?.Arn !== roleArn ||
      role.PermissionsBoundary?.PermissionsBoundaryArn !== boundary ||
      !samePolicy(role.AssumeRolePolicyDocument, trust)
    )
      fail();
    const [attached, inline] = await Promise.all([
      iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName })),
      iam.send(new ListRolePoliciesCommand({ RoleName: roleName })),
    ]);
    if (
      attached.IsTruncated ||
      attached.AttachedPolicies?.length ||
      inline.IsTruncated ||
      inline.PolicyNames?.some((name) => name !== 'native-review')
    )
      fail();
    let existing;
    try {
      existing = await iam.send(
        new GetRolePolicyCommand({ RoleName: roleName, PolicyName: 'native-review' }),
      );
    } catch (error) {
      if (!absent(error)) throw error;
    }
    if (existing) {
      if (!samePolicy(existing.PolicyDocument, policy)) fail();
    } else {
      await authorize();
      await iam.send(
        new PutRolePolicyCommand({
          RoleName: roleName,
          PolicyName: 'native-review',
          PolicyDocument: JSON.stringify(policy),
        }),
      );
      const observed = await iam.send(
        new GetRolePolicyCommand({ RoleName: roleName, PolicyName: 'native-review' }),
      );
      if (!samePolicy(observed.PolicyDocument, policy)) fail();
    }
    await authorize();
    return { roleArn, credentialAlias: aliasArn };
  };
