import {
  DeleteParameterCommand,
  GetParametersCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { createHash } from 'node:crypto';

const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_BEDROCK_AUTH' });

const rolePattern =
  /^arn:(aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/((?:[\w+=,.@-]+\/)*[\w+=,.@-]{1,64})$/;

export const normalizeBedrockIam = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('A Bedrock IAM role and region are required');
  }
  const roleArn = String(input.roleArn ?? '').trim();
  const region = String(input.region ?? '').trim();
  if (!rolePattern.test(roleArn) || roleArn.length > 2048) {
    throw invalid('Enter a valid IAM role ARN');
  }
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) {
    throw invalid('Enter a valid AWS region');
  }
  const partition = roleArn.split(':')[1];
  const regionPartition = region.startsWith('cn-')
    ? 'aws-cn'
    : region.startsWith('us-gov-')
      ? 'aws-us-gov'
      : 'aws';
  if (partition !== regionPartition)
    throw invalid('The role and region must use the same AWS partition');
  const externalId = String(input.externalId ?? '').trim();
  if (externalId && !/^[\w+=,.@:/-]{2,1224}$/.test(externalId)) {
    throw invalid('The external ID contains unsupported characters or has an invalid length');
  }
  return { roleArn, region, ...(externalId ? { externalId } : {}) };
};

export const bedrockAuthPath = (base, projectId = null) => {
  if (!base) throw invalid('Agent settings are not configured');
  if (projectId !== null && !/^[A-Za-z0-9._-]+$/.test(projectId)) {
    throw invalid('Invalid space identifier');
  }
  return projectId
    ? `${base}/projects/${projectId}/agent-credentials/bedrock-iam`
    : `${base}/bedrock-auth`;
};

export const normalizeBedrockAuth = (input) => {
  if (!input || !['api-key', 'iam'].includes(input.mode)) {
    throw invalid('Bedrock authentication must be API key or IAM');
  }
  if (input.mode === 'iam' && !input.iam) {
    throw invalid('Configure an IAM role before enabling IAM');
  }
  return {
    mode: input.mode,
    ...(input.iam ? { iam: normalizeBedrockIam(input.iam) } : {}),
  };
};

// Absent configuration preserves API-key deployments. Malformed configuration
// fails closed: it must never silently re-enable personal or space API keys.
export const readBedrockAuth = async (ssm, { base, projectId = null }) => {
  const platformPath = bedrockAuthPath(base);
  const spacePath = projectId ? bedrockAuthPath(base, projectId) : null;
  const response = await ssm.send(
    new GetParametersCommand({
      Names: [platformPath, ...(spacePath ? [spacePath] : [])],
    }),
  );
  const values = new Map((response.Parameters ?? []).map((p) => [p.Name, p.Value]));
  try {
    return {
      platform: values.has(platformPath)
        ? normalizeBedrockAuth(JSON.parse(values.get(platformPath)))
        : { mode: 'api-key' },
      space:
        spacePath && values.has(spacePath)
          ? normalizeBedrockIam(JSON.parse(values.get(spacePath)))
          : null,
    };
  } catch {
    throw invalid(
      'Bedrock authentication configuration is invalid; contact a platform administrator',
    );
  }
};

export const writeBedrockAuth = async (ssm, { base, source, projectId, update }) => {
  if (
    update.bedrockAuth === undefined &&
    update.bedrockIam === undefined &&
    typeof update.bedrockBearerToken !== 'string'
  )
    return;
  if (source === 'user' && (update.bedrockAuth !== undefined || update.bedrockIam !== undefined)) {
    throw invalid('Personal IAM roles are not supported');
  }
  if (source !== 'platform' && update.bedrockAuth !== undefined) {
    throw invalid('Only platform administrators can select the Bedrock authentication mode');
  }
  if (source === 'platform' && update.bedrockIam !== undefined) {
    throw invalid('Configure platform IAM through the Bedrock authentication setting');
  }
  const platform =
    update.bedrockAuth === undefined
      ? (await readBedrockAuth(ssm, { base })).platform
      : normalizeBedrockAuth(update.bedrockAuth);
  const space =
    update.bedrockIam === undefined || update.bedrockIam === null
      ? update.bedrockIam
      : normalizeBedrockIam(update.bedrockIam);
  if (
    platform.mode === 'iam' &&
    typeof update.bedrockBearerToken === 'string' &&
    update.bedrockBearerToken.trim()
  ) {
    throw invalid('Bedrock API keys are disabled by the platform IAM setting');
  }
  if (space && platform.mode !== 'iam') {
    throw invalid('Enable platform IAM before configuring a space IAM role');
  }
  if (space !== undefined && (source !== 'space' || !projectId)) {
    throw invalid('A space is required for a space IAM setting');
  }
  if (update.bedrockAuth !== undefined) {
    await ssm.send(
      new PutParameterCommand({
        Name: bedrockAuthPath(base),
        Type: 'String',
        Value: JSON.stringify(platform),
        Overwrite: true,
      }),
    );
  }
  if (space !== undefined) {
    const Name = bedrockAuthPath(base, projectId);
    if (space === null) {
      try {
        await ssm.send(new DeleteParameterCommand({ Name }));
      } catch (error) {
        if (error?.name !== 'ParameterNotFound') throw error;
      }
    } else {
      await ssm.send(
        new PutParameterCommand({
          Name,
          Type: 'String',
          Value: JSON.stringify(space),
          Overwrite: true,
        }),
      );
    }
  }
};

