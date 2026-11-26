import { createHash } from 'node:crypto';
import { nativeRuntimeResourceNames } from '../shared/native-runtime-binding.js';

export const controlError = (code) => Object.assign(new Error(code), { code });
const sort = (item) =>
  Array.isArray(item)
    ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(
          Object.keys(item)
            .toSorted()
            .map((key) => [key, sort(item[key])]),
        )
      : item;
export const canonicalJson = (value) => JSON.stringify(sort(value));
export const document = (value) =>
  typeof value === 'string' ? JSON.parse(decodeURIComponent(value)) : value;
export const sameDocument = (left, right) =>
  canonicalJson(document(left)) === canonicalJson(document(right));

export const validateDeployment = (deployment) => {
  const d = deployment ?? {};
  if (
    !/^\d{12}$/.test(d.accountId ?? '') ||
    !/^aws(?:-[a-z]+)*$/.test(d.partition ?? '') ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(d.region ?? '') ||
    !/^fs-[0-9a-f]{8}(?:[0-9a-f]{9})?$/.test(d.fileSystemId ?? '') ||
    !/^sha256:[0-9a-f]{64}$/.test(d.imageDigest ?? '') ||
    typeof d.imageUri !== 'string' ||
    !d.imageUri.endsWith(`@${d.imageDigest}`) ||
    !d.imageUri.startsWith(`${d.accountId}.dkr.ecr.${d.region}.`) ||
    !new RegExp(
      `^arn:${d.partition}:ecr:${d.region}:${d.accountId}:repository/[a-z0-9][a-z0-9._/-]*$`,
    ).test(d.ecrRepositoryArn ?? '') ||
    !new RegExp(`^arn:${d.partition}:iam::${d.accountId}:policy/[A-Za-z0-9_+=,.@/-]+$`).test(
      d.permissionsBoundaryArn ?? '',
    ) ||
    !Array.isArray(d.subnetIds) ||
    !d.subnetIds.length ||
    !d.subnetIds.every((id) => /^subnet-[0-9a-f]+$/.test(id)) ||
    !Array.isArray(d.securityGroupIds) ||
    !d.securityGroupIds.length ||
    !d.securityGroupIds.every((id) => /^sg-[0-9a-f]+$/.test(id))
  ) {
    throw controlError('native_deployment_invalid');
  }
  const repository = d.ecrRepositoryArn.split(':repository/')[1];
  const suffix = d.partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
  if (
    d.imageUri !== `${d.accountId}.dkr.ecr.${d.region}.${suffix}/${repository}@${d.imageDigest}`
  ) {
    throw controlError('native_deployment_invalid');
  }
  return Object.freeze({
    ...d,
    subnetIds: [...new Set(d.subnetIds)].toSorted(),
    securityGroupIds: [...new Set(d.securityGroupIds)].toSorted(),
  });
};

