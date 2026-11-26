variable "enable_native_workflow_sources" {
  description = "Enable the dedicated native workflow-source API"
  type        = bool
  default     = false
  nullable    = false
}

variable "workflow_source_bindings_table_name" {
  description = "Name of the isolated workflow-source binding table"
  type        = string
  nullable    = false
}

variable "workflow_source_bindings_table_arn" {
  description = "ARN of the isolated workflow-source binding table"
  type        = string
  nullable    = false
}

locals {
  workflow_sources_connection_table_arns = compact([
    var.git_connections_table_arn,
    var.git_provider_connections_table_arn,
  ])
  workflow_sources_secret_arns = compact([
    var.github_app_private_key_secret_arn,
    var.gitlab_oauth_secret_arn,
    var.bitbucket_oauth_secret_arn,
  ])
}

# This role belongs only to the API Gateway-facing workflow-source service.
# Do not share it with AgentCore, source-control, or either credential broker.
resource "aws_iam_role" "workflow_sources" {
  name               = "${var.project_name}-workflow-sources-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "workflow_sources_basic" {
  role       = aws_iam_role.workflow_sources.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "workflow_sources_vpc" {
  role       = aws_iam_role.workflow_sources.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "workflow_sources" {
  name = "workflow-source-verification"
  role = aws_iam_role.workflow_sources.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          # The pilot deliberately reuses existing Neptune membership. The
          # service can read it but cannot change the graph itself.
          Sid      = "ReadProjectMembership"
          Effect   = "Allow"
          Action   = ["neptune-db:ReadDataViaQuery", "neptune-db:connect"]
          Resource = local.neptune_resource_arn
        },
        {
          # Binding deletion is a conditional Put of a tombstone, not DeleteItem.
          Sid      = "ManageWorkflowSourceBindings"
          Effect   = "Allow"
          Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
          Resource = var.workflow_source_bindings_table_arn
        },
        {
          # ensureFreshGitToken reads and refreshes the existing user's token.
          # It never deletes a token or writes GitHub App configuration.
          Sid      = "ReadAndRefreshOAuthTokens"
          Effect   = "Allow"
          Action   = ["ssm:GetParameter", "ssm:PutParameter"]
          Resource = "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
        },
      ],
      length(local.workflow_sources_connection_table_arns) > 0 ? [
        {
          Sid      = "ReadGitConnections"
          Effect   = "Allow"
          Action   = ["dynamodb:GetItem"]
          Resource = local.workflow_sources_connection_table_arns
        },
      ] : [],
      var.git_provider_connections_table_arn != "" ? [
        {
          # getGitConnection migrates an observed legacy connection with a
          # conditional Put; refresh only conditionally updates its metadata.
          Sid      = "MigrateAndRefreshProviderConnections"
          Effect   = "Allow"
          Action   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
          Resource = var.git_provider_connections_table_arn
        },
      ] : [],
      var.git_connections_table_arn != "" && var.git_provider_connections_table_arn != "" ? [
        {
          # The migration transaction pairs a provider-table Put with an
          # observed legacy-row Delete. No provider-row deletion is required.
          Sid      = "RemoveMigratedLegacyConnection"
          Effect   = "Allow"
          Action   = ["dynamodb:DeleteItem"]
          Resource = var.git_connections_table_arn
        },
      ] : [],
      var.github_app_config_param_arn != "" ? [
        {
          Sid      = "ReadGitHubAppConfiguration"
          Effect   = "Allow"
          Action   = ["ssm:GetParameter"]
          Resource = var.github_app_config_param_arn
        },
      ] : [],
      length(local.workflow_sources_secret_arns) > 0 ? [
        {
          Sid      = "ReadProviderVerificationSecrets"
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue"]
          Resource = local.workflow_sources_secret_arns
        },
      ] : [],
    )
  })
}

module "workflow_sources_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-workflow-sources-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  memory_size   = 512
  timeout       = 30

  # Deployment installs the root package-lock once with npm ci before packaging.
  # Match existing workspace builds; per-Lambda installs would race each other.
  source_path = [
    {
      path = "${path.module}/../../../../lambda/workflow-sources"
      commands = [
        "cd ../.. && npm run build -w workflow-sources",
        ":zip lambda/workflow-sources/.build",
      ]
    }
  ]
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.workflow_sources.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  environment_variables = merge(local.native_package_jobs_api_environment, {
    POWERTOOLS_SERVICE_NAME            = local.powertools_service_name
    POWERTOOLS_LOG_LEVEL               = var.powertools_log_level
    POWERTOOLS_LOGGER_LOG_EVENT        = tostring(var.powertools_log_event)
    WORKFLOW_SOURCE_API_ENABLED        = tostring(var.enable_native_workflow_sources)
    WORKFLOW_SOURCE_BINDINGS_TABLE     = var.workflow_source_bindings_table_name
    NEPTUNE_ENDPOINT                   = var.neptune_endpoint
    GIT_CONNECTIONS_TABLE              = var.git_connections_table_name
    GIT_PROVIDER_CONNECTIONS_TABLE     = var.git_provider_connections_table_name
    GITHUB_APP_CONFIG_PARAM            = var.github_app_config_param_name
    GITHUB_APP_PRIVATE_KEY_SECRET_NAME = var.github_app_private_key_secret_name
    GITLAB_OAUTH_SECRET_NAME           = var.gitlab_oauth_secret_name
    GITLAB_REDIRECT_URI                = var.gitlab_redirect_uri
    BITBUCKET_OAUTH_SECRET_NAME        = var.bitbucket_oauth_secret_name
    ENVIRONMENT                        = var.environment
    CORS_ALLOWED_ORIGINS               = var.cors_allowed_origins
  })
}

output "workflow_sources_lambda_name" {
  description = "Name of the dedicated workflow-source API Lambda"
  value       = module.workflow_sources_lambda.lambda_function_name
}

output "workflow_sources_lambda_invoke_arn" {
  description = "API Gateway invoke ARN of the dedicated workflow-source API Lambda"
  value       = module.workflow_sources_lambda.lambda_function_invoke_arn
}

output "workflow_sources_lambda_arn" {
  description = "ARN of the dedicated workflow-source API Lambda"
  value       = module.workflow_sources_lambda.lambda_function_arn
}
