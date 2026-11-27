output "cluster_id" {
  description = "Neptune cluster identifier"
  value       = aws_neptune_cluster.main.id
}

output "cluster_arn" {
  description = "Neptune cluster ARN"
  value       = aws_neptune_cluster.main.arn
}

output "cluster_resource_id" {
  description = "Neptune cluster resource ID for IAM auth"
  value       = aws_neptune_cluster.main.cluster_resource_id
}

output "cluster_endpoint" {
  description = "Neptune cluster endpoint"
  value       = aws_neptune_cluster.main.endpoint
  # The cluster endpoint exists before any instance serves it. Apply-time
  # invocations (the membership copy) must not reach it before the writer does.
  depends_on = [aws_neptune_cluster_instance.main]
}

output "cluster_reader_endpoint" {
  description = "Neptune cluster reader endpoint"
  value       = aws_neptune_cluster.main.reader_endpoint
}

output "cluster_port" {
  description = "Neptune cluster port"
  value       = aws_neptune_cluster.main.port
}

output "security_group_id" {
  description = "Neptune security group ID"
  value       = aws_security_group.neptune.id
}

output "instance_class" {
  description = "Neptune instance class managed by Terraform"
  value       = aws_neptune_cluster_instance.main.instance_class
}
