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