export const runtimePolicyDocuments = ({ deployment, identity, accessPointArn }) => {
  const d = validateDeployment(deployment);
  const names = nativeRuntimeResourceNames(identity);
  const prefix = `arn:${d.partition}`;
  const fsArn = `${prefix}:elasticfilesystem:${d.region}:${d.accountId}:file-system/${d.fileSystemId}`;
  if (
    !new RegExp(
      `^${prefix}:elasticfilesystem:${d.region}:${d.accountId}:access-point/fsap-[0-9a-f]{17}$`,
    ).test(accessPointArn ?? '')
  ) {
    throw controlError('native_access_point_mismatch');
  }
  const runtimePrefix = `${prefix}:bedrock-agentcore:${d.region}:${d.accountId}:runtime/${names.runtimeName}-`;
  const logs = `${prefix}:logs:${d.region}:${d.accountId}:log-group:/aws/bedrock-agentcore/runtimes/${names.runtimeName}-*`;
  return {
    names,
    roleArn: `${prefix}:iam::${d.accountId}:role/native-runs/${names.roleName}`,
    fileSystemArn: fsArn,
    runtimePrefix,
    trustPolicy: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Service: `bedrock-agentcore.${d.partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com'}`,
          },
          Action: 'sts:AssumeRole',
          Condition: {
            StringEquals: { 'aws:SourceAccount': d.accountId },
            ArnLike: { 'aws:SourceArn': `${runtimePrefix}*` },
          },
        },
      ],
    },
    permissionsPolicy: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DiscoverOwnWorkspace',
          Effect: 'Allow',
          Action: [
            'elasticfilesystem:DescribeAccessPoints',
            'elasticfilesystem:DescribeMountTargets',
          ],
          Resource: [fsArn, accessPointArn],
        },
        {
          Sid: 'MountOwnWorkspace',
          Effect: 'Allow',
          Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
          Resource: fsArn,
          Condition: {
            ArnEquals: { 'elasticfilesystem:AccessPointArn': accessPointArn },
            Bool: {
              'aws:SecureTransport': 'true',
              'elasticfilesystem:AccessedViaMountTarget': 'true',
            },
          },
        },
        {
          Sid: 'DenyOtherWorkspaceMounts',
          Effect: 'Deny',
          Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
          Resource: '*',
          Condition: { ArnNotEquals: { 'elasticfilesystem:AccessPointArn': accessPointArn } },
        },
        {
          Sid: 'DenyRootAccess',
          Effect: 'Deny',
          Action: 'elasticfilesystem:ClientRootAccess',
          Resource: '*',
        },
        {
          Sid: 'PullRuntimeImage',
          Effect: 'Allow',
          Action: [
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
            'ecr:BatchCheckLayerAvailability',
          ],
          Resource: d.ecrRepositoryArn,
        },
        {
          Sid: 'EcrAuthentication',
          Effect: 'Allow',
          Action: 'ecr:GetAuthorizationToken',
          Resource: '*',
        },
        {
          Sid: 'RuntimeLogs',
          Effect: 'Allow',
          Action: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:DescribeLogStreams',
          ],
          Resource: [logs, `${logs}:*`],
        },
      ],
    },
  };
};

export const resourceToken = (purpose, identity) =>
  createHash('sha256')
    .update(JSON.stringify([purpose, identity.projectId, identity.executionId, identity.bindingId]))
    .digest('hex');

// EFS resource-policy Allows can bypass narrower identity permissions. The
// dedicated filesystem therefore has only these deployment-owned Denies.
export const fileSystemPolicy = (deployment) => {
  const d = validateDeployment(deployment);
  const Resource = `arn:${d.partition}:elasticfilesystem:${d.region}:${d.accountId}:file-system/${d.fileSystemId}`;
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyRoot',
        Effect: 'Deny',
        Principal: '*',
        Action: 'elasticfilesystem:ClientRootAccess',
        Resource,
      },
      ...Object.entries({
        DenyWithoutAccessPoint: { Null: { 'elasticfilesystem:AccessPointArn': 'true' } },
        DenyInsecureTransport: { BoolIfExists: { 'aws:SecureTransport': 'false' } },
        DenyWithoutMountTarget: {
          BoolIfExists: { 'elasticfilesystem:AccessedViaMountTarget': 'false' },
        },
      }).map(([Sid, Condition]) => ({
        Sid,
        Effect: 'Deny',
        Principal: '*',
        Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
        Resource,
        Condition,
      })),
    ],
  };
};

// IAM can reorder statements/actions on readback. Preserve all other values,
// including conditions, rather than accepting a subset of the expected grant.
export const samePolicy = (left, right) => {
  const normalize = (value) => {
    const policy = document(value);
    if (!policy || !Array.isArray(policy.Statement)) return null;
    return {
      ...policy,
      Statement: policy.Statement.map((statement) => ({
        ...statement,
        ...Object.fromEntries(
          ['Action', 'Resource']
            .filter((key) => Array.isArray(statement[key]))
            .map((key) => [key, [...statement[key]].toSorted()]),
        ),
      })).toSorted((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    };
  };
  try {
    const a = normalize(left);
    const b = normalize(right);
    return a !== null && b !== null && canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
};
