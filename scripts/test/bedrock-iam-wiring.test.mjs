import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const moduleBlock = (path, name) => {
  const block = read(path).match(new RegExp(`module "${name}" \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(block, `missing module "${name}"`);
  return block;
};

test('IAM setup receives the deployed broker principal through provider-owned wiring', () => {
  assert.match(
    moduleBlock('terraform/modules/api/lambda/main.tf', 'credential_broker_lambda'),
    /lambda_role\s+= aws_iam_role\.credential_broker\.arn/,
  );
  assert.match(
    read('terraform/modules/api/lambda/bedrock-iam.tf'),
    /output "credential_broker_role_arn" \{[^}]*value\s+= aws_iam_role\.credential_broker\.arn/,
  );
  assert.match(
    moduleBlock('terraform/main.tf', 'api'),
    /credential_broker_role_arn\s+= module\.lambda\.credential_broker_role_arn/,
  );
  assert.match(
    read('terraform/modules/api/bedrock-iam.tf'),
    /variable "credential_broker_role_arn" \{[^}]*type\s+= string/,
  );
  assert.match(
    moduleBlock('terraform/modules/api/agents.tf', 'agents_lambda'),
    /CREDENTIAL_BROKER_ROLE_ARN\s+= var\.credential_broker_role_arn/,
  );
});
