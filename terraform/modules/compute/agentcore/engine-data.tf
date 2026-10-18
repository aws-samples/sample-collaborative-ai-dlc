# ---------------------------------------------------------------------------
# Engine process state behind engine-data (opt-in: enable_engine_data)
#
# runtime engine -> lambda:InvokeFunction (grant from the invocation)
#   -> engine-data Lambda (verifies the grant, allowlisted store method,
#      argument schema, execution belongs to the grant) -> process table
#
# This slice moves the engine's process-store calls only. The runtime role
# keeps its own permissions until every engine data path goes through a
# grant-checked Lambda; removing them is the last step of the series.
# ---------------------------------------------------------------------------

locals {
  engine_data_enabled = var.enable_engine_data
  engine_data_dir     = "${path.module}/../../../../lambda/engine-data"
}

resource "terraform_data" "engine_data_requires_gateway" {
  count = local.engine_data_enabled ? 1 : 0

  lifecycle {
    precondition {
      condition     = local.mcp_gateway_enabled
      error_message = "enable_engine_data requires enable_mcp_gateway: the built-in MCP would otherwise keep direct table access in the runtime."
    }
  }
}

resource "aws_iam_role" "engine_data" {
  count = local.engine_data_enabled ? 1 : 0

  name = "${var.project_name}-engine-data-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "engine_data_logs" {
  count = local.engine_data_enabled ? 1 : 0

  role       = aws_iam_role.engine_data[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# What the allowlisted store methods send (transactions are authorized per
# item). No Scan, no DeleteItem and no BatchWriteItem: the methods that need
# them are not exposed.
resource "aws_iam_role_policy" "engine_data" {
  count = local.engine_data_enabled ? 1 : 0

  name = "engine-data"
  role = aws_iam_role.engine_data[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "VerifyGatewayGrants"
        Effect   = "Allow"
        Action   = ["kms:GetPublicKey"]
        Resource = aws_kms_key.gateway_grant[0].arn
      },
      {
        Sid    = "ProcessTable"
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]
        Resource = [
          aws_dynamodb_table.v2_executions.arn,
          "${aws_dynamodb_table.v2_executions.arn}/index/*",
        ]
      },
    ]
  })
}

module "engine_data_lambda" {
  count = local.engine_data_enabled ? 1 : 0

  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-engine-data-${var.environment}"
  description   = "Grant-verified process-state access for the AgentCore engine"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 30
  memory_size   = 512

  source_path = [
    {
      path = local.engine_data_dir
      commands = [
        "cd ../.. && npm run build -w engine-data",
        ":zip lambda/engine-data/.build",
      ]
    }
  ]
  hash_extra = local.mcp_tools_sources_hash

  create_role = false
  lambda_role = aws_iam_role.engine_data[0].arn

  environment_variables = {
    AWS_SDK_UA_APP_ID       = var.aws_sdk_ua_app_id
    POWERTOOLS_SERVICE_NAME = var.powertools_service_name
    POWERTOOLS_LOG_LEVEL    = var.powertools_log_level
    V2_PROCESS_TABLE        = aws_dynamodb_table.v2_executions.name
    GATEWAY_GRANT_KEY_IDS   = aws_kms_key.gateway_grant[0].arn
  }

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  depends_on = [
    terraform_data.engine_data_requires_gateway,
    aws_iam_role_policy_attachment.engine_data_logs,
  ]

  tags = var.tags
}

resource "aws_iam_role_policy" "agentcore_invoke_engine_data" {
  count = local.engine_data_enabled ? 1 : 0

  name = "invoke-engine-data"
  role = aws_iam_role.agentcore.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = module.engine_data_lambda[0].lambda_function_arn
    }]
  })
}
