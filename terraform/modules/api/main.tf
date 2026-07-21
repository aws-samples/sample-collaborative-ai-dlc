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
    aws_api_gateway_integration.source_control,
    aws_api_gateway_integration.sprints_get,
    aws_api_gateway_integration.sprint_get,
    aws_api_gateway_integration.entity_collection_get,
    aws_api_gateway_integration.entity_item_get,
    aws_api_gateway_integration.review_get,
    aws_api_gateway_integration.sprint_graph_get,
    aws_api_gateway_integration.github_auth_get,
    aws_api_gateway_integration.github_callback_get,
    aws_api_gateway_integration.github_repos_get,
    aws_api_gateway_integration.github_status_get,
    aws_api_gateway_integration.github_disconnect_delete,
    aws_api_gateway_integration.github_admin_config_get,
    aws_api_gateway_integration.github_admin_config_put,
    aws_api_gateway_integration.github_app_status_get,
    aws_api_gateway_integration.github_app_repos_get,
    aws_api_gateway_integration.timeline_events_get,
    aws_api_gateway_integration.sprint_realtime_token_post,
    aws_api_gateway_integration.project_realtime_token_post,
    aws_api_gateway_integration.discussion_routes,
    aws_api_gateway_integration.cognito_users_get,
    aws_api_gateway_integration.admin_users_get,
    aws_api_gateway_integration.admin_users_platform_admin_put,
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
    aws_api_gateway_integration.agent_verify_mcp_post,
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
    module.cors_discussion_read,
    module.cors_discussions_search,
    module.cors_cognito_users,
    module.cors_admin_users,
    module.cors_admin_users_platform_admin,
    module.cors_github_auth,
    module.cors_github_callback,
    module.cors_github_repos,
    module.cors_github_status,
    module.cors_github_disconnect,
    module.cors_github_admin_config,
    module.cors_github_app_status,
    module.cors_github_app_repos,
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
    module.cors_project_agents_tasks,
    module.cors_project_agents,
    module.cors_source_control,
    module.cors_source_control_branches,
    module.cors_source_control_tree,
    module.cors_source_control_contents,
    module.cors_source_control_review_comments,
    module.cors_agents_root,
    module.cors_agent_task,
    module.cors_agent_questions,
    module.cors_agent_capabilities,
    module.cors_agent_settings,
    module.cors_agent_verify_mcp,
    # Every method must have its integration BEFORE the deployment is
    # created, or the first apply that introduces a route fails with
    # "No integration defined for method" (the deployment races the new
    # method/integration pair). This list is the FULL closure — every
    # integration resource and every CORS module in this module. When you
    # add a route, add its integration (+ cors module) here too.
    aws_api_gateway_integration.agent_questions_get,
    aws_api_gateway_integration.agent_task_get,
    aws_api_gateway_integration.block_collection_get,
    aws_api_gateway_integration.block_collection_post,
    aws_api_gateway_integration.block_item_body_get,
    aws_api_gateway_integration.block_item_delete,
    aws_api_gateway_integration.block_item_get,
    aws_api_gateway_integration.block_item_put,
    aws_api_gateway_integration.block_item_script_get,
    aws_api_gateway_integration.gitlab_auth_get,
    aws_api_gateway_integration.gitlab_callback_get,
    aws_api_gateway_integration.gitlab_disconnect_delete,
    aws_api_gateway_integration.gitlab_repos_get,
    aws_api_gateway_integration.gitlab_status_get,
    aws_api_gateway_integration.intent,
    aws_api_gateway_integration.intent_discussion,
    aws_api_gateway_integration.migrate_tracker_post,
    aws_api_gateway_integration.project_agents_get,
    aws_api_gateway_integration.workflow,
    module.cors_block_item,
    module.cors_block_item_body,
    module.cors_block_item_script,
    module.cors_block_type,
    module.cors_gitlab_auth,
    module.cors_gitlab_callback,
    module.cors_gitlab_disconnect,
    module.cors_gitlab_repos,
    module.cors_gitlab_status,
    module.cors_intent,
    module.cors_intent_discussion,
    module.cors_intent_discussion_message_redact,
    module.cors_intent_discussion_messages,
    module.cors_intent_discussion_read,
    module.cors_intent_discussion_assist,
    module.cors_intent_discussions,
    module.cors_intent_discussions_search,
    module.cors_intent_gate_answer,
    module.cors_intent_gate_revise,
    module.cors_intent_artifact_impact,
    module.cors_intent_artifact_content,
    module.cors_intent_artifact_verify,
    module.cors_intent_artifact_quorum_edit,
    module.cors_intent_artifact_versions,
    module.cors_intent_artifact_version,
    module.cors_intent_quorum_edit_decision,
    module.cors_intent_graph,
    module.cors_intent_audit,
    module.cors_intent_derive,
    module.cors_intent_outputs,
    module.cors_intent_realtime_token,
    module.cors_intent_start,
    module.cors_intent_cancel,
    module.cors_intent_rewind,
    module.cors_intent_repair,
    module.cors_intent_compose,
    module.cors_intent_compose_report_upload,
    module.cors_intent_composes,
    module.cors_intent_recompose,
    module.cors_intents,
    module.cors_intents_metrics,
    module.cors_migrate_tracker,
    module.cors_custom_mcp_servers,
    module.cors_custom_rules,
    module.cors_workflow,
    module.cors_workflow_compiled,
    module.cors_workflow_execution_preview,
    module.cors_workflow_validate_grid,
    module.cors_workflow_phases,
    module.cors_workflow_placement,
    module.cors_workflow_placements,
    module.cors_workflow_rule,
    module.cors_workflow_rules,
    module.cors_workflow_scope,
    module.cors_workflow_scope_membership,
    module.cors_workflow_scopes,
    module.cors_workflows,
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
      aws_api_gateway_resource.admin_users.id,
      aws_api_gateway_resource.admin_users_username.id,
      aws_api_gateway_resource.admin_users_platform_admin.id,
      aws_api_gateway_method.admin_users_get.id,
      aws_api_gateway_method.admin_users_platform_admin_put.id,
      aws_api_gateway_integration.admin_users_get.id,
      aws_api_gateway_integration.admin_users_platform_admin_put.id,
      aws_api_gateway_resource.members.id,
      aws_api_gateway_resource.member.id,
      aws_api_gateway_resource.repos.id,
      aws_api_gateway_resource.source_control.id,
      aws_api_gateway_resource.source_control_branches.id,
      aws_api_gateway_resource.source_control_tree.id,
      aws_api_gateway_resource.source_control_contents.id,
      aws_api_gateway_resource.source_control_review_comments.id,
      jsonencode({ for k, v in aws_api_gateway_method.source_control : k => v.id }),
      jsonencode({ for k, v in aws_api_gateway_integration.source_control : k => v.id }),
      aws_api_gateway_method.repos_get.id,
      aws_api_gateway_method.repos_post.id,
      aws_api_gateway_method.repos_delete.id,
      aws_api_gateway_integration.repos_get.id,
      aws_api_gateway_integration.repos_post.id,
      aws_api_gateway_integration.repos_delete.id,
      aws_api_gateway_resource.custom_mcp_servers.id,
      aws_api_gateway_method.custom_mcp_servers_get.id,
      aws_api_gateway_method.custom_mcp_servers_put.id,
      aws_api_gateway_integration.custom_mcp_servers_get.id,
      aws_api_gateway_integration.custom_mcp_servers_put.id,
      aws_api_gateway_resource.custom_mcp_servers_secrets.id,
      aws_api_gateway_method.custom_mcp_servers_secrets_get.id,
      aws_api_gateway_method.custom_mcp_servers_secrets_put.id,
      aws_api_gateway_integration.custom_mcp_servers_secrets_get.id,
      aws_api_gateway_integration.custom_mcp_servers_secrets_put.id,
      aws_api_gateway_resource.custom_rules.id,
      aws_api_gateway_method.custom_rules_get.id,
      aws_api_gateway_method.custom_rules_put.id,
      aws_api_gateway_integration.custom_rules_get.id,
      aws_api_gateway_integration.custom_rules_put.id,
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
      aws_api_gateway_resource.github_admin.id,
      aws_api_gateway_resource.github_admin_config.id,
      aws_api_gateway_method.github_admin_config_get.id,
      aws_api_gateway_method.github_admin_config_put.id,
      aws_api_gateway_integration.github_admin_config_get.id,
      aws_api_gateway_integration.github_admin_config_put.id,
      aws_api_gateway_resource.github_app.id,
      aws_api_gateway_resource.github_app_status.id,
      aws_api_gateway_resource.github_app_repos.id,
      aws_api_gateway_method.github_app_status_get.id,
      aws_api_gateway_method.github_app_repos_get.id,
      aws_api_gateway_integration.github_app_status_get.id,
      aws_api_gateway_integration.github_app_repos_get.id,
      # GitLab routes — project ref travels as a ?project= query string (not a
      # path segment) so namespaced group/project paths survive API Gateway.
      aws_api_gateway_resource.gitlab.id,
      aws_api_gateway_resource.gitlab_auth.id,
      aws_api_gateway_resource.gitlab_callback.id,
      aws_api_gateway_resource.gitlab_repos.id,
      aws_api_gateway_resource.gitlab_status.id,
      aws_api_gateway_resource.gitlab_disconnect.id,
      aws_api_gateway_resource.timeline_events.id,
      aws_api_gateway_resource.sprint_realtime_token.id,
      aws_api_gateway_resource.project_realtime_token.id,
      aws_api_gateway_resource.discussions.id,
      aws_api_gateway_resource.discussion.id,
      aws_api_gateway_resource.discussion_messages.id,
      aws_api_gateway_resource.discussion_read.id,
      aws_api_gateway_resource.discussions_search.id,
      aws_api_gateway_resource.blocks.id,
      aws_api_gateway_resource.block_type.id,
      aws_api_gateway_resource.block_item.id,
      aws_api_gateway_resource.block_item_body.id,
      aws_api_gateway_resource.block_item_script.id,
      aws_api_gateway_resource.workflows.id,
      aws_api_gateway_resource.workflow.id,
      aws_api_gateway_resource.workflow_phases.id,
      aws_api_gateway_resource.workflow_placements.id,
      aws_api_gateway_resource.workflow_placement.id,
      aws_api_gateway_resource.workflow_scopes.id,
      aws_api_gateway_resource.workflow_scope.id,
      aws_api_gateway_resource.workflow_scope_membership.id,
      aws_api_gateway_resource.workflow_rules.id,
      aws_api_gateway_resource.workflow_rule_layer.id,
      aws_api_gateway_resource.workflow_rule.id,
      aws_api_gateway_resource.workflow_compiled.id,
      aws_api_gateway_resource.workflow_execution_preview.id,
      aws_api_gateway_resource.workflow_validate_grid.id,
      # Hash the whole workflow route map (like the intent map below) so ANY
      # future addition to local.workflow_routes forces a stage redeployment.
      # Field incident: execution-preview was added to the map without a
      # trigger entry — terraform created the method, but the live stage never
      # redeployed, so OPTIONS/GET 403'd (surfacing as a CORS preflight error).
      jsonencode({ for k, v in aws_api_gateway_method.workflow : k => v.id }),
      jsonencode({ for k, v in aws_api_gateway_integration.workflow : k => v.id }),
      aws_api_gateway_resource.intents.id,
      aws_api_gateway_resource.intents_metrics.id,
      aws_api_gateway_resource.intent.id,
      aws_api_gateway_resource.intent_graph.id,
      aws_api_gateway_resource.intent_audit.id,
      aws_api_gateway_resource.intent_derive.id,
      aws_api_gateway_resource.intent_outputs.id,
      aws_api_gateway_resource.intent_start.id,
      aws_api_gateway_resource.intent_cancel.id,
      aws_api_gateway_resource.intent_rewind.id,
      aws_api_gateway_resource.intent_repair.id,
      aws_api_gateway_resource.intent_realtime_token.id,
      aws_api_gateway_resource.intent_gates.id,
      aws_api_gateway_resource.intent_gate.id,
      aws_api_gateway_resource.intent_gate_answer.id,
      aws_api_gateway_resource.intent_gate_revise.id,
      # Post-hoc artifact editing (impact / content / verify / quorum edit).
      # Methods+integrations ride the shared `intent` for_each below — hashing
      # the whole route map catches any future intent-route addition too.
      aws_api_gateway_resource.intent_artifacts.id,
      aws_api_gateway_resource.intent_artifact.id,
      aws_api_gateway_resource.intent_artifact_impact.id,
      aws_api_gateway_resource.intent_artifact_content.id,
      aws_api_gateway_resource.intent_artifact_verify.id,
      aws_api_gateway_resource.intent_artifact_quorum_edit.id,
      aws_api_gateway_resource.intent_artifact_versions.id,
      aws_api_gateway_resource.intent_artifact_version.id,
      aws_api_gateway_resource.intent_quorum_edits.id,
      aws_api_gateway_resource.intent_quorum_edit.id,
      aws_api_gateway_resource.intent_quorum_edit_decision.id,
      jsonencode({ for k, v in aws_api_gateway_method.intent : k => v.id }),
      jsonencode({ for k, v in aws_api_gateway_integration.intent : k => v.id }),
      aws_api_gateway_resource.intent_discussions.id,
      aws_api_gateway_resource.intent_discussions_search.id,
      aws_api_gateway_resource.intent_discussion.id,
      aws_api_gateway_resource.intent_discussion_messages.id,
      aws_api_gateway_resource.intent_discussion_message.id,
      aws_api_gateway_resource.intent_discussion_message_redact.id,
      aws_api_gateway_resource.intent_discussion_read.id,
      aws_api_gateway_resource.intent_discussion_assist.id,
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
      aws_api_gateway_gateway_response.default_4xx.id,
      aws_api_gateway_gateway_response.default_5xx.id,
      aws_api_gateway_resource.project_agents.id,
      aws_api_gateway_resource.project_agents_tasks.id,
      aws_api_gateway_resource.agents_root.id,
      aws_api_gateway_resource.agent_task.id,
      aws_api_gateway_resource.agent_questions.id,
      aws_api_gateway_resource.agent_capabilities.id,
      aws_api_gateway_resource.agent_settings.id,
      aws_api_gateway_resource.agent_verify_mcp.id,
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
