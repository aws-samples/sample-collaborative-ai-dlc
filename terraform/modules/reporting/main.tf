# Reporting lake: every change to the v2-executions table, queryable in Athena.
#
#   v2-executions (unchanged)
#     -> Kinesis Data Streams for DynamoDB (a streaming destination on the table)
#     -> Firehose, with the transform Lambda: one JSON line per change, with
#        transcripts and credential fields left out
#     -> S3: executions/record_type=<sort-key prefix>/dt=<yyyy-MM-dd>/*.gz
#     -> Glue table `changes` + Athena views (views/*.sql)
#
# The streaming destination is a separate resource from the table, so the
# table definition doesn't change. See docs/using-the-platform/reporting.md.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  name     = "${var.project_name}-reporting-${var.environment}"
  database = replace("${var.project_name}_reporting_${var.environment}", "-", "_")

  # The transform's sort-key prefix -> record_type map is the single source of
  # the partition values; "other" catches prefixes added later.
  record_types = concat(
    values(jsondecode(file("${path.module}/../../../lambda/reporting/record-types.json"))),
    ["other"],
  )

  lake_start_date = var.lake_start_date != "" ? var.lake_start_date : terraform_data.lake_created.output

  views_dir = "${path.module}/views"
  view_files = [
    for f in sort(fileset(local.views_dir, "*.sql")) : { name = f, sql = file("${local.views_dir}/${f}") }
  ]
}

# The day the lake was first created, kept across later applies.
resource "terraform_data" "lake_created" {
  input = formatdate("YYYY-MM-DD", timestamp())
  lifecycle {
    ignore_changes = [input]
  }
}

# -----------------------------------------------------------------------------
# Lake bucket
# -----------------------------------------------------------------------------

resource "random_id" "lake_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "lake" {
  bucket = "${local.name}-${random_id.lake_suffix.hex}"
  # DynamoDB keeps only each row's current state, so the change history here
  # can't be rebuilt. Objects are written once, so versioning adds nothing.
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket_public_access_block" "lake" {
  bucket                  = aws_s3_bucket.lake.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "lake" {
  bucket = aws_s3_bucket.lake.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "lake" {
  bucket = aws_s3_bucket.lake.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "lake" {
  bucket = aws_s3_bucket.lake.id
  rule {
    id     = "athena-results"
    status = "Enabled"
    filter {
      prefix = "athena-results/"
    }
    expiration {
      days = 7
    }
  }
  rule {
    id     = "firehose-errors"
    status = "Enabled"
    filter {
      prefix = "errors/"
    }
    expiration {
      days = 30
    }
  }
}

data "aws_iam_policy_document" "lake" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.lake.arn,
      "${aws_s3_bucket.lake.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "lake" {
  bucket     = aws_s3_bucket.lake.id
  policy     = data.aws_iam_policy_document.lake.json
  depends_on = [aws_s3_bucket_public_access_block.lake]
}

# -----------------------------------------------------------------------------
# DynamoDB -> Kinesis -> Firehose -> S3
# -----------------------------------------------------------------------------

resource "aws_kinesis_stream" "executions" {
  name             = "${local.name}-executions"
  retention_period = 24
  encryption_type  = "KMS"
  kms_key_id       = "alias/aws/kinesis"

  stream_mode_details {
    stream_mode = var.kinesis_shard_count > 0 ? "PROVISIONED" : "ON_DEMAND"
  }
  shard_count = var.kinesis_shard_count > 0 ? var.kinesis_shard_count : null
}

resource "aws_dynamodb_kinesis_streaming_destination" "executions" {
  stream_arn = aws_kinesis_stream.executions.arn
  table_name = var.v2_executions_table_name
  # Orders changes to the same row that land in the same millisecond.
  approximate_creation_date_time_precision = "MICROSECOND"
}

resource "aws_cloudwatch_log_group" "firehose" {
  name              = "/aws/kinesisfirehose/${local.name}"
  retention_in_days = var.environment == "prod" ? 30 : 7
}

resource "aws_cloudwatch_log_stream" "firehose" {
  name           = "S3Delivery"
  log_group_name = aws_cloudwatch_log_group.firehose.name
}

resource "aws_kinesis_firehose_delivery_stream" "executions" {
  name        = "${local.name}-executions"
  destination = "extended_s3"

  kinesis_source_configuration {
    kinesis_stream_arn = aws_kinesis_stream.executions.arn
    role_arn           = aws_iam_role.firehose.arn
  }

  extended_s3_configuration {
    role_arn   = aws_iam_role.firehose.arn
    bucket_arn = aws_s3_bucket.lake.arn
    # Dynamic partitioning needs a buffer of at least 64 MB; at platform
    # volumes the interval is what sets the latency.
    buffering_size      = 64
    buffering_interval  = var.buffer_seconds
    compression_format  = "GZIP"
    prefix              = "executions/record_type=!{partitionKeyFromLambda:record_type}/dt=!{partitionKeyFromLambda:dt}/"
    error_output_prefix = "errors/!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/"

    dynamic_partitioning_configuration {
      enabled        = true
      retry_duration = 300
    }

    processing_configuration {
      enabled = true
      processors {
        type = "Lambda"
        # Invocation buffering is left at Firehose's defaults. AWS doesn't
        # store default values, so setting them shows a change on every plan.
        parameters {
          parameter_name  = "LambdaArn"
          parameter_value = "${module.transform_lambda.lambda_function_arn}:$LATEST"
        }
      }
    }

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = aws_cloudwatch_log_group.firehose.name
      log_stream_name = aws_cloudwatch_log_stream.firehose.name
    }
  }

  depends_on = [aws_iam_role_policy.firehose]
}

