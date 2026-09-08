import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// specs/bedrock-iam-role-credential-mode — req-least-privilege-assume,
// req-model-grant-families, req-broker-side-assume.
//
// The broker is the ONE principal allowed to assume a customer's Bedrock role.
// These assertions pin the two things that are easy to loosen by accident: the
// resource scope of that permission, and which model families the grant covers.

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const brokerTerraform = read('../../../terraform/modules/api/lambda/main.tf');
const brokerVariables = read('../../../terraform/modules/api/lambda/variables.tf');
const grantTerraform = read('../../../terraform/bedrock-role-grant.tf');
const trustPolicyTemplate = read(
  '../../../terraform/templates/bedrock-role-trust-policy.json.tftpl',
);
// The grant file's three inputs are declared with every other root variable.
const rootVariables = read('../../../terraform/variables.tf');

const terraformBlock = (source, header) => {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`terraform block not found: ${header}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced terraform block: ${header}`);
};

describe('credential broker sts:AssumeRole scope', () => {
  const policy = terraformBlock(
    brokerTerraform,
    'resource "aws_iam_role_policy" "credential_broker"',
  );

  it('extracts a plausible policy block (guards the extractor itself)', () => {
    expect(policy.length).toBeGreaterThan(500);
    expect(policy).toContain('aws_iam_role.credential_broker.id');
  });

  it('grants sts:AssumeRole only on the configured role set, never a literal wildcard', () => {
    expect(policy).toContain('"sts:AssumeRole"');
    const assumeStatement = policy.slice(policy.indexOf('"sts:AssumeRole"'));
    const resourceLine = assumeStatement.match(/Resource\s*=\s*(.+)/)[1].trim();
    expect(resourceLine).toBe('var.bedrock_assumable_role_arns');
    // A hardcoded "*" here would make the target trust policy the only control.
    expect(resourceLine).not.toBe('"*"');
  });

  it('defaults the assumable set to the documented path-scoped pattern', () => {
    const variable = terraformBlock(brokerVariables, 'variable "bedrock_assumable_role_arns"');
    expect(variable).toContain('default     = ["arn:aws:iam::*:role/aidlc-bedrock-*"]');
    // The bare wildcard remains available, but only as an explicit, documented
    // opt-out an operator has to type (dec-assumable-role-default). The
    // description string escapes its quotes, hence the HCL-escaped form here.
    expect(variable).toContain('[\\"*\\"] to opt out');
    expect(variable).toContain('type        = list(string)');
  });

  it("grants sts:AssumeRole in exactly one permission policy, the broker's", () => {
    // The module's shared `lambda_assume_role_policy` also names sts:AssumeRole,
    // but that is a TRUST policy — it says who may assume the Lambda roles and
    // grants their holders nothing. Only permission policies are counted here.
    const permissionPolicies = [
      ...brokerTerraform.matchAll(/resource "aws_iam_role_policy" "([a-z0-9_]+)"/g),
    ].map((match) => ({
      name: match[1],
      body: terraformBlock(brokerTerraform, match[0]),
    }));
    expect(permissionPolicies.length).toBeGreaterThan(1);
    const granting = permissionPolicies
      .filter((entry) => entry.body.includes('"sts:AssumeRole"'))
      .map((entry) => entry.name);
    expect(granting).toEqual(['credential_broker']);
  });
});

