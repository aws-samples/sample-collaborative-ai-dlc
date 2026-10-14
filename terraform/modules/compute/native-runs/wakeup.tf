resource "aws_sqs_queue" "cancellation" {
  name                       = "${local.name}-cancellation"
  visibility_timeout_seconds = 720
  message_retention_seconds  = 1209600
  sqs_managed_sse_enabled    = true
}
resource "aws_sqs_queue" "projection" {
  name                       = "${local.name}-projection"
  visibility_timeout_seconds = 720
  message_retention_seconds  = 1209600
  sqs_managed_sse_enabled    = true
}
resource "aws_iam_role" "wakeup" {
  name               = "${local.name}-wakeup"
  assume_role_policy = local.lambda_trust
}
resource "aws_iam_role_policy_attachment" "wakeup_basic" {
  role       = aws_iam_role.wakeup.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "wakeup" {
  role = aws_iam_role.wakeup.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"], Resource = aws_dynamodb_table.bindings.stream_arn },
      { Effect = "Allow", Action = ["dynamodb:Scan", "dynamodb:GetItem"], Resource = aws_dynamodb_table.bindings.arn },
      { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.provisioning.arn, aws_sqs_queue.execution[0].arn, aws_sqs_queue.cancellation.arn, aws_sqs_queue.projection.arn] },
    ]
  })
}
# This separate grant cannot address executions, revocations, or package jobs.
resource "aws_iam_role_policy" "wakeup_checkpoint" {
  role = aws_iam_role.wakeup.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem"], Resource = var.native_repair_table_arn, Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["runtime"] } } },
    ]
  })
}
module "wakeup" {
  source                 = "terraform-aws-modules/lambda/aws"
  version                = "~> 8.0"
  function_name          = "${local.name}-wakeup"
  handler                = "wakeup.handler"
  runtime                = "nodejs24.x"
  architectures          = ["arm64"]
  memory_size            = 512
  timeout                = 900
  create_role            = false
  lambda_role            = aws_iam_role.wakeup.arn
  create_package         = false
  local_existing_package = module.packages["wakeup"].local_filename
  environment_variables = merge(local.base_environment, {
    NATIVE_REPAIR_CHECKPOINT_TABLE = var.native_repair_table_name
    NATIVE_EXECUTION_QUEUE_URL     = aws_sqs_queue.execution[0].url
    NATIVE_CANCELLATION_QUEUE_URL  = aws_sqs_queue.cancellation.url
    NATIVE_PROJECTION_QUEUE_URL    = aws_sqs_queue.projection.url
  })
  cloudwatch_logs_retention_in_days = 14
  depends_on                        = [aws_iam_role_policy.wakeup, aws_iam_role_policy.wakeup_checkpoint, aws_iam_role_policy_attachment.wakeup_basic]
}
resource "aws_lambda_event_source_mapping" "wakeup" {
  event_source_arn               = aws_dynamodb_table.bindings.stream_arn
  function_name                  = module.wakeup.lambda_function_arn
  starting_position              = "TRIM_HORIZON"
  batch_size                     = 50
  bisect_batch_on_function_error = true
  function_response_types        = ["ReportBatchItemFailures"]
}
resource "aws_cloudwatch_event_rule" "native_repair" {
  name                = "${local.name}-repair"
  schedule_expression = "rate(5 minutes)"
}
resource "aws_cloudwatch_event_target" "native_repair" {
  rule = aws_cloudwatch_event_rule.native_repair.name
  arn  = module.wakeup.lambda_function_arn
}
resource "aws_lambda_permission" "native_repair" {
  action        = "lambda:InvokeFunction"
  function_name = module.wakeup.lambda_function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.native_repair.arn
}
resource "aws_cloudwatch_metric_alarm" "wakeup_errors" {
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
  alarm_description   = "Native repair: owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Inspect scoped repair logs/checkpoint and retained queue work; never edit execution state or discard mandatory work."
  alarm_name          = "${local.name}-wakeup-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = module.wakeup.lambda_function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}
resource "aws_cloudwatch_metric_alarm" "stream_lag" {
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
  alarm_description   = "Native repair: owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Inspect scoped repair logs/checkpoint and retained queue work; never edit execution state or discard mandatory work."
  alarm_name          = "${local.name}-stream-lag"
  namespace           = "AWS/Lambda"
  metric_name         = "IteratorAge"
  dimensions          = { FunctionName = module.wakeup.lambda_function_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 300000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

# Dedicated function concurrency keeps cancellation independent of a long
# ordinary worker call; the cancellation command has already invalidated its lease.
module "cancellation_worker" {
  source                         = "terraform-aws-modules/lambda/aws"
  version                        = "~> 8.0"
  function_name                  = "${local.name}-cancellation"
  handler                        = "execution-worker.handler"
  runtime                        = "nodejs24.x"
  architectures                  = ["arm64"]
  memory_size                    = 512
  timeout                        = 120
  reserved_concurrent_executions = 2
  recursive_loop                 = "Allow"
  create_role                    = false
  lambda_role                    = aws_iam_role.execution_worker[0].arn
  vpc_subnet_ids                 = var.api_subnet_ids
  vpc_security_group_ids         = var.api_security_group_ids
  create_package                 = false
  local_existing_package         = module.packages["execution-worker"].local_filename
  environment_variables = merge(local.base_environment, local.execution_environment, {
    NEPTUNE_ENDPOINT                      = var.neptune_endpoint
    WORKFLOW_SOURCE_BINDINGS_TABLE        = var.workflow_source_bindings_table_name
    NATIVE_PACKAGE_JOBS_TABLE             = var.package_jobs_table_name
    SOURCE_CONTROL_BINDINGS_TABLE         = var.source_control_bindings_table_name
    NATIVE_EXECUTION_QUEUE_URL            = aws_sqs_queue.cancellation.url
    NATIVE_EXECUTION_CREDENTIALS_FUNCTION = module.execution_credentials[0].lambda_function_arn
    NATIVE_CANCELLATION_ONLY              = "true"
  })
  cloudwatch_logs_retention_in_days = 7
  depends_on                        = [aws_iam_role_policy.execution_worker]
}
resource "aws_iam_role_policy" "cancellation_queue" {
  role = aws_iam_role.execution_worker[0].id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility", "sqs:SendMessage"], Resource = aws_sqs_queue.cancellation.arn }]
  })
}
resource "aws_lambda_event_source_mapping" "cancellation" {
  event_source_arn        = aws_sqs_queue.cancellation.arn
  function_name           = module.cancellation_worker.lambda_function_arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_cloudwatch_metric_alarm" "queue_lag" {
  for_each = {
    execution    = aws_sqs_queue.execution[0].name
    preparation  = aws_sqs_queue.provisioning.name
    cancellation = aws_sqs_queue.cancellation.name
    projection   = aws_sqs_queue.projection.name
  }
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
  alarm_description   = "Native repair: owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Inspect scoped repair logs/checkpoint and retained queue work; never edit execution state or discard mandatory work."
  alarm_name          = "${local.name}-${each.key}-lag"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = each.key == "cancellation" ? 60 : 600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "repair_scan_stalled" {
  alarm_name          = "${local.name}-repair-scan-stalled"
  alarm_description   = "No successful full repair sweep; owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Inspect native_repair_scan logs and scoped lease, throttling and send failures. Diagnostic window, not an agreed SLO."
  namespace           = "NativeRepair"
  metric_name         = "ScanCompleted"
  dimensions          = { Scope = "runtime", SourceTable = aws_dynamodb_table.bindings.name }
  statistic           = "Sum"
  period              = var.native_operations.full_scan_alarm_seconds
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
}
resource "aws_cloudwatch_metric_alarm" "repair_work_errors" {
  alarm_name          = "${local.name}-repair-work-errors"
  namespace           = "NativeRepair"
  metric_name         = "RepairErrors"
  dimensions          = { Scope = "runtime", SourceTable = aws_dynamodb_table.bindings.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
  alarm_description   = "Repair failure; owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Inspect native_repair_row_failed pointers; failed rows retry next sweep, preserved checkpoint resumes after timeout."
}
resource "aws_cloudwatch_metric_alarm" "wakeup_throttles" {
  alarm_name          = "${local.name}-wakeup-throttles"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = module.wakeup.lambda_function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
  alarm_description   = "Repair or stream invocation throttled; owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Check concurrency, checkpoint age and stream lag."
}
resource "aws_cloudwatch_metric_alarm" "preparation_dead_letters" {
  alarm_name          = "${local.name}-preparation-dlq"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dead_letter.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
  alarm_description   = "Preparation dead letters; owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Inspect authoritative preparation state and repair logs before redrive. Preserve retained data."
}

# Partial batch failures return HTTP success to Lambda; Errors alone misses them.
resource "aws_cloudwatch_log_metric_filter" "native_repair_partial_failures" {
  name           = "${local.name}-stream-failures"
  log_group_name = "/aws/lambda/${module.wakeup.lambda_function_name}"
  pattern        = "{ $.event = \"native_wakeup_retry\" }"
  metric_transformation {
    name          = "${local.name}-stream-failures"
    namespace     = "NativeRepair"
    value         = "1"
    default_value = 0
  }
}
resource "aws_cloudwatch_metric_alarm" "native_repair_partial_failures" {
  alarm_name          = "${local.name}-stream-failures"
  namespace           = "NativeRepair"
  metric_name         = "${local.name}-stream-failures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
  alarm_description   = "Partial delivery or terminal package failure; owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Inspect scoped function logs and authoritative records; never delete or bypass failed work."
}
