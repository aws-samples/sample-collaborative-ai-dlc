output "ecr_repository_url" {
  description = "URL of the ECR repository"
  value       = aws_ecr_repository.yjs_server.repository_url
}

output "ecs_cluster_id" {
  description = "ID of the ECS cluster"
  value       = aws_ecs_cluster.main.id
}

output "ecs_cluster_arn" {
  description = "ARN of the ECS cluster"
  value       = aws_ecs_cluster.main.arn
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = aws_ecs_service.yjs_server.name
}

output "alb_dns_name" {
  description = "DNS name of the ALB"
  value       = aws_lb.yjs_server.dns_name
}

output "alb_arn" {
  description = "ARN of the ALB"
  value       = aws_lb.yjs_server.arn
}

output "yjs_server_url" {
  description = "WebSocket URL for Yjs server"
  # ALB internal URL; TLS is terminated at CloudFront
  value = "ws://${aws_lb.yjs_server.dns_name}" # nosemgrep: detect-insecure-websocket
}

output "task_role_arn" {
  description = "ARN of the ECS task role"
  value       = aws_iam_role.ecs_task.arn
}

output "yjs_image_uri" {
  description = "Full image URI with tag for the deployed yjs-server image"
  value       = module.yjs_docker_build.image_uri
}

output "yjs_image_tag" {
  description = "Image tag (hash) for the deployed yjs-server image"
  value       = local.yjs_image_tag
}
