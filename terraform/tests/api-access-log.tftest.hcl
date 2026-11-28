# The REST API access log keeps its existing format unless the identity flag
# is on, and then adds only pseudonymous identity fields.
mock_provider "aws" {}

variables {
  credential_broker_role_arn               = "arn:aws:iam::123456789012:role/credential-broker"
  aws_sdk_ua_app_id                        = "aws-sdk-ua-app-id"
  project_name                             = "project-name"
  powertools_service_name                  = "powertools-service-name"
  powertools_log_level                     = "INFO"
  powertools_log_event                     = false
  cognito_user_pool_arn                    = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_Test"
  projects_lambda_invoke_arn               = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:projects_lambda/invocations"
  projects_lambda_name                     = "projects-lambda-name"
  users_lambda_invoke_arn                  = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:users_lambda/invocations"
  users_lambda_name                        = "users-lambda-name"
  sprints_lambda_invoke_arn                = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:sprints_lambda/invocations"
  sprints_lambda_name                      = "sprints-lambda-name"
  requirements_lambda_invoke_arn           = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:requirements_lambda/invocations"
  requirements_lambda_name                 = "requirements-lambda-name"
  user_stories_lambda_invoke_arn           = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:user_stories_lambda/invocations"
  user_stories_lambda_name                 = "user-stories-lambda-name"
  tasks_lambda_invoke_arn                  = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:tasks_lambda/invocations"
  tasks_lambda_name                        = "tasks-lambda-name"
  general_info_lambda_invoke_arn           = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:general_info_lambda/invocations"
  general_info_lambda_name                 = "general-info-lambda-name"
  code_files_lambda_invoke_arn             = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:code_files_lambda/invocations"
  code_files_lambda_name                   = "code-files-lambda-name"
  reviews_lambda_invoke_arn                = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:reviews_lambda/invocations"
  reviews_lambda_name                      = "reviews-lambda-name"
  questions_lambda_invoke_arn              = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:questions_lambda/invocations"
  questions_lambda_name                    = "questions-lambda-name"
  sprint_graph_lambda_invoke_arn           = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:sprint_graph_lambda/invocations"
  sprint_graph_lambda_name                 = "sprint-graph-lambda-name"
  timeline_events_lambda_invoke_arn        = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:timeline_events_lambda/invocations"
  timeline_events_lambda_name              = "timeline-events-lambda-name"
  discussions_lambda_invoke_arn            = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:discussions_lambda/invocations"
  discussions_lambda_name                  = "discussions-lambda-name"
  building_blocks_lambda_invoke_arn        = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:building_blocks_lambda/invocations"
  building_blocks_lambda_name              = "building-blocks-lambda-name"
  workflows_lambda_invoke_arn              = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:workflows_lambda/invocations"
  workflows_lambda_name                    = "workflows-lambda-name"
  intents_lambda_invoke_arn                = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:intents_lambda/invocations"
  intents_lambda_name                      = "intents-lambda-name"
  environments_lambda_invoke_arn           = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:environments_lambda/invocations"
  environments_lambda_name                 = "environments-lambda-name"
  tools_lambda_invoke_arn                  = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:tools_lambda/invocations"
  tools_lambda_name                        = "tools-lambda-name"
  agent_credential_grant_secret_param_name = "agent-credential-grant-secret-param-name"
  bedrock_region                           = "us-east-1"
  environment_registry_table_name          = "environment-registry-table-name"
  runtime_compatibility_version            = "runtime-compatibility-version"
  cognito_users_lambda_invoke_arn          = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:cognito_users_lambda/invocations"
  cognito_users_lambda_name                = "cognito-users-lambda-name"
  api_gateway_account_id                   = "123456789012"
  v2_executions_table_name                 = "v2-executions-table-name"
  access_table_name                        = "access-table-name"
  environment                              = "test"
  github_lambda_invoke_arn                 = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:github-lambda/invocations"
  github_lambda_name                       = "github-lambda"
  gitlab_lambda_invoke_arn                 = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:gitlab-lambda/invocations"
  gitlab_lambda_name                       = "gitlab-lambda"
  bitbucket_lambda_invoke_arn              = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:bitbucket-lambda/invocations"
  source_control_lambda_invoke_arn         = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:source-control-lambda/invocations"
  bitbucket_lambda_name                    = "bitbucket-lambda"
  codecommit_lambda_invoke_arn             = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:codecommit-lambda/invocations"
  codecommit_lambda_name                   = "codecommit-lambda"
  source_control_lambda_name               = "source-control-lambda"
  trackers_lambda_invoke_arn               = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:trackers-lambda/invocations"
  trackers_lambda_name                     = "trackers-lambda"
}

