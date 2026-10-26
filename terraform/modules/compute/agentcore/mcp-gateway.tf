# ---------------------------------------------------------------------------
# Built-in MCP behind AgentCore Gateway (opt-in: enable_mcp_gateway)
#
# runtime CLI -> stdio proxy (SigV4, InvokeGateway) -> Gateway (AWS_IAM)
#   -> mcp-tools Lambda (verifies the control-plane grant on every call)
#   -> Neptune / process table / realtime channel
#
# The orchestrator and discussions Lambdas sign per-invocation grants with the
# asymmetric key below; the tools Lambda only ever reads its public half.
# Disabled, nothing here exists and the runtime keeps its local MCP server.
# ---------------------------------------------------------------------------

locals {
  mcp_gateway_enabled = var.enable_mcp_gateway
  mcp_tools_dir       = "${path.module}/../../../../lambda/mcp-tools"
  # The tools Lambda bundles its own directory plus lambda/shared/** (the MCP
  # core lives in lambda/shared/mcp); the module only hashes source_path.
  mcp_tools_sources_hash = sha256(join("", [
    for f in sort(fileset("${path.module}/../../../../lambda/shared", "**/*.{js,mjs,cjs,json}")) :
    filesha256("${path.module}/../../../../lambda/shared/${f}")
  ]))
  gateway_grant_signer_role_arns = [
    "arn:${local.partition}:iam::${data.aws_caller_identity.current.account_id}:role${var.iam_role_path}${var.project_name}-v2-orchestrator-${var.environment}",
    "arn:${local.partition}:iam::${data.aws_caller_identity.current.account_id}:role${var.iam_role_path}${var.project_name}-discussions-${var.environment}",
  ]
  mcp_gateway_tools_json = file("${local.mcp_tools_dir}/gateway-tools.json")
  mcp_gateway_headers    = ["x-aidlc-grant", "x-aidlc-session"]
}

resource "terraform_data" "mcp_gateway_requires_vpc" {
  count = local.mcp_gateway_enabled ? 1 : 0

  lifecycle {
    precondition {
      condition     = local.vpc_enabled
      error_message = "enable_mcp_gateway requires network_mode = \"VPC\" so the tools Lambda can reach Neptune."
    }
  }
}

resource "aws_kms_key" "gateway_grant" {
  count = local.mcp_gateway_enabled ? 1 : 0

  description              = "${var.project_name}-${var.environment} AgentCore Gateway grant signing key"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30

  # Only the two control-plane issuers may sign, whatever IAM policies exist
  # elsewhere in the account; administration stays with the account root.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministrationExceptSigning"
        Effect    = "Allow"
        Principal = { AWS = "arn:${local.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
        NotAction = ["kms:Sign"]
        Resource  = "*"
      },
      {
        Sid       = "ControlPlaneIssuersSign"
        Effect    = "Allow"
        Principal = { AWS = "arn:${local.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = ["kms:Sign"]
        Resource  = "*"
        Condition = {
          ArnEquals    = { "aws:PrincipalArn" = local.gateway_grant_signer_role_arns }
          StringEquals = { "kms:SigningAlgorithm" = "ECDSA_SHA_256" }
        }
      },
    ]
  })

  tags = var.tags
}

resource "aws_kms_alias" "gateway_grant" {
  count = local.mcp_gateway_enabled ? 1 : 0

  name          = "alias/${var.project_name}-${var.environment}-gateway-grant"
  target_key_id = aws_kms_key.gateway_grant[0].key_id
}

resource "aws_security_group" "mcp_tools" {
  count = local.mcp_gateway_enabled ? 1 : 0

  name_prefix = "${var.project_name}-mcp-tools-${var.environment}"
  description = "MCP tools Lambda; egress only (Neptune in-VPC, AWS APIs)"

  lifecycle {
    create_before_destroy = true
  }
  vpc_id = var.vpc_id

  egress {
    description = "Neptune (IAM auth) inside the VPC"
    from_port   = 8182
    to_port     = 8182
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "AWS APIs (KMS, DynamoDB, API Gateway management) over HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
}

resource "aws_iam_role" "mcp_tools" {
  count = local.mcp_gateway_enabled ? 1 : 0

  name                 = "${var.project_name}-mcp-tools-${var.environment}"
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

resource "aws_iam_role_policy_attachment" "mcp_tools_vpc" {
  count = local.mcp_gateway_enabled ? 1 : 0

  role       = aws_iam_role.mcp_tools[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# The data-plane permissions the built-in MCP needs. They live on this role,
# behind per-call grant verification, instead of being usable directly by
# whatever runs in the agent's VM. (Removing them from the runtime role is the
# follow-up once every runtime command goes through a grant-scoped path.)
resource "aws_iam_role_policy" "mcp_tools" {
  count = local.mcp_gateway_enabled ? 1 : 0

  name = "mcp-tools"
  role = aws_iam_role.mcp_tools[0].id
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
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"]
        Resource = [
          aws_dynamodb_table.v2_executions.arn,
          "${aws_dynamodb_table.v2_executions.arn}/index/*",
        ]
      },
      {
        Sid      = "RealtimeConnections"
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = ["${var.connections_table_arn}/index/DocumentIdIndex"]
      },
      {
        # Broadcasts only post to connections; no
        # connection lookup or disconnect.
        Sid      = "RealtimeBroadcast"
        Effect   = "Allow"
        Action   = ["execute-api:ManageConnections"]
        Resource = "${var.websocket_execution_arn}/*/POST/@connections/*"
      },
    ]
  })
}

