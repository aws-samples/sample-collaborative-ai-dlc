import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Static checks on the runtime role's Terraform that a plan cannot express.
// terraform/tests/agentcore-runtime-role.tftest.hcl plans the three rollout
// modes with mock providers and asserts the evaluated policies.
const read = (file) =>
  readFile(
    new URL(`../../../terraform/modules/compute/agentcore/${file}`, import.meta.url),
    'utf8',
  );
const block = (terraform, header) =>
  terraform.match(new RegExp(`^${header} \\{([\\s\\S]*?)^\\}`, 'm'))?.[1] ?? null;
const actionsOf = (text) =>
  [...text.matchAll(/Effect\s*= "(\w+)"[\s\S]*?Action\s*= \[([\s\S]*?)\]/g)].flatMap(
    ([, effect, list]) =>
      [...list.matchAll(/"([^"]+)"/g)].map(([, action]) => `${effect} ${action}`),
  );

describe('agentcore IAM role policy', () => {
  it('lets engine-data make the checkpoint ConditionCheck the enforced runtime no longer makes', async () => {
    // putWorkflowCheckpoint (lambda/shared/v2-process-store.js) issues a
    // TransactWriteCommand whose ConditionCheck on the execution META row maps
    // to dynamodb:ConditionCheckItem.
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

  it('grants the DynamoDB key to the runtime only with direct access', async () => {
    const kms = block(await read('main.tf'), 'module "dynamodb_kms_runtime_access"');
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
});
