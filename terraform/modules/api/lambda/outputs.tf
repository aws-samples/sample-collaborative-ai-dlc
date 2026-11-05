# API integration URIs identify functions independently of their package builds.
# Reuse the Lambda module's static ARN so refreshing an API snapshot does not
# pull generated archive hashes and unrelated code updates into the target graph.
output "agents_orchestrator_role_arn" {
  description = "ARN of the IAM role for the agents Lambda (most privileged: Neptune + DDB + SSM + AgentCore invoke). Consumed by the api module to wire the agents_lambda created in api/agents.tf."
  value       = aws_iam_role.agents_orchestrator.arn
  depends_on  = [aws_iam_role_policy.agents_orchestrator]
}

output "lambda_security_group_id" {
  description = "Security group ID for Lambda functions"
  value       = aws_security_group.lambda.id
}

output "projects_lambda_arn" {
  description = "ARN of the projects Lambda function"
  value       = module.projects_lambda.lambda_function_arn
}

output "projects_lambda_invoke_arn" {
  description = "Invoke ARN of the projects Lambda function"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.projects_lambda.lambda_function_arn_static}/invocations"
}

output "projects_lambda_name" {
  description = "Name of the projects Lambda function"
  value       = module.projects_lambda.lambda_function_name
}

output "users_lambda_arn" {
  description = "ARN of the users Lambda function"
  value       = module.users_lambda.lambda_function_arn
}

output "users_lambda_invoke_arn" {
  description = "Invoke ARN of the users Lambda function"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.users_lambda.lambda_function_arn_static}/invocations"
}

output "users_lambda_name" {
  description = "Name of the users Lambda function"
  value       = module.users_lambda.lambda_function_name
}

output "sprints_lambda_arn" {
  value = module.sprints_lambda.lambda_function_arn
}
output "sprints_lambda_invoke_arn" {
  value = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.sprints_lambda.lambda_function_arn_static}/invocations"
}
output "sprints_lambda_name" {
  value = module.sprints_lambda.lambda_function_name
}

output "requirements_lambda_arn" {
  value = module.requirements_lambda.lambda_function_arn
}
output "requirements_lambda_invoke_arn" {
  value = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.requirements_lambda.lambda_function_arn_static}/invocations"
}
output "requirements_lambda_name" {
  value = module.requirements_lambda.lambda_function_name
}

output "user_stories_lambda_arn" {
  value = module.user_stories_lambda.lambda_function_arn
}
output "user_stories_lambda_invoke_arn" {
  value = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.user_stories_lambda.lambda_function_arn_static}/invocations"
}
output "user_stories_lambda_name" {
  value = module.user_stories_lambda.lambda_function_name
}

output "tasks_lambda_arn" {
  value = module.tasks_lambda.lambda_function_arn
}
output "tasks_lambda_invoke_arn" {
  value = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.tasks_lambda.lambda_function_arn_static}/invocations"
}
output "tasks_lambda_name" {
  value = module.tasks_lambda.lambda_function_name
}

output "code_files_lambda_arn" {
  value = module.code_files_lambda.lambda_function_arn
}
output "code_files_lambda_invoke_arn" {
  value = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.code_files_lambda.lambda_function_arn_static}/invocations"
}
output "code_files_lambda_name" {
  value = module.code_files_lambda.lambda_function_name
}

output "reviews_lambda_arn" {
  value = module.reviews_lambda.lambda_function_arn
}
output "reviews_lambda_invoke_arn" {
  value = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.reviews_lambda.lambda_function_arn_static}/invocations"
}
output "reviews_lambda_name" {
  value = module.reviews_lambda.lambda_function_name
}

output "questions_lambda_arn" {
  value = module.questions_lambda.lambda_function_arn
}
output "questions_lambda_invoke_arn" {
  value = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.questions_lambda.lambda_function_arn_static}/invocations"
}
output "questions_lambda_name" {
  value = module.questions_lambda.lambda_function_name
}

