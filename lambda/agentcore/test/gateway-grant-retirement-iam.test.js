import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Static checks on the Terraform that keeps end-of-stage grant retirement out
// of the runtime's reach: no `terraform plan` runs in unit tests, so the
// invariants are asserted on the configuration text, like agentcore-iam-policy.
const read = (path) => readFile(new URL(`../../../terraform/${path}`, import.meta.url), 'utf8');
const block = (terraform, type, name) =>
  terraform.match(new RegExp(`^resource "${type}" "${name}" \\{([\\s\\S]*?)^\\}`, 'm'))?.[1] ??
  null;
const runtimeRolePolicies = (terraform) =>
  [...terraform.matchAll(/^resource "aws_iam_role_policy" "(\w+)" \{([\s\S]*?)^\}/gm)].filter(
    ([, , body]) => /role\s*=\s*aws_iam_role\.agentcore\.id/.test(body),
  );

const AGENTCORE = 'modules/compute/agentcore';
const agentcoreFiles = ['main.tf', 'mcp-gateway.tf', 'engine-data.tf', 'grant-retirement.tf'];

describe('gateway grant retirement IAM', () => {
  it('keeps the retirement table outside every runtime-role Allow and denies it explicitly', async () => {
    const policies = (
      await Promise.all(agentcoreFiles.map((file) => read(`${AGENTCORE}/${file}`)))
    ).flatMap(runtimeRolePolicies);
    expect(policies.map(([, name]) => name)).toEqual(
      expect.arrayContaining(['agentcore', 'agentcore_deny_gateway_grant_retirements']),
    );
    for (const [, name, body] of policies) {
      if (name === 'agentcore_deny_gateway_grant_retirements') continue;
      expect(body).not.toContain('gateway_grant_retirements');
      // No table wildcard that could reach the retirement table indirectly.
      expect(body).not.toMatch(/:table\/\*|dynamodb:\*/);
    }

    const deny = block(
      await read(`${AGENTCORE}/grant-retirement.tf`),
      'aws_iam_role_policy',
      'agentcore_deny_gateway_grant_retirements',
    );
    expect(deny).toContain('Effect = "Deny"');
    expect(deny).toContain('Action = ["dynamodb:*"]');
    expect(deny).toContain('aws_dynamodb_table.gateway_grant_retirements[0].arn,');
    expect(deny).toContain('"${aws_dynamodb_table.gateway_grant_retirements[0].arn}/*"');
  });

  it('covers managed runtimes, which run under the same role', async () => {
    expect(await read('main.tf')).toMatch(/runtime_role_arn\s*=\s*module\.agentcore\.role_arn/);
  });

  it('expires rows by TTL and exists exactly when grants are issued', async () => {
    const table = block(
      await read(`${AGENTCORE}/grant-retirement.tf`),
      'aws_dynamodb_table',
      'gateway_grant_retirements',
    );
    expect(table).toContain('count = local.mcp_gateway_enabled ? 1 : 0');
    expect(table).toMatch(/ttl \{\s*attribute_name = "expiresAt"\s*enabled\s*= true/);
    expect(table).toContain('hash_key       = "pk"');
  });

  it('lets the writers only write what they need and every consumer only read', async () => {
    const agentcore = await read(`${AGENTCORE}/grant-retirement.tf`);
    const api = await read('modules/api/lambda/grant-retirement.tf');
    const orchestrator = block(api, 'aws_iam_role_policy', 'v2_orchestrator_retire_gateway_grants');
    expect(orchestrator).toMatch(/role\s*=\s*aws_iam_role\.v2_orchestrator\.id/);
    // jti records and the issuance guard's read only: the orchestrator never
    // writes an execution-level retirement, so it needs neither UpdateItem on
    // the table nor a run-ownership ConditionCheck on the process table.
    expect(orchestrator).toContain('Action   = ["dynamodb:PutItem", "dynamodb:GetItem"]');
    expect(orchestrator).not.toMatch(/dynamodb:(UpdateItem|ConditionCheckItem|DeleteItem|\*)/);
    expect(orchestrator).not.toContain('v2_executions_table_arn');

    const writers = block(api, 'aws_iam_role_policy', 'gateway_execution_retirement_writers');
    expect(writers).toContain('for_each = var.enable_mcp_gateway ? {');
    expect(writers).toMatch(
      /intents = \{\s*role\s*= aws_iam_role\.intents\.id\s*actions = \["dynamodb:PutItem", "dynamodb:UpdateItem"\]/,
    );
    expect(writers).toMatch(
      /projects = \{\s*role\s*= aws_iam_role\.neptune_artifacts\.id\s*actions = \["dynamodb:UpdateItem"\]/,
    );
    expect(writers).toContain('Action   = each.value.actions');
    expect(writers).toContain('Resource = var.gateway_grant_retirement_table_arn');
    // Every execution-level write is fenced on the run the request read; the
    // ConditionCheck targets the process table, never the retirement table.
    expect(writers).toMatch(
      /Action\s*= \["dynamodb:ConditionCheckItem"\]\s*Resource = var\.v2_executions_table_arn/,
    );
    expect(writers).not.toMatch(/dynamodb:(DeleteItem|\*)/);
    // The projects Lambda is the only one running under that role.
    expect(
      (await read('modules/api/lambda/main.tf')).match(
        /lambda_role = aws_iam_role\.neptune_artifacts\.arn/g,
      ),
    ).toHaveLength(1);

    const readers = block(api, 'aws_iam_role_policy', 'gateway_grant_retirement_readers');
    expect(readers).toContain('credential_broker = aws_iam_role.credential_broker.id');
    expect(readers).toContain('source_control    = aws_iam_role.source_control.id');
    expect(readers).toContain('Action   = ["dynamodb:GetItem"]');
    for (const name of [
      'mcp_tools_read_gateway_grant_retirements',
      'engine_data_read_gateway_grant_retirements',
    ]) {
      expect(block(agentcore, 'aws_iam_role_policy', name)).toContain(
        'Action   = ["dynamodb:GetItem"]',
      );
    }
  });

  // A jti whose retirement exhausted is recorded on META (pendingGrantRetirements):
  // every consumer must be able to read that row, or its grant check fails closed.
  it('lets every grant consumer read the META rows that record pending retirements', async () => {
    const processRead = /"dynamodb:GetItem"[^\]]*\]\s*Resource\s*=\s*\[?\s*/;
    for (const [file, name] of [
      ['mcp-gateway.tf', 'mcp_tools'],
      ['engine-data.tf', 'engine_data'],
    ]) {
      const terraform = await read(`${AGENTCORE}/${file}`);
      expect(block(terraform, 'aws_iam_role_policy', name)).toMatch(
        new RegExp(`${processRead.source}aws_dynamodb_table\\.v2_executions\\.arn`),
      );
      expect(terraform).toMatch(/V2_PROCESS_TABLE\s*= aws_dynamodb_table\.v2_executions\.name/);
    }
    const lambdas = await read('modules/api/lambda/main.tf');
    for (const name of ['credential_broker', 'source_control_runtime_alias']) {
      expect(block(lambdas, 'aws_iam_role_policy', name)).toMatch(
        new RegExp(`${processRead.source}var\\.v2_executions_table_arn`),
      );
    }
    // Both API consumers name the process table beside the retirement table.
    for (const fn of ['credential_broker_lambda', 'source_control_lambda']) {
      const moduleBody = lambdas.match(new RegExp(`^module "${fn}" \\{([\\s\\S]*?)^\\}`, 'm'))?.[1];
      expect(moduleBody).toMatch(/V2_PROCESS_TABLE\s*= var\.v2_executions_table_name/);
      expect(moduleBody).toMatch(
        /GATEWAY_GRANT_RETIREMENT_TABLE\s*= var\.gateway_grant_retirement_table_name/,
      );
    }
  });

  it('configures the table on the orchestrator and on every grant consumer', async () => {
    const env = 'GATEWAY_GRANT_RETIREMENT_TABLE';
    expect(await read(`${AGENTCORE}/mcp-gateway.tf`)).toContain(
      `${env} = aws_dynamodb_table.gateway_grant_retirements[0].name`,
    );
    expect(await read(`${AGENTCORE}/engine-data.tf`)).toContain(
      `${env} = aws_dynamodb_table.gateway_grant_retirements[0].name`,
    );
    const lambdas = await read('modules/api/lambda/main.tf');
    // v2-orchestrator, credential broker, source-control, intents, projects.
    expect(
      lambdas.match(new RegExp(`${env}\\s*= var\\.gateway_grant_retirement_table_name`, 'g')),
    ).toHaveLength(5);
    // The writers get the table under the same flag that creates it.
    for (const fn of ['intents_lambda', 'projects_lambda']) {
      const moduleBody = lambdas.match(new RegExp(`^module "${fn}" \\{([\\s\\S]*?)^\\}`, 'm'))?.[1];
      expect(moduleBody).toMatch(
        new RegExp(
          `var\\.enable_mcp_gateway \\? \\{\\s*${env}\\s*= var\\.gateway_grant_retirement_table_name`,
        ),
      );
    }
  });
});