const document = (Statement) => ({ Version: '2012-10-17', Statement });
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const json = (value) => JSON.stringify(value, null, 2);

// Both accounts receive explicit policies. Setup grants the broker permission
// to assume this exact role; the application never modifies IAM itself.
export const generateBedrockIamSetup = ({ brokerRoleArn, config }) => {
  const iam = normalizeBedrockIam(config);
  const source = rolePattern.exec(brokerRoleArn ?? '');
  const target = rolePattern.exec(iam.roleArn);
  if (!source || source[1] !== target[1]) {
    throw invalid('The broker role and inference role must be in the same AWS partition');
  }
  if (brokerRoleArn === iam.roleArn) throw invalid('Use a dedicated Bedrock inference role');
  const [, partition, accountId, rolePath] = target;
  const roleName = rolePath.split('/').at(-1);
  const sourceRoleName = source[3].split('/').at(-1);
  const iamPath = rolePath.includes('/')
    ? `/${rolePath.slice(0, rolePath.lastIndexOf('/') + 1)}`
    : '/';
  const policyName = `CollaborativeBedrock-${createHash('sha256').update(iam.roleArn).digest('hex').slice(0, 12)}`;
  const trustPolicy = document([
    {
      Effect: 'Allow',
      Principal: { AWS: brokerRoleArn },
      Action: 'sts:AssumeRole',
      ...(iam.externalId
        ? { Condition: { StringEquals: { 'sts:ExternalId': iam.externalId } } }
        : {}),
    },
  ]);
  const assumeRolePolicy = document([
    {
      Effect: 'Allow',
      Action: 'sts:AssumeRole',
      Resource: iam.roleArn,
    },
  ]);
  const inferencePolicy = document([
    {
      Sid: 'BedrockInference',
      Effect: 'Allow',
      Action: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:GetInferenceProfile',
      ],
      Resource: [
        `arn:${partition}:bedrock:*::foundation-model/*`,
        `arn:${partition}:bedrock:*:${accountId}:inference-profile/*`,
        `arn:${partition}:bedrock:*:${accountId}:application-inference-profile/*`,
      ],
    },
    {
      Sid: 'ModelDiscovery',
      Effect: 'Allow',
      Action: ['bedrock:ListInferenceProfiles', 'bedrock:ListFoundationModels'],
      Resource: '*',
    },
    {
      Sid: 'CodexInference',
      Effect: 'Allow',
      Action: [
        'bedrock-mantle:CreateInference',
        'bedrock-mantle:GetInference',
        'bedrock-mantle:CancelInference',
        'bedrock-mantle:DeleteInference',
        'bedrock-mantle:GetProject',
        'bedrock-mantle:ListModels',
        'bedrock-mantle:ListTagsForResource',
      ],
      Resource: `arn:${partition}:bedrock-mantle:${iam.region}:${accountId}:project/*`,
    },
    {
      Sid: 'CodexProjectDiscovery',
      Effect: 'Allow',
      Action: 'bedrock-mantle:ListProjects',
      Resource: '*',
    },
  ]);
  const accountCheck = (account) =>
    `[ "$(aws sts get-caller-identity --query Account --output text)" = ${shellQuote(account)} ] || { echo 'Wrong AWS account. Switch accounts before continuing.' >&2; exit 1; }`;
  return {
    config: iam,
    brokerRoleArn,
    applicationAccountId: source[2],
    inferenceAccountId: accountId,
    trustPolicy,
    assumeRolePolicy,
    inferencePolicy,
    inferenceCommands: [
      '# Run in AWS CloudShell in the inference account. Creates a NEW dedicated role.',
      'set -eu',
      accountCheck(accountId),
      `aws iam create-role --role-name ${shellQuote(roleName)} --path ${shellQuote(iamPath)} --assume-role-policy-document ${shellQuote(json(trustPolicy))} --max-session-duration 3600`,
      `aws iam put-role-policy --role-name ${shellQuote(roleName)} --policy-name CollaborativeBedrockInference --policy-document ${shellQuote(json(inferencePolicy))}`,
    ].join('\n\n'),
    applicationCommands: [
      '# Run in AWS CloudShell in the application account.',
      'set -eu',
      accountCheck(source[2]),
      `aws iam put-role-policy --role-name ${shellQuote(sourceRoleName)} --policy-name ${shellQuote(policyName)} --policy-document ${shellQuote(json(assumeRolePolicy))}`,
    ].join('\n\n'),
  };
};
