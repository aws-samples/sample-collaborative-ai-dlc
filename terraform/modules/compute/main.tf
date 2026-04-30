resource "aws_ecs_cluster" "agents" {
  name = "${var.project_name}-${var.environment}-agents"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "agents" {
  cluster_name = aws_ecs_cluster.agents.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    base              = 1
    weight            = 100
    capacity_provider = "FARGATE"
  }
}
