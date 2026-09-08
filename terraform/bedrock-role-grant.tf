# =============================================================================
# Bedrock IAM-role credential mode — the customer-side role grant
#
# specs/bedrock-iam-role-credential-mode: req-model-grant-families,
# req-least-privilege-assume, req-same-and-cross-account.
#
# The role that the credential broker assumes is NOT created here. It belongs to
# whoever owns the Bedrock account, which under a central-Bedrock-account topology
# is a different account from this deployment. Terraform cannot create a role in
# an account it does not manage, and it must not: the trust policy is the
# customer's authoritative control over who may assume it.
#
# What this file does is render, from one place, the exact documents an
# operator needs in that account: the permission policy plus same-account and
# cross-account trust-policy forms. Rendering them from Terraform expressions
# rather than copyable code blocks in prose means the account id, region
# wildcards, broker principal and condition keys are derived, not retyped. A
# retyped trust policy is how a dev deployment ended up with a single-space
# `sts:RoleSessionName` condition under a platform-scope binding: every space but
# one was denied, and the failure surfaced only on the first stage of a run.
#
# `terraform output -raw bedrock_role_grant_policy_json`
# `terraform output -raw bedrock_role_same_account_trust_policy_json`
# `terraform output -raw bedrock_role_cross_account_trust_policy_template_json`
# `terraform output -raw credential_broker_role_arn`
# =============================================================================

# Needed to default the Bedrock role account to this deployment's own account.
data "aws_caller_identity" "current" {}

# The three inputs this file reads are declared in variables.tf with every other
# root variable: bedrock_role_account_id, bedrock_assumable_role_arns and
# bedrock_role_trusted_space_ids.

