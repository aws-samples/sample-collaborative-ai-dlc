# Gateway grant retirement: every issuer retires the grants it signs, by jti,
# when their use ends — the orchestrator for stage grants (at the stage
# callback) and synchronous engine commands (when the command returns), the
# intents Lambda for the synchronous commands it dispatches itself. A run's own
# end writes no execution-level record. Only a deliberate stop retires a whole
# execution (cancel, rewind, recompose, lane repair, delete, the durable
# watchdog — intents and projects), conditional on the run the request read.
# The credential broker and the source-control runtime alias reject a retired
# grant. The table lives in the agentcore module, which also denies the runtime
# role every action on it.

resource "aws_iam_role_policy" "v2_orchestrator_retire_gateway_grants" {
  count = var.enable_mcp_gateway ? 1 : 0

  name = "retire-gateway-grants"
  role = aws_iam_role.v2_orchestrator.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # PutItem: a grant's jti. GetItem: a new run waits past the
        # execution's retirement before it signs its first grant.
        Sid      = "RetireGatewayGrants"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:GetItem"]
        Resource = var.gateway_grant_retirement_table_arn
      },
    ]
  })
}

# Control-plane writers. UpdateItem: the execution record, written in one
# transaction with a ConditionCheck that META still names the run the request
# read (ConditionCheckItem on the process table: the intents role already holds
# it; the projects role gets it here). The intents Lambda also retires the jti
# of a grant it issued for a synchronous command, and a jti a run recorded as
# unretired (PutItem).
resource "aws_iam_role_policy" "gateway_execution_retirement_writers" {
  for_each = var.enable_mcp_gateway ? {
    intents = {
      role    = aws_iam_role.intents.id
      actions = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
    }
    projects = {
      role    = aws_iam_role.neptune_artifacts.id
      actions = ["dynamodb:UpdateItem"]
    }
  } : {}

  name = "retire-gateway-executions"
  role = each.value.role
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RetireGatewayExecutions"
        Effect   = "Allow"
        Action   = each.value.actions
        Resource = var.gateway_grant_retirement_table_arn
      },
      {
        Sid      = "CheckRunOwnershipForRetirement"
        Effect   = "Allow"
        Action   = ["dynamodb:ConditionCheckItem"]
        Resource = var.v2_executions_table_arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "gateway_grant_retirement_readers" {
  for_each = var.enable_engine_data ? {
    credential_broker = aws_iam_role.credential_broker.id
    source_control    = aws_iam_role.source_control.id
  } : {}

  name = "read-gateway-grant-retirements"
  role = each.value
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadGatewayGrantRetirements"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem"]
      Resource = var.gateway_grant_retirement_table_arn
    }]
  })
}
