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
  sso_claim_readers = ["users"]
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
    Statement = concat(
      [{
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
        Resource = [var.access_table_arn, "${var.access_table_arn}/index/by-user"]
      }],
      # Raw SSO claims recorded under USER#<sub> are read only by the Lambdas that
      # calculate business roles from them. The by-user index needs no exclusion:
      # claim rows carry no userId.
      contains(local.sso_claim_readers, each.key) ? [] : [{
        Effect   = "Deny"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
        Resource = [var.access_table_arn]
        Condition = {
          "ForAnyValue:StringLike" = { "dynamodb:LeadingKeys" = ["USER#*"] }
        }
      }]
    )
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

locals {
  membership_migration_environment = {
    NEPTUNE_ENDPOINT        = var.neptune_endpoint
    ACCESS_TABLE            = var.access_table_name
    AUDIT_TABLE             = var.audit_table_name
    COGNITO_USER_POOL_ID    = var.cognito_user_pool_id
    SSO_ROLE_CONFIG         = var.sso_role_config
    AWS_SDK_UA_APP_ID       = var.aws_sdk_ua_app_id
    POWERTOOLS_SERVICE_NAME = local.powertools_service_name
    POWERTOOLS_LOG_LEVEL    = var.powertools_log_level
  }

  # Lambda rejects environments above 4 KB, measured as the serialized map. The
  # SSO token trigger carries a subset of these variables and of the role config.
  sso_role_config_environments = {
    users               = local.users_environment
    cognito-users       = local.cognito_users_environment
    migrate-memberships = local.membership_migration_environment
  }
}

# Fails the plan instead of the apply when the SSO role mappings no longer fit
# in the environment of a Lambda that reads them.
resource "terraform_data" "sso_role_config_size" {
  lifecycle {
    precondition {
      condition = alltrue([
        for environment in values(local.sso_role_config_environments) : length(jsonencode(environment)) <= 4096
      ])
      error_message = "The SSO role mappings exceed the 4 KB Lambda environment limit of the users, cognito-users, or migrate-memberships Lambda. Reduce provider mappings."
    }
  }
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
      },
      {
        # One pass over the directory to backfill federated users' SSO claims.
        Effect   = "Allow"
        Action   = ["cognito-idp:ListUsers"]
        Resource = var.cognito_user_pool_arn
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
  environment_variables             = local.membership_migration_environment
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

locals {
  sso_claims_enabled = length(keys(try(jsondecode(var.sso_role_config).providers, {}))) > 0
}

# The sign-in trigger records claims before the backfill runs, so a sign-in
# during the deployment is either recorded or copied by the backfill.
resource "terraform_data" "sso_claims_recorder" {
  count = local.sso_claims_enabled ? 1 : 0
  input = var.sso_token_lambda_arn
}

# Runs once on upgrade, before the users Lambda reads recorded claims: from then
# on a missing copy means the user has no SSO claims. Existing copies are kept.
resource "aws_lambda_invocation" "sso_claims_backfill" {
  count           = local.sso_claims_enabled ? 1 : 0
  function_name   = module.membership_migration_lambda.lambda_function_name
  input           = jsonencode({ action = "backfill-sso-claims", version = 1 })
  lifecycle_scope = "CREATE_ONLY"
  depends_on      = [aws_iam_role_policy.membership_migration, terraform_data.sso_claims_recorder]
  lifecycle {
    postcondition {
      condition     = try(jsondecode(self.result).backfilled, false)
      error_message = "SSO claims backfill failed. The users Lambda update is blocked; inspect the migration Lambda logs."
    }
  }
}
