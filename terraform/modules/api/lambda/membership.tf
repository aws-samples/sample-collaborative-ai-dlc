locals {
  membership_readers = {
    neptune_reader      = aws_iam_role.neptune_reader.id
    neptune_questions   = aws_iam_role.neptune_questions.id
    neptune_tasks       = aws_iam_role.neptune_tasks.id
    neptune_artifacts   = aws_iam_role.neptune_artifacts.id
    users               = aws_iam_role.users.id
    agents_orchestrator = aws_iam_role.agents_orchestrator.id
    intents             = aws_iam_role.intents.id
    discussions         = aws_iam_role.discussions.id
    trackers            = aws_iam_role.trackers.id
    source_control      = aws_iam_role.source_control.id
    intent_pin_lookup   = aws_iam_role.intent_pin_lookup.id
  }
  membership_writers = {
    projects = aws_iam_role.neptune_artifacts.id
    users    = aws_iam_role.users.id
  }
}

resource "aws_iam_role_policy" "membership_read" {
  for_each = local.membership_readers
  name     = "space-membership-read"
  role     = each.value
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:Query"]
      Resource = [var.access_table_arn, "${var.access_table_arn}/index/by-user"]
    }]
  })
}

resource "aws_iam_role_policy" "membership_write" {
  for_each = local.membership_writers
  name     = "space-membership-write-and-history"
  role     = each.value
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = concat(
          ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem"],
          each.key == "users" ? ["dynamodb:UpdateItem"] : []
        )
        Resource = [var.access_table_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:Query"]
        Resource = [var.audit_table_arn]
      }
    ]
  })
}

resource "aws_iam_role" "membership_migration" {
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn == "" ? null : var.iam_permissions_boundary_arn
  name                 = "${var.project_name}-membership-migration-${var.environment}"
  assume_role_policy   = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "membership_migration_basic" {
  role       = aws_iam_role.membership_migration.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "membership_migration_vpc" {
  role       = aws_iam_role.membership_migration.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "membership_migration" {
  role = aws_iam_role.membership_migration.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.neptune_statement,
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"]
        Resource = [var.access_table_arn, "${var.access_table_arn}/index/by-user", var.audit_table_arn]
      }
    ]
  })
}

module "membership_migration_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-migrate-memberships-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 900
  source_path = [{
    path = "${path.module}/../../../../lambda/migrate-memberships"
    commands = [
      "cd ../.. && npm run build -w migrate-memberships",
      ":zip lambda/migrate-memberships/.build",
    ]
  }]
  hash_extra                        = local.shared_sources_hash
  create_role                       = false
  lambda_role                       = aws_iam_role.membership_migration.arn
  vpc_subnet_ids                    = var.private_subnet_ids
  vpc_security_group_ids            = [aws_security_group.lambda.id]
  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7
  environment_variables = {
    NEPTUNE_ENDPOINT        = var.neptune_endpoint
    ACCESS_TABLE            = var.access_table_name
    AUDIT_TABLE             = var.audit_table_name
    AWS_SDK_UA_APP_ID       = var.aws_sdk_ua_app_id
    POWERTOOLS_SERVICE_NAME = local.powertools_service_name
    POWERTOOLS_LOG_LEVEL    = var.powertools_log_level
  }
  depends_on = [
    aws_iam_role_policy.membership_migration,
    aws_iam_role_policy_attachment.membership_migration_basic,
    aws_iam_role_policy_attachment.membership_migration_vpc,
    module.dynamodb_kms_runtime_access,
  ]
}

# An apply-time resource, not a plan-time data source. The stable input runs this
# once on upgrade; ordinary updates cannot re-import stale authorization edges.
resource "aws_lambda_invocation" "membership_copy" {
  depends_on      = [aws_iam_role_policy.membership_read, aws_iam_role_policy.membership_write]
  function_name   = module.membership_migration_lambda.lambda_function_name
  input           = jsonencode({ action = "copy", version = 1 })
  lifecycle_scope = "CREATE_ONLY"
  lifecycle {
    postcondition {
      condition     = try(jsondecode(self.result).verified, false)
      error_message = "Membership copy/verification failed. Application cutover is blocked; inspect the migration Lambda logs."
    }
  }
}
