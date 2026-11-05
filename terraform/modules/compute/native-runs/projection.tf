resource "aws_iam_role" "projection" {
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn != "" ? var.iam_permissions_boundary_arn : null
  name                 = "${local.name}-projection"
  assume_role_policy   = local.lambda_trust
}
resource "aws_iam_role_policy_attachment" "projection_basic" {
  role       = aws_iam_role.projection.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
resource "aws_iam_role_policy" "projection" {
  role = aws_iam_role.projection.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = "${local.base_environment.NATIVE_AUTHORITY_FUNCTION}:projection" },
      { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility", "sqs:SendMessage"], Resource = aws_sqs_queue.projection.arn },
      { Effect = "Allow", Action = ["neptune-db:connect", "neptune-db:ReadDataViaQuery", "neptune-db:WriteDataViaQuery", "neptune-db:DeleteDataViaQuery"], Resource = local.graph_arn },
      { Effect = "Allow", Action = ["s3:GetObjectVersion"], Resource = "${aws_s3_bucket.publications.arn}/native-executions/*" },
    ]
  })
}
module "projection" {
  source                 = "terraform-aws-modules/lambda/aws"
  version                = "~> 8.0"
  function_name          = "${local.name}-projection"
  handler                = "projection-worker.handler"
  runtime                = "nodejs24.x"
  architectures          = ["arm64"]
  memory_size            = 512
  timeout                = 120
  recursive_loop         = "Allow"
  create_role            = false
  lambda_role            = aws_iam_role.projection.arn
  vpc_subnet_ids         = var.api_subnet_ids
  vpc_security_group_ids = var.api_security_group_ids
  create_package         = false
  local_existing_package = module.packages["projection-worker"].local_filename
  environment_variables = merge(local.base_environment, local.execution_environment, {
    NEPTUNE_ENDPOINT            = var.neptune_endpoint
    NATIVE_PROJECTION_QUEUE_URL = aws_sqs_queue.projection.url
  })
  cloudwatch_logs_retention_in_days = 7
  depends_on                        = [aws_iam_role_policy.projection, aws_iam_role_policy_attachment.projection_basic]
}
resource "aws_lambda_event_source_mapping" "projection" {
  event_source_arn        = aws_sqs_queue.projection.arn
  function_name           = module.projection.lambda_function_arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}