output "sprint_graph_lambda_arn" {
  value = module.sprint_graph_lambda.lambda_function_arn
}
output "sprint_graph_lambda_invoke_arn" {
  value = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.sprint_graph_lambda.lambda_function_arn_static}/invocations"
}
output "sprint_graph_lambda_name" {
  value = module.sprint_graph_lambda.lambda_function_name
}

output "general_info_lambda_arn" {
  value = module.general_info_lambda.lambda_function_arn
}
output "general_info_lambda_invoke_arn" {
  value = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.general_info_lambda.lambda_function_arn_static}/invocations"
}
output "general_info_lambda_name" {
  value = module.general_info_lambda.lambda_function_name
}

output "github_lambda_arn" {
  description = "ARN of the github Lambda function"
  value       = module.github_lambda.lambda_function_arn
}

output "github_lambda_invoke_arn" {
  description = "Invoke ARN of the github Lambda function"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.github_lambda.lambda_function_arn_static}/invocations"
}

output "github_lambda_name" {
  description = "Name of the github Lambda function"
  value       = module.github_lambda.lambda_function_name
}

output "gitlab_lambda_arn" {
  description = "ARN of the gitlab Lambda function"
  value       = module.gitlab_lambda.lambda_function_arn
}

output "gitlab_lambda_invoke_arn" {
  description = "Invoke ARN of the gitlab Lambda function"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.gitlab_lambda.lambda_function_arn_static}/invocations"
}

output "gitlab_lambda_name" {
  description = "Name of the gitlab Lambda function"
  value       = module.gitlab_lambda.lambda_function_name
}

output "bitbucket_lambda_arn" {
  description = "ARN of the bitbucket Lambda function"
  value       = module.bitbucket_lambda.lambda_function_arn
}

output "bitbucket_lambda_invoke_arn" {
  description = "Invoke ARN of the bitbucket Lambda function"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.bitbucket_lambda.lambda_function_arn_static}/invocations"
}

output "bitbucket_lambda_name" {
  description = "Name of the bitbucket Lambda function"
  value       = module.bitbucket_lambda.lambda_function_name
}

output "codecommit_lambda_arn" {
  description = "ARN of the codecommit Lambda function"
  value       = module.codecommit_lambda.lambda_function_arn
}

output "codecommit_lambda_invoke_arn" {
  description = "Invoke ARN of the codecommit Lambda function"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.codecommit_lambda.lambda_function_arn_static}/invocations"
}

output "codecommit_lambda_name" {
  description = "Name of the codecommit Lambda function"
  value       = module.codecommit_lambda.lambda_function_name
}

output "codecommit_platform_principals" {
  description = "Execution role ARNs a tenant CodeCommit access role must trust (comma-separated)"
  value       = local.codecommit_platform_principals
}

output "source_control_lambda_arn" {
  description = "ARN of the project source-control Lambda"
  value       = module.source_control_lambda.lambda_function_arn
}

output "source_control_lambda_invoke_arn" {
  description = "Invoke ARN of the project source-control Lambda"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.source_control_lambda.lambda_function_arn_static}/invocations"
}

output "source_control_lambda_name" {
  description = "Name of the project source-control Lambda"
  value       = module.source_control_lambda.lambda_function_name
}

output "credential_broker_lambda_arn" {
  description = "ARN of the AgentCore-only credential broker"
  value       = module.credential_broker_lambda.lambda_function_arn
}

output "credential_broker_lambda_name" {
  description = "Name of the AgentCore-only credential broker"
  value       = module.credential_broker_lambda.lambda_function_name
}

output "trackers_lambda_arn" {
  description = "ARN of the trackers Lambda function"
  value       = module.trackers_lambda.lambda_function_arn
}

output "trackers_lambda_invoke_arn" {
  description = "Invoke ARN of the trackers Lambda function"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.trackers_lambda.lambda_function_arn_static}/invocations"
}

