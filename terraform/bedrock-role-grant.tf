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
# What this file does is render, from one place, the exact two documents an
# operator has to paste into that account — the permission policy and the trust
# policy, both below. Rendering them from Terraform expressions rather than a
# copyable code block in prose means the account id, region wildcards, broker
# principal and condition keys are derived, not retyped. A retyped trust policy
# is how a dev deployment ended up with a single-space `sts:RoleSessionName`
# condition under a platform-scope binding: every space but one was denied, and
# the failure surfaced only on the first stage of a run.
#
# `terraform output -raw bedrock_role_grant_policy_json`
# `terraform output -raw bedrock_role_trust_policy_json`
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
          #
          # Not the same resource as CodexMantleInference below: that one is the
          # legacy bedrock-mantle service's own project namespace.
          Sid      = "CodexOpenAiCompatibleProject"
          Effect   = "Allow"
          Action   = ["bedrock:InvokeModel"]
          Resource = ["arn:${data.aws_partition.current.partition}:bedrock:*:${account}:project/default"]
        },
        {
          # Codex only, LEGACY. con-codex-mantle: Codex 0.145.0 called
          # bedrock-mantle.<region>.api.aws/openai/v1/responses and needed
          # bedrock-mantle:CreateInference; bedrock:InvokeModel does not authorize it.
          #
          # Retained because the Mantle endpoint remains supported and a pinned-version
          # rollback must not also need an IAM change. The current pinned Codex uses
          # the runtime provider above. Measured: Mantle in eu-central-1 serves NO
          # model id (every id 404s, Anthropic included), which is why the provider
          # moved rather than the Region.
          Sid      = "CodexMantleInference"
          Effect   = "Allow"
          Action   = ["bedrock-mantle:CreateInference"]
          Resource = ["arn:${data.aws_partition.current.partition}:bedrock-mantle:*:${account}:project/*"]
        },
      ]
    }
  }

  bedrock_role_grant_policy = local.bedrock_grant_policies["grant"]

  # The session-policy ceiling, minified into the broker's environment. An inline
  # session policy is capped at 2048 characters; this renders to ~0.8 KB.
  bedrock_role_session_policy_json = jsonencode(local.bedrock_grant_policies["ceiling"])

  # ── The trust policy, the customer's own control ──
  #
  # req-session-name-trust-condition. The `aidlc-` prefix is the SAME stability
  # contract as ROLE_SESSION_NAME_PREFIX in lambda/shared/bedrock-role.js, which
  # composes the name the broker actually sends. The two are asserted equal by
  # lambda/credential-broker/test/bedrock-role-iam.test.js, because a trust policy
  # that disagrees with the composed name denies every run — and denies it late,
  # on the first stage, not at bind time.
  #
  # No sts:ExternalId condition is rendered: the external ID is generated per
  # binding when the binding is saved, so Terraform cannot know it. A CROSS-ACCOUNT
  # role must add it by hand from the save response (docs/getting-started/bedrock-credentials.md).
  #
  # One statement base, two conditions. The choice is made on the ENCODED strings,
  # not on the two condition objects: a ternary has to unify its result types, and
  # these conditions are deliberately different shapes (a pattern vs a list).
  bedrock_role_trust_statement = {
    Sid    = "AllowCollaborativeAiDlcCredentialBroker"
    Effect = "Allow"
    # The broker execution role is the only principal holding sts:AssumeRole for
    # customer Bedrock roles, so it is the only principal a trust policy names.
    Principal = { AWS = module.lambda.credential_broker_role_arn }
    Action    = "sts:AssumeRole"
  }

  # Shared by every space. The only form a PLATFORM-SCOPE binding can use, and it
  # admits the `aidlc-preflight` session name that binding's preflight probes with.
  bedrock_role_trust_policy_shared = {
    Version = "2012-10-17"
    Statement = [
      merge(local.bedrock_role_trust_statement, {
        Condition = { StringLike = { "sts:RoleSessionName" = "aidlc-*" } }
      }),
    ]
  }

  # Pinned to named spaces, for a SPACE-SCOPE binding. StringEquals on a closed set
  # is tighter than a pattern when the set is known.
  bedrock_role_trust_policy_spaces = {
    Version = "2012-10-17"
    Statement = [
      merge(local.bedrock_role_trust_statement, {
        Condition = {
          StringEquals = {
            "sts:RoleSessionName" = [for id in var.bedrock_role_trusted_space_ids : "aidlc-${id}"]
          }
        }
      }),
    ]
  }

  bedrock_role_trust_policy_json = length(var.bedrock_role_trusted_space_ids) > 0 ? jsonencode(local.bedrock_role_trust_policy_spaces) : jsonencode(local.bedrock_role_trust_policy_shared)
}
