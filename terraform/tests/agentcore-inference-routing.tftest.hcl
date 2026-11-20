# Inference routing a deployment opts into reaches the runtime, and through the
# same output every managed environment runtime, only when it is configured. A
# default deployment keeps the environment it had: an added key would otherwise
# change every published environment's protected environment.

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
    defaults = { zone_ids = ["use1-az1", "use1-az2"], names = ["us-east-1a", "us-east-1b"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  # Applied (not only planned) below, so the values the runtime validates need
  # a realistic shape.
  mock_data "aws_ecr_image" {
    defaults = { image_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/test-agentcore" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/test" }
  }
}

mock_provider "awscc" {
  mock_resource "awscc_bedrockagentcore_runtime" {
    defaults = {
      id                    = "test_agentcore_test-abc123"
      agent_runtime_id      = "test_agentcore_test-abc123"
      agent_runtime_version = "47"
    }
  }
}

mock_provider "docker" {}

variables {
  aws_sdk_ua_app_id           = "Collaborative_AI-DLC-test"
  project_name                = "test"
  environment                 = "test"
  powertools_service_name     = "test-agentcore"
  powertools_log_level        = "INFO"
  aws_region                  = "us-east-1"
  neptune_endpoint            = "neptune.test"
  neptune_cluster_resource_id = "cluster-TEST"
  artifacts_bucket_name       = "test-artifacts"
  artifacts_bucket_arn        = "arn:aws:s3:::test-artifacts"
  blocks_table_name           = "test-blocks"
  aidlc_repo_ref              = "main"
  bedrock_model               = "test-model"
  bedrock_region              = "us-east-1"
  network_mode                = "PUBLIC"
  image_tag                   = "1.2.3"
}

run "amazon_bedrock_by_default" {
  command = apply
  module { source = "./modules/compute/agentcore" }
  override_data {
    target = data.awscc_bedrockagentcore_runtime.stage_executor
    values = { agent_runtime_version = "47" }
  }
  assert {
    condition = length(setintersection(keys(output.runtime_environment_variables), [
      "BEDROCK_GATEWAY_URL",
      "BEDROCK_GATEWAY_DISABLE_CONTENT_TYPE_GUARD",
      "AIDLC_MODEL_ALIASES",
    ])) == 0
    error_message = "Without the gateway and alias settings the runtime environment must not name them."
  }
}

run "gateway_and_aliases_reach_the_runtime" {
  command = apply
  module { source = "./modules/compute/agentcore" }
  variables {
    bedrock_region                             = "eu-central-1"
    bedrock_gateway_url                        = "https://gateway.example.com"
    bedrock_gateway_disable_content_type_guard = true
    bedrock_model_aliases = {
      opus  = "eu.anthropic.claude-opus-5-5"
      haiku = "eu.anthropic.claude-haiku-5-5"
    }
  }
  override_data {
    target = data.awscc_bedrockagentcore_runtime.stage_executor
    values = { agent_runtime_version = "47" }
  }
  assert {
    condition     = output.runtime_environment_variables.BEDROCK_GATEWAY_URL == "https://gateway.example.com"
    error_message = "The runtime must receive the Bedrock gateway URL."
  }
  assert {
    condition     = output.runtime_environment_variables.BEDROCK_GATEWAY_DISABLE_CONTENT_TYPE_GUARD == "true"
    error_message = "The runtime must receive the content-type switch as the string the Claude driver reads."
  }
  assert {
    condition = jsondecode(output.runtime_environment_variables.AIDLC_MODEL_ALIASES) == {
      opus  = "eu.anthropic.claude-opus-5-5"
      haiku = "eu.anthropic.claude-haiku-5-5"
    }
    error_message = "The runtime must receive the configured aliases as the JSON object the model resolver reads."
  }
  assert {
    condition     = awscc_bedrockagentcore_runtime.stage_executor.environment_variables["BEDROCK_GATEWAY_URL"] == "https://gateway.example.com"
    error_message = "The Standard runtime must run with the environment that managed runtimes inherit."
  }
}

run "content_type_switch_needs_a_gateway" {
  command = apply
  module { source = "./modules/compute/agentcore" }
  variables {
    bedrock_gateway_disable_content_type_guard = true
  }
  override_data {
    target = data.awscc_bedrockagentcore_runtime.stage_executor
    values = { agent_runtime_version = "47" }
  }
  assert {
    condition     = !contains(keys(output.runtime_environment_variables), "BEDROCK_GATEWAY_DISABLE_CONTENT_TYPE_GUARD")
    error_message = "The content-type switch belongs to the gateway and must not reach a runtime that calls Amazon Bedrock."
  }
}
