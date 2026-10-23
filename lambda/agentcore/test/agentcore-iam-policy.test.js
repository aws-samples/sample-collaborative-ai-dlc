import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Static checks on the runtime role's Terraform, per rollout mode. The mode
// local is `runtime_direct_data_access = !(enable_engine_data &&
// enforce_runtime_grants)`; terraform/tests/agentcore-runtime-role.tftest.hcl
// plans the same three modes with mock providers.
const read = (file) =>
  readFile(
    new URL(`../../../terraform/modules/compute/agentcore/${file}`, import.meta.url),
    'utf8',
  );
const block = (terraform, header) =>
  terraform.match(new RegExp(`^${header} \\{([\\s\\S]*?)^\\}`, 'm'))?.[1] ?? null;
const DIRECT = 'local.runtime_direct_data_access';

// The top-level arguments of the policy's `Statement = concat(...)`, comments
// dropped, each classified as kept in every mode or only with direct access.
const statementGroups = (policy) => {
  const body = policy
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const start = body.indexOf('Statement = concat(') + 'Statement = concat('.length;
  const groups = [];
  let depth = 0;
  let from = start;
  for (let i = start; depth >= 0; i++) {
    const ch = body[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if ((ch === ',' && depth === 0) || depth < 0) {
      const text = body.slice(from, i).trim();
      if (text) groups.push(text);
      from = i + 1;
    }
  }
  return groups.map((text) => ({
    text,
    direct: text.startsWith(DIRECT) || text.endsWith(`if ${DIRECT}]`),
  }));
};
const actionsOf = (text) =>
  [...text.matchAll(/Effect\s*= "(\w+)"[\s\S]*?Action\s*= \[([\s\S]*?)\]/g)].flatMap(
    ([, effect, list]) =>
      [...list.matchAll(/"([^"]+)"/g)].map(([, action]) => `${effect} ${action}`),
  );

const DIRECT_DATA = /^Allow (neptune-db|dynamodb|s3|ssm|execute-api):/;

describe('agentcore IAM role policy', () => {
  it('keeps ConditionCheckItem for direct-path checkpoints and drops it once grants are enforced', async () => {
    // putWorkflowCheckpoint (lambda/shared/v2-process-store.js) issues a
    // TransactWriteCommand whose ConditionCheck on the execution META row maps
    // to dynamodb:ConditionCheckItem. On the direct path the runtime role makes
    // that call; with engine data the engine-data role does.
    const policy = block(await read('main.tf'), 'resource "aws_iam_role_policy" "agentcore"');
    const groups = statementGroups(policy);
    expect(groups.filter((g) => g.direct).flatMap((g) => actionsOf(g.text))).toContain(
      'Allow dynamodb:ConditionCheckItem',
    );
    expect(groups.filter((g) => !g.direct).flatMap((g) => actionsOf(g.text))).not.toContain(
      'Allow dynamodb:ConditionCheckItem',
    );

    const engineData = block(
      await read('engine-data.tf'),
      'resource "aws_iam_role_policy" "engine_data"',
    );
    expect(engineData).toMatch(
      /Action = \[[^\]]*"dynamodb:ConditionCheckItem"[^\]]*\]\s*Resource = \[\s*aws_dynamodb_table\.v2_executions\.arn/,
    );
  });

  it('enables direct access unless engine data and runtime grant enforcement are both on', async () => {
    expect(await read('engine-data.tf')).toContain(
      'runtime_direct_data_access = !(var.enable_engine_data && var.enforce_runtime_grants)',
    );
    const root = await readFile(new URL('../../../terraform/main.tf', import.meta.url), 'utf8');
    expect(block(root, 'module "agentcore"')).toMatch(
      /enforce_runtime_grants\s*= var\.enforce_runtime_grants/,
    );
  });

  it('leaves the runtime role only its remote paths once grants are enforced', async () => {
    const main = await read('main.tf');
    const policy = block(main, 'resource "aws_iam_role_policy" "agentcore"');
    const groups = statementGroups(policy);
    // ECR pull, logs, the broker, durable callbacks and the AssumeRole deny stay.
    expect(groups.filter((g) => !g.direct).flatMap((g) => actionsOf(g.text))).toEqual([
      'Allow ecr:GetDownloadUrlForLayer',
      'Allow ecr:BatchGetImage',
      'Allow ecr:BatchCheckLayerAvailability',
      'Allow ecr:GetAuthorizationToken',
      'Allow lambda:InvokeFunction',
      'Deny sts:AssumeRole',
      'Allow logs:CreateLogStream',
      'Allow logs:PutLogEvents',
      'Allow logs:CreateLogGroup',
      'Allow lambda:SendDurableExecutionCallbackSuccess',
      'Allow lambda:SendDurableExecutionCallbackFailure',
      'Allow lambda:SendDurableExecutionCallbackHeartbeat',
    ]);
    // Every direct data family is gated, and only those are.
    const gated = groups.filter((g) => g.direct).flatMap((g) => actionsOf(g.text));
    expect(gated.length).toBeGreaterThan(0);
    expect(gated.every((action) => DIRECT_DATA.test(action))).toBe(true);
    expect(new Set(gated.map((action) => action.split(/[ :]/)[1]))).toEqual(
      new Set(['neptune-db', 'dynamodb', 's3', 'ssm', 'execute-api']),
    );

    // The invoke statement keeps the broker; the unqualified source-control
    // function goes, leaving the `runtime` alias from invoke-engine-data.
    expect(policy).toMatch(
      /Resource = concat\(\s*\[local\.credential_broker_function_arn\],\s*local\.runtime_direct_data_access \? \[local\.source_control_function_arn\] : \[\],\s*\)/,
    );
    expect(policy.match(/source_control_function_arn/g)).toHaveLength(1);
    const engineData = await read('engine-data.tf');
    expect(
      block(engineData, 'resource "aws_iam_role_policy" "agentcore_invoke_engine_data"'),
    ).toMatch(
      /Resource = \[\s*module\.engine_data_lambda\[0\]\.lambda_function_arn,\s*local\.source_control_runtime_alias_arn,\s*\]/,
    );
    expect(engineData).toContain(
      'source_control_runtime_alias_arn = "${local.source_control_function_arn}:runtime"',
    );

    // The DynamoDB CMK grant follows the table access; mcp-tools and engine-data keep theirs.
    const kms = block(main, 'module "dynamodb_kms_runtime_access"');
    expect(kms).toMatch(
      /role_names = merge\(local\.runtime_direct_data_access \? \{\s*agentcore = aws_iam_role\.agentcore\.name\s*\} : \{\}/,
    );
    expect(kms).toContain('mcp_tools = aws_iam_role.mcp_tools[0].name');
    expect(kms).toContain('engine_data = aws_iam_role.engine_data[0].name');
  });

  it('adds no other runtime-role grant that could reach data or the unqualified function', async () => {
    const files = ['main.tf', 'mcp-gateway.tf', 'engine-data.tf', 'grant-retirement.tf'];
    const policies = (await Promise.all(files.map(read))).flatMap((terraform) =>
      [...terraform.matchAll(/^resource "aws_iam_role_policy" "(\w+)" \{([\s\S]*?)^\}/gm)].filter(
        ([, , body]) => /role\s*=\s*aws_iam_role\.agentcore\.id/.test(body),
      ),
    );
    const others = Object.fromEntries(
      policies.filter(([, name]) => name !== 'agentcore').map(([, name, body]) => [name, body]),
    );
    expect(Object.keys(others).toSorted()).toEqual([
      'agentcore_deny_gateway_grant_retirements',
      'agentcore_invoke_engine_data',
      'agentcore_invoke_mcp_gateway',
    ]);
    expect(actionsOf(others.agentcore_invoke_mcp_gateway)).toEqual([
      'Allow bedrock-agentcore:InvokeGateway',
    ]);
    expect(actionsOf(others.agentcore_invoke_engine_data)).toEqual(['Allow lambda:InvokeFunction']);
    expect(actionsOf(others.agentcore_deny_gateway_grant_retirements)).toEqual(['Deny dynamodb:*']);
    for (const body of Object.values(others)) {
      expect(body).not.toContain('source_control_function_arn,');
      expect(body).not.toMatch(/function:\*|lambda:\*/);
    }
  });

  it('gives the enforced runtime no direct-client configuration', async () => {
    const env = (await read('main.tf')).match(
      /runtime_environment_variables = merge\(\{([\s\S]*?)\n\s*\}, local\.runtime_direct_data_access \? \{([\s\S]*?)\} : \{\}/,
    );
    expect(env).toBeTruthy();
    const keys = (text) =>
      [...text.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map(([, key]) => key).toSorted();
    expect(keys(env[2])).toEqual([
      'ARTIFACTS_BUCKET',
      'BLOCKS_TABLE',
      'CONNECTIONS_TABLE',
      'MCP_SECRETS_SSM_PREFIX',
      'NEPTUNE_ENDPOINT',
      'WEBSOCKET_ENDPOINT',
    ]);
    expect(keys(env[1])).not.toEqual(expect.arrayContaining(['BLOCKS_TABLE']));
  });
});