describe('bedrock role grant families', () => {
  // Comments in this file legitimately DISCUSS the patterns that must be absent
  // (con-gpt-global-cris-only explains why there is no eu.openai pattern), so
  // absence must be asserted against the code, not the prose.
  const grantCode = grantTerraform
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it.each([
    'inference-profile/eu.anthropic.claude-*',
    'inference-profile/global.anthropic.claude-*',
    'inference-profile/global.openai.gpt-*',
  ])('grants the %s family pattern', (pattern) => {
    // Patterns, not enumerations: con-claude-model-fanout shows a run pinned to
    // one model also invokes others in the same family.
    expect(grantCode).toContain(pattern);
  });

  it('grants no eu.openai pattern, because no such inference profile exists', () => {
    // con-gpt-global-cris-only. Including one would imply a capability that is not
    // there; eu.openai.gpt-5.6-sol returns ValidationException.
    expect(grantCode).not.toContain('eu.openai');
    // Guard the comment-stripping itself: the prose DOES mention it, so a broken
    // filter would make the assertion above pass for the wrong reason.
    expect(grantTerraform).toContain('eu.openai');
  });

  it('region-wildcards foundation models and fences them to an inference profile', () => {
    expect(grantCode).toContain('bedrock:*::foundation-model/anthropic.claude-*');
    expect(grantCode).toContain('bedrock:*::foundation-model/openai.gpt-*');
    // con-fm-fence-works: without the condition a bare foundation-model id would
    // resolve to direct invocation and bypass the inference-profile requirement.
    expect(grantCode).toContain('"bedrock:InferenceProfileArn"');
    expect(grantCode).toContain('StringLike');
  });

  it('grants Codex Runtime access to the implicit project/default resource', () => {
    // Supported Codex versions use the Bedrock Runtime OpenAI-compatible endpoint,
    // which authorizes bedrock:InvokeModel against this resource in addition to the model.
    expect(grantCode).toContain('"bedrock:InvokeModel"');
    expect(grantCode).toContain('bedrock:*:${account}:project/default');
  });

  it('scopes every account-bearing ARN to the role-owning account, not the platform account', () => {
    // req-model-grant-families: under a central-Bedrock-account topology the role
    // lives in a different account, so a hardcoded caller-identity reference in
    // these ARNs would silently grant nothing.
    const accountBearing = [...grantCode.matchAll(/arn:\$\{[^}]+\}:bedrock[^"]*/g)].map(
      (match) => match[0],
    );
    expect(accountBearing.length).toBeGreaterThan(0);
    for (const arn of accountBearing) {
      // Either account-less (foundation-model) or the role account — never the
      // deployment's own caller identity.
      expect(arn).not.toContain('data.aws_caller_identity');
    }
  });

  it('grants invoke actions only — no management, no logging, no credential creation', () => {
    // Only ACTION positions count. `bedrock:InferenceProfileArn` is a condition
    // key, not an action, so it is excluded by requiring the `Action = [...]`
    // context rather than matching any service-prefixed quoted string.
    const actionLists = [...grantCode.matchAll(/Action\s*=\s*\[([^\]]*)\]/g)].map(
      (match) => match[1],
    );
    const actions = new Set(
      actionLists.flatMap((list) =>
        [...list.matchAll(/"([a-z0-9-]+:[A-Za-z*]+)"/g)].map((m) => m[1]),
      ),
    );
    expect([...actions].toSorted()).toEqual([
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
    ]);
    // req-credential-safety: no role in this design may create a long-lived credential.
    expect(grantCode).not.toContain('iam:CreateAccessKey');
    expect(grantCode).not.toContain('iam:CreateServiceSpecificCredential');
  });
});

