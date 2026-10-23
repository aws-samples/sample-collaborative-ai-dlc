# The runtime role across the engine-data rollout: unchanged until runtime
# grants are enforced, then reduced to the remote paths only.
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
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"], zone_ids = ["use1-az1", "use1-az2"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_ecr_repository" {
    override_during = plan
    defaults        = { arn = "arn:aws:ecr:us-east-1:123456789012:repository/test" }
  }
  mock_resource "aws_dynamodb_table" {
    override_during = plan
    defaults        = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/test-v2-executions" }
  }
  mock_resource "aws_ssm_parameter" {
    override_during = plan
    defaults        = { arn = "arn:aws:ssm:us-east-1:123456789012:parameter/test/test/models" }
  }
}

mock_provider "awscc" {}

override_module {
  target  = module.agentcore_docker_build
  outputs = { image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/test:tag" }
}
override_module {
  target  = module.engine_data_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-engine-data-test", lambda_function_name = "test-engine-data-test" }
}
override_module {
  target  = module.mcp_tools_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-mcp-tools-test", lambda_function_name = "test-mcp-tools-test" }
}

variables {
  aws_sdk_ua_app_id           = "Collaborative_AI-DLC-test"
  project_name                = "test"
  environment                 = "test"
  powertools_service_name     = "test"
  powertools_log_level        = "INFO"
  aws_region                  = "us-east-1"
  neptune_endpoint            = "neptune.example"
  neptune_cluster_resource_id = "cluster-TEST"
  artifacts_bucket_name       = "test-artifacts"
  artifacts_bucket_arn        = "arn:aws:s3:::test-artifacts"
  blocks_table_name           = "test-blocks"
  blocks_table_arn            = "arn:aws:dynamodb:us-east-1:123456789012:table/test-blocks"
  connections_table_name      = "test-connections"
  connections_table_arn       = "arn:aws:dynamodb:us-east-1:123456789012:table/test-connections"
  websocket_endpoint          = "https://ws.example"
  websocket_execution_arn     = "arn:aws:execute-api:us-east-1:123456789012:ws1/test"
  aidlc_repo_ref              = "main"
  bedrock_model               = "test-model"
  bedrock_region              = "us-east-1"
  kms_key_arn                 = "arn:aws:kms:us-east-1:123456789012:key/test"
  network_mode                = "VPC"
  vpc_id                      = "vpc-1"
  vpc_cidr                    = "10.0.0.0/16"
  private_route_table_ids     = ["rtb-1"]
}

run "flag_off_keeps_direct_access" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_mcp_gateway     = false
    enable_engine_data     = false
    enforce_runtime_grants = false
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : s if contains(s.Action, "dynamodb:ConditionCheckItem")]) == 1
    error_message = "Direct-path runtimes need ConditionCheckItem for workflow checkpoints."
  }
  assert {
    condition = alltrue([for prefix in ["neptune-db:", "dynamodb:", "s3:", "ssm:", "execute-api:"] : anytrue([
      for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : anytrue([for a in s.Action : startswith(a, prefix)])
    ])])
    error_message = "The flag-off runtime role must keep its direct data access."
  }
  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : s.Resource if contains(s.Action, "lambda:InvokeFunction")]), "arn:aws:lambda:us-east-1:123456789012:function:test-source-control-test")
    error_message = "The flag-off runtime role must keep the unqualified source-control function."
  }
  assert {
    condition     = contains(keys(output.runtime_environment_variables), "NEPTUNE_ENDPOINT")
    error_message = "The flag-off runtime keeps its direct-client configuration."
  }
}

run "transition_keeps_direct_access" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_mcp_gateway     = true
    enable_engine_data     = true
    enforce_runtime_grants = false
  }

  assert {
    condition = alltrue([for prefix in ["neptune-db:", "dynamodb:", "s3:", "ssm:", "execute-api:"] : anytrue([
      for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : anytrue([for a in s.Action : startswith(a, prefix)])
    ])])
    error_message = "Legacy runtimes still need their direct data access while the broker serves them."
  }
  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : s.Resource if contains(s.Action, "lambda:InvokeFunction")]), "arn:aws:lambda:us-east-1:123456789012:function:test-source-control-test")
    error_message = "Legacy runtimes still call the unqualified source-control function."
  }
  assert {
    condition     = contains(keys(output.runtime_environment_variables), "ARTIFACTS_BUCKET")
    error_message = "The transition runtime keeps its direct-client configuration."
  }
}

run "enforced_grants_strip_direct_access" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_mcp_gateway     = true
    enable_engine_data     = true
    enforce_runtime_grants = true
  }

  assert {
    condition = !anytrue(flatten([
      for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : [
        for a in s.Action : anytrue([for prefix in ["neptune-db:", "dynamodb:", "s3:", "ssm:", "execute-api:"] : startswith(a, prefix)])
      ]
    ]))
    error_message = "The enforced runtime role must hold no Neptune, DynamoDB, S3, SSM or websocket access."
  }
  assert {
    condition     = flatten([for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : s.Resource if contains(s.Action, "lambda:InvokeFunction")]) == ["arn:aws:lambda:us-east-1:123456789012:function:test-credential-broker-test"]
    error_message = "The enforced runtime role invokes only the broker from its base policy."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.agentcore_invoke_engine_data[0].policy).Statement[0].Resource == [
      "arn:aws:lambda:us-east-1:123456789012:function:test-engine-data-test",
      "arn:aws:lambda:us-east-1:123456789012:function:test-source-control-test:runtime",
    ]
    error_message = "engine-data and the source-control runtime alias stay invocable."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : s
      if s.Effect == "Deny" && contains(s.Action, "sts:AssumeRole")
    ]) == 1
    error_message = "The runtime role keeps its Deny on sts:AssumeRole."
  }
  assert {
    condition = length(setintersection(keys(output.runtime_environment_variables), [
      "BLOCKS_TABLE", "ARTIFACTS_BUCKET", "NEPTUNE_ENDPOINT", "CONNECTIONS_TABLE", "WEBSOCKET_ENDPOINT", "MCP_SECRETS_SSM_PREFIX",
    ])) == 0
    error_message = "The enforced runtime gets no direct-client configuration."
  }
  assert {
    condition     = output.runtime_environment_variables.SOURCE_CONTROL_FUNCTION == "arn:aws:lambda:us-east-1:123456789012:function:test-source-control-test:runtime"
    error_message = "The enforced runtime calls source-control through its runtime alias."
  }
}
