import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const publicEcrPassword = 'inert-public-ecr-test-password';
export const publicEcrToken = Buffer.from(`AWS:${publicEcrPassword}`).toString('base64');

// Extend existing deployment AWS stubs without allowing an actual AWS/registry call.
export const stubPublicEcr = (bin) => {
  const aws = join(bin, 'aws');
  const existing = existsSync(aws) ? readFileSync(aws, 'utf8').replace(/^#!.*\n/, '') : 'exit 1\n';
  writeFileSync(
    aws,
    `#!/bin/bash
if [[ "$1" == ecr-public ]]; then
  [[ "$*" == 'ecr-public get-authorization-token --region us-east-1 --query authorizationData.authorizationToken --output text' ]] || exit 97
  [[ -z "\${ECR_TEST_LOG:-}" ]] || echo login >> "$ECR_TEST_LOG"
  if [[ "\${ECR_TEST_LOGIN_FAIL:-0}" == 1 ]]; then
    echo '${publicEcrToken}' >&2
    exit 1
  fi
  echo '${publicEcrToken}'
  exit 0
fi
${existing}`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'curl'),
    `#!${process.execPath}
const fs = require('node:fs');
const assert = require('node:assert/strict');
const input = fs.readFileSync(0, 'utf8');
assert.ok(input.includes('Authorization: Bearer ${publicEcrToken}'));
assert.ok(!process.argv.join(' ').includes('${publicEcrToken}'));
assert.equal(process.argv[2], '-q');
assert.ok(process.argv.includes('--config'));
assert.ok(process.argv.includes('-'));
assert.ok(process.argv.includes('--max-time'));
assert.ok(!process.argv.includes('--location'));
if (process.env.ECR_TEST_LOG) fs.appendFileSync(process.env.ECR_TEST_LOG, process.argv.at(-1) + '\\n');
process.stdout.write(process.env.ECR_TEST_HTTP_STATUS || '200');
process.exit(process.env.ECR_TEST_HTTP_STATUS && process.env.ECR_TEST_HTTP_STATUS !== '200' ? 22 : 0);
`,
    { mode: 0o755 },
  );
};
