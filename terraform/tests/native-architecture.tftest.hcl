mock_provider "aws" {
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_region" { defaults = { region = "us-east-1" } }
  mock_data "aws_partition" { defaults = { partition = "aws", dns_suffix = "amazonaws.com" } }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-1:123456789012:rule/test-native-repair" }
  }
  mock_resource "aws_dynamodb_table" {
    defaults = {
      arn        = "arn:aws:dynamodb:us-east-1:123456789012:table/test-native"
      stream_arn = "arn:aws:dynamodb:us-east-1:123456789012:table/test-native/stream/2026-10-13T00:00:00.000"
    }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:us-east-1:123456789012:test-native", url = "https://sqs.us-east-1.amazonaws.com/123456789012/test-native" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::test-native-publications" }
  }
}

variables {
  native_repair_table_name               = "test-native-repair"
  native_repair_table_arn                = "arn:aws:dynamodb:us-east-1:123456789012:table/test-native-repair"
  project_name                           = "test"
  environment                            = "dev"
  project_ids                            = ["project-one"]
  vpc_id                                 = "vpc-0123456789abcdef0"
  runtime_subnet_ids                     = ["subnet-0123456789abcdef0"]
  api_subnet_ids                         = ["subnet-0123456789abcdef0"]
  api_security_group_ids                 = ["sg-0123456789abcdef0"]
  neptune_endpoint                       = "test-neptune-endpoint"
  neptune_cluster_resource_id            = "test-neptune-cluster-resource-id"
  workflow_source_bindings_table_name    = "test-workflow-source-bindings-table-name"
  workflow_source_bindings_table_arn     = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  package_jobs_table_name                = "test-package-jobs-table-name"
  package_jobs_table_arn                 = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  image_repository_url                   = "123456789012.dkr.ecr.us-east-1.amazonaws.com/test"
  image_repository_arn                   = "arn:aws:ecr:us-east-1:123456789012:repository/test"
  image_digest                           = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  tags                                   = {}
  native_packages_bucket_name            = "test-native-packages-bucket-name"
  native_packages_bucket_arn             = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  source_control_bindings_table_name     = "test-source-control-bindings-table-name"
  source_control_bindings_table_arn      = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  git_connections_table_name             = "test-git-connections-table-name"
  git_connections_table_arn              = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  git_provider_connections_table_name    = "test-git-provider-connections-table-name"
  git_provider_connections_table_arn     = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  github_app_config_param_name           = "test-github-app-config-param-name"
  github_app_config_param_arn            = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  github_app_private_key_secret_name     = "test-github-app-private-key-secret-name"
  github_app_private_key_secret_arn      = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  gitlab_oauth_secret_name               = "test-gitlab-oauth-secret-name"
  gitlab_oauth_secret_arn                = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  gitlab_redirect_uri                    = "test-gitlab-redirect-uri"
  bitbucket_oauth_secret_name            = "test-bitbucket-oauth-secret-name"
  bitbucket_oauth_secret_arn             = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  agent_credential_metadata_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test"
  connections_table_name                 = "test-connections-table-name"
  connections_table_arn                  = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  websocket_endpoint                     = "test-websocket-endpoint"
  websocket_execution_arn                = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  cognito_user_pool_id                   = "test-cognito-user-pool-id"
  cognito_client_id                      = "test-cognito-client-id"
}
run "admission_closed_retains_services_and_owners" {
  # Apply only to the mock provider so generated ARN-dependent policy JSON is
  # fully known. Packaging and Lambda modules are overridden below; no AWS calls.
  command = apply
  module { source = "./modules/compute/native-runs" }
  variables { execution_enabled = false }
  override_module {
    target  = module.packages["api"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["worker"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["authority"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["wakeup"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["execution-worker"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["execution-credentials"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["projection-worker"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["result-worker"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.results
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-results" }
  }
  override_module {
    target  = module.api
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-api", lambda_function_name = "test-api", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-api/invocations" }
  }
  override_module {
    target  = module.worker
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-worker", lambda_function_name = "test-worker", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-worker/invocations" }
  }
  override_module {
    target  = module.authority
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-authority", lambda_function_name = "test-authority", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-authority/invocations" }
  }
  override_module {
    target  = module.wakeup
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-wakeup", lambda_function_name = "test-wakeup", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-wakeup/invocations" }
  }
  override_module {
    target  = module.projection
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-projection", lambda_function_name = "test-projection", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-projection/invocations" }
  }
  override_module {
    target  = module.cancellation_worker
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-cancellation_worker", lambda_function_name = "test-cancellation_worker", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-cancellation_worker/invocations" }
  }
  override_module {
    target  = module.execution_worker[0]
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-execution_worker[0]", lambda_function_name = "test-execution_worker[0]", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-execution_worker[0]/invocations" }
  }
  override_module {
    target  = module.execution_credentials[0]
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-execution_credentials[0]", lambda_function_name = "test-execution_credentials[0]", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-execution_credentials[0]/invocations" }
  }
  assert {
    condition     = length(aws_sqs_queue.execution) == 1 && length(aws_iam_role.execution_worker) == 1 && length(aws_iam_role.execution_credentials) == 1
    error_message = "Admission shutdown must retain existing-run execution and credential resources."
  }
  assert {
    condition     = toset(keys(aws_lambda_alias.authority)) == toset(["commands", "execution", "preparation", "projection", "results"])
    error_message = "Authority must expose exactly the five IAM-isolated caller aliases."
  }
  assert {
    condition     = local.execution_environment.NATIVE_EXECUTION_ENABLED == "true" && local.execution_environment.NATIVE_EXECUTION_ADMISSION_ENABLED == "false"
    error_message = "Admission and existing-run service availability must be independent."
  }
  assert {
    condition     = aws_dynamodb_table.bindings.stream_enabled && aws_dynamodb_table.bindings.stream_view_type == "NEW_AND_OLD_IMAGES"
    error_message = "Committed native state must feed durable wakeups."
  }
  assert {
    condition     = length(local.authority_write_statements[0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]) == 1 && local.authority_write_statements[0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"][0] == "NATIVE#*"
    error_message = "Native authority cannot mutate operator image-revocation partitions."
  }
  assert {
    condition = alltrue([
      for action in flatten([
        for policy in [aws_iam_role_policy.api.policy, aws_iam_role_policy.worker.policy, aws_iam_role_policy.execution_worker[0].policy, aws_iam_role_policy.projection.policy, aws_iam_role_policy.results.policy] :
        [for statement in jsondecode(policy).Statement : statement.Action]
      ]) : !can(regex("^dynamodb:(Put|Update|Delete|Batch|Transact|\\*)", action)) && action != "*"
    ])
    error_message = "Transport and effect adapters must not have direct control-table mutation authority."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.wakeup_errors.alarm_actions) == 0 && length(aws_cloudwatch_metric_alarm.repair_scan_stalled.alarm_actions) == 0 && aws_cloudwatch_metric_alarm.repair_scan_stalled.treat_missing_data == "breaching"
    error_message = "Unconfigured alarms must have no notification actions; absent complete sweeps must remain visible."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.wakeup_checkpoint.policy).Statement[0].Resource == var.native_repair_table_arn && jsondecode(aws_iam_role_policy.wakeup_checkpoint.policy).Statement[0].Condition["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"][0] == "runtime"
    error_message = "Wakeup checkpoint writes must be restricted to the runtime scope of the separate repair table."
  }

}

