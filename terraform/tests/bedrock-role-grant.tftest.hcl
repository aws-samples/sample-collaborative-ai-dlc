mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = {
      partition  = "aws"
      dns_suffix = "amazonaws.com"
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/terraform-test"
      user_id    = "AIDATERRAFORMTEST"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

mock_provider "awscc" {}
mock_provider "random" {}
mock_provider "time" {}

run "generated_bedrock_inference_grant" {
  command = plan

  plan_options {
    target = [
      data.aws_caller_identity.current,
      data.aws_partition.current,
    ]
  }

  variables {
    bedrock_role_account_id = "123456789012"
  }

  assert {
    condition = toset(one([
      for statement in jsondecode(output.bedrock_role_grant_policy_json).Statement : statement.Resource
      if statement.Sid == "InvokeThroughInferenceProfiles"
      ])) == toset([
      "arn:aws:bedrock:*:123456789012:inference-profile/eu.anthropic.claude-*",
      "arn:aws:bedrock:*:123456789012:inference-profile/global.anthropic.claude-*",
      "arn:aws:bedrock:*:123456789012:inference-profile/global.openai.gpt-*",
    ])
    error_message = "The generated grant must contain the supported Claude and Codex inference-profile families."
  }

  assert {
    condition = toset(one([
      for statement in jsondecode(output.bedrock_role_grant_policy_json).Statement : statement.Action
      if statement.Sid == "InvokeThroughInferenceProfiles"
      ])) == toset([
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ])
    error_message = "Inference profiles must permit both regular and streaming Bedrock Runtime invocation."
  }

  assert {
    condition = toset(one([
      for statement in jsondecode(output.bedrock_role_grant_policy_json).Statement : statement.Resource
      if statement.Sid == "InvokeFoundationModelsOnlyViaInferenceProfile"
      ])) == toset([
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
      "arn:aws:bedrock:*::foundation-model/openai.gpt-*",
    ])
    error_message = "The generated grant must include the supported foundation-model families."
  }

  assert {
    condition = one([
      for statement in jsondecode(output.bedrock_role_grant_policy_json).Statement : statement.Condition.StringLike["bedrock:InferenceProfileArn"]
      if statement.Sid == "InvokeFoundationModelsOnlyViaInferenceProfile"
    ]) == "arn:aws:bedrock:*:123456789012:inference-profile/*"
    error_message = "Foundation-model invocation must remain fenced to an inference profile."
  }

  assert {
    condition = toset(one([
      for statement in jsondecode(output.bedrock_role_grant_policy_json).Statement : statement.Action
      if statement.Sid == "InvokeFoundationModelsOnlyViaInferenceProfile"
      ])) == toset([
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ])
    error_message = "Foundation models must permit both regular and streaming Bedrock Runtime invocation."
  }

  assert {
    condition = one([
      for statement in jsondecode(output.bedrock_role_grant_policy_json).Statement : statement
      if statement.Sid == "CodexOpenAiCompatibleProject"
      ]) == {
      Sid      = "CodexOpenAiCompatibleProject"
      Effect   = "Allow"
      Action   = ["bedrock:InvokeModel"]
      Resource = ["arn:aws:bedrock:*:123456789012:project/default"]
    }
    error_message = "Codex Runtime must be authorized against the implicit project/default resource."
  }

  assert {
    condition = length([
      for action in flatten([
        for statement in jsondecode(output.bedrock_role_grant_policy_json).Statement : statement.Action
      ]) : action
      if startswith(action, "bedrock-mantle:")
    ]) == 0
    error_message = "The generated inference grant must not contain legacy bedrock-mantle actions."
  }
}

run "rendered_bedrock_trust_policies" {
  command = plan

  plan_options {
    target = [module.lambda.aws_iam_role.credential_broker]
  }

  override_resource {
    target          = module.lambda.aws_iam_role.credential_broker
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:role/collaborative-ai-dlc-credential-broker-dev"
    }
  }

  assert {
    condition = one(jsondecode(output.bedrock_role_same_account_trust_policy_json).Statement).Principal == {
      AWS = "arn:aws:iam::123456789012:role/collaborative-ai-dlc-credential-broker-dev"
    }
    error_message = "The same-account trust policy must name only the credential broker role."
  }

  assert {
    condition     = one(jsondecode(output.bedrock_role_same_account_trust_policy_json).Statement).Action == "sts:AssumeRole"
    error_message = "The trust policy must grant only sts:AssumeRole."
  }

  assert {
    condition     = one(jsondecode(output.bedrock_role_same_account_trust_policy_json).Statement).Condition.StringLike["sts:RoleSessionName"] == "aidlc-*"
    error_message = "The default same-account trust policy must admit the stable aidlc-* role-session prefix."
  }

  assert {
    condition     = try(one(jsondecode(output.bedrock_role_same_account_trust_policy_json).Statement).Condition.StringEquals["sts:ExternalId"], null) == null
    error_message = "The same-account trust policy must not require an external ID."
  }

  assert {
    condition     = one(jsondecode(output.bedrock_role_cross_account_trust_policy_template_json).Statement).Principal.AWS == "arn:aws:iam::123456789012:role/collaborative-ai-dlc-credential-broker-dev"
    error_message = "The cross-account template must name the same credential broker role."
  }

  assert {
    condition     = one(jsondecode(output.bedrock_role_cross_account_trust_policy_template_json).Statement).Condition.StringLike["sts:RoleSessionName"] == "aidlc-*"
    error_message = "The cross-account template must admit the stable aidlc-* role-session prefix."
  }

  assert {
    condition     = one(jsondecode(output.bedrock_role_cross_account_trust_policy_template_json).Statement).Condition.StringEquals["sts:ExternalId"] == "$${BEDROCK_EXTERNAL_ID}"
    error_message = "The cross-account template must require substitution of the platform-generated external ID."
  }

  assert {
    condition     = output.bedrock_role_trust_policy_json == output.bedrock_role_same_account_trust_policy_json
    error_message = "The compatibility trust-policy output must remain the same-account document."
  }
}