# -----------------------------------------------------------------------------
# Glue table, Athena workgroup and views
# -----------------------------------------------------------------------------

resource "aws_glue_catalog_database" "reporting" {
  name        = local.database
  description = "Reporting lake for ${var.project_name} ${var.environment}"
}

# Every change to every reported row, in one envelope. The row itself is the
# JSON string in `item`; the views pick fields out of it.
resource "aws_glue_catalog_table" "changes" {
  name          = "changes"
  database_name = aws_glue_catalog_database.reporting.name
  table_type    = "EXTERNAL_TABLE"

  parameters = {
    classification                  = "json"
    "projection.enabled"            = "true"
    "projection.record_type.type"   = "enum"
    "projection.record_type.values" = join(",", local.record_types)
    "projection.dt.type"            = "date"
    "projection.dt.format"          = "yyyy-MM-dd"
    "projection.dt.range"           = "${local.lake_start_date},NOW"
    "projection.dt.interval"        = "1"
    "projection.dt.interval.unit"   = "DAYS"
    "storage.location.template"     = "s3://${aws_s3_bucket.lake.bucket}/executions/record_type=$${record_type}/dt=$${dt}/"
  }

  partition_keys {
    name = "record_type"
    type = "string"
  }
  partition_keys {
    name = "dt"
    type = "string"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.lake.bucket}/executions/"
    input_format  = "org.apache.hadoop.mapred.TextInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"

    ser_de_info {
      serialization_library = "org.openx.data.jsonserde.JsonSerDe"
      parameters            = { "ignore.malformed.json" = "true" }
    }

    columns {
      name    = "event_id"
      type    = "string"
      comment = "DynamoDB change ID, or snapshot-<run>-... for backfilled rows"
    }
    columns {
      name    = "event_name"
      type    = "string"
      comment = "INSERT | MODIFY | REMOVE | SNAPSHOT"
    }
    columns {
      name = "event_time"
      type = "string"
    }
    columns {
      name    = "event_ts_us"
      type    = "bigint"
      comment = "Change time in epoch microseconds; orders changes to one row"
    }
    columns {
      name = "pk"
      type = "string"
    }
    columns {
      name = "sk"
      type = "string"
    }
    columns {
      name = "execution_id"
      type = "string"
    }
    columns {
      name = "entity_type"
      type = "string"
    }
    columns {
      name    = "item"
      type    = "string"
      comment = "The row as JSON (the old image for REMOVE)"
    }
  }
}

resource "aws_athena_workgroup" "reporting" {
  name          = local.name
  description   = "Reporting lake queries for ${var.project_name} ${var.environment}"
  force_destroy = true

  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true
    bytes_scanned_cutoff_per_query     = var.athena_bytes_scanned_cutoff

    result_configuration {
      output_location = "s3://${aws_s3_bucket.lake.bucket}/athena-results/"
      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}

# Re-run whenever a view file changes. The function runs each file's
# CREATE OR REPLACE VIEW statements in file-name order.
resource "aws_lambda_invocation" "views" {
  function_name = module.views_lambda.lambda_function_name
  input         = jsonencode({ files = local.view_files })

  depends_on = [
    aws_glue_catalog_table.changes,
    aws_athena_workgroup.reporting,
    aws_iam_role_policy.views,
  ]
}

# -----------------------------------------------------------------------------
# Read-only access for BI tools and later reporting APIs
# -----------------------------------------------------------------------------

resource "aws_iam_policy" "reader" {
  path        = var.iam_role_path
  name        = "${local.name}-reader"
  description = "Query the ${var.project_name} ${var.environment} reporting lake through Athena"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "athena:GetWorkGroup",
          "athena:StartQueryExecution",
          "athena:StopQueryExecution",
          "athena:GetQueryExecution",
          "athena:GetQueryResults",
          "athena:GetQueryResultsStream",
          "athena:ListQueryExecutions",
          "athena:BatchGetQueryExecution",
        ]
        Resource = aws_athena_workgroup.reporting.arn
      },
      {
        Effect = "Allow"
        Action = [
          "athena:ListWorkGroups",
          "athena:ListDataCatalogs",
          "athena:GetDataCatalog",
          "athena:ListDatabases",
          "athena:GetDatabase",
          "athena:ListTableMetadata",
          "athena:GetTableMetadata",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "glue:GetDatabase",
          "glue:GetDatabases",
          "glue:GetTable",
          "glue:GetTables",
          "glue:GetPartition",
          "glue:GetPartitions",
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
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.lake.arn}/executions/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"]
        Resource = "${aws_s3_bucket.lake.arn}/athena-results/*"
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# Alarms
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "freshness" {
  alarm_name          = "${local.name}-stale"
  alarm_description   = "The reporting lake is more than 15 minutes behind; see ${aws_cloudwatch_log_group.firehose.name} and errors/ in the lake bucket"
  namespace           = "AWS/Firehose"
  metric_name         = "DeliveryToS3.DataFreshness"
  dimensions          = { DeliveryStreamName = aws_kinesis_firehose_delivery_stream.executions.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "transform_errors" {
  alarm_name          = "${local.name}-transform-errors"
  alarm_description   = "The reporting transform Lambda is failing; see its logs"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = module.transform_lambda.lambda_function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
}
