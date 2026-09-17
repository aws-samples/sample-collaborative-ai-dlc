resource "aws_dynamodb_table" "members" {
  count        = var.scaling.cluster_enabled ? 1 : 0
  name         = "${var.project_name}-yjs-members-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

resource "aws_iam_role_policy" "cluster" {
  count = var.scaling.cluster_enabled ? 1 : 0
  role  = aws_iam_role.ecs_task.id
  name  = "yjs-document-ownership"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"]
        Resource = var.documents_table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Scan"]
        Resource = aws_dynamodb_table.members[0].arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource = "${var.snapshots_bucket_arn}/yjs-documents/*"
      },
    ]
  })
}

resource "aws_appautoscaling_target" "workers" {
  min_capacity       = local.min_capacity
  max_capacity       = local.max_capacity
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.yjs_server.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "resources" {
  for_each = var.scaling.autoscaling == null ? {} : {
    # One Node event loop can saturate one vCPU. Adjust the service CPU target
    # if an operator selects extra CPUs primarily to obtain more memory.
    cpu    = { metric = "ECSServiceAverageCPUUtilization", target = 60 * min(1, 1024 / local.worker_cpu) }
    memory = { metric = "ECSServiceAverageMemoryUtilization", target = 70 }
  }
  name               = "${local.metric_service}-${each.key}"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.workers.resource_id
  scalable_dimension = aws_appautoscaling_target.workers.scalable_dimension
  service_namespace  = aws_appautoscaling_target.workers.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = each.value.target
    scale_out_cooldown = 60
    scale_in_cooldown  = 600
    predefined_metric_specification {
      predefined_metric_type = each.value.metric
    }
  }
}

resource "aws_appautoscaling_policy" "capacity" {
  count              = var.scaling.autoscaling == null ? 0 : 1
  name               = "${local.metric_service}-capacity"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.workers.resource_id
  scalable_dimension = aws_appautoscaling_target.workers.scalable_dimension
  service_namespace  = aws_appautoscaling_target.workers.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_out_cooldown = 60
    scale_in_cooldown  = 600
    customized_metric_specification {
      namespace   = "CollaborativeAI/Yjs"
      metric_name = "CapacityUtilization"
      statistic   = "Average"
      dimensions {
        name  = "ServiceName"
        value = local.metric_service
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "workers" {
  for_each = {
    capacity    = { metric = "CapacityUtilization", statistic = "Maximum", threshold = 85 }
    event_loop  = { metric = "EventLoopDelayP99Ms", statistic = "Maximum", threshold = 200 }
    persistence = { metric = "PersistenceErrors", statistic = "Sum", threshold = 0 }
    rejected    = { metric = "RejectedConnections", statistic = "Sum", threshold = 0 }
  }
  alarm_name          = "${local.metric_service}-${each.key}"
  alarm_description   = "Yjs worker pressure or failed checkpoints. Inspect per-task logs and document distribution before raising limits."
  namespace           = "CollaborativeAI/Yjs"
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  period              = 60
  evaluation_periods  = each.key == "persistence" ? 1 : 3
  treat_missing_data  = "notBreaching"
  dimensions          = { ServiceName = local.metric_service }
  alarm_actions       = var.scaling.alarm_actions
  ok_actions          = var.scaling.alarm_actions
}
