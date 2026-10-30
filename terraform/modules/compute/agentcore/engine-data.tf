# ---------------------------------------------------------------------------
# Engine process state behind engine-data (opt-in: enable_engine_data)
#
# runtime engine -> lambda:InvokeFunction (grant from the invocation)
#   -> engine-data Lambda (verifies the grant, allowlisted store or graph
#      operation, argument schema, ids owned by the grant) -> process table,
#      Neptune
#
# The engine's process-store, graph, catalog, owned-blob and realtime calls go
# through it; provider review operations go to the source-control `runtime`
# alias. The runtime role keeps its own permissions until the final strip.
# ---------------------------------------------------------------------------

locals {
  engine_data_enabled = var.enable_engine_data
  engine_data_dir     = "${path.module}/../../../../lambda/engine-data"
  artifacts_objects   = "${var.artifacts_bucket_arn}/"

  # The S3 IAM grammar is looser than the handlers' key grammar; both apply.
  # HeadObject is authorized by s3:GetObject (GetObjectVersion when versioned).
  engine_data_catalog_objects = [
    "${local.artifacts_objects}blocks/bodies/sha256/*",
    "${local.artifacts_objects}blocks/scripts/sha256/*",
    "${local.artifacts_objects}aidlc-releases/v1/*/manifest.json",
    "${local.artifacts_objects}aidlc-releases/v1/*/catalog.json",
    "${local.artifacts_objects}aidlc-releases/v1/runtime/sha256/*",
    "${local.artifacts_objects}aidlc-runtime/*/core/aidlc-common/conductor.md",
    "${local.artifacts_objects}custom-rules/*",
  ]

  engine_data_optional_statements = concat(
    var.blocks_table_arn != "" ? [{
      Sid      = "CatalogTable"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:Query"]
      Resource = [var.blocks_table_arn, "${var.blocks_table_arn}/index/GSI1"]
    }] : [],
    var.connections_table_arn != "" ? [{
      Sid      = "IntentRecipients"
      Effect   = "Allow"
      Action   = ["dynamodb:Query"]
      Resource = ["${var.connections_table_arn}/index/DocumentIdIndex"]
    }] : [],
    var.websocket_execution_arn != "" ? [{
      Sid      = "IntentBroadcast"
      Effect   = "Allow"
      Action   = ["execute-api:ManageConnections"]
      Resource = "${var.websocket_execution_arn}/*/POST/@connections/*"
    }] : [],
  )

  # The grant-only source-control entry point the runtime calls in this mode.
  source_control_runtime_alias_arn = "${local.source_control_function_arn}:runtime"
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

  name                 = "${var.project_name}-engine-data-${var.environment}"
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn == "" ? null : var.iam_permissions_boundary_arn
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

resource "aws_iam_role_policy_attachment" "engine_data_vpc" {
  count = local.engine_data_enabled ? 1 : 0

  role       = aws_iam_role.engine_data[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
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
    Statement = concat([
      {
        Sid      = "VerifyGatewayGrants"
        Effect   = "Allow"
        Action   = ["kms:GetPublicKey"]
        Resource = aws_kms_key.gateway_grant[0].arn
      },
      {
        Sid    = "NeptuneGraph"
        Effect = "Allow"
        Action = ["neptune-db:ReadDataViaQuery", "neptune-db:WriteDataViaQuery", "neptune-db:DeleteDataViaQuery", "neptune-db:connect"]
        Resource = [
          "arn:${local.partition}:neptune-db:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:${var.neptune_cluster_resource_id}/*",
        ]
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
      {
        Sid      = "CatalogAndCustomRuleObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = local.engine_data_catalog_objects
      },
      {
        Sid      = "IntentAttachments"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${local.artifacts_objects}intent-attachments/committed/*"
      },
    ], local.engine_data_optional_statements)
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
  timeout       = 120
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

  # Neptune is VPC-only. The tools Lambda's security group already allows the
  # same egress (Neptune port inside the VPC, HTTPS for AWS APIs), and the
  # Gateway is a precondition of engine-data, so it is reused.
  vpc_subnet_ids         = aws_subnet.agentcore[*].id
  vpc_security_group_ids = [aws_security_group.mcp_tools[0].id]

  environment_variables = {
    AWS_SDK_UA_APP_ID       = var.aws_sdk_ua_app_id
    POWERTOOLS_SERVICE_NAME = var.powertools_service_name
    POWERTOOLS_LOG_LEVEL    = var.powertools_log_level
    V2_PROCESS_TABLE        = aws_dynamodb_table.v2_executions.name
    NEPTUNE_ENDPOINT        = var.neptune_endpoint
    GATEWAY_GRANT_KEY_IDS   = aws_kms_key.gateway_grant[0].arn
    ARTIFACTS_BUCKET        = var.artifacts_bucket_name
    BLOCKS_TABLE            = var.blocks_table_name
    CONNECTIONS_TABLE       = var.connections_table_name
    WEBSOCKET_ENDPOINT      = var.websocket_endpoint

    GATEWAY_GRANT_RETIREMENT_TABLE = aws_dynamodb_table.gateway_grant_retirements[0].name
  }

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  depends_on = [
    terraform_data.engine_data_requires_gateway,
    aws_iam_role_policy_attachment.engine_data_vpc,
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
      Effect = "Allow"
      Action = ["lambda:InvokeFunction"]
      Resource = [
        module.engine_data_lambda[0].lambda_function_arn,
        local.source_control_runtime_alias_arn,
      ]
    }]
  })
}