run "configured_native_alarm_routes" {
  # Apply only to the mock provider so generated ARN-dependent policy JSON is
  # fully known. Packaging and Lambda modules are overridden below; no AWS calls.
  command = apply
  module { source = "./modules/compute/native-runs" }
  variables {
    execution_enabled = false
    native_operations = {
      alarm_actions           = ["arn:aws:sns:us-east-1:123456789012:existing-operations"]
      incident_owner          = "test-operations-reference"
      full_scan_alarm_seconds = 900
    }
  }
  override_module {
    target  = module.packages["api"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["worker"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["authority"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["wakeup"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["execution-worker"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["execution-credentials"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["projection-worker"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.packages["result-worker"]
    outputs = { local_filename = "/tmp/native-test.zip" }
  }
  override_module {
    target  = module.results
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-results" }
  }
  override_module {
    target  = module.api
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-api", lambda_function_name = "test-api", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-api/invocations" }
  }
  override_module {
    target  = module.worker
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-worker", lambda_function_name = "test-worker", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-worker/invocations" }
  }
  override_module {
    target  = module.authority
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-authority", lambda_function_name = "test-authority", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-authority/invocations" }
  }
  override_module {
    target  = module.wakeup
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-wakeup", lambda_function_name = "test-wakeup", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-wakeup/invocations" }
  }
  override_module {
    target  = module.projection
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-projection", lambda_function_name = "test-projection", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-projection/invocations" }
  }
  override_module {
    target  = module.cancellation_worker
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-cancellation_worker", lambda_function_name = "test-cancellation_worker", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-cancellation_worker/invocations" }
  }
  override_module {
    target  = module.execution_worker[0]
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-execution_worker[0]", lambda_function_name = "test-execution_worker[0]", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-execution_worker[0]/invocations" }
  }
  override_module {
    target  = module.execution_credentials[0]
    outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-execution_credentials[0]", lambda_function_name = "test-execution_credentials[0]", lambda_function_version = "1", lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test-execution_credentials[0]/invocations" }
  }
  assert {
    condition     = length(aws_sqs_queue.execution) == 1 && length(aws_iam_role.execution_worker) == 1 && length(aws_iam_role.execution_credentials) == 1
    error_message = "Admission shutdown must retain existing-run execution and credential resources."
  }
  assert {
    condition     = toset(keys(aws_lambda_alias.authority)) == toset(["commands", "execution", "preparation", "projection", "results"])
    error_message = "Authority must expose exactly the five IAM-isolated caller aliases."
  }
  assert {
    condition     = local.execution_environment.NATIVE_EXECUTION_ENABLED == "true" && local.execution_environment.NATIVE_EXECUTION_ADMISSION_ENABLED == "false"
    error_message = "Admission and existing-run service availability must be independent."
  }
  assert {
    condition     = aws_dynamodb_table.bindings.stream_enabled && aws_dynamodb_table.bindings.stream_view_type == "NEW_AND_OLD_IMAGES"
    error_message = "Committed native state must feed durable wakeups."
  }
  assert {
    condition     = length(local.authority_write_statements[0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]) == 1 && local.authority_write_statements[0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"][0] == "NATIVE#*"
    error_message = "Native authority cannot mutate operator image-revocation partitions."
  }
  assert {
    condition = alltrue([
      for action in flatten([
        for policy in [aws_iam_role_policy.api.policy, aws_iam_role_policy.worker.policy, aws_iam_role_policy.execution_worker[0].policy, aws_iam_role_policy.projection.policy, aws_iam_role_policy.results.policy] :
        [for statement in jsondecode(policy).Statement : statement.Action]
      ]) : !can(regex("^dynamodb:(Put|Update|Delete|Batch|Transact|\\*)", action)) && action != "*"
    ])
    error_message = "Transport and effect adapters must not have direct control-table mutation authority."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.wakeup_errors.alarm_actions == toset(var.native_operations.alarm_actions) && aws_cloudwatch_metric_alarm.repair_work_errors.alarm_actions == toset(var.native_operations.alarm_actions) && aws_cloudwatch_metric_alarm.preparation_dead_letters.alarm_actions == toset(var.native_operations.alarm_actions) && aws_cloudwatch_metric_alarm.repair_scan_stalled.period == 900 && strcontains(aws_cloudwatch_metric_alarm.wakeup_errors.alarm_description, "test-operations-reference")
    error_message = "Configured native routes, owner reference and diagnostic window must reach the alarms."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.wakeup_checkpoint.policy).Statement[0].Resource == var.native_repair_table_arn && jsondecode(aws_iam_role_policy.wakeup_checkpoint.policy).Statement[0].Condition["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"][0] == "runtime"
    error_message = "Wakeup checkpoint writes must be restricted to the runtime scope of the separate repair table."
  }

}
