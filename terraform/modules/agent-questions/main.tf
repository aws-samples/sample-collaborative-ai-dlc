# =============================================================================
# Partition-Aware Data Sources
# =============================================================================
data "aws_partition" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix
}

# Lambda Execution Role
resource "aws_iam_role" "submit_question" {
  name = "${var.project_name}-submit-question-${var.environment}"

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

resource "aws_iam_role_policy" "submit_question" {
  name = "submit-question-policy"
  role = aws_iam_role.submit_question.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:GetItem"]
        Resource = [var.agent_questions_table_arn, var.connections_table_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = "${var.connections_table_arn}/index/*"
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

# Submit Question Lambda
module "submit_question_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-submit-question-${var.environment}"
  handler       = "submit-question.handler"
  runtime       = "nodejs24.x"

  source_path = [
    {
      path             = "${path.module}/../../../lambda/submit-question"
      npm_requirements = true
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.submit_question.arn

  environment_variables = {
    QUESTIONS_TABLE    = var.agent_questions_table_name
    CONNECTIONS_TABLE  = var.connections_table_name
    WEBSOCKET_ENDPOINT = replace(var.websocket_api_endpoint, "wss://", "https://")
  }

  tags = var.tags
}