locals {
  bedrock_role_account = coalesce(
    var.bedrock_role_account_id != "" ? var.bedrock_role_account_id : null,
    data.aws_caller_identity.current.account_id,
  )

  # ── One statement definition, rendered for two audiences ──
  #
  # `grant` is the customer-facing permission policy an operator attaches to the
  # Bedrock role. `ceiling` is the SESSION POLICY the broker attaches on every
  # AssumeRole (req-least-privilege-assume), which caps what a minted credential can
  # do regardless of what the assumed role's own policy happens to allow.
  #
  # Both come from this ONE definition on purpose. The grant is only ADVICE — the
  # role lives in an account this deployment does not manage, so nothing verifies the
  # operator attached it, or that they attached nothing wider. The ceiling is the
  # enforcement, and a ceiling that drifts from the grant is worse than none: it
  # would deny a call the documented grant permits. That is not hypothetical. When
  # Codex moved to the Bedrock Runtime provider the grant needed a fourth statement
  # (`project/default`); a hand-copied ceiling would have kept the three-statement
  # shape and 401'd every Codex call, naming a resource the operator had already
  # allowed.
  #
  # The renders differ in exactly one way: the ceiling wildcards the ACCOUNT. The
  # grant names the Bedrock account because a role's own policy should be scoped to
  # the models that account owns, but bedrock_assumable_role_arns may span accounts
  # while bedrock_role_account_id names only one, so an account-pinned ceiling would
  # deny a legitimately bound role in another account. Wildcarding costs nothing: a
  # session policy INTERSECTS with the role's policy, so the role's own — narrower —
  # resource scoping still decides. The ceiling constrains ACTIONS and keeps the
  # inference-profile fence; it is not a second place to express model scope.
  bedrock_grant_render_accounts = {
    grant   = local.bedrock_role_account
    ceiling = "*"
  }

  bedrock_grant_policies = {
    for render, account in local.bedrock_grant_render_accounts : render => {
      Version = "2012-10-17"
      Statement = [
        {
          # Inference-profile patterns, never enumerations.
          #
          # con-claude-model-fanout: Claude Code invokes models beyond the configured
          # one (a run pinned to sonnet-5 also called opus-5 and haiku-4-5), so any
          # allowlist narrower than the provider family breaks real runs.
          #
          # con-gpt-global-cris-only: GPT is reachable ONLY through global CRIS. There
          # is deliberately no `eu.openai.*` pattern because no such profile exists —
          # adding one would imply a capability that does not.
          Sid    = "InvokeThroughInferenceProfiles"
          Effect = "Allow"
          Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
          Resource = [
            "arn:${data.aws_partition.current.partition}:bedrock:*:${account}:inference-profile/eu.anthropic.claude-*",
            "arn:${data.aws_partition.current.partition}:bedrock:*:${account}:inference-profile/global.anthropic.claude-*",
            "arn:${data.aws_partition.current.partition}:bedrock:*:${account}:inference-profile/global.openai.gpt-*",
          ]
        },
        {
          # Foundation-model ARNs are account-less and region-wildcarded, then FENCED
          # by a StringLike condition on bedrock:InferenceProfileArn.
          # con-fm-fence-works: a bare foundation-model id resolves to direct
          # invocation and is denied by the condition, which forces every call through
          # an inference profile by design. Verified live on 2026-09-07 for the ceiling
          # render too: a bare `anthropic.claude-sonnet-4-5` invoke is denied under the
          # session policy while the `eu.` profile succeeds.
          Sid    = "InvokeFoundationModelsOnlyViaInferenceProfile"
          Effect = "Allow"
          Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
          Resource = [
            "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/anthropic.claude-*",
            "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/openai.gpt-*",
          ]
          Condition = {
            StringLike = {
              "bedrock:InferenceProfileArn" = "arn:${data.aws_partition.current.partition}:bedrock:*:${account}:inference-profile/*"
            }
          }
        },
        {
          # Codex only. con-codex-runtime-provider: Codex >= 0.149.1 with
          # model_provider = "amazon-bedrock-runtime" calls
          # bedrock-runtime.<region>.amazonaws.com/openai/v1/responses. That
          # OpenAI-compatible API authorizes bedrock:InvokeModel against the Region's
          # implicit `project/default` resource IN ADDITION to the model, so without
          # this statement every call fails 401 naming that exact resource — measured,
          # with the model itself already allowed by the statements above.
          Sid      = "CodexOpenAiCompatibleProject"
          Effect   = "Allow"
          Action   = ["bedrock:InvokeModel"]
          Resource = ["arn:${data.aws_partition.current.partition}:bedrock:*:${account}:project/default"]
        },
      ]
    }
  }

  bedrock_role_grant_policy = local.bedrock_grant_policies["grant"]

  # The session-policy ceiling, minified into the broker's environment. An inline
  # session policy is capped at 2048 characters; this renders to ~0.8 KB.
  bedrock_role_session_policy_json = jsonencode(local.bedrock_grant_policies["ceiling"])

  # ── Trust policies, owned and attached by the Bedrock account operator ──
  #
  # Terraform renders the documents but deliberately creates no customer
  # inference role. Both forms use one template so the principal and action
  # cannot drift: the broker execution role is the only principal, and the
  # only action is sts:AssumeRole.
  #
  # req-session-name-trust-condition. The `aidlc-` prefix is the SAME stability
  # contract as ROLE_SESSION_NAME_PREFIX in lambda/shared/bedrock-role.js. The
  # default StringLike form admits every space and the `aidlc-preflight` probe
  # needed by a platform-scope binding. Operators may instead provide a closed
  # set of space ids, which renders StringEquals entries for those sessions.
  bedrock_role_session_condition_json = length(var.bedrock_role_trusted_space_ids) > 0 ? jsonencode({
    StringEquals = {
      "sts:RoleSessionName" = [for id in var.bedrock_role_trusted_space_ids : "aidlc-${id}"]
    }
    }) : jsonencode({
    StringLike = {
      "sts:RoleSessionName" = "aidlc-*"
    }
  })
  bedrock_role_session_condition = jsondecode(local.bedrock_role_session_condition_json)

  bedrock_role_trust_policy_template = "${path.module}/templates/bedrock-role-trust-policy.json.tftpl"

  # Same-account trust does not need an external ID because the principal is a
  # role in the same account. This render is ready to attach as-is.
  bedrock_role_same_account_trust_policy_json = templatefile(
    local.bedrock_role_trust_policy_template,
    {
      broker_role_arn = module.lambda.credential_broker_role_arn
      condition       = local.bedrock_role_session_condition
    },
  )

  # Cross-account trust must use the binding's platform-generated external ID.
  # Terraform cannot know that runtime value and must never generate a competing
  # one, so this is intentionally a substitution template. An authorized operator
  # replaces ${BEDROCK_EXTERNAL_ID} with the exact value returned by the binding
  # API/UI before attaching the policy; leaving the marker unchanged fails closed.
  bedrock_role_external_id_placeholder = "$${BEDROCK_EXTERNAL_ID}"
  bedrock_role_cross_account_condition = merge(
    local.bedrock_role_session_condition,
    {
      StringEquals = merge(
        try(local.bedrock_role_session_condition.StringEquals, {}),
        { "sts:ExternalId" = local.bedrock_role_external_id_placeholder },
      )
    },
  )
  bedrock_role_cross_account_trust_policy_template_json = templatefile(
    local.bedrock_role_trust_policy_template,
    {
      broker_role_arn = module.lambda.credential_broker_role_arn
      condition       = local.bedrock_role_cross_account_condition
    },
  )

  # Backward-compatible alias. Its old contract omitted ExternalId, so it remains
  # the ready-to-attach same-account document; cross-account callers must use the
  # explicitly named template output above.
  bedrock_role_trust_policy_json = local.bedrock_role_same_account_trust_policy_json
}