// specs/bedrock-iam-role-credential-mode — req-least-privilege-assume.
//
// The session-policy ceiling and the customer-facing grant MUST be two renders of one
// statement definition, not two definitions. This is the load-bearing property: the
// grant is advice about a role in an account this deployment does not manage, the
// ceiling is the enforcement, and a ceiling that lags the grant DENIES a call the
// documented grant permits.
//
// That failure is not hypothetical. Moving Codex to the Bedrock Runtime provider added
// a dedicated statement (`project/default`) because the OpenAI-compatible API authorizes
// against that implicit resource; a copied ceiling without it would 401 every Codex call
// while the operator's own policy looked correct.
describe('Bedrock grant and session-policy ceiling are one definition', () => {
  it('renders both from the same statements local, so neither can be a copy', () => {
    expect(grantTerraform).toContain('bedrock_grant_policies = {');
    expect(grantTerraform).toContain('for render, account in local.bedrock_grant_render_accounts');
    // Both consumers must INDEX the shared render map rather than restate statements.
    expect(grantTerraform).toContain(
      'bedrock_role_grant_policy = local.bedrock_grant_policies["grant"]',
    );
    expect(grantTerraform).toContain('jsonencode(local.bedrock_grant_policies["ceiling"])');
  });

  it('defines each statement exactly once (a second copy is the drift this prevents)', () => {
    // Every Sid appears once. A hand-copied ceiling would duplicate all three.
    for (const sid of [
      'InvokeThroughInferenceProfiles',
      'InvokeFoundationModelsOnlyViaInferenceProfile',
      'CodexOpenAiCompatibleProject',
    ]) {
      expect(grantTerraform.match(new RegExp(`Sid\\s+=\\s+"${sid}"`, 'g'))).toHaveLength(1);
    }
    // The model grant itself has exactly one Statement list. Trust policies live
    // in the shared template, outside this grant/ceiling definition.
    expect(grantTerraform.match(/Statement = \[/g)).toHaveLength(1);
    expect(
      terraformBlock(grantTerraform, '  bedrock_grant_policies = {').match(/Statement = \[/g),
    ).toHaveLength(1);
  });

  // req-session-name-trust-condition. A trust policy is the customer's only
  // control over who may assume their Bedrock role, and it is the document most
  // easily got wrong by retyping: a dev deployment pinned StringEquals to one
  // space id under a PLATFORM-scope binding, which denied every other space and
  // surfaced only as a runtime 500 on the first stage of a run. Rendering it from
  // Terraform is the fix; these assertions are what stop the render drifting from
  // the session name the broker actually sends.
  describe('rendered trust policies', () => {
    it('uses one template that names only the derived broker role principal', () => {
      expect(trustPolicyTemplate).toContain('Principal = { AWS = broker_role_arn }');
      expect(trustPolicyTemplate).toContain('Action    = "sts:AssumeRole"');
      expect(trustPolicyTemplate).not.toContain('Resource');
      expect(
        grantTerraform.match(/broker_role_arn = module\.lambda\.credential_broker_role_arn/g),
      ).toHaveLength(2);
      expect(grantTerraform).not.toMatch(/resource\s+"aws_iam_role"/);
    });

    it('uses the same aidlc- session-name prefix the broker composes', async () => {
      const { ROLE_SESSION_NAME_PREFIX, PREFLIGHT_SESSION_NAME } =
        await import('../../shared/bedrock-role.js');
      expect(grantTerraform).toContain(`"${ROLE_SESSION_NAME_PREFIX}*"`);
      expect(grantTerraform).toContain(`"${ROLE_SESSION_NAME_PREFIX}\${id}"`);
      expect(PREFLIGHT_SESSION_NAME.startsWith(ROLE_SESSION_NAME_PREFIX)).toBe(true);
    });

    it('defaults to the shared form and narrows only when spaces are named', () => {
      const variable = terraformBlock(rootVariables, 'variable "bedrock_role_trusted_space_ids"');
      expect(variable).toContain('default     = []');
      expect(grantTerraform).toContain('length(var.bedrock_role_trusted_space_ids) > 0');
      expect(grantTerraform).toContain('StringLike');
      expect(grantTerraform).toContain('StringEquals');
    });

    it('renders separate same-account and cross-account documents', () => {
      expect(grantTerraform).toContain('bedrock_role_same_account_trust_policy_json');
      expect(grantTerraform).toContain('bedrock_role_cross_account_trust_policy_template_json');
      expect(grantTerraform).toContain(
        '"sts:ExternalId" = local.bedrock_role_external_id_placeholder',
      );
      expect(grantTerraform).toContain(
        'bedrock_role_external_id_placeholder = "$${BEDROCK_EXTERNAL_ID}"',
      );
      // Same-account conditions are passed directly; only the cross-account path
      // merges the platform-generated external-ID substitution marker.
      expect(grantTerraform).toContain('condition       = local.bedrock_role_session_condition');
      expect(grantTerraform).toContain(
        'condition       = local.bedrock_role_cross_account_condition',
      );
    });
  });

  it('wildcards the account in the ceiling render only', () => {
    // The grant names the Bedrock account; the ceiling cannot, because
    // bedrock_assumable_role_arns may span accounts while bedrock_role_account_id names
    // one — an account-pinned ceiling would deny a legitimately bound role elsewhere.
    // Intersection means the role's own narrower scoping still decides.
    expect(grantTerraform).toContain('grant   = local.bedrock_role_account');
    expect(grantTerraform).toContain('ceiling = "*"');
  });

  it('requires a validated ceiling and wires it to both brokers', () => {
    const variable = terraformBlock(brokerVariables, 'variable "bedrock_role_session_policy_json"');
    expect(variable).not.toMatch(/\bdefault\s*=/);
    expect(variable).toContain('length(trimspace(var.bedrock_role_session_policy_json)) > 0');
    expect(variable).toContain('<= 2048');
    expect(variable).toContain('jsondecode(var.bedrock_role_session_policy_json).Version');
    expect(variable).toContain(
      'length(jsondecode(var.bedrock_role_session_policy_json).Statement) > 0',
    );
    expect(variable).toContain(
      'can(jsondecode(var.bedrock_role_session_policy_json).Statement[0])',
    );

    const occurrences = brokerTerraform.match(
      /BEDROCK_SESSION_POLICY\s+=\s+var\.bedrock_role_session_policy_json/g,
    );
    // Once for the value broker, once for the metadata broker running the preflight.
    expect(occurrences).toHaveLength(2);
  });
});
