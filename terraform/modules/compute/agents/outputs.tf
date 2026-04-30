output "ecr_repository_url" {
  description = "ECR repository URL for agent images"
  value       = aws_ecr_repository.agents.repository_url
}

output "agent_task_definition_arn" {
  description = "ARN of the unified Agent task definition"
  value       = aws_ecs_task_definition.agent.arn
}

# Family ARN without revision (e.g. arn:...:task-definition/<family>) — used as the base
# for an IAM Resource pattern like "<family_arn>:*" so ecs:RunTask can be scoped to any
# revision of this specific task-definition family without breaking on every revision bump.
output "agent_task_definition_family_arn" {
  description = "ARN of the Agent task definition without the revision suffix (for IAM scoping to family:*)"
  value       = aws_ecs_task_definition.agent.arn_without_revision
}

output "agent_security_group_id" {
  description = "Security group ID for agent tasks"
  value       = aws_security_group.agents.id
}

output "agent_task_role_arn" {
  description = "ARN of the agent task IAM role"
  value       = aws_iam_role.agent_task.arn
}

output "agent_execution_role_arn" {
  description = "ARN of the agent execution IAM role"
  value       = aws_iam_role.agent_execution.arn
}

output "ecr_repository_name" {
  description = "ECR repository name for agent images"
  value       = aws_ecr_repository.agents.name
}

output "ecr_repository_arn" {
  description = "ECR repository ARN for agent images (used to scope ecr:* IAM permissions)"
  value       = aws_ecr_repository.agents.arn
}

output "agent_image_uri" {
  description = "Full image URI with tag for the deployed agent image"
  value       = module.agents_docker_build.image_uri
}

output "agent_image_tag" {
  description = "Image tag (hash) for the deployed agent image"
  value       = local.agents_image_tag
}