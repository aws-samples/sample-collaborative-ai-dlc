import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const terraformPath = new URL(
  '../../../terraform/modules/compute/agentcore/main.tf',
  import.meta.url,
);

describe('agentcore IAM role policy', () => {
  it('grants ConditionCheckItem so workflow checkpoints can transact-write', async () => {
    // putWorkflowCheckpoint (lambda/shared/v2-process-store.js) issues a
    // TransactWriteCommand whose ConditionCheck on the execution META row maps
    // to the dynamodb:ConditionCheckItem action. Without it the transaction is
    // denied and the checkpoint silently fails to advance.
    const terraform = await readFile(terraformPath, 'utf8');
    const agentcorePolicy = terraform.match(
      /resource "aws_iam_role_policy" "agentcore" \{([\s\S]*?)^\}/m,
    )?.[1];

    expect(agentcorePolicy).toBeTruthy();
    expect(agentcorePolicy).toContain('"dynamodb:ConditionCheckItem"');
  });
});
