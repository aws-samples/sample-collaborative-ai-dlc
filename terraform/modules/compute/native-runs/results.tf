# Derived result artifacts have no publication, recovery, or execution writes.
resource "aws_iam_role" "results" {
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn != "" ? var.iam_permissions_boundary_arn : null
  name                 = "${local.name}-results"
  assume_role_policy   = local.lambda_trust
}
resource "aws_iam_role_policy_attachment" "results_basic" {
  role       = aws_iam_role.results.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
resource "aws_iam_role_policy" "results" {
  role = aws_iam_role.results.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = "${local.base_environment.NATIVE_AUTHORITY_FUNCTION}:results" },
      { Effect = "Allow", Action = ["dynamodb:GetItem"], Resource = aws_dynamodb_table.bindings.arn,
      Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["NATIVE#*"] } } },
      { Effect = "Allow", Action = ["s3:GetObjectVersion"], Resource = "${aws_s3_bucket.publications.arn}/native-executions/*" },
      { Effect = "Allow", Action = ["s3:PutObject", "s3:DeleteObjectVersion"], Resource = "${aws_s3_bucket.publications.arn}/native-results/v1/*" },
    ]
  })
}
module "results" {
  source                            = "terraform-aws-modules/lambda/aws"
  version                           = "~> 8.0"
  function_name                     = "${local.name}-results"
  handler                           = "result-worker.handler"
  runtime                           = "nodejs24.x"
  architectures                     = ["arm64"]
  memory_size                       = 512
  ephemeral_storage_size            = 512
  timeout                           = 900
  create_role                       = false
  lambda_role                       = aws_iam_role.results.arn
  vpc_subnet_ids                    = var.api_subnet_ids
  vpc_security_group_ids            = var.api_security_group_ids
  create_package                    = false
  local_existing_package            = module.packages["result-worker"].local_filename
  environment_variables             = merge(local.base_environment, local.execution_environment)
  cloudwatch_logs_retention_in_days = 7
  depends_on                        = [aws_iam_role_policy.results, aws_iam_role_policy_attachment.results_basic]
}

# Git plumbing runs on the qualified image with the existing derived-result role.
# The builder reads captured source objects and has no provider credentials.
resource "aws_lambda_function" "git_result" {
  function_name = "${local.name}-git-result"
  role          = aws_iam_role.results.arn
  package_type  = "Image"
  image_uri     = "${var.image_repository_url}@${var.image_arm64_manifest_digest}"
  architectures = ["arm64"]
  memory_size   = 1024
  timeout       = 900
  ephemeral_storage { size = 1024 }
  image_config {
    entry_point       = ["/usr/bin/env", "LAMBDA_TASK_ROOT=/opt/native-runtime-control", "_HANDLER=result-worker.handler", "/usr/local/bin/node", "/opt/native-lambda-interface/node_modules/aws-lambda-ric/index.mjs"]
    command           = ["result-worker.handler"]
    working_directory = "/opt/native-runtime-control"
  }
  vpc_config {
    subnet_ids         = var.api_subnet_ids
    security_group_ids = var.api_security_group_ids
  }
  environment { variables = merge(local.base_environment, local.execution_environment) }
  tags       = var.tags
  depends_on = [aws_ecr_repository_policy.workflow_engine, aws_iam_role_policy.results, aws_cloudwatch_log_group.git_result]
}
resource "aws_cloudwatch_log_group" "git_result" {
  name              = "/aws/lambda/${local.name}-git-result"
  retention_in_days = 7
  tags              = var.tags
}
