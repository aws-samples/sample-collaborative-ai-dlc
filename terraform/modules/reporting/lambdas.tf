# The three reporting Lambdas are built from one workspace (lambda/reporting),
# each from its own entry point, and each has its own role.

locals {
  lambda_source = "${path.module}/../../../lambda/reporting"
  log_retention = var.environment == "prod" ? 30 : 7

  lambda_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.${local.dns_suffix}" }
    }]
  })

  lambda_environment = {
    AWS_SDK_UA_APP_ID       = var.aws_sdk_ua_app_id
    POWERTOOLS_SERVICE_NAME = var.powertools_service_name
    POWERTOOLS_LOG_LEVEL    = var.powertools_log_level
  }

  glue_resources = [
    "arn:${local.partition}:glue:${local.region}:${local.account_id}:catalog",
    aws_glue_catalog_database.reporting.arn,
    "arn:${local.partition}:glue:${local.region}:${local.account_id}:table/${local.database}/*",
  ]
}

# -----------------------------------------------------------------------------
# Transform (Firehose record transformation)
# -----------------------------------------------------------------------------

resource "aws_iam_role" "transform" {
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn == "" ? null : var.iam_permissions_boundary_arn
  name                 = "${local.name}-transform"
  assume_role_policy   = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "transform_basic" {
  role       = aws_iam_role.transform.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

module "transform_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${local.name}-transform"
  description   = "Turns v2-executions changes into reporting lake rows (Firehose transform)"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 120
  memory_size   = 256

  source_path = [
    {
      path = local.lambda_source
      commands = [
        "cd ../.. && npm run build:transform -w reporting",
        ":zip lambda/reporting/.build/transform",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.transform.arn

  cloudwatch_logs_retention_in_days = local.log_retention
  environment_variables             = local.lambda_environment

  depends_on = [aws_iam_role_policy_attachment.transform_basic]
}

# -----------------------------------------------------------------------------
# Backfill (one-off, resumable scan of the table into the lake)
# -----------------------------------------------------------------------------

resource "aws_iam_role" "backfill" {
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn == "" ? null : var.iam_permissions_boundary_arn
  name                 = "${local.name}-backfill"
  assume_role_policy   = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "backfill_basic" {
  role       = aws_iam_role.backfill.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "backfill" {
  name = "reporting-backfill"
  role = aws_iam_role.backfill.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Scan"]
        Resource = var.v2_executions_table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.lake.arn}/executions/*"
      },
    ]
  })
}

module "backfill_kms_access" {
  source = "../security/dynamodb-kms-runtime-access"

  kms_key_arn = var.kms_key_arn
  dns_suffix  = local.dns_suffix
  role_names  = { reporting_backfill = aws_iam_role.backfill.name }
}

module "backfill_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${local.name}-backfill"
  description   = "One-off, resumable scan of v2-executions into the reporting lake"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 900
  memory_size   = 512

  source_path = [
    {
      path = local.lambda_source
      commands = [
        "cd ../.. && npm run build:backfill -w reporting",
        ":zip lambda/reporting/.build/backfill",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.backfill.arn

  cloudwatch_logs_retention_in_days = local.log_retention
  environment_variables = merge(local.lambda_environment, {
    TABLE_NAME  = var.v2_executions_table_name
    LAKE_BUCKET = aws_s3_bucket.lake.bucket
  })

  depends_on = [aws_iam_role_policy_attachment.backfill_basic]
}

# -----------------------------------------------------------------------------
# Views (creates or replaces the Athena views; invoked by Terraform)
# -----------------------------------------------------------------------------

resource "aws_iam_role" "views" {
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn == "" ? null : var.iam_permissions_boundary_arn
  name                 = "${local.name}-views"
  assume_role_policy   = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "views_basic" {
  role       = aws_iam_role.views.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "views" {
  name = "reporting-views"
  role = aws_iam_role.views.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetWorkGroup"]
        Resource = aws_athena_workgroup.reporting.arn
      },
      {
        Effect = "Allow"
        Action = [
          "glue:GetDatabase",
          "glue:GetTable",
          "glue:GetTables",
          "glue:CreateTable",
          "glue:UpdateTable",
        ]
        Resource = local.glue_resources
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetBucketLocation", "s3:ListBucket"]
        Resource = aws_s3_bucket.lake.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"]
        Resource = "${aws_s3_bucket.lake.arn}/athena-results/*"
      },
    ]
  })
}

module "views_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${local.name}-views"
  description   = "Creates or replaces the reporting lake's Athena views"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 300
  memory_size   = 256

  source_path = [
    {
      path = local.lambda_source
      commands = [
        "cd ../.. && npm run build:views -w reporting",
        ":zip lambda/reporting/.build/views",
      ]
    }
  ]

  create_role = false
  lambda_role = aws_iam_role.views.arn

  cloudwatch_logs_retention_in_days = local.log_retention
  environment_variables = merge(local.lambda_environment, {
    ATHENA_WORKGROUP = aws_athena_workgroup.reporting.name
    GLUE_DATABASE    = aws_glue_catalog_database.reporting.name
  })

  depends_on = [aws_iam_role_policy_attachment.views_basic]
}

# -----------------------------------------------------------------------------
# Firehose delivery role
# -----------------------------------------------------------------------------

resource "aws_iam_role" "firehose" {
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn == "" ? null : var.iam_permissions_boundary_arn
  name                 = "${local.name}-firehose"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "firehose.${local.dns_suffix}" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "sts:ExternalId" = local.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "firehose" {
  name = "reporting-firehose"
  role = aws_iam_role.firehose.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "kinesis:DescribeStream",
          "kinesis:DescribeStreamSummary",
          "kinesis:GetShardIterator",
          "kinesis:GetRecords",
          "kinesis:ListShards",
        ]
        Resource = aws_kinesis_stream.executions.arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:GetBucketLocation",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:ListBucketMultipartUploads",
          "s3:PutObject",
        ]
        Resource = [aws_s3_bucket.lake.arn, "${aws_s3_bucket.lake.arn}/*"]
      },
      {
        Effect = "Allow"
        Action = ["lambda:InvokeFunction", "lambda:GetFunctionConfiguration"]
        Resource = [
          module.transform_lambda.lambda_function_arn,
          "${module.transform_lambda.lambda_function_arn}:*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.firehose.arn}:*"
      },
    ]
  })
}
