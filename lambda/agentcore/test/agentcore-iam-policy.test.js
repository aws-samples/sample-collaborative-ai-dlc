import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const executionDataTerraformPath = new URL(
  '../../../terraform/modules/api/lambda/main.tf',
  import.meta.url,
);
const agentcoreTerraformPath = new URL(
  '../../../terraform/modules/compute/agentcore/main.tf',
  import.meta.url,
);

describe('agentcore execution data IAM policies', () => {
  it('grants ConditionCheckItem so workflow checkpoints can transact-write', async () => {
    // putWorkflowCheckpoint (lambda/shared/v2-process-store.js) issues a
    // TransactWriteCommand whose ConditionCheck on the execution META row maps
    // to the dynamodb:ConditionCheckItem action. Without it the transaction is
    // denied and the checkpoint silently fails to advance.
    const terraform = await readFile(executionDataTerraformPath, 'utf8');
    const executionDataPolicy = terraform.match(
      /resource "aws_iam_role_policy" "execution_data" \{([\s\S]*?)^\}/m,
    )?.[1];

    expect(executionDataPolicy).toBeTruthy();
    expect(executionDataPolicy).toContain('"dynamodb:ConditionCheckItem"');
  });

  it('explicitly denies execution-table and index access to the scoped runtime role', async () => {
    const terraform = await readFile(agentcoreTerraformPath, 'utf8');
    const scopedPolicy = terraform.match(
      /resource "aws_iam_role_policy" "agentcore_scoped" \{([\s\S]*?)^\}/m,
    )?.[1];

    expect(scopedPolicy).toBeTruthy();
    const deniedResources = scopedPolicy.match(
      /Effect\s*=\s*"Deny"\s+Action\s*=\s*\[\s*"dynamodb:\*"\s*,?\s*\]\s+Resource\s*=\s*\[([\s\S]*?)\]/,
    )?.[1];

    expect(deniedResources).toBeTruthy();
    expect(deniedResources.split(',').map((resource) => resource.trim())).toEqual(
      expect.arrayContaining([
        'aws_dynamodb_table.v2_executions.arn',
        '"${aws_dynamodb_table.v2_executions.arn}/index/*"',
      ]),
    );
  });
});
