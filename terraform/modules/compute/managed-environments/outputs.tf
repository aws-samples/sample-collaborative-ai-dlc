output "control_lambda_arn" {
  description = "ARN of the managed environment control Lambda"
  value       = module.control_lambda.lambda_function_arn
}

output "control_lambda_invoke_arn" {
  description = "Invoke ARN of the managed environment control Lambda"
  value       = module.control_lambda.lambda_function_invoke_arn
}

output "control_lambda_name" {
  description = "Name of the managed environment control Lambda"
  value       = module.control_lambda.lambda_function_name
}

output "status_lambda_name" {
  description = "Name of the managed environment status Lambda"
  value       = module.status_lambda.lambda_function_name
}

output "codebuild_project_name" {
  description = "ARM64 CodeBuild project used for environment images"
  value       = aws_codebuild_project.managed_environments.name
}

output "build_context_bucket_name" {
  description = "Private bucket containing generated environment build contexts"
  value       = aws_s3_bucket.build_context.id
}

output "tool_control_lambda_arn" {
  description = "ARN of the managed tool control Lambda"
  value       = module.tool_control_lambda.lambda_function_arn
}

output "tool_control_lambda_invoke_arn" {
  description = "Invoke ARN of the managed tool control Lambda"
  value       = module.tool_control_lambda.lambda_function_invoke_arn
}

output "tool_control_lambda_name" {
  description = "Name of the managed tool control Lambda"
  value       = module.tool_control_lambda.lambda_function_name
}

output "tool_status_lambda_name" {
  description = "Name of the managed tool status Lambda"
  value       = module.tool_status_lambda.lambda_function_name
}

output "tool_codebuild_project_name" {
  description = "ARM64 CodeBuild project used for managed tool artifacts"
  value       = aws_codebuild_project.managed_tools.name
}

output "tool_repository_name" {
  description = "Immutable ECR repository for managed tool artifacts"
  value       = aws_ecr_repository.managed_tools.name
}

output "tool_repository_url" {
  description = "URL of the immutable managed tool ECR repository"
  value       = aws_ecr_repository.managed_tools.repository_url
}
