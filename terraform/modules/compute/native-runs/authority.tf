locals {
  authority_write_statements = [
    {
      Sid       = "CheckNativeAggregates"
      Effect    = "Allow"
      Action    = ["dynamodb:ConditionCheckItem"]
      Resource  = aws_dynamodb_table.bindings.arn
      Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["NATIVE#*"] } }
    },
    {
      Sid       = "WriteNativeAggregatesAndSpacePresence"
      Effect    = "Allow"
      Action    = ["dynamodb:PutItem"]
      Resource  = aws_dynamodb_table.bindings.arn
      Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["NATIVE#*", "NATIVE_SPACE#*"] } }
    },
    {
      Sid       = "CheckProjectTeardown"
      Effect    = "Allow"
      Action    = ["dynamodb:ConditionCheckItem"]
      Resource  = var.yjs_documents_table_arn
      Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["scope#project:*"] } }
    },
    {
      Sid      = "ReadOutputSubscribers"
      Effect   = "Allow"
      Action   = ["dynamodb:Query"]
      Resource = "${var.connections_table_arn}/index/DocumentIdIndex"
    },
    {
      Sid      = "InvalidateNativeOutput"
      Effect   = "Allow"
      Action   = ["execute-api:ManageConnections"]
      Resource = "${var.websocket_execution_arn}/*"
    },
  ]
}

module "authority_dynamodb_kms" {
  source      = "../../security/dynamodb-kms-runtime-access"
  kms_key_arn = var.kms_key_arn
  dns_suffix  = data.aws_partition.current.dns_suffix
  role_names  = { authority = aws_iam_role.authority.name }
}

resource "aws_iam_role" "authority" {
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn != "" ? var.iam_permissions_boundary_arn : null
  name                 = "${local.name}-authority"
  assume_role_policy   = local.lambda_trust
  tags                 = var.tags
}
resource "aws_iam_role_policy_attachment" "authority_basic" {
  role       = aws_iam_role.authority.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
module "authority" {
  source                 = "terraform-aws-modules/lambda/aws"
  version                = "~> 8.0"
  function_name          = "${local.name}-authority"
  handler                = "authority.handler"
  runtime                = "nodejs24.x"
  architectures          = ["arm64"]
  memory_size            = 512
  timeout                = 90
  publish                = true
  create_role            = false
  lambda_role            = aws_iam_role.authority.arn
  vpc_subnet_ids         = var.api_subnet_ids
  vpc_security_group_ids = var.api_security_group_ids
  create_package         = false
  local_existing_package = module.packages["authority"].local_filename
  environment_variables = merge(local.base_environment, local.execution_environment, {
    NEPTUNE_ENDPOINT                   = var.neptune_endpoint
    YJS_DOCUMENTS_TABLE                = var.yjs_documents_table_name
    WORKFLOW_SOURCE_BINDINGS_TABLE     = var.workflow_source_bindings_table_name
    NATIVE_PACKAGE_JOBS_TABLE          = var.package_jobs_table_name
    NATIVE_EXECUTION_QUEUE_URL         = aws_sqs_queue.execution[0].url
    NATIVE_GIT_RESULT_FUNCTION         = aws_lambda_function.git_result.arn
    NATIVE_RESULT_FUNCTION             = module.results.lambda_function_arn
    SOURCE_CONTROL_BINDINGS_TABLE      = var.source_control_bindings_table_name
    SOURCE_CONTROL_FUNCTION            = var.source_control_function_arn
    TRACKERS_FUNCTION                  = var.trackers_function_arn
    ARTIFACTS_BUCKET                   = var.artifacts_bucket_name
    AGENT_SETTINGS_SSM_PREFIX          = local.agent_settings_prefix
    AGENT_CREDENTIAL_METADATA_FUNCTION = var.agent_credential_metadata_function_arn
    COGNITO_USER_POOL_ID               = var.cognito_user_pool_id
    COGNITO_CLIENT_ID                  = var.cognito_client_id
    CONNECTIONS_TABLE                  = var.connections_table_name
    WEBSOCKET_ENDPOINT                 = var.websocket_endpoint
  })
  cloudwatch_logs_retention_in_days = 7
  depends_on                        = [aws_iam_role_policy.authority, aws_iam_role_policy_attachment.authority_basic]
}
resource "aws_lambda_alias" "authority" {
  for_each         = toset(["commands", "execution", "preparation", "projection", "results"])
  name             = each.key
  function_name    = module.authority.lambda_function_name
  function_version = module.authority.lambda_function_version
}
