output "ecr_repository_url" {
  description = "ECR repository URL for the AgentCore image"
  value       = aws_ecr_repository.agentcore.repository_url
}

output "ecr_repository_name" {
  description = "ECR repository name"
  value       = aws_ecr_repository.agentcore.name
}

output "ecr_repository_arn" {
  description = "ARN of the protected AgentCore image repository"
  value       = aws_ecr_repository.agentcore.arn
}

output "image_uri" {
  description = "Full image URI (with content-hash tag) built for the runtime"
  value       = module.agentcore_docker_build.image_uri
}

output "image_digest" {
  description = "Immutable digest of the protected AgentCore image"
  value       = data.aws_ecr_image.agentcore.image_digest
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

output "runtime_version" {
  description = "AgentCore runtime version used by the seeded Standard environment"
  value       = awscc_bedrockagentcore_runtime.stage_executor.agent_runtime_version
}

output "runtime_compatibility_version" {
  description = "Runtime contract version supported by the protected image"
  value       = "1"
}

output "network_mode" {
  description = "Network mode inherited by managed environment runtimes"
  value       = var.network_mode
}

output "runtime_subnet_ids" {
  description = "Subnets inherited by managed environment runtimes"
  value       = aws_subnet.agentcore[*].id
}

output "runtime_security_group_ids" {
  description = "Security groups inherited by managed environment runtimes"
  value       = aws_security_group.agentcore[*].id
}

output "runtime_environment_variables" {
  description = "Protected environment variables inherited by managed runtimes"
  value       = local.runtime_environment_variables
}

output "managed_environment_repository_name" {
  description = "Name of the immutable managed environment image repository"
  value       = aws_ecr_repository.managed_environments.name
}

output "managed_environment_repository_url" {
  description = "URL of the immutable managed environment image repository"
  value       = aws_ecr_repository.managed_environments.repository_url
}

output "managed_environment_repository_arn" {
  description = "ARN of the immutable managed environment image repository"
  value       = aws_ecr_repository.managed_environments.arn
}
