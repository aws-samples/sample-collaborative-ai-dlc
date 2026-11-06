# The built-in MCP behind AgentCore Gateway: the interceptor is the single
# authorization point, the aidlc target only receives the context it injects,
# and only the Gateway role may invoke either Lambda. Mock providers only.
mock_provider "aws" {
  mock_data "aws_partition" { defaults = { partition = "aws", dns_suffix = "amazonaws.com" } }
  mock_data "aws_region" { defaults = { region = "eu-central-1", name = "eu-central-1" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_availability_zones" {
    defaults = {
      zone_ids = ["euc1-az1", "euc1-az2"]
      names    = ["eu-central-1a", "eu-central-1b"]
    }
  }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/test" } }
  mock_resource "aws_kms_key" { defaults = { arn = "arn:aws:kms:eu-central-1:123456789012:key/grant" } }
  mock_resource "aws_dynamodb_table" { defaults = { arn = "arn:aws:dynamodb:eu-central-1:123456789012:table/test" } }
  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:eu-central-1:123456789012:repository/test"
      repository_url = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/test"
    }
  }
  mock_resource "aws_security_group" { defaults = { id = "sg-0123456789abcdef0" } }
  mock_resource "aws_subnet" { defaults = { id = "subnet-0123456789abcdef0" } }
  mock_resource "aws_bedrockagentcore_gateway" {
    defaults = { gateway_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:gateway/test-mcp-test-abc" }
  }
  mock_data "aws_ecr_image" {
    defaults = { image_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000" }
  }
}
mock_provider "awscc" {}
mock_provider "docker" {}

variables {
  aws_sdk_ua_app_id           = "Collaborative_AI-DLC-test"
  project_name                = "test"
  environment                 = "test"
  powertools_service_name     = "test"
  powertools_log_level        = "INFO"
  aws_region                  = "eu-central-1"
  neptune_endpoint            = "neptune.example"
  neptune_cluster_resource_id = "cluster-ABC"
  artifacts_bucket_name       = "artifacts"
  artifacts_bucket_arn        = "arn:aws:s3:::artifacts"
  blocks_table_name           = "blocks"
  aidlc_repo_ref              = "main"
  bedrock_model               = "model"
  bedrock_region              = "eu-central-1"
  network_mode                = "VPC"
  vpc_id                      = "vpc-1"
  vpc_cidr                    = "10.0.0.0/16"
  private_route_table_ids     = ["rtb-1"]
  kms_key_arn                 = "arn:aws:kms:eu-central-1:123456789012:key/data"
  enable_mcp_gateway          = true
}

override_module {
  target  = module.agentcore_docker_build
  outputs = { image_uri = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/agentcore:test" }
}
override_module {
  target  = module.mcp_tools_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:eu-central-1:123456789012:function:test-mcp-tools-test", lambda_function_name = "test-mcp-tools-test" }
}
override_module {
  target  = module.mcp_interceptor_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:eu-central-1:123456789012:function:test-mcp-interceptor-test", lambda_function_name = "test-mcp-interceptor-test" }
}

run "interceptor_guards_the_gateway" {
  command = apply
  module {
    source = "./modules/compute/agentcore"
  }

  assert {
    condition = (
      length(aws_bedrockagentcore_gateway.mcp[0].interceptor_configuration) == 1 &&
      toset(aws_bedrockagentcore_gateway.mcp[0].interceptor_configuration[0].interception_points) == toset(["REQUEST", "RESPONSE"]) &&
      aws_bedrockagentcore_gateway.mcp[0].interceptor_configuration[0].interceptor[0].lambda[0].arn == "arn:aws:lambda:eu-central-1:123456789012:function:test-mcp-interceptor-test" &&
      aws_bedrockagentcore_gateway.mcp[0].interceptor_configuration[0].input_configuration[0].pass_request_headers == true
    )
    error_message = "The Gateway must run the interceptor on REQUEST and RESPONSE with the caller's headers."
  }
  assert {
    condition     = toset(aws_bedrockagentcore_gateway_target.aidlc[0].metadata_configuration[0].allowed_request_headers) == toset(["x-aidlc-context", "x-aidlc-context-policy"])
    error_message = "The aidlc target may only receive the interceptor's context headers, never the grant or session."
  }
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.mcp_gateway[0].policy).Statement : s.Resource
      if contains(flatten([s.Action]), "lambda:InvokeFunction")
      ])) == toset([
      "arn:aws:lambda:eu-central-1:123456789012:function:test-mcp-tools-test",
      "arn:aws:lambda:eu-central-1:123456789012:function:test-mcp-interceptor-test",
    ])
    error_message = "The Gateway role must be able to invoke exactly the tools and interceptor Lambdas."
  }
  assert {
    condition = alltrue(flatten([
      for policy in [aws_iam_role_policy.agentcore.policy, aws_iam_role_policy.agentcore_invoke_mcp_gateway[0].policy] : [
        for s in jsondecode(policy).Statement : s.Effect != "Allow" || alltrue([
          for r in flatten([try(s.Resource, [])]) : !(strcontains(r, "mcp-tools") || strcontains(r, "mcp-interceptor") || r == "*" || endswith(r, "function:*"))
          ]) || !anytrue([
          for a in flatten([s.Action]) : contains(["*", "lambda:*", "lambda:InvokeFunction", "lambda:Invoke*", "lambda:InvokeFunctionUrl"], a)
        ])
      ]
    ]))
    error_message = "The runtime role must not be able to invoke the tools or interceptor Lambdas (any qualifier)."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.agentcore_invoke_mcp_gateway[0].policy).Statement :
      flatten([s.Action]) == ["bedrock-agentcore:InvokeGateway"]
    ])
    error_message = "The runtime may only call InvokeGateway on the Gateway."
  }
  assert {
    condition = (
      contains(flatten([for s in jsondecode(aws_iam_role_policy.mcp_interceptor[0].policy).Statement : s.Action]), "kms:GetPublicKey") &&
      !contains(flatten([for s in jsondecode(aws_iam_role_policy.mcp_tools[0].policy).Statement : s.Action]), "kms:GetPublicKey")
    )
    error_message = "Only the interceptor verifies grants, so only it reads the grant public key."
  }
  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.mcp_interceptor[0].policy).Statement : s.Action])) == toset([
      "kms:GetPublicKey",
      "neptune-db:ReadDataViaQuery",
      "neptune-db:connect",
      "dynamodb:GetItem",
    ])
    error_message = "The interceptor is read-only: grant public key, intent ownership and the execution/stage rows."
  }
}

run "nothing_exists_without_the_gateway" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_mcp_gateway = false
  }

  assert {
    condition = (
      length(aws_bedrockagentcore_gateway.mcp) == 0 &&
      length(aws_iam_role.mcp_interceptor) == 0 &&
      length(aws_iam_role_policy.mcp_gateway) == 0
    )
    error_message = "With the Gateway off, neither the interceptor nor its grants may exist."
  }
}
