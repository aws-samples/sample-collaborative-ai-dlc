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
    defaults = { gateway_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:gateway/test-mcp-test-abc", gateway_url = "https://test.gateway.bedrock-agentcore.eu-central-1.amazonaws.com/mcp" }
  }
  mock_data "aws_ecr_image" {
    defaults = { image_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000" }
  }
}
# Native's observed-runtime contract also applies to the shared image. The
# mock engine cannot preserve a null computed nested code artifact (a typed null
# crashes Terraform 1.17). Supply an explicitly incompatible artifact and require
# its rejection below. The production observation expressions, including valid
# container observations, are exercised by terraform-agentcore-runtime-version.
mock_provider "awscc" {
  mock_resource "awscc_bedrockagentcore_runtime" {
    defaults = {
      agent_runtime_id  = "test-runtime-ABC"
      agent_runtime_arn = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:runtime/test-runtime-ABC"
    }
  }
}
override_data {
  target = data.awscc_bedrockagentcore_runtime.stage_executor_observed
  values = {
    status                = "READY"
    agent_runtime_version = "2"
    agent_runtime_id      = "test-runtime-ABC"
    agent_runtime_arn     = "arn:aws:bedrock-agentcore:eu-central-1:123456789012:runtime/test-runtime-ABC"
    agent_runtime_name    = "test_agentcore_test"
    role_arn              = "arn:aws:iam::123456789012:role/test"
    agent_runtime_artifact = {
      container_configuration = { container_uri = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/test@sha256:0000000000000000000000000000000000000000000000000000000000000000" }
      code_configuration = {
        code        = { s3 = { bucket = "incompatible-code-artifact", prefix = "", version_id = "" } }
        entry_point = ["index.py"]
        runtime     = "PYTHON_3_13"
      }
    }
    environment_variables = {
      AWS_SDK_UA_APP_ID                = "Collaborative_AI-DLC-test"
      DISCUSSION_RESULT_FUNCTION       = "arn:aws:lambda:eu-central-1:123456789012:function:test-discussion-result-test"
      V2_WORKSPACE_DIR                 = "/mnt/workspace"
      V2_PROCESS_TABLE                 = "test-v2-executions-test"
      BLOCKS_TABLE                     = "blocks"
      ARTIFACTS_BUCKET                 = "artifacts"
      NEPTUNE_ENDPOINT                 = "neptune.example"
      CONNECTIONS_TABLE                = ""
      WEBSOCKET_ENDPOINT               = ""
      AIDLC_REPO_REF                   = "main"
      BEDROCK_MODEL                    = "model"
      AWS_REGION                       = "eu-central-1"
      CREDENTIAL_BROKER_FUNCTION       = "test-credential-broker-test"
      SOURCE_CONTROL_FUNCTION          = "test-source-control-test"
      MCP_SECRETS_SSM_PREFIX           = "/test/test"
      RUNTIME_COMPATIBILITY_VERSION    = "1"
      NATIVE_INTERACTION_PROBE_ENABLED = "false"
      POWERTOOLS_SERVICE_NAME          = "test"
      POWERTOOLS_LOG_LEVEL             = "INFO"
      BEDROCK_REGION                   = "eu-central-1"
      AIDLC_MCP_GATEWAY_URL            = "https://test.gateway.bedrock-agentcore.eu-central-1.amazonaws.com/mcp"
      AIDLC_MCP_GATEWAY_TARGET         = "aidlc"
    }
  }
}
# The protected native engine runs the single ARM64 platform manifest of the
# runtime image index; an index without exactly one is refused at plan time.
mock_provider "docker" {
  mock_data "docker_registry_image_manifests" {
    defaults = {
      manifests = [{
        architecture  = "arm64"
        os            = "linux"
        media_type    = "application/vnd.oci.image.manifest.v1+json"
        sha256_digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
      }]
    }
  }
}

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
  target  = module.agentcore_image_build
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
  expect_failures = [
    data.awscc_bedrockagentcore_runtime.stage_executor_observed,
  ]
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
