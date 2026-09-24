import { createHash } from 'node:crypto';

import {
  authError,
  normalizeBedrockIam,
  BEDROCK_IAM_ROLE_PATTERN as rolePattern,
} from './agent-auth-catalog.js';
export { normalizeBedrockIam } from './agent-auth-catalog.js';

const invalid = (message) => authError('AGENT_AUTH_INVALID', message);
const document = (Statement) => ({ Version: '2012-10-17', Statement });
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const json = (value) => JSON.stringify(value, null, 2);

// A separate Bash owns errexit and AWS CLI settings. The outer conditional
// keeps an interactive CloudShell alive even if an earlier paste enabled -e;
// downloaded scripts still return a failure status.
const cloudShellCommands = (description, accountId, steps) =>
  [
    `# ${description}`,
    "if bash <<'COLLABORATIVE_BEDROCK_SETUP'",
    'set -eu',
    "export AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off",
    "step='Checking AWS account'",
    `trap 'status=$?; if [ "$status" -ne 0 ]; then printf "\\nBedrock IAM setup failed during: %s (exit %s).\\nSee the error above.\\n" "$step" "$status" >&2; fi' EXIT`,
    'printf "\\n%s\\n" "$step"',
    'actual_account="$(aws sts get-caller-identity --query Account --output text)"',
    `if [ "$actual_account" != ${shellQuote(accountId)} ]; then`,
    `  printf 'Wrong AWS account: %s. Expected ${accountId}. Switch accounts before continuing.\\n' "$actual_account" >&2`,
    '  exit 1',
    'fi',
    ...steps.flatMap(({ label, command }) => [
      '',
      `step=${shellQuote(label)}`,
      'printf "\\n%s\\n" "$step"',
      command,
    ]),
    'COLLABORATIVE_BEDROCK_SETUP',
    'then',
    "  printf '\\nBedrock IAM setup completed. Return to the wizard to continue.\\n'",
    'else',
    '  # Keep CloudShell open; report failure when run as a script.',
    '  case $- in *i*) ;; *) false ;; esac',
    'fi',
  ].join('\n');

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
  const applicationSteps = [
    {
      label: `Allowing ${sourceRoleName} to assume ${iam.roleArn}`,
      command: `aws iam put-role-policy --role-name ${shellQuote(sourceRoleName)} --policy-name ${shellQuote(policyName)} --policy-document ${shellQuote(json(assumeRolePolicy))}`,
    },
  ];
  // IAM trust updates replace the whole document. Read it at execution time
  // and append only this deployment's statement, preserving other principals,
  // conditions and denies. Repeating the same setup does not duplicate it.
  const mergeTrust = [
    'import json, sys',
    'policy = json.load(sys.stdin)',
    'addition = json.loads(sys.argv[1])',
    'statements = policy["Statement"]',
    'if isinstance(statements, dict):',
    '    statements = [statements]',
    'if addition not in statements:',
    '    statements.append(addition)',
    'policy["Statement"] = statements',
    'print(json.dumps(policy))',
  ].join('\n');
  const reuseInferencePolicyName = `CollaborativeBedrockInference-${createHash('sha256').update(`${brokerRoleArn}:${iam.region}`).digest('hex').slice(0, 12)}`;
  return {
    config: iam,
    brokerRoleArn,
    applicationAccountId: source[2],
    inferenceAccountId: accountId,
    trustPolicy,
    assumeRolePolicy,
    inferencePolicy,
    reuseCommands: cloudShellCommands(
      'Run in AWS CloudShell in the inference account. Connects this deployment to an EXISTING role.',
      accountId,
      [
        {
          label: `Reading the existing trust policy for ${roleName}`,
          command: `current_trust="$(aws iam get-role --role-name ${shellQuote(roleName)} --query Role.AssumeRolePolicyDocument --output json)"`,
        },
        {
          label: 'Adding this deployment to the trust policy while keeping existing statements',
          command: [
            `updated_trust="$(printf '%s\\n' "$current_trust" | python3 -c ${shellQuote(mergeTrust)} ${shellQuote(json(trustPolicy.Statement[0]))})"`,
            `aws iam update-assume-role-policy --role-name ${shellQuote(roleName)} --policy-document "$updated_trust"`,
          ].join('\n'),
        },
        {
          label: `Adding this deployment's inference permissions for ${iam.region}; other policies are retained`,
          command: `aws iam put-role-policy --role-name ${shellQuote(roleName)} --policy-name ${shellQuote(reuseInferencePolicyName)} --policy-document ${shellQuote(json(inferencePolicy))}`,
        },
        ...(accountId === source[2] ? applicationSteps : []),
      ],
    ),
    inferenceCommands: cloudShellCommands(
      'Run in AWS CloudShell in the inference account. Creates a NEW dedicated role.',
      accountId,
      [
        {
          label: `Creating new role ${roleName}. If it already exists, choose "I already have an inference role" in the wizard or use a different role name.`,
          command: `aws iam create-role --role-name ${shellQuote(roleName)} --path ${shellQuote(iamPath)} --assume-role-policy-document ${shellQuote(json(trustPolicy))} --max-session-duration 3600 --query Role.Arn --output text`,
        },
        {
          label: `Adding inference permissions to ${roleName}`,
          command: `aws iam put-role-policy --role-name ${shellQuote(roleName)} --policy-name CollaborativeBedrockInference --policy-document ${shellQuote(json(inferencePolicy))}`,
        },
      ],
    ),
    applicationCommands: cloudShellCommands(
      'Run in AWS CloudShell in the application account.',
      source[2],
      applicationSteps,
    ),
  };
};
