# =============================================================================
# Partition-Aware Data Sources
# =============================================================================
data "aws_partition" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix
}

resource "aws_cloudwatch_event_bus" "agents" {
  name = "${var.project_name}-agents-${var.environment}"

  tags = var.tags
}

# Lambda Execution Role
resource "aws_iam_role" "notify_lambda" {
  name = "${var.project_name}-notify-lambda-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.${local.dns_suffix}" }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "notify_lambda" {
  name = "notify-lambda-policy"
  role = aws_iam_role.notify_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = ["${var.connections_table_arn}/index/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["execute-api:ManageConnections"]
        Resource = "${var.websocket_execution_arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:${local.partition}:logs:*:*:*"
      }
    ]
  })
}

# Notification Lambda
module "notify_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-notify-${var.environment}"
  handler       = "notify.handler"
  runtime       = "nodejs24.x"

  source_path = [
    {
      path = "${path.module}/../../../lambda/notify"
      commands = [
        "npm ci --omit=dev --ignore-scripts",
        ":zip",
      ]
      patterns = [
        "!test/.*",
        "!vitest\\.config\\.js",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.notify_lambda.arn

  environment_variables = {
    CONNECTIONS_TABLE  = var.connections_table_name
    WEBSOCKET_ENDPOINT = replace(var.websocket_api_endpoint, "wss://", "https://")
  }

  tags = var.tags
}

# EventBridge Rules
resource "aws_cloudwatch_event_rule" "agent_started" {
  name           = "${var.project_name}-agent-started-${var.environment}"
  event_bus_name = aws_cloudwatch_event_bus.agents.name

  event_pattern = jsonencode({
    detail-type = ["agent.started"]
  })

  tags = var.tags
}

resource "aws_cloudwatch_event_rule" "agent_completed" {
  name           = "${var.project_name}-agent-completed-${var.environment}"
  event_bus_name = aws_cloudwatch_event_bus.agents.name

  event_pattern = jsonencode({
    detail-type = ["agent.completed"]
  })

  tags = var.tags
}

resource "aws_cloudwatch_event_rule" "agent_question" {
  name           = "${var.project_name}-agent-question-${var.environment}"
  event_bus_name = aws_cloudwatch_event_bus.agents.name

  event_pattern = jsonencode({
    detail-type = ["agent.question"]
  })

  tags = var.tags
}

resource "aws_cloudwatch_event_rule" "agent_error" {
  name           = "${var.project_name}-agent-error-${var.environment}"
  event_bus_name = aws_cloudwatch_event_bus.agents.name

  event_pattern = jsonencode({
    detail-type = ["agent.error"]
  })

  tags = var.tags
}

# Artifact change events
resource "aws_cloudwatch_event_rule" "artifact_created" {
  name           = "${var.project_name}-artifact-created-${var.environment}"
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  event_pattern  = jsonencode({ detail-type = ["artifact.created"] })
  tags           = var.tags
}

resource "aws_cloudwatch_event_rule" "artifact_updated" {
  name           = "${var.project_name}-artifact-updated-${var.environment}"
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  event_pattern  = jsonencode({ detail-type = ["artifact.updated"] })
  tags           = var.tags
}

resource "aws_cloudwatch_event_rule" "artifact_deleted" {
  name           = "${var.project_name}-artifact-deleted-${var.environment}"
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  event_pattern  = jsonencode({ detail-type = ["artifact.deleted"] })
  tags           = var.tags
}

resource "aws_cloudwatch_event_rule" "sprint_phase_changed" {
  name           = "${var.project_name}-sprint-phase-changed-${var.environment}"
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  event_pattern  = jsonencode({ detail-type = ["sprint.phaseChanged"] })
  tags           = var.tags
}

# Targets for artifact events
resource "aws_cloudwatch_event_target" "artifact_created" {
  rule           = aws_cloudwatch_event_rule.artifact_created.name
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  target_id      = "notify"
  arn            = module.notify_lambda.lambda_function_arn
}
resource "aws_cloudwatch_event_target" "artifact_updated" {
  rule           = aws_cloudwatch_event_rule.artifact_updated.name
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  target_id      = "notify"
  arn            = module.notify_lambda.lambda_function_arn
}
resource "aws_cloudwatch_event_target" "artifact_deleted" {
  rule           = aws_cloudwatch_event_rule.artifact_deleted.name
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  target_id      = "notify"
  arn            = module.notify_lambda.lambda_function_arn
}
resource "aws_cloudwatch_event_target" "sprint_phase_changed" {
  rule           = aws_cloudwatch_event_rule.sprint_phase_changed.name
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  target_id      = "notify"
  arn            = module.notify_lambda.lambda_function_arn
}

# Lambda permissions for artifact events
resource "aws_lambda_permission" "artifact_created" {
  statement_id  = "AllowEventBridgeArtifactCreated"
  action        = "lambda:InvokeFunction"
  function_name = module.notify_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.artifact_created.arn
}
resource "aws_lambda_permission" "artifact_updated" {
  statement_id  = "AllowEventBridgeArtifactUpdated"
  action        = "lambda:InvokeFunction"
  function_name = module.notify_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.artifact_updated.arn
}
resource "aws_lambda_permission" "artifact_deleted" {
  statement_id  = "AllowEventBridgeArtifactDeleted"
  action        = "lambda:InvokeFunction"
  function_name = module.notify_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.artifact_deleted.arn
}
resource "aws_lambda_permission" "sprint_phase_changed" {
  statement_id  = "AllowEventBridgeSprintPhaseChanged"
  action        = "lambda:InvokeFunction"
  function_name = module.notify_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.sprint_phase_changed.arn
}

# Lambda Targets
resource "aws_cloudwatch_event_target" "agent_started" {
  rule           = aws_cloudwatch_event_rule.agent_started.name
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  target_id      = "notify"
  arn            = module.notify_lambda.lambda_function_arn
}

resource "aws_cloudwatch_event_target" "agent_completed" {
  rule           = aws_cloudwatch_event_rule.agent_completed.name
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  target_id      = "notify"
  arn            = module.notify_lambda.lambda_function_arn
}

resource "aws_cloudwatch_event_target" "agent_question" {
  rule           = aws_cloudwatch_event_rule.agent_question.name
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  target_id      = "notify"
  arn            = module.notify_lambda.lambda_function_arn
}

resource "aws_cloudwatch_event_target" "agent_error" {
  rule           = aws_cloudwatch_event_rule.agent_error.name
  event_bus_name = aws_cloudwatch_event_bus.agents.name
  target_id      = "notify"
  arn            = module.notify_lambda.lambda_function_arn
}

# Lambda Permissions for EventBridge
resource "aws_lambda_permission" "agent_started" {
  statement_id  = "AllowEventBridgeStarted"
  action        = "lambda:InvokeFunction"
  function_name = module.notify_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.agent_started.arn
}

resource "aws_lambda_permission" "agent_completed" {
  statement_id  = "AllowEventBridgeCompleted"
  action        = "lambda:InvokeFunction"
  function_name = module.notify_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.agent_completed.arn
}

resource "aws_lambda_permission" "agent_question" {
  statement_id  = "AllowEventBridgeQuestion"
  action        = "lambda:InvokeFunction"
  function_name = module.notify_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.agent_question.arn
}

resource "aws_lambda_permission" "agent_error" {
  statement_id  = "AllowEventBridgeError"
  action        = "lambda:InvokeFunction"
  function_name = module.notify_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.agent_error.arn
}
