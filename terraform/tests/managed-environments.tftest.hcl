mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_iam_role" {
    override_during = plan
    defaults        = { arn = "arn:aws:iam::123456789012:role/test" }
  }
}

variables {
  project_name                  = "test"
  environment                   = "test"
  powertools_service_name       = "test"
  powertools_log_level          = "INFO"
  powertools_log_event          = false
  registry_table_name           = "test-registry"
  registry_table_arn            = "arn:aws:dynamodb:us-east-1:123456789012:table/test-registry"
  core_image_uri                = "123456789012.dkr.ecr.us-east-1.amazonaws.com/core"
  core_image_digest             = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  core_image_size_bytes         = 1
  core_runtime_arn              = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/core"
  core_runtime_version          = "1"
  runtime_compatibility_version = "1"
  runtime_role_arn              = "arn:aws:iam::123456789012:role/runtime"
  runtime_network_mode          = "VPC"
  runtime_subnet_ids            = ["subnet-1"]
  runtime_security_group_ids    = ["sg-1"]
  runtime_environment_variables = {}
  core_repository_arn           = "arn:aws:ecr:us-east-1:123456789012:repository/core"
  environment_repository_name   = "envs"
  environment_repository_url    = "123456789012.dkr.ecr.us-east-1.amazonaws.com/envs"
  environment_repository_arn    = "arn:aws:ecr:us-east-1:123456789012:repository/envs"
  cors_allowed_origins          = "*"
}

# The Lambda packages are built by the upstream module at plan time; the
# assertions here only concern IAM and the environment both lambdas receive.
override_module {
  target  = module.control_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:control", lambda_function_name = "control", lambda_function_invoke_arn = "arn:aws:apigateway:invoke/control" }
}
override_module {
  target  = module.status_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:status", lambda_function_name = "status" }
}
override_module {
  target  = module.tool_control_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:tool-control", lambda_function_name = "tool-control", lambda_function_invoke_arn = "arn:aws:apigateway:invoke/tool-control" }
}
override_module {
  target  = module.tool_status_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:tool-status", lambda_function_name = "tool-status" }
}

run "session_cleanup_survives_disabling_instances" {
  command = plan
  module {
    source = "./modules/compute/managed-environments"
  }
  variables {
    instances_compute_enabled = false
  }

  assert {
    condition     = length(aws_iam_role_policy.status_instances) == 0
    error_message = "Provisioning grants must stay gated by instances_compute_enabled."
  }
  assert {
    condition = contains(
      flatten([for s in jsondecode(aws_iam_role_policy.status_session_cleanup.policy).Statement : s.Action]),
      "bedrock-agentcore:DeleteCapacityProviderSession",
    )
    error_message = "The poller must keep DeleteCapacityProviderSession with the feature off, so queued releases still complete."
  }
  assert {
    condition     = aws_iam_role.instances_operator.name == "test-instances-operator-test"
    error_message = "The operator role must exist with the feature off (live capacity providers reference it)."
  }
  assert {
    condition = (
      local.instances_compute_environment.MANAGED_INSTANCES_OPERATOR_ROLE_ARN == "" &&
      local.instances_compute_environment.MANAGED_INSTANCES_SUBNETS == "[]"
    )
    error_message = "With the feature off the lambdas must not see Instances as configured."
  }
}

run "one_instances_configuration_for_both_lambdas" {
  command = plan
  module {
    source = "./modules/compute/managed-environments"
  }
  variables {
    instances_compute_enabled              = true
    instances_allowed_instance_types       = ["c7i.large"]
    instances_allowed_instance_types_arm64 = []
  }

  assert {
    condition     = length(aws_iam_role_policy.status_instances) == 1
    error_message = "Provisioning grants must exist when the feature is enabled."
  }
  assert {
    condition     = local.instances_compute_environment.MANAGED_INSTANCES_OPERATOR_ROLE_ARN == aws_iam_role.instances_operator.arn
    error_message = "With the feature on the lambdas must see the operator role."
  }
  assert {
    condition = (
      local.instances_compute_environment.MANAGED_INSTANCES_ALLOWED_TYPES == jsonencode(["c7i.large"]) &&
      local.instances_compute_environment.MANAGED_INSTANCES_ALLOWED_TYPES_ARM64 == jsonencode([])
    )
    error_message = "Custom and empty allowlists must reach the lambdas as configured."
  }
  assert {
    condition = !contains(
      flatten([for s in jsondecode(aws_iam_role_policy.status_instances[0].policy).Statement : s.Action]),
      "bedrock-agentcore:DeleteCapacityProviderSession",
    )
    error_message = "Session cleanup belongs to the ungated policy only."
  }
}
