# The runtime version handed to the Lambdas must be the one this apply
# produced. The awscc resource keeps the version it had before an in-place
# update, so the mocked resource below stays on "47" while the read performed
# after the update reports "48".

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

run "create_runtime" {
  command = apply
  module { source = "./modules/compute/agentcore" }
  override_data {
    target = data.awscc_bedrockagentcore_runtime.stage_executor
    values = { agent_runtime_version = "47" }
  }
  assert {
    condition     = output.runtime_version == "47"
    error_message = "The runtime version output must report the created runtime version."
  }
}

run "runtime_update_reports_the_new_version_in_the_same_apply" {
  command = apply
  module { source = "./modules/compute/agentcore" }
  variables { bedrock_model = "another-model" }
  override_data {
    target = data.awscc_bedrockagentcore_runtime.stage_executor
    values = { agent_runtime_version = "48" }
  }
  assert {
    condition     = awscc_bedrockagentcore_runtime.stage_executor.agent_runtime_version == "47"
    error_message = "Test setup: the resource must keep its pre-update version, as the awscc provider does."
  }
  assert {
    condition     = output.runtime_version == "48"
    error_message = "A runtime update must surface its new version in the same apply (issue #710)."
  }
}
