# ---------------------------------------------------------------------------
# End-of-stage Gateway grant retirement (with enable_mcp_gateway)
#
# Each issuer records a grant's jti here (pk GRANT#<jti>) when its use ends:
# the orchestrator at a stage callback and after every synchronous engine
# command, the intents Lambda after the synchronous commands it dispatches.
# A deliberate stop — cancel, rewind, recompose, lane repair, delete, durable
# watchdog — has the intents/projects Lambdas retire every grant of the
# execution issued up to that second (pk EXEC#<executionId>, retiredAt),
# conditional on the run they read; a run's own end writes no such record.
# Every grant consumer
# (mcp-tools, engine-data, the credential broker and the source-control runtime
# alias) rejects a grant either record covers. Writers and readers are wired in
# their own modules; this file owns the table, the consumer reads in this
# module, and the runtime-role Deny.
#
# The table holds no business data: each row expires (TTL `expiresAt`) only
# after any grant it names has expired, so it is not deletion-protected and
# disabling the Gateway may remove it.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "gateway_grant_retirements" {
  #checkov:skip=CKV_AWS_28:Rows are short-lived revocation markers that expire with the grants they name; there is nothing to restore.
  count = local.mcp_gateway_enabled ? 1 : 0

  name           = "${var.project_name}-gateway-grant-retirements-${var.environment}"
  billing_mode   = local.billing_mode
  hash_key       = "pk"
  read_capacity  = local.read_capacity
  write_capacity = local.write_capacity

  deletion_protection_enabled = false

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  attribute {
    name = "pk"
    type = "S"
  }

  server_side_encryption {
    enabled     = var.kms_key_arn != ""
    kms_key_arn = var.kms_key_arn != "" ? var.kms_key_arn : null
  }

  tags = var.tags
}

# The runtime relays grants but must never see or clear a retirement. It holds
# no Allow on this table; the explicit Deny keeps it that way whatever is
# granted to the role later (core and managed runtimes share this role).
resource "aws_iam_role_policy" "agentcore_deny_gateway_grant_retirements" {
  count = local.mcp_gateway_enabled ? 1 : 0

  name = "deny-gateway-grant-retirements"
  role = aws_iam_role.agentcore.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "DenyGatewayGrantRetirements"
      Effect = "Deny"
      Action = ["dynamodb:*"]
      Resource = [
        aws_dynamodb_table.gateway_grant_retirements[0].arn,
        "${aws_dynamodb_table.gateway_grant_retirements[0].arn}/*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "mcp_tools_read_gateway_grant_retirements" {
  count = local.mcp_gateway_enabled ? 1 : 0

  name = "read-gateway-grant-retirements"
  role = aws_iam_role.mcp_tools[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadGatewayGrantRetirements"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem"]
      Resource = aws_dynamodb_table.gateway_grant_retirements[0].arn
    }]
  })
}

resource "aws_iam_role_policy" "engine_data_read_gateway_grant_retirements" {
  count = local.engine_data_enabled ? 1 : 0

  name = "read-gateway-grant-retirements"
  role = aws_iam_role.engine_data[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadGatewayGrantRetirements"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem"]
      Resource = aws_dynamodb_table.gateway_grant_retirements[0].arn
    }]
  })
}