output "trackers_lambda_name" {
  description = "Name of the trackers Lambda function"
  value       = module.trackers_lambda.lambda_function_name
}

output "timeline_events_lambda_arn" {
  value = module.timeline_events_lambda.lambda_function_arn
}
output "timeline_events_lambda_invoke_arn" {
  value = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.timeline_events_lambda.lambda_function_arn_static}/invocations"
}
output "timeline_events_lambda_name" {
  value = module.timeline_events_lambda.lambda_function_name
}

output "purge_neptune_lambda_name" {
  value = module.purge_neptune_lambda.lambda_function_name
}

output "migrate_tracker_fields_lambda_name" {
  description = "Name of the one-shot tracker-fields migration Lambda. Invoke via `aws lambda invoke` after deploy; see lambda/migrate-tracker-fields/index.js for the payload contract."
  value       = module.migrate_tracker_fields_lambda.lambda_function_name
}

output "building_blocks_lambda_invoke_arn" {
  description = "Invoke ARN of the building-blocks CRUD Lambda"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.building_blocks_lambda.lambda_function_arn_static}/invocations"
}

output "building_blocks_lambda_name" {
  description = "Name of the building-blocks CRUD Lambda"
  value       = module.building_blocks_lambda.lambda_function_name
}

output "seed_blocks_lambda_name" {
  description = "Name of the one-shot baseline seed Lambda. Invoke via `aws lambda invoke` after deploy; see lambda/seed-blocks/index.js for the payload contract."
  value       = module.seed_blocks_lambda.lambda_function_name
}

output "workflows_lambda_invoke_arn" {
  description = "Invoke ARN of the workflows composition Lambda"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.workflows_lambda.lambda_function_arn_static}/invocations"
}

output "workflows_lambda_name" {
  description = "Name of the workflows composition Lambda"
  value       = module.workflows_lambda.lambda_function_name
}

output "cognito_users_lambda_arn" {
  description = "ARN of the cognito-users Lambda function"
  value       = module.cognito_users_lambda.lambda_function_arn
}

output "cognito_users_lambda_invoke_arn" {
  description = "Invoke ARN of the cognito-users Lambda function"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.cognito_users_lambda.lambda_function_arn_static}/invocations"
}

output "cognito_users_lambda_name" {
  description = "Name of the cognito-users Lambda function"
  value       = module.cognito_users_lambda.lambda_function_name
}
output "discussions_lambda_invoke_arn" {
  description = "Invoke ARN of the discussions Lambda"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.discussions_lambda.lambda_function_arn_static}/invocations"
}

output "discussions_lambda_name" {
  description = "Name of the discussions Lambda"
  value       = module.discussions_lambda.lambda_function_name
}

output "intents_lambda_invoke_arn" {
  description = "Invoke ARN of the v2 intents Lambda"
  value       = "arn:${local.partition}:apigateway:${data.aws_region.current.region}:lambda:path/2015-03-31/functions/${module.intents_lambda.lambda_function_arn_static}/invocations"
}

output "intents_lambda_name" {
  description = "Name of the v2 intents Lambda"
  value       = module.intents_lambda.lambda_function_name
}

output "v2_orchestrator_lambda_arn" {
  description = "ARN of the v2 orchestrator durable Lambda"
  value       = module.v2_orchestrator_lambda.lambda_function_arn
}

output "v2_orchestrator_lambda_name" {
  description = "Name of the v2 orchestrator durable Lambda"
  value       = module.v2_orchestrator_lambda.lambda_function_name
}

output "v2_orchestrator_qualified_name" {
  description = "Qualified name of the v2 orchestrator durable Lambda"
  value       = "${module.v2_orchestrator_lambda.lambda_function_name}:${module.v2_orchestrator_alias.lambda_alias_name}"
}

output "v2_orchestrator_qualified_arn" {
  description = "Qualified ARN of the v2 orchestrator durable Lambda"
  value       = module.v2_orchestrator_alias.lambda_alias_arn
}
