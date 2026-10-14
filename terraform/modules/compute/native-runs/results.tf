# Derived result artifacts have no publication, recovery, or execution writes.
resource "aws_iam_role" "results" {
  name               = "${local.name}-results"
  assume_role_policy = local.lambda_trust
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
