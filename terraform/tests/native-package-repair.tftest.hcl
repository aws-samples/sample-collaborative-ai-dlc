mock_provider "aws" {
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_region" { defaults = { region = "us-east-1" } }
  mock_data "aws_partition" { defaults = { partition = "aws", dns_suffix = "amazonaws.com" } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/test" } }
  mock_resource "aws_cloudwatch_event_rule" { defaults = { arn = "arn:aws:events:us-east-1:123456789012:rule/test" } }
  mock_resource "aws_sqs_queue" { defaults = { arn = "arn:aws:sqs:us-east-1:123456789012:test", url = "https://sqs.us-east-1.amazonaws.com/123456789012/test" } }
}
variables {
  aws_sdk_ua_app_id                        = "Collaborative_AI-DLC-test"
  agent_credential_grant_secret_param_arn  = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  agent_credential_grant_secret_param_name = "test"
  agentcore_runtime_arn                    = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test"
  aidlc_repo_ref                           = "test"
  application_url                          = "https://example.test"
  artifacts_bucket_arn                     = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  artifacts_bucket_name                    = "test"
  blocks_table_arn                         = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  blocks_table_name                        = "test"
  cognito_user_pool_arn                    = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_test"
  cognito_user_pool_id                     = "us-east-1_test"
  connections_table_arn                    = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  connections_table_name                   = "test"
  core_image_digest                        = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  core_runtime_version                     = "1"
  discussion_locks_table_arn               = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  discussion_locks_table_name              = "test"
  discussion_read_state_table_arn          = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  discussion_read_state_table_name         = "test"
  dynamodb_table_arns                      = []
  environment                              = "dev"
  environment_registry_table_arn           = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  environment_registry_table_name          = "test"
  lambda_vpc_scope                         = "all"
  native_package_jobs_table_arn            = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  native_package_jobs_table_name           = "test"
  native_package_jobs_table_stream_arn     = "arn:aws:dynamodb:us-east-1:123456789012:table/jobs/stream/2026-10-14T00:00:00.000"
  native_packages_bucket_arn               = "arn:aws:s3:::test-native-packages"
  native_packages_bucket_name              = "test"
  native_repair_table_arn                  = "arn:aws:dynamodb:us-east-1:123456789012:table/repair"
  native_repair_table_name                 = "test-native-repair"
  neptune_cluster_resource_id              = "test"
  neptune_endpoint                         = "test"
  powertools_log_event                     = false
  powertools_log_level                     = "INFO"
  powertools_service_name                  = "test"
  private_subnet_ids                       = ["subnet-0123456789abcdef0"]
  project_name                             = "test"
  realtime_doc_secret_param_arn            = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  realtime_doc_secret_param_name           = "test"
  runtime_compatibility_version            = "test"
  v2_executions_table_arn                  = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  v2_executions_table_name                 = "test"
  vpc_id                                   = "vpc-0123456789abcdef0"
  websocket_api_endpoint_https             = "https://test.execute-api.us-east-1.amazonaws.com/dev"
  websocket_execution_arn                  = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  workflow_source_bindings_table_arn       = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  workflow_source_bindings_table_name      = "test-workflow-sources"
  yjs_documents_table_arn                  = "arn:aws:dynamodb:us-east-1:123456789012:table/test"
  yjs_documents_table_name                 = "test"
}
override_module {
  target = module.source_control_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:source_control_lambda"
    lambda_function_name       = "source_control_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:source_control_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.credential_broker_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:credential_broker_lambda"
    lambda_function_name       = "credential_broker_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:credential_broker_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.credential_metadata_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:credential_metadata_lambda"
    lambda_function_name       = "credential_metadata_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:credential_metadata_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.projects_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:projects_lambda"
    lambda_function_name       = "projects_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:projects_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.users_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:users_lambda"
    lambda_function_name       = "users_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:users_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.sprints_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:sprints_lambda"
    lambda_function_name       = "sprints_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:sprints_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.requirements_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:requirements_lambda"
    lambda_function_name       = "requirements_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:requirements_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.user_stories_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:user_stories_lambda"
    lambda_function_name       = "user_stories_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:user_stories_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.tasks_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:tasks_lambda"
    lambda_function_name       = "tasks_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:tasks_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.code_files_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:code_files_lambda"
    lambda_function_name       = "code_files_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:code_files_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.reviews_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:reviews_lambda"
    lambda_function_name       = "reviews_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:reviews_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.questions_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:questions_lambda"
    lambda_function_name       = "questions_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:questions_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.sprint_graph_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:sprint_graph_lambda"
    lambda_function_name       = "sprint_graph_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:sprint_graph_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.general_info_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:general_info_lambda"
    lambda_function_name       = "general_info_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:general_info_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.github_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:github_lambda"
    lambda_function_name       = "github_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:github_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.gitlab_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:gitlab_lambda"
    lambda_function_name       = "gitlab_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:gitlab_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.bitbucket_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:bitbucket_lambda"
    lambda_function_name       = "bitbucket_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:bitbucket_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.trackers_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:trackers_lambda"
    lambda_function_name       = "trackers_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:trackers_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.timeline_events_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:timeline_events_lambda"
    lambda_function_name       = "timeline_events_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:timeline_events_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.discussions_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:discussions_lambda"
    lambda_function_name       = "discussions_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:discussions_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.discussion_result
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:discussion_result"
    lambda_function_name       = "discussion_result"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:discussion_result/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.cognito_users_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:cognito_users_lambda"
    lambda_function_name       = "cognito_users_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:cognito_users_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.purge_neptune_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:purge_neptune_lambda"
    lambda_function_name       = "purge_neptune_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:purge_neptune_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.migrate_tracker_fields_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:migrate_tracker_fields_lambda"
    lambda_function_name       = "migrate_tracker_fields_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:migrate_tracker_fields_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.building_blocks_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:building_blocks_lambda"
    lambda_function_name       = "building_blocks_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:building_blocks_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.seed_blocks_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:seed_blocks_lambda"
    lambda_function_name       = "seed_blocks_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:seed_blocks_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.workflows_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:workflows_lambda"
    lambda_function_name       = "workflows_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:workflows_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.intents_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:intents_lambda"
    lambda_function_name       = "intents_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:intents_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.intent_pin_lookup_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:intent_pin_lookup_lambda"
    lambda_function_name       = "intent_pin_lookup_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:intent_pin_lookup_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.v2_orchestrator_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:v2_orchestrator_lambda"
    lambda_function_name       = "v2_orchestrator_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:v2_orchestrator_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.native_package_storage_probe_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:native_package_storage_probe_lambda"
    lambda_function_name       = "native_package_storage_probe_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:native_package_storage_probe_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.native_package_worker_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:native_package_worker_lambda"
    lambda_function_name       = "native_package_worker_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:native_package_worker_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.native_package_repair_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:native_package_repair_lambda"
    lambda_function_name       = "native_package_repair_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:native_package_repair_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
override_module {
  target = module.workflow_sources_lambda
  outputs = {
    lambda_function_arn        = "arn:aws:lambda:us-east-1:123456789012:function:workflow_sources_lambda"
    lambda_function_name       = "workflow_sources_lambda"
    lambda_function_version    = "1"
    lambda_function_invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:workflow_sources_lambda/invocations"
    lambda_role_arn            = "arn:aws:iam::123456789012:role/test"
  }
}
run "disabled_package_repair" {
  command = apply
  module { source = "./modules/api/lambda" }
  assert {
    condition     = aws_cloudwatch_event_rule.native_package_repair.state == "DISABLED" && !aws_lambda_event_source_mapping.native_package_jobs.enabled && length(aws_pipes_pipe.native_package_jobs) == 0 && length(aws_cloudwatch_metric_alarm.native_package_repair_stalled) == 0
    error_message = "Disabled imports must not schedule repair, dispatch, consume, or alarm on missing successful scans."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.native_package_jobs_age.alarm_actions) == 0 && length(aws_cloudwatch_metric_alarm.native_package_function_errors["repair"].alarm_actions) == 0
    error_message = "Unconfigured package alarms must not send notifications."
  }
}
run "configured_package_repair" {
  command = apply
  module { source = "./modules/api/lambda" }
  variables {
    enable_native_package_jobs         = true
    native_package_jobs_host_qualified = true
    native_operations = {
      alarm_actions           = ["arn:aws:sns:us-east-1:123456789012:existing-operations"]
      incident_owner          = "test-operations-reference"
      full_scan_alarm_seconds = 900
    }
  }
  assert {
    condition     = aws_cloudwatch_event_rule.native_package_repair.state == "ENABLED" && aws_lambda_event_source_mapping.native_package_jobs.enabled && length(aws_pipes_pipe.native_package_jobs) == 1
    error_message = "Qualified imports must connect repair alongside existing dispatch and worker paths."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.native_package_repair_stalled[0].period == 900 && aws_cloudwatch_metric_alarm.native_package_repair_stalled[0].alarm_actions == toset(var.native_operations.alarm_actions) && alltrue([for alarm in aws_cloudwatch_metric_alarm.native_package_jobs_dead_letters : alarm.alarm_actions == toset(var.native_operations.alarm_actions) && strcontains(alarm.alarm_description, "test-operations-reference")])
    error_message = "Configured routes and ownership must reach both package DLQs and stalled repair alarms."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.native_package_repair.policy).Statement[0].Action == ["dynamodb:Scan", "dynamodb:GetItem"] && jsondecode(aws_iam_role_policy.native_package_repair.policy).Statement[1].Resource == var.native_repair_table_arn && jsondecode(aws_iam_role_policy.native_package_repair.policy).Statement[1].Condition["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"][0] == "packages" && jsondecode(aws_iam_role_policy.native_package_repair.policy).Statement[2].Action == ["sqs:SendMessage"]
    error_message = "Repair can only read jobs, checkpoint its own scope and send hints; no publisher, credential, or job mutation authority."
  }
}
