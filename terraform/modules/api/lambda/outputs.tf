output "agents_orchestrator_role_arn" {
  description = "ARN of the IAM role for the agents Lambda (most privileged: Neptune + DDB + SSM + ECS RunTask + IAM PassRole). Consumed by the api module to wire the agents_lambda created in api/agents.tf."
  value       = aws_iam_role.agents_orchestrator.arn
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
  value       = module.projects_lambda.lambda_function_invoke_arn
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
  value       = module.users_lambda.lambda_function_invoke_arn
}

output "users_lambda_name" {
  description = "Name of the users Lambda function"
  value       = module.users_lambda.lambda_function_name
}

output "sprints_lambda_arn" {
  value = module.sprints_lambda.lambda_function_arn
}
output "sprints_lambda_invoke_arn" {
  value = module.sprints_lambda.lambda_function_invoke_arn
}
output "sprints_lambda_name" {
  value = module.sprints_lambda.lambda_function_name
}

output "requirements_lambda_arn" {
  value = module.requirements_lambda.lambda_function_arn
}
output "requirements_lambda_invoke_arn" {
  value = module.requirements_lambda.lambda_function_invoke_arn
}
output "requirements_lambda_name" {
  value = module.requirements_lambda.lambda_function_name
}

output "user_stories_lambda_arn" {
  value = module.user_stories_lambda.lambda_function_arn
}
output "user_stories_lambda_invoke_arn" {
  value = module.user_stories_lambda.lambda_function_invoke_arn
}
output "user_stories_lambda_name" {
  value = module.user_stories_lambda.lambda_function_name
}

output "tasks_lambda_arn" {
  value = module.tasks_lambda.lambda_function_arn
}
output "tasks_lambda_invoke_arn" {
  value = module.tasks_lambda.lambda_function_invoke_arn
}
output "tasks_lambda_name" {
  value = module.tasks_lambda.lambda_function_name
}

output "code_files_lambda_arn" {
  value = module.code_files_lambda.lambda_function_arn
}
output "code_files_lambda_invoke_arn" {
  value = module.code_files_lambda.lambda_function_invoke_arn
}
output "code_files_lambda_name" {
  value = module.code_files_lambda.lambda_function_name
}

output "reviews_lambda_arn" {
  value = module.reviews_lambda.lambda_function_arn
}
output "reviews_lambda_invoke_arn" {
  value = module.reviews_lambda.lambda_function_invoke_arn
}
output "reviews_lambda_name" {
  value = module.reviews_lambda.lambda_function_name
}

output "questions_lambda_arn" {
  value = module.questions_lambda.lambda_function_arn
}
output "questions_lambda_invoke_arn" {
  value = module.questions_lambda.lambda_function_invoke_arn
}
output "questions_lambda_name" {
  value = module.questions_lambda.lambda_function_name
}

output "sprint_graph_lambda_arn" {
  value = module.sprint_graph_lambda.lambda_function_arn
}
output "sprint_graph_lambda_invoke_arn" {
  value = module.sprint_graph_lambda.lambda_function_invoke_arn
}
output "sprint_graph_lambda_name" {
  value = module.sprint_graph_lambda.lambda_function_name
}

output "general_info_lambda_arn" {
  value = module.general_info_lambda.lambda_function_arn
}
output "general_info_lambda_invoke_arn" {
  value = module.general_info_lambda.lambda_function_invoke_arn
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
  value       = module.github_lambda.lambda_function_invoke_arn
}

output "github_lambda_name" {
  description = "Name of the github Lambda function"
  value       = module.github_lambda.lambda_function_name
}

output "github_issues_lambda_arn" {
  description = "ARN of the github-issues Lambda function"
  value       = module.github_issues_lambda.lambda_function_arn
}

output "github_issues_lambda_invoke_arn" {
  description = "Invoke ARN of the github-issues Lambda function"
  value       = module.github_issues_lambda.lambda_function_invoke_arn
}

output "github_issues_lambda_name" {
  description = "Name of the github-issues Lambda function"
  value       = module.github_issues_lambda.lambda_function_name
}

output "timeline_events_lambda_arn" {
  value = module.timeline_events_lambda.lambda_function_arn
}
output "timeline_events_lambda_invoke_arn" {
  value = module.timeline_events_lambda.lambda_function_invoke_arn
}
output "timeline_events_lambda_name" {
  value = module.timeline_events_lambda.lambda_function_name
}

output "purge_neptune_lambda_name" {
  value = module.purge_neptune_lambda.lambda_function_name
}

output "cognito_users_lambda_arn" {
  description = "ARN of the cognito-users Lambda function"
  value       = module.cognito_users_lambda.lambda_function_arn
}

output "cognito_users_lambda_invoke_arn" {
  description = "Invoke ARN of the cognito-users Lambda function"
  value       = module.cognito_users_lambda.lambda_function_invoke_arn
}

output "cognito_users_lambda_name" {
  description = "Name of the cognito-users Lambda function"
  value       = module.cognito_users_lambda.lambda_function_name
}