module "mcp_tools_lambda" {
  count = local.mcp_gateway_enabled ? 1 : 0

  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-mcp-tools-${var.environment}"
  description   = "AgentCore Gateway target for the built-in aidlc MCP tools"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 120
  memory_size   = 512

  source_path = [
    {
      path = local.mcp_tools_dir
      commands = [
        "cd ../.. && npm run build -w mcp-tools",
        ":zip lambda/mcp-tools/.build",
      ]
    }
  ]
  hash_extra = local.mcp_tools_sources_hash

  create_role = false
  lambda_role = aws_iam_role.mcp_tools[0].arn

  vpc_subnet_ids         = aws_subnet.agentcore[*].id
  vpc_security_group_ids = [aws_security_group.mcp_tools[0].id]

  environment_variables = {
    AWS_SDK_UA_APP_ID       = var.aws_sdk_ua_app_id
    POWERTOOLS_SERVICE_NAME = var.powertools_service_name
    POWERTOOLS_LOG_LEVEL    = var.powertools_log_level
    V2_PROCESS_TABLE        = aws_dynamodb_table.v2_executions.name
    NEPTUNE_ENDPOINT        = var.neptune_endpoint
    CONNECTIONS_TABLE       = var.connections_table_name
    WEBSOCKET_ENDPOINT      = var.websocket_endpoint
    GATEWAY_GRANT_KEY_IDS   = aws_kms_key.gateway_grant[0].arn
  }

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  depends_on = [
    terraform_data.mcp_gateway_requires_vpc,
    aws_iam_role_policy_attachment.mcp_tools_vpc,
  ]

  tags = var.tags
}

resource "aws_iam_role" "mcp_gateway" {
  count = local.mcp_gateway_enabled ? 1 : 0

  name                 = "${var.project_name}-mcp-gateway-${var.environment}"
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn == "" ? null : var.iam_permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "mcp_gateway" {
  count = local.mcp_gateway_enabled ? 1 : 0

  name = "invoke-mcp-tools"
  role = aws_iam_role.mcp_gateway[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = module.mcp_tools_lambda[0].lambda_function_arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${var.artifacts_bucket_arn}/mcp-gateway/*"
      },
      ], var.kms_key_arn == "" ? [] : [{
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.kms_key_arn
    }])
  })
}

resource "aws_bedrockagentcore_gateway" "mcp" {
  count = local.mcp_gateway_enabled ? 1 : 0

  name            = "${var.project_name}-mcp-${var.environment}"
  description     = "Built-in aidlc MCP tools for AgentCore runtime sessions"
  protocol_type   = "MCP"
  authorizer_type = "AWS_IAM"
  role_arn        = aws_iam_role.mcp_gateway[0].arn

  tags = var.tags
}

# Gateway reads a Lambda target's tool schema at create/update time; S3 keeps
# the generated JSON schema intact instead of re-expressing it as nested HCL.
resource "aws_s3_object" "mcp_gateway_tools" {
  count = local.mcp_gateway_enabled ? 1 : 0

  bucket       = var.artifacts_bucket_name
  key          = "mcp-gateway/aidlc-tools-${sha256(local.mcp_gateway_tools_json)}.json"
  content      = local.mcp_gateway_tools_json
  content_type = "application/json"

  # The target re-reads the schema on update; never leave it pointing at a key
  # that was deleted first.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_bedrockagentcore_gateway_target" "aidlc" {
  count = local.mcp_gateway_enabled ? 1 : 0

  gateway_identifier = aws_bedrockagentcore_gateway.mcp[0].gateway_id
  name               = "aidlc"
  description        = "Built-in aidlc MCP tools"

  target_configuration {
    mcp {
      lambda {
        lambda_arn = module.mcp_tools_lambda[0].lambda_function_arn
        tool_schema {
          s3 {
            uri = "s3://${var.artifacts_bucket_name}/${aws_s3_object.mcp_gateway_tools[0].key}"
          }
        }
      }
    }
  }

  credential_provider_configuration {
    gateway_iam_role {}
  }

  metadata_configuration {
    allowed_request_headers = local.mcp_gateway_headers
  }

  depends_on = [aws_iam_role_policy.mcp_gateway]
}

resource "aws_iam_role_policy" "agentcore_invoke_mcp_gateway" {
  count = local.mcp_gateway_enabled ? 1 : 0

  name = "invoke-mcp-gateway"
  role = aws_iam_role.agentcore.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock-agentcore:InvokeGateway"]
      Resource = aws_bedrockagentcore_gateway.mcp[0].gateway_arn
    }]
  })
}
