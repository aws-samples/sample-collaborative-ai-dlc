output "ecr_repository_url" {
  description = "ECR repository URL for the AgentCore image"
  value       = aws_ecr_repository.agentcore.repository_url
}

output "ecr_repository_name" {
  description = "ECR repository name"
  value       = aws_ecr_repository.agentcore.name
}

output "image_uri" {
  description = "Full image URI (with content-hash tag) built for the runtime"
  value       = module.agentcore_docker_build.image_uri
}

output "image_tag" {
  description = "Content-hash image tag"
  value       = local.agentcore_image_tag
}

output "v2_executions_table_name" {
  description = "v2 process/state DynamoDB table name"
  value       = aws_dynamodb_table.v2_executions.name
}

output "v2_executions_table_arn" {
  description = "v2 process/state DynamoDB table ARN"
  value       = aws_dynamodb_table.v2_executions.arn
}

output "runtime_arn" {
  description = "ARN of the Bedrock AgentCore Runtime"
  value       = awscc_bedrockagentcore_runtime.stage_executor.agent_runtime_arn
}

output "runtime_id" {
  description = "Id of the Bedrock AgentCore Runtime"
  value       = awscc_bedrockagentcore_runtime.stage_executor.agent_runtime_id
}

output "role_arn" {
  description = "IAM execution role ARN for the runtime"
  value       = aws_iam_role.agentcore.arn
}
