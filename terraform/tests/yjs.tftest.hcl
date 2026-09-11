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
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/test-yjs" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:test-yjs" }
  }
  mock_resource "aws_dynamodb_table" {
    defaults = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/test-members" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/test/1234567890123456" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/test/1234567890123456" }
  }
}

mock_provider "docker" {}

variables {
  project_name                  = "test"
  environment                   = "prod"
  aws_region                    = "us-east-1"
  vpc_id                        = "vpc-0123456789abcdef0"
  private_subnet_ids            = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
  cognito_user_pool_id          = "us-east-1_test"
  cognito_client_id             = "testclient"
  realtime_doc_secret_param_arn = "arn:aws:ssm:us-east-1:123456789012:parameter/test"
  documents_table_name          = "test-documents"
  documents_table_arn           = "arn:aws:dynamodb:us-east-1:123456789012:table/test-documents"
  snapshots_bucket_name         = "test-snapshots"
  snapshots_bucket_arn          = "arn:aws:s3:::test-snapshots"
}

run "standalone_defaults" {
  command = plan
  module {
    source = "./modules/realtime/yjs-server"
  }
  override_module {
    target  = module.yjs_docker_build
    outputs = { image_uri = "example.test/yjs:test" }
  }
  assert {
    condition     = aws_ecs_task_definition.yjs_server.cpu == "1024" && aws_ecs_task_definition.yjs_server.memory == "2048"
    error_message = "Production must have one vCPU and 2 GiB by default."
  }
  assert {
    condition     = aws_appautoscaling_target.workers.min_capacity == 1 && aws_appautoscaling_target.workers.max_capacity == 1
    error_message = "Standalone must stay at one worker."
  }
  assert {
    condition     = length(aws_dynamodb_table.members) == 0 && length(aws_appautoscaling_policy.resources) == 0
    error_message = "Cluster storage and automatic scaling must be opt-in."
  }
  assert {
    condition     = aws_ecs_service.yjs_server.deployment_maximum_percent == 100 && aws_ecs_service.yjs_server.deployment_minimum_healthy_percent == 0
    error_message = "A single-worker upgrade must stop the old task before starting another owner."
  }
}

run "manual_cluster" {
  command = plan
  module {
    source = "./modules/realtime/yjs-server"
  }
  override_module {
    target  = module.yjs_docker_build
    outputs = { image_uri = "example.test/yjs:test" }
  }
  variables {
    scaling = { cluster_enabled = true, desired_count = 4, cpu = 512, memory = 2048 }
  }
  assert {
    condition     = aws_appautoscaling_target.workers.min_capacity == 4 && aws_appautoscaling_target.workers.max_capacity == 4
    error_message = "Manual scaling must update both bounds to the requested count."
  }
  assert {
    condition     = length(aws_dynamodb_table.members) == 1 && length(aws_iam_role_policy.cluster) == 1
    error_message = "Cluster mode needs membership storage and snapshot permissions."
  }
}

run "automatic_cluster" {
  command = plan
  module {
    source = "./modules/realtime/yjs-server"
  }
  override_module {
    target  = module.yjs_docker_build
    outputs = { image_uri = "example.test/yjs:test" }
  }
  variables {
    scaling = { cluster_enabled = true, cpu = 2048, memory = 4096, autoscaling = { min_capacity = 2, max_capacity = 8 } }
  }
  assert {
    condition     = aws_appautoscaling_target.workers.min_capacity == 2 && aws_appautoscaling_target.workers.max_capacity == 8
    error_message = "Automatic scaling must preserve its bounds."
  }
  assert {
    condition     = aws_appautoscaling_policy.resources["cpu"].target_tracking_scaling_policy_configuration[0].target_value == 30
    error_message = "The CPU target must account for one Node event loop on two allocated vCPUs."
  }
  assert {
    condition     = aws_appautoscaling_policy.capacity[0].target_tracking_scaling_policy_configuration[0].scale_in_cooldown == 600
    error_message = "Scale-in must leave room transfers time to settle."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.yjs_server.container_definitions)[0].stopTimeout == 120
    error_message = "ECS must give the application its checkpoint/drain budget."
  }
}

run "reject_uncoordinated_replicas" {
  command = plan
  module {
    source = "./modules/realtime/yjs-server"
  }
  override_module {
    target  = module.yjs_docker_build
    outputs = { image_uri = "example.test/yjs:test" }
  }
  variables {
    scaling = { desired_count = 2 }
  }
  expect_failures = [var.scaling]
}

run "reject_invalid_fargate_size" {
  command = plan
  module {
    source = "./modules/realtime/yjs-server"
  }
  override_module {
    target  = module.yjs_docker_build
    outputs = { image_uri = "example.test/yjs:test" }
  }
  variables {
    scaling = { cpu = 512, memory = 512 }
  }
  expect_failures = [aws_ecs_task_definition.yjs_server]
}
