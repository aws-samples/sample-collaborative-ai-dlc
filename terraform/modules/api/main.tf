# API Gateway REST API
resource "aws_api_gateway_rest_api" "main" {
  name        = "${var.project_name}-api-${var.environment}"
  description = "REST API for ${var.project_name}"

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_resource" "api" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "api"
}

# Cognito Authorizer
resource "aws_api_gateway_authorizer" "cognito" {
  name          = "${var.project_name}-cognito-authorizer"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  type          = "COGNITO_USER_POOLS"
  provider_arns = [var.cognito_user_pool_arn]
}

# API Gateway Deployment
resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id

  depends_on = [
    aws_api_gateway_integration.projects_get,
    aws_api_gateway_integration.projects_post,
    aws_api_gateway_integration.project_get,
    aws_api_gateway_integration.project_put,
    aws_api_gateway_integration.project_delete,
    aws_api_gateway_integration.members_get,
    aws_api_gateway_integration.members_post,
    aws_api_gateway_integration.member_put,
    aws_api_gateway_integration.member_delete,
    aws_api_gateway_integration.repos_get,
    aws_api_gateway_integration.repos_post,
    aws_api_gateway_integration.repos_delete,
    aws_api_gateway_integration.sprints_get,
    aws_api_gateway_integration.sprints_post,
    aws_api_gateway_integration.sprint_get,
    aws_api_gateway_integration.sprint_put,
    aws_api_gateway_integration.sprint_delete,
    aws_api_gateway_integration.entity_collection_get,
    aws_api_gateway_integration.entity_collection_post,
    aws_api_gateway_integration.entity_item_get,
    aws_api_gateway_integration.entity_item_put,
    aws_api_gateway_integration.entity_item_delete,
    aws_api_gateway_integration.review_get,
    aws_api_gateway_integration.review_post,
    aws_api_gateway_integration.review_put,
    aws_api_gateway_integration.sprint_graph_get,
    aws_api_gateway_integration.github_auth_get,
    aws_api_gateway_integration.github_callback_get,
    aws_api_gateway_integration.github_repos_get,
    aws_api_gateway_integration.github_status_get,
    aws_api_gateway_integration.github_disconnect_delete,
    aws_api_gateway_integration.github_repos_tree_get,
    aws_api_gateway_integration.github_repos_branches_get,
    aws_api_gateway_integration.github_repos_contents_get,
    aws_api_gateway_integration.timeline_events_get,
    aws_api_gateway_integration.timeline_events_post,
    aws_api_gateway_integration.sprint_realtime_token_post,
    aws_api_gateway_integration.project_realtime_token_post,
    aws_api_gateway_integration.discussion_routes,
    aws_api_gateway_integration.cognito_users_get,
    aws_api_gateway_integration.trackers_root_get,
    aws_api_gateway_integration.trackers_auth_provider_get,
    aws_api_gateway_integration.trackers_callback_provider_get,
    aws_api_gateway_integration.trackers_external_projects_provider_instance_get,
    aws_api_gateway_integration.trackers_connections_provider_instance_post,
    aws_api_gateway_integration.trackers_providers_get,
    aws_api_gateway_integration.trackers_providers_provider_oauth_config_put,
    aws_api_gateway_integration.trackers_provider_instance_delete,
    aws_api_gateway_integration.project_trackers_get,
    aws_api_gateway_integration.project_trackers_post,
    aws_api_gateway_integration.project_tracker_binding_delete,
    aws_api_gateway_integration.project_tracker_binding_issues_get,
    aws_api_gateway_integration.project_tracker_binding_issue_get,
    aws_api_gateway_integration.project_tracker_binding_issue_comments_get,
    aws_api_gateway_integration.project_agents_tasks_get,
    aws_api_gateway_integration.agent_capabilities_get,
    aws_api_gateway_integration.agent_settings_get,
    aws_api_gateway_integration.agent_settings_put,
    aws_api_gateway_integration.admin_tracker_migration_status_get,
    aws_api_gateway_integration.admin_tracker_migration_post,
    module.cors_admin_tracker_migration,
    module.cors_admin_tracker_migration_status,
    module.cors_projects,
    module.cors_project,
    module.cors_members,
    module.cors_member,
    module.cors_repos,
    module.cors_sprints,
    module.cors_sprint,
    module.cors_requirements,
    module.cors_requirement,
    module.cors_user_stories,
    module.cors_user_story,
    module.cors_tasks,
    module.cors_task,
    module.cors_general_info,
    module.cors_general_info_item,
    module.cors_code_files,
    module.cors_code_file,
    module.cors_review,
    module.cors_questions,
    module.cors_question,
    module.cors_sprint_graph,
    module.cors_timeline_events,
    module.cors_sprint_realtime_token,
    module.cors_project_realtime_token,
    module.cors_discussions,
    module.cors_discussion,
    module.cors_discussion_messages,
    module.cors_discussion_message_redact,
    module.cors_discussion_read,
    module.cors_discussion_assist,
    module.cors_discussions_search,
    module.cors_cognito_users,
    module.cors_github_auth,
    module.cors_github_callback,
    module.cors_github_repos,
    module.cors_github_status,
    module.cors_github_disconnect,
    module.cors_github_repos_branches,
    module.cors_github_repos_tree,
    module.cors_github_repos_contents,
    module.cors_github_repos_pulls_comments,
    module.cors_trackers_root,
    module.cors_trackers_auth_provider,
    module.cors_trackers_callback_provider,
    module.cors_trackers_external_projects_provider_instance,
    module.cors_trackers_connections_provider_instance,
    module.cors_trackers_providers,
    module.cors_trackers_providers_provider_oauth_config,
    module.cors_trackers_provider_instance,
    module.cors_project_trackers,
    module.cors_project_tracker_binding,
    module.cors_project_tracker_binding_issues,
    module.cors_project_tracker_binding_issue,
    module.cors_project_tracker_binding_issue_comments,
    module.cors_agent_pool_warm,
    module.cors_agent_pool,
    module.cors_agent_pool_recycle,
    module.cors_agent_pool_worker,
    module.cors_project_agents_tasks,
    module.cors_project_agents,
    module.cors_agents_root,
    module.cors_agent_task,
    module.cors_agent_questions,
    module.cors_agent_question_answer,
    module.cors_agent_capabilities,
    module.cors_agent_settings,
  ]

  lifecycle {
    create_before_destroy = true
  }

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.projects.id,
      aws_api_gateway_resource.project.id,
      aws_api_gateway_resource.migrate_tracker.id,
      aws_api_gateway_resource.admin.id,
      aws_api_gateway_resource.admin_tracker_migration.id,
      aws_api_gateway_resource.admin_tracker_migration_status.id,
      aws_api_gateway_resource.members.id,
      aws_api_gateway_resource.member.id,
      aws_api_gateway_resource.repos.id,
      aws_api_gateway_method.repos_get.id,
      aws_api_gateway_method.repos_post.id,
      aws_api_gateway_method.repos_delete.id,
      aws_api_gateway_integration.repos_get.id,
      aws_api_gateway_integration.repos_post.id,
      aws_api_gateway_integration.repos_delete.id,
      aws_api_gateway_resource.sprints.id,
      aws_api_gateway_resource.sprint.id,
      aws_api_gateway_resource.requirements.id,
      aws_api_gateway_resource.requirement.id,
      aws_api_gateway_resource.user_stories.id,
      aws_api_gateway_resource.user_story.id,
      aws_api_gateway_resource.tasks.id,
      aws_api_gateway_resource.task.id,
      aws_api_gateway_resource.code_files.id,
      aws_api_gateway_resource.code_file.id,
      aws_api_gateway_resource.review.id,
      aws_api_gateway_resource.questions.id,
      aws_api_gateway_resource.question.id,
      aws_api_gateway_resource.sprint_graph.id,
      aws_api_gateway_resource.github.id,
      aws_api_gateway_resource.github_auth.id,
      aws_api_gateway_resource.github_callback.id,
      aws_api_gateway_resource.github_repos.id,
      aws_api_gateway_resource.github_status.id,
      aws_api_gateway_resource.github_disconnect.id,
      aws_api_gateway_resource.github_repos_owner.id,
      aws_api_gateway_resource.github_repos_owner_repo.id,
      aws_api_gateway_resource.github_repos_branches.id,
      aws_api_gateway_resource.github_repos_tree.id,
      aws_api_gateway_resource.github_repos_contents.id,
      aws_api_gateway_resource.timeline_events.id,
      aws_api_gateway_resource.sprint_realtime_token.id,
      aws_api_gateway_resource.project_realtime_token.id,
      aws_api_gateway_resource.discussions.id,
      aws_api_gateway_resource.discussion.id,
      aws_api_gateway_resource.discussion_messages.id,
      aws_api_gateway_resource.discussion_message.id,
      aws_api_gateway_resource.discussion_message_redact.id,
      aws_api_gateway_resource.discussion_read.id,
      aws_api_gateway_resource.discussion_assist.id,
      aws_api_gateway_resource.discussions_search.id,
      aws_api_gateway_resource.blocks.id,
      aws_api_gateway_resource.block_type.id,
      aws_api_gateway_resource.block_item.id,
      aws_api_gateway_resource.block_item_body.id,
      aws_api_gateway_resource.workflows.id,
      aws_api_gateway_resource.workflow.id,
      aws_api_gateway_resource.workflow_phases.id,
      aws_api_gateway_resource.workflow_placements.id,
      aws_api_gateway_resource.workflow_placement.id,
      aws_api_gateway_resource.workflow_scopes.id,
      aws_api_gateway_resource.workflow_scope.id,
      aws_api_gateway_resource.workflow_compiled.id,
      aws_api_gateway_resource.cognito_users.id,
      aws_api_gateway_resource.trackers_root.id,
      aws_api_gateway_resource.trackers_auth_provider.id,
      aws_api_gateway_resource.trackers_callback_provider.id,
      aws_api_gateway_resource.trackers_external_projects_provider_instance.id,
      aws_api_gateway_resource.trackers_connections_provider_instance.id,
      aws_api_gateway_resource.trackers_providers.id,
      aws_api_gateway_resource.trackers_providers_provider.id,
      aws_api_gateway_resource.trackers_providers_provider_oauth_config.id,
      aws_api_gateway_resource.trackers_provider_instance.id,
      # Bump on auth-method changes too — the redeployment triggers only watch
      # resource ids, but flipping callback auth (Cognito → NONE in #197)
      # needs a fresh stage deploy as well.
      aws_api_gateway_method.trackers_callback_provider_get.authorization,
      aws_api_gateway_resource.project_trackers.id,
      aws_api_gateway_resource.project_tracker_binding.id,
      aws_api_gateway_resource.project_tracker_binding_issues.id,
      aws_api_gateway_resource.project_tracker_binding_issue.id,
      aws_api_gateway_resource.project_tracker_binding_issue_comments.id,
      aws_api_gateway_resource.project_mcp_servers.id,
      aws_api_gateway_resource.project_steering_docs.id,
      aws_api_gateway_resource.task_mcp_servers.id,
      aws_api_gateway_resource.task_steering_docs.id,
      aws_api_gateway_gateway_response.default_4xx.id,
      aws_api_gateway_gateway_response.default_5xx.id,
      var.enable_agents ? aws_api_gateway_resource.project_agents[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.project_agents_tasks[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.agents_root[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.agent_task[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.agent_questions[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.agent_question[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.agent_question_answer[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.agent_pool[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.agent_pool_recycle[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.agent_pool_warm[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.agent_pool_worker[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.agent_capabilities[0].id : "",
      var.enable_agents ? aws_api_gateway_resource.agent_settings[0].id : "",
    ]))
  }
}

# CloudWatch Log Group for REST API access logs
resource "aws_cloudwatch_log_group" "api_access_logs" {
  name              = "/aws/apigateway/${var.project_name}-rest-api-${var.environment}"
  retention_in_days = var.environment == "prod" ? 30 : 7
}

# API Gateway Stage
# The description reference to api_gateway_account_id creates an implicit
# dependency so the stage waits for account-level CloudWatch logging config.
resource "aws_api_gateway_stage" "main" {
  deployment_id = aws_api_gateway_deployment.main.id
  rest_api_id   = aws_api_gateway_rest_api.main.id
  stage_name    = var.environment
  description   = "Managed by Terraform (apigw-account: ${var.api_gateway_account_id})"

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access_logs.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      caller         = "$context.identity.caller"
      user           = "$context.identity.user"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      resourcePath   = "$context.resourcePath"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
    })
  }
}

# CORS Configuration for OPTIONS method
resource "aws_api_gateway_method" "cors_options" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.api.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "cors_options" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.api.id
  http_method = aws_api_gateway_method.cors_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = jsonencode({
      statusCode = 200
    })
  }
}

resource "aws_api_gateway_method_response" "cors_options" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.api.id
  http_method = aws_api_gateway_method.cors_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "cors_options" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.api.id
  http_method = aws_api_gateway_method.cors_options.http_method
  status_code = aws_api_gateway_method_response.cors_options.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'"
    "method.response.header.Access-Control-Allow-Methods" = "'GET,POST,PUT,DELETE,OPTIONS'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

# Gateway Responses — add CORS headers to error responses so the browser
# can read them instead of masking them as CORS failures.
resource "aws_api_gateway_gateway_response" "default_4xx" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  response_type = "DEFAULT_4XX"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'*'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'"
    "gatewayresponse.header.Access-Control-Allow-Methods" = "'GET,POST,PUT,DELETE,OPTIONS'"
  }

  response_templates = {
    "application/json" = "{\"message\":$context.error.messageString}"
  }
}

resource "aws_api_gateway_gateway_response" "default_5xx" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  response_type = "DEFAULT_5XX"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'*'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'"
    "gatewayresponse.header.Access-Control-Allow-Methods" = "'GET,POST,PUT,DELETE,OPTIONS'"
  }

  response_templates = {
    "application/json" = "{\"message\":$context.error.messageString}"
  }
}
