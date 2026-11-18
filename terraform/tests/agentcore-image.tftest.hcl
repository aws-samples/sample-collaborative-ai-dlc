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
}

mock_provider "awscc" {}

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
  build_amd64_image           = true
}

run "builds_image_by_default" {
  command = plan
  module { source = "./modules/compute/agentcore" }
  override_module {
    target  = module.agentcore_docker_build
    outputs = { image_uri = "example.test/agentcore:test" }
  }
  override_module {
    target  = module.agentcore_docker_build_amd64
    outputs = { image_uri = "example.test/agentcore:test-amd64" }
  }
  assert {
    condition     = length(module.agentcore_docker_build) == 1 && length(module.agentcore_docker_build_amd64) == 1
    error_message = "Without image_tag both core images must be built here."
  }
  assert {
    condition     = length(output.image_tag) == 16 && data.aws_ecr_image.agentcore.image_tag == output.image_tag
    error_message = "Without image_tag the image must be tagged with the source content hash."
  }
}

run "uses_prebuilt_image" {
  command = plan
  module { source = "./modules/compute/agentcore" }
  variables { image_tag = "1.2.3" }
  assert {
    condition     = length(module.agentcore_docker_build) == 0 && length(module.agentcore_docker_build_amd64) == 0
    error_message = "A pre-built image_tag must skip both Docker builds."
  }
  assert {
    condition     = data.aws_ecr_image.agentcore.image_tag == "1.2.3" && data.aws_ecr_image.agentcore_amd64[0].image_tag == "1.2.3-amd64"
    error_message = "The pre-built images must be looked up by the supplied tag and its -amd64 variant."
  }
  assert {
    condition     = output.image_tag == "1.2.3"
    error_message = "The image tag output must report the supplied tag."
  }
}
