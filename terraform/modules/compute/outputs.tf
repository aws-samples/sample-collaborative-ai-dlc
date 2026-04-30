output "cluster_id" {
  description = "ID of the ECS cluster"
  value       = aws_ecs_cluster.agents.id
}

output "cluster_arn" {
  description = "ARN of the ECS cluster"
  value       = aws_ecs_cluster.agents.arn
}

output "cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.agents.name
}
