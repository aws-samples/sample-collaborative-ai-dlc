import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const terraformAvailable = spawnSync('terraform', ['version'], { stdio: 'ignore' }).status === 0;

// Use the production HCL block, so reintroducing nonsensitive() in its input
// actually prints the fixture's private fields and fails this regression.
const block = (source, heading) => {
  const start = source.indexOf(heading);
  assert.notEqual(start, -1);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1);
  return source.slice(start, end + 2);
};

test(
  'Terraform plan output hides the complete normalized SSO provider map',
  {
    skip:
      !terraformAvailable && 'Terraform is required; this test also runs in the Terraform CI job',
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidlc-sso-privacy-'));
    const moduleDir = join(dir, 'terraform');
    mkdirSync(moduleDir);
    mkdirSync(join(dir, 'config'));
    const run = (args) => {
      const result = spawnSync('terraform', args, { cwd: moduleDir, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    try {
      writeFileSync(
        join(dir, 'config/platform-roles.json'),
        readFileSync(join(root, 'config/platform-roles.json')),
      );
      const main = readFileSync(join(root, 'terraform/main.tf'), 'utf8');
      const variables = readFileSync(join(root, 'terraform/variables.tf'), 'utf8');
      writeFileSync(
        join(moduleDir, 'main.tf'),
        `
variable "auth_mode" { default = "hybrid" }
${block(variables, 'variable "sso_providers" {')}
locals {
  sso_enabled = var.auth_mode != "local"
  sso_role_config = {
    providers = {
      for name, provider in var.sso_providers : name => {
        roleMappings = provider.role_mappings
        requiredClaimValues = provider.required_claim_values
      }
    }
  }
}
${block(main, 'resource "terraform_data" "sso_preconditions" {')}
`,
      );
      const provider = {
        display_name: 'Private provider configuration',
        type: 'oidc',
        issuer_url: 'https://private-issuer.example.com',
        client_id: 'private-client-id-sentinel',
        client_secret_arn:
          'arn:aws:secretsmanager:eu-central-1:111122223333:secret:private-secret-sentinel',
        email_claim: 'email',
        role_claim: 'groups',
        role_mappings: { 'platform-admin': ['private-admin-group-sentinel'] },
      };
      writeFileSync(
        join(moduleDir, 'test.tfvars.json'),
        JSON.stringify({
          sso_providers: { CorporateOIDC: provider },
        }),
      );
      run(['init', '-no-color']);
      const output = run(['plan', '-no-color', '-var-file=test.tfvars.json', '-out=test.tfplan']);
      for (const value of [
        provider.issuer_url,
        provider.client_id,
        provider.client_secret_arn,
        provider.role_mappings['platform-admin'][0],
      ]) {
        assert.ok(!output.includes(value), 'Terraform printed private provider configuration');
      }
      const plan = JSON.parse(run(['show', '-json', 'test.tfplan']));
      const resource = plan.resource_changes.find(
        (item) => item.address === 'terraform_data.sso_preconditions',
      );
      assert.equal(resource.change.after_sensitive.input, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
