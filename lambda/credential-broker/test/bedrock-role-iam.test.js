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

  it('includes the Codex mantle statement scoped to project/*', () => {
    // con-codex-mantle: Codex needs bedrock-mantle:CreateInference, which
    // bedrock:InvokeModel does not authorize. Present so Codex works the moment
    // its own defects are fixed — no acceptance criterion depends on it
    // succeeding (req-codex-scope, con-codex-model-missing).
    expect(grantCode).toContain('"bedrock-mantle:CreateInference"');
    // `${account}` is the render variable: the grant render substitutes the Bedrock
    // account, the ceiling render substitutes `*`. One definition, two renders.
    expect(grantCode).toContain('bedrock-mantle:*:${account}:project/*');
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
      'bedrock-mantle:CreateInference',
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
// a fourth statement (`project/default`) because the OpenAI-compatible API authorizes
// against that implicit resource; a copied ceiling would have kept three statements and
// 401'd every Codex call while the operator's own policy looked correct.
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
    // Every Sid appears once. A hand-copied ceiling would duplicate all four.
    for (const sid of [
      'InvokeThroughInferenceProfiles',
      'InvokeFoundationModelsOnlyViaInferenceProfile',
      'CodexOpenAiCompatibleProject',
      'CodexMantleInference',
    ]) {
      expect(grantTerraform.match(new RegExp(`Sid\\s+=\\s+"${sid}"`, 'g'))).toHaveLength(1);
    }
    // And the model grant has exactly ONE Statement list. The two trust-policy
    // forms below it hold the others; counting them separately is what keeps this
    // assertion meaningful now that the file renders more than one document.
    expect(grantTerraform.match(/Statement = \[/g)).toHaveLength(3);
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
  describe('rendered trust policy', () => {
    const statement = terraformBlock(grantTerraform, '  bedrock_role_trust_statement = {');
    const shared = terraformBlock(grantTerraform, '  bedrock_role_trust_policy_shared = {');
    const spaces = terraformBlock(grantTerraform, '  bedrock_role_trust_policy_spaces = {');
    const selector = grantTerraform.slice(
      grantTerraform.indexOf('  bedrock_role_trust_policy_json = '),
    );

    it('names the broker role as the principal, derived not retyped', () => {
      expect(statement).toContain('module.lambda.credential_broker_role_arn');
      expect(statement).toContain('Action    = "sts:AssumeRole"');
      // One statement base, so the principal cannot drift between the two forms.
      expect(shared).toContain('merge(local.bedrock_role_trust_statement');
      expect(spaces).toContain('merge(local.bedrock_role_trust_statement');
    });

    it('uses the same aidlc- session-name prefix the broker composes', async () => {
      // The prefix is a stability contract: customers author trust policies on it.
      // If these two ever disagree, every run is denied at credential resolution.
      const { ROLE_SESSION_NAME_PREFIX, PREFLIGHT_SESSION_NAME } =
        await import('../../shared/bedrock-role.js');
      expect(shared).toContain(`"${ROLE_SESSION_NAME_PREFIX}*"`);
      expect(spaces).toContain(`"${ROLE_SESSION_NAME_PREFIX}\${id}"`);
      // The shared form must admit the platform-scope preflight's session name,
      // which is the whole reason the default is StringLike and not StringEquals.
      expect(PREFLIGHT_SESSION_NAME.startsWith(ROLE_SESSION_NAME_PREFIX)).toBe(true);
    });

    it('defaults to the shared form and narrows only when spaces are named', () => {
      const variable = terraformBlock(rootVariables, 'variable "bedrock_role_trusted_space_ids"');
      expect(variable).toContain('default     = []');
      expect(shared).toContain('StringLike');
      expect(spaces).toContain('StringEquals');
      // Selected on the encoded strings: a ternary cannot unify a pattern with a list.
      expect(selector).toContain('length(var.bedrock_role_trusted_space_ids) > 0');
      expect(selector).toContain('jsonencode(local.bedrock_role_trust_policy_spaces)');
      expect(selector).toContain('jsonencode(local.bedrock_role_trust_policy_shared)');
    });

    it('renders no sts:ExternalId condition, because Terraform cannot know it', () => {
      // The external ID is generated per binding at save time. Rendering a
      // placeholder would produce a policy that denies every assume.
      expect(shared).not.toContain('sts:ExternalId');
      expect(spaces).not.toContain('sts:ExternalId');
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

  it('reaches both brokers, so the preflight exercises the call it predicts', () => {
    const occurrences = brokerTerraform.match(
      /BEDROCK_SESSION_POLICY\s+=\s+var\.bedrock_role_session_policy_json/g,
    );
    // Once for the value broker, once for the metadata broker running the preflight.
    expect(occurrences).toHaveLength(2);
    expect(brokerVariables).toContain('variable "bedrock_role_session_policy_json"');
  });
});