run "non_prod_keeps_the_existing_format" {
  command = plan
  module {
    source = "./modules/api"
  }

  assert {
    condition     = aws_api_gateway_stage.main.access_log_settings[0].format == "{\"caller\":\"$context.identity.caller\",\"httpMethod\":\"$context.httpMethod\",\"ip\":\"$context.identity.sourceIp\",\"protocol\":\"$context.protocol\",\"requestId\":\"$context.requestId\",\"requestTime\":\"$context.requestTime\",\"resourcePath\":\"$context.resourcePath\",\"responseLength\":\"$context.responseLength\",\"status\":\"$context.status\",\"user\":\"$context.identity.user\"}"
    error_message = "Without the identity flag, the access log format must stay byte-for-byte the same."
  }
}

run "prod_records_the_caller_by_default" {
  command = plan
  module {
    source = "./modules/api"
  }
  variables {
    environment = "prod"
  }

  assert {
    condition = (
      jsondecode(aws_api_gateway_stage.main.access_log_settings[0].format).sub == "$context.authorizer.claims.sub" &&
      jsondecode(aws_api_gateway_stage.main.access_log_settings[0].format).clientId == "$context.authorizer.claims.client_id"
    )
    error_message = "The identity fields must come from the authorizer sub and client_id claims."
  }

  assert {
    condition = (
      toset(keys(jsondecode(aws_api_gateway_stage.main.access_log_settings[0].format))) == toset([
        "caller", "clientId", "httpMethod", "ip", "protocol", "requestId", "requestTime",
        "resourcePath", "responseLength", "status", "sub", "user",
      ])
    )
    error_message = "The identity flag must add only sub and clientId; never email, username, audience, or token fields."
  }

}

run "prod_can_opt_out" {
  command = plan
  module {
    source = "./modules/api"
  }
  variables {
    environment         = "prod"
    access_log_identity = false
  }

  assert {
    condition     = aws_api_gateway_stage.main.access_log_settings[0].format == "{\"caller\":\"$context.identity.caller\",\"httpMethod\":\"$context.httpMethod\",\"ip\":\"$context.identity.sourceIp\",\"protocol\":\"$context.protocol\",\"requestId\":\"$context.requestId\",\"requestTime\":\"$context.requestTime\",\"resourcePath\":\"$context.resourcePath\",\"responseLength\":\"$context.responseLength\",\"status\":\"$context.status\",\"user\":\"$context.identity.user\"}"
    error_message = "Opting out must keep the existing access log format."
  }

}

run "non_prod_can_opt_in" {
  command = plan
  module {
    source = "./modules/api"
  }
  variables {
    environment         = "test"
    access_log_identity = true
  }

  assert {
    condition = (
      jsondecode(aws_api_gateway_stage.main.access_log_settings[0].format).sub == "$context.authorizer.claims.sub" &&
      jsondecode(aws_api_gateway_stage.main.access_log_settings[0].format).clientId == "$context.authorizer.claims.client_id"
    )
    error_message = "The identity fields must come from the authorizer sub and client_id claims."
  }

  assert {
    condition = (
      toset(keys(jsondecode(aws_api_gateway_stage.main.access_log_settings[0].format))) == toset([
        "caller", "clientId", "httpMethod", "ip", "protocol", "requestId", "requestTime",
        "resourcePath", "responseLength", "status", "sub", "user",
      ])
    )
    error_message = "The identity flag must add only sub and clientId; never email, username, audience, or token fields."
  }

}
