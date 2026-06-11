# =============================================================================
# Partition-Aware Data Sources
# =============================================================================
data "aws_partition" "realtime" {}

locals {
  realtime_partition  = data.aws_partition.realtime.partition
  realtime_dns_suffix = data.aws_partition.realtime.dns_suffix
}

# IAM Role for Lambda functions
resource "aws_iam_role" "lambda" {
  name = "${var.project_name}-ws-lambda-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.${local.realtime_dns_suffix}" }
    }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "${var.project_name}-ws-lambda-policy"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:${local.realtime_partition}:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = [var.connections_table_arn, "${var.connections_table_arn}/index/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["execute-api:ManageConnections"]
        Resource = "${aws_apigatewayv2_api.websocket.execution_arn}/*"
      },
      {
        # ws-connection verifies realtime scope tokens at $connect (plan §4a).
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = aws_ssm_parameter.realtime_doc_secret.arn
      }
    ]
  })
}

data "aws_region" "current" {}

# Connection Lambda (handles $connect and $disconnect)
module "connection_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-ws-connection-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"

  source_path = [
    {
      path = "${path.module}/../../../lambda/ws-connection"
      commands = [
        "cd ../.. && npm run build -w ws-connection",
        ":zip lambda/ws-connection/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.lambda.arn

  environment_variables = {
    CONNECTIONS_TABLE     = var.connections_table_name
    WEBSOCKET_ENDPOINT    = "https://${aws_apigatewayv2_api.websocket.id}.execute-api.${data.aws_region.current.id}.${local.realtime_dns_suffix}/${var.websocket_stage_name}"
    REALTIME_SECRET_PARAM = aws_ssm_parameter.realtime_doc_secret.name
    DOC_TOKEN_ENFORCE     = var.doc_token_enforce ? "true" : "false"
  }
}

# Message Lambda (handles $default)
module "message_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-ws-message-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"

  source_path = [
    {
      path = "${path.module}/../../../lambda/ws-message"
      commands = [
        "cd ../.. && npm run build -w ws-message",
        ":zip lambda/ws-message/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.lambda.arn

  environment_variables = {
    CONNECTIONS_TABLE  = var.connections_table_name
    WEBSOCKET_ENDPOINT = "https://${aws_apigatewayv2_api.websocket.id}.execute-api.${data.aws_region.current.id}.${local.realtime_dns_suffix}/${var.websocket_stage_name}"
  }
}

# Authorizer Lambda (validates Cognito token)
module "authorizer_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-ws-authorizer-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"

  source_path = [
    {
      path = "${path.module}/../../../lambda/ws-authorizer"
      commands = [
        "cd ../.. && npm run build -w ws-authorizer",
        ":zip lambda/ws-authorizer/.build",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.lambda.arn

  environment_variables = {
    COGNITO_USER_POOL_ID = var.cognito_user_pool_id
    COGNITO_CLIENT_ID    = var.cognito_client_id
  }
}
