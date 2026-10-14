variable "enable_native_package_jobs" {
  description = "Enable protected native package jobs after bounded first-import readiness review"
  type        = bool
  default     = false
  nullable    = false
}

variable "native_package_jobs_host_qualified" {
  description = "Readiness gate for the bounded first import: review dev storage evidence, ARM64 packaging, network configuration, and resource budgets; collect live dispatch validation during the import loop"
  type        = bool
  default     = false
  nullable    = false
}

variable "native_package_jobs_table_name" {
  description = "Name of the protected native package job table"
  type        = string
  nullable    = false
}

variable "native_package_jobs_table_arn" {
  description = "ARN of the protected native package job table"
  type        = string
  nullable    = false
}

variable "native_package_jobs_table_stream_arn" {
  description = "ARN of the protected job table's NEW_IMAGE stream"
  type        = string
  nullable    = false
}

variable "native_packages_bucket_name" {
  description = "Name of the separate private native package bucket"
  type        = string
  nullable    = false
}

variable "native_packages_bucket_arn" {
  description = "ARN of the separate private native package bucket"
  type        = string
  nullable    = false
}

# These disabled-prototype defaults are not approval of live resource sizing.
# Revisit them with the user and measure actual ARM64 package verification.
variable "native_package_worker_memory_size" {
  description = "Worker memory in MiB; prototype sizing pending live approval"
  type        = number
  default     = 2048
  nullable    = false
  validation {
    condition     = floor(var.native_package_worker_memory_size) == var.native_package_worker_memory_size && var.native_package_worker_memory_size >= 512 && var.native_package_worker_memory_size <= 10240
    error_message = "Worker memory must be an integer from 512 to 10240 MiB."
  }
}

variable "native_package_worker_ephemeral_storage_size" {
  description = "Worker temporary storage in MiB; prototype sizing pending live approval"
  type        = number
  default     = 4096
  nullable    = false
  validation {
    condition     = floor(var.native_package_worker_ephemeral_storage_size) == var.native_package_worker_ephemeral_storage_size && var.native_package_worker_ephemeral_storage_size >= 512 && var.native_package_worker_ephemeral_storage_size <= 10240
    error_message = "Worker temporary storage must be an integer from 512 to 10240 MiB."
  }
}

variable "native_package_worker_timeout_seconds" {
  description = "Lambda timeout; the worker operation budget leaves 60 seconds for cleanup and job updates"
  type        = number
  default     = 600
  nullable    = false
  validation {
    condition     = floor(var.native_package_worker_timeout_seconds) == var.native_package_worker_timeout_seconds && var.native_package_worker_timeout_seconds >= 120 && var.native_package_worker_timeout_seconds <= 900
    error_message = "Worker timeout must be an integer from 120 to 900 seconds."
  }
}

variable "native_package_worker_reserved_concurrency" {
  description = "Reserved worker concurrency; prototype value pending live approval and SQS throttle qualification"
  type        = number
  default     = 1
  nullable    = false
  validation {
    condition     = floor(var.native_package_worker_reserved_concurrency) == var.native_package_worker_reserved_concurrency && var.native_package_worker_reserved_concurrency >= 1 && var.native_package_worker_reserved_concurrency <= 100
    error_message = "Worker reserved concurrency must be an integer from 1 to 100."
  }
}

variable "native_package_worker_max_attempts" {
  description = "Maximum fenced job attempts; separate from SQS delivery/redrive attempts"
  type        = number
  default     = 3
  nullable    = false
  validation {
    condition     = floor(var.native_package_worker_max_attempts) == var.native_package_worker_max_attempts && var.native_package_worker_max_attempts >= 1 && var.native_package_worker_max_attempts <= 10
    error_message = "Worker job attempts must be an integer from 1 to 10."
  }
}

variable "native_package_worker_lease_seconds" {
  description = "Job lease duration; null derives Lambda timeout plus 60 seconds and must remain below queue visibility"
  type        = number
  default     = null
  validation {
    condition     = var.native_package_worker_lease_seconds == null ? true : floor(var.native_package_worker_lease_seconds) == var.native_package_worker_lease_seconds && var.native_package_worker_lease_seconds > 0
    error_message = "Worker lease must be null or a positive integer number of seconds."
  }
}

variable "native_package_jobs_max_receive_count" {
  description = "Queue deliveries before DLQ; not the protected job attempt counter"
  type        = number
  default     = 10
  nullable    = false
  validation {
    condition     = floor(var.native_package_jobs_max_receive_count) == var.native_package_jobs_max_receive_count && var.native_package_jobs_max_receive_count >= 5 && var.native_package_jobs_max_receive_count <= 100
    error_message = "Queue max receive count must be an integer from 5 to 100."
  }
}

locals {
  # Dev storage evidence, 2026-09-22, run 2995f24c-c750-4a1d-b1c1-9eac45e1c819:
  # Storage contract: docs/concepts/native-execution.md#package-integrity.
  # All 20 cases completed: 18 PASS; INITIAL_CREATE_REUSED and
  # CONDITION_NOT_IMPLEMENTED remain inconclusive. Reviewed policies match;
  # final inventories contain only the original fixture and no multipart uploads.
  # Evidence covers effective combined worker/bucket policy for direct uploads
  # in dev, not independent policies, other principals, production, or native
  # execution qualification. Explicit enablement and host readiness still apply.
  native_package_upload_policy_qualified = var.environment == "dev"
  native_package_jobs_active             = var.enable_native_package_jobs && var.native_package_jobs_host_qualified && local.native_package_upload_policy_qualified
  native_package_worker_budget_ms        = (var.native_package_worker_timeout_seconds - 60) * 1000
  native_package_worker_lease_seconds    = coalesce(var.native_package_worker_lease_seconds, var.native_package_worker_timeout_seconds + 60)
  native_package_jobs_visibility_seconds = 6 * var.native_package_worker_timeout_seconds
  native_package_pipe_name               = "${var.project_name}-native-package-jobs-${var.environment}"
  native_package_archive_objects_arn     = "${var.native_packages_bucket_arn}/native-packages/v1/*"
  # esbuild follows sibling imports outside this workspace's source_path.
  # Hash the native directory as well as shared code so loader changes (and
  # additional native helpers used by the host) invalidate the worker bundle.
  native_package_worker_sources_hash = sha256(jsonencode({
    shared    = local.shared_sources_hash
    root_lock = filesha256("${path.module}/../../../../package-lock.json")
    agentcore_native = {
      for relative in sort(tolist(fileset("${path.module}/../../../../lambda/agentcore/native", "**/*.js"))) :
      relative => filesha256("${path.module}/../../../../lambda/agentcore/native/${relative}")
    }
  }))

  # Resource identifiers are configuration, not invocation or storage grants.
  native_package_jobs_api_environment = {
    NATIVE_PACKAGE_JOBS_TABLE           = var.native_package_jobs_table_name
    NATIVE_PACKAGE_JOBS_ENABLED         = tostring(local.native_package_jobs_active)
    NATIVE_PACKAGE_JOBS_QUEUE_ARN       = aws_sqs_queue.native_package_jobs.arn
    NATIVE_PACKAGE_WORKER_FUNCTION_NAME = module.native_package_worker_lambda.lambda_function_name
  }
}

resource "terraform_data" "native_package_jobs_configuration" {
  input = {
    enabled   = var.enable_native_package_jobs
    qualified = var.native_package_jobs_host_qualified
  }
  lifecycle {
    precondition {
      condition     = !var.enable_native_package_jobs || var.native_package_jobs_host_qualified
      error_message = "Native package jobs require reviewed host readiness for the bounded first import; live dispatch validation is collected during that loop."
    }
    precondition {
      condition     = !var.enable_native_package_jobs || local.native_package_upload_policy_qualified
      error_message = "Native package imports are restricted to the dev storage-probe environment. Enablement and host readiness cannot qualify another environment."
    }
    precondition {
      condition     = local.native_package_worker_lease_seconds > var.native_package_worker_timeout_seconds && local.native_package_worker_lease_seconds < local.native_package_jobs_visibility_seconds
      error_message = "Worker lease must exceed the Lambda timeout and remain shorter than SQS visibility."
    }
  }
}

# The API creates a job conditionally in application code. PutItem permission
# alone also permits replacement; this is not an IAM boundary protecting worker
# fields from a compromised API. There are no SQS-send, worker-invoke, or package
# object grants here. The agent runtime has no access to this table or function.
resource "aws_iam_role_policy" "workflow_sources_native_package_jobs" {
  name = "native-package-job-submission"
  role = aws_iam_role.workflow_sources.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "SubmitAndReadProtectedPackageJobs"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
      Resource = var.native_package_jobs_table_arn
    }]
  })
}

resource "aws_sqs_queue" "native_package_jobs_dead_letter" {
  name                      = "${var.project_name}-native-package-jobs-dlq-${var.environment}"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "native_package_jobs" {
  name                       = "${var.project_name}-native-package-jobs-${var.environment}"
  visibility_timeout_seconds = local.native_package_jobs_visibility_seconds
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.native_package_jobs_dead_letter.arn
    maxReceiveCount     = var.native_package_jobs_max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "native_package_jobs" {
  queue_url = aws_sqs_queue.native_package_jobs_dead_letter.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.native_package_jobs.arn]
  })
}

# Separate failures reading/dispatching the stream from worker processing.
resource "aws_sqs_queue" "native_package_jobs_dispatch_dead_letter" {
  name                      = "${var.project_name}-native-package-dispatch-dlq-${var.environment}"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue_redrive_allow_policy" "native_package_jobs_dispatch" {
  queue_url = aws_sqs_queue.native_package_jobs_dispatch_dead_letter.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "denyAll"
  })
}

resource "aws_iam_role" "native_package_jobs_pipe" {
  name = "${var.project_name}-native-package-pipe-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pipes.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        ArnEquals = {
          "aws:SourceArn" = "arn:${local.partition}:pipes:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:pipe/${local.native_package_pipe_name}"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "native_package_jobs_pipe" {
  name = "dispatch-protected-package-job-pointers"
  role = aws_iam_role.native_package_jobs_pipe.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadProtectedJobStream"
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"]
        Resource = var.native_package_jobs_table_stream_arn
      },
      {
        Sid      = "SendJobPointerOrDispatchFailure"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [aws_sqs_queue.native_package_jobs.arn, aws_sqs_queue.native_package_jobs_dispatch_dead_letter.arn]
      },
    ]
  })
}

# Documentation reviewed 2026-09-22; live dispatch remains UNQUALIFIED.
# AWS's filtering guide excludes eventName although its DynamoDB tutorial uses
# it. Filter record data; the worker still rechecks the protected job.
# Duplicate QUEUED pointers remain safe because the worker claims the protected
# job conditionally. The pointer never carries actor/credential/package authority.
#
# Keep the pipe absent when disabled: an unqualified filter must not prevent a
# disabled foundation deployment. There is no API/queue dual write to recover.
resource "aws_pipes_pipe" "native_package_jobs" {
  count = local.native_package_jobs_active ? 1 : 0

  name          = local.native_package_pipe_name
  role_arn      = aws_iam_role.native_package_jobs_pipe.arn
  source        = var.native_package_jobs_table_stream_arn
  target        = aws_sqs_queue.native_package_jobs.arn
  desired_state = "RUNNING"

  source_parameters {
    filter_criteria {
      filter {
        pattern = jsonencode({
          dynamodb = { NewImage = { state = { S = ["QUEUED"] } } }
        })
      }
    }
    dynamodb_stream_parameters {
      batch_size                         = 1
      maximum_batching_window_in_seconds = 0
      parallelization_factor             = 1
      starting_position                  = "TRIM_HORIZON"
      # Documentation recommends a cutoff shorter than stream retention.
      # Keep 23 hours against the documented 24-hour retention; test DLQ behavior.
      maximum_record_age_in_seconds = 82800
      maximum_retry_attempts        = -1
      dead_letter_config {
        arn = aws_sqs_queue.native_package_jobs_dispatch_dead_letter.arn
      }
    }
  }

  target_parameters {
    # Preserve literal Pipes placeholder delimiters: jsonencode escapes < and >.
    # Both keys are validated strings; quote their scalar path substitutions.
    input_template = <<-JSON
      {"schemaVersion":1,"projectId":"<$.dynamodb.Keys.projectId.S>","jobId":"<$.dynamodb.Keys.jobId.S>"}
    JSON
  }

  depends_on = [
    terraform_data.native_package_jobs_configuration,
    aws_iam_role_policy.native_package_jobs_pipe,
  ]
}

resource "aws_iam_role" "native_package_worker" {
  name               = "${var.project_name}-native-package-worker-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "native_package_worker_basic" {
  role       = aws_iam_role.native_package_worker.id
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "native_package_worker_vpc" {
  role       = aws_iam_role.native_package_worker.id
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "native_package_worker" {
  name = "protected-package-intake"
  role = aws_iam_role.native_package_worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "ReadAndUpdateExistingPackageJobs"
          Effect   = "Allow"
          Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
          Resource = var.native_package_jobs_table_arn
        },
        {
          Sid      = "ReadWorkflowSourceBindings"
          Effect   = "Allow"
          Action   = ["dynamodb:GetItem"]
          Resource = var.workflow_source_bindings_table_arn
        },
        {
          Sid      = "ReadProjectMembership"
          Effect   = "Allow"
          Action   = ["neptune-db:ReadDataViaQuery", "neptune-db:connect"]
          Resource = local.neptune_resource_arn
        },
        {
          Sid      = "ReadAndRefreshOAuthTokens"
          Effect   = "Allow"
          Action   = ["ssm:GetParameter", "ssm:PutParameter"]
          Resource = "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/git-token/*"
        },
        {
          Sid      = "ConsumeProtectedJobPointers"
          Effect   = "Allow"
          Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
          Resource = aws_sqs_queue.native_package_jobs.arn
        },
        {
          Sid      = "ReadPinnedPrivatePackages"
          Effect   = "Allow"
          Action   = ["s3:GetObject", "s3:GetObjectVersion"]
          Resource = local.native_package_archive_objects_arn
        },
      ],
      # The conditional publisher grant is a separate worker-only policy below.
      # No ListBucket, DeleteObject, DeleteObjectVersion, ACL or tagging grants.
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
          Sid      = "MigrateAndRefreshProviderConnections"
          Effect   = "Allow"
          Action   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
          Resource = var.git_provider_connections_table_arn
        },
      ] : [],
      var.git_connections_table_arn != "" && var.git_provider_connections_table_arn != "" ? [
        {
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

resource "aws_iam_role_policy" "native_package_publisher" {
  name = "publish-immutable-native-packages"
  role = aws_iam_role.native_package_worker.id
  # Root wiring supplies the S3 module output that depends on bucket protection.
  policy = templatefile("${path.module}/policies/native-package-publisher.json.tftpl", {
    bucket_arn = var.native_packages_bucket_arn
  })
}

module "native_package_worker_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name                  = "${var.project_name}-native-package-worker-${var.environment}"
  handler                        = "index.handler"
  runtime                        = "nodejs24.x"
  architectures                  = ["arm64"]
  memory_size                    = var.native_package_worker_memory_size
  ephemeral_storage_size         = var.native_package_worker_ephemeral_storage_size
  timeout                        = var.native_package_worker_timeout_seconds
  reserved_concurrent_executions = var.native_package_worker_reserved_concurrency

  source_path = [
    {
      path = "${path.module}/../../../../lambda/native-package-worker"
      patterns = [
        "!.build/.*",
        "!.probe-build/.*",
        "!.repair-build/.*",
      ]
      commands = [
        "cd ../.. && npm run build -w native-package-worker",
        ":zip lambda/native-package-worker/.build",
      ]
    }
  ]
  hash_extra = local.native_package_worker_sources_hash

  create_role = false
  lambda_role = aws_iam_role.native_package_worker.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  environment_variables = {
    POWERTOOLS_SERVICE_NAME                  = local.powertools_service_name
    POWERTOOLS_LOG_LEVEL                     = var.powertools_log_level
    POWERTOOLS_LOGGER_LOG_EVENT              = "false"
    NATIVE_PACKAGE_JOBS_ENABLED              = tostring(local.native_package_jobs_active)
    NATIVE_PACKAGE_JOBS_TABLE                = var.native_package_jobs_table_name
    NATIVE_PACKAGE_JOBS_QUEUE_ARN            = aws_sqs_queue.native_package_jobs.arn
    NATIVE_PACKAGE_WORKER_FUNCTION_NAME      = "${var.project_name}-native-package-worker-${var.environment}"
    NATIVE_PACKAGE_WORKER_BUDGET_MS          = tostring(local.native_package_worker_budget_ms)
    NATIVE_PACKAGE_WORKER_CLEANUP_RESERVE_MS = "60000"
    NATIVE_PACKAGE_WORKER_LEASE_MS           = tostring(local.native_package_worker_lease_seconds * 1000)
    NATIVE_PACKAGE_WORKER_MAX_ATTEMPTS       = tostring(var.native_package_worker_max_attempts)
    NATIVE_PACKAGES_BUCKET                   = var.native_packages_bucket_name
    NATIVE_PACKAGES_EXPECTED_BUCKET_OWNER    = data.aws_caller_identity.current.account_id
    WORKFLOW_SOURCE_BINDINGS_TABLE           = var.workflow_source_bindings_table_name
    NEPTUNE_ENDPOINT                         = var.neptune_endpoint
    GIT_CONNECTIONS_TABLE                    = var.git_connections_table_name
    GIT_PROVIDER_CONNECTIONS_TABLE           = var.git_provider_connections_table_name
    GITHUB_APP_CONFIG_PARAM                  = var.github_app_config_param_name
    GITHUB_APP_PRIVATE_KEY_SECRET_NAME       = var.github_app_private_key_secret_name
    GITLAB_OAUTH_SECRET_NAME                 = var.gitlab_oauth_secret_name
    GITLAB_REDIRECT_URI                      = var.gitlab_redirect_uri
    BITBUCKET_OAUTH_SECRET_NAME              = var.bitbucket_oauth_secret_name
    ENVIRONMENT                              = var.environment
  }

  depends_on = [
    terraform_data.native_package_jobs_configuration,
    aws_iam_role_policy.native_package_worker,
    aws_iam_role_policy.native_package_publisher,
    aws_iam_role_policy_attachment.native_package_worker_basic,
    aws_iam_role_policy_attachment.native_package_worker_vpc,
  ]
}

resource "aws_lambda_event_source_mapping" "native_package_jobs" {
  event_source_arn        = aws_sqs_queue.native_package_jobs.arn
  function_name           = module.native_package_worker_lambda.lambda_function_arn
  enabled                 = local.native_package_jobs_active
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  depends_on = [aws_iam_role_policy.native_package_worker]
}

# Notification actions are opt-in, using the root native_operations contract.
resource "aws_cloudwatch_metric_alarm" "native_package_jobs_dead_letters" {
  for_each = {
    worker   = aws_sqs_queue.native_package_jobs_dead_letter.name
    dispatch = aws_sqs_queue.native_package_jobs_dispatch_dead_letter.name
  }
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
  alarm_name          = "${var.project_name}-native-package-${each.key}-dlq-${var.environment}"
  alarm_description   = "Package DLQ requires inspection; owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Repair requeues eligible authoritative jobs; never rediscover latest or replay raw stream records"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "native_package_jobs_age" {
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
  alarm_name          = "${var.project_name}-native-package-job-age-${var.environment}"
  alarm_description   = "Protected package jobs are waiting beyond the prototype processing budget"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.native_package_jobs.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = local.native_package_jobs_visibility_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "native_package_worker_throttles" {
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
  alarm_name          = "${var.project_name}-native-package-worker-throttles-${var.environment}"
  alarm_description   = "Qualify SQS polling against reserved concurrency before increasing worker capacity"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = module.native_package_worker_lambda.lambda_function_name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

output "native_package_jobs_queue_arn" {
  description = "ARN of the protected package job pointer queue"
  value       = aws_sqs_queue.native_package_jobs.arn
}

output "native_package_jobs_queue_name" {
  description = "Name of the protected package job pointer queue"
  value       = aws_sqs_queue.native_package_jobs.name
}

output "native_package_jobs_queue_url" {
  description = "URL of the protected package job pointer queue"
  value       = aws_sqs_queue.native_package_jobs.id
}

output "native_package_jobs_dead_letter_queue_arn" {
  description = "ARN of the worker's dead-letter queue"
  value       = aws_sqs_queue.native_package_jobs_dead_letter.arn
}

output "native_package_jobs_dispatch_dead_letter_queue_arn" {
  description = "ARN of the stream dispatch dead-letter queue"
  value       = aws_sqs_queue.native_package_jobs_dispatch_dead_letter.arn
}

output "native_package_worker_lambda_name" {
  description = "Name of the protected package intake worker"
  value       = module.native_package_worker_lambda.lambda_function_name
}

output "native_package_worker_lambda_arn" {
  description = "ARN of the protected package intake worker; do not grant agent invocation"
  value       = module.native_package_worker_lambda.lambda_function_arn
}

output "native_package_worker_role_arn" {
  description = "Dedicated publisher IAM role; export only the role so bucket protection can precede attached upload permissions"
  value       = aws_iam_role.native_package_worker.arn
}

output "native_package_jobs_pipe_arn" {
  description = "ARN of the qualified dispatch pipe, or null while disabled"
  value       = try(aws_pipes_pipe.native_package_jobs[0].arn, null)
}

variable "native_repair_table_name" { type = string }
variable "native_repair_table_arn" { type = string }
variable "native_operations" {
  type = object({
    alarm_actions           = optional(list(string), [])
    incident_owner          = optional(string, "")
    full_scan_alarm_seconds = optional(number, 1800)
  })
  default = {}
}

# Read-only package repair is separate from the publisher and its VPC/provider
# access. Enabling imports still requires the existing dev readiness gates.
resource "aws_iam_role" "native_package_repair" {
  name               = "${var.project_name}-native-package-repair-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
}
resource "aws_iam_role_policy_attachment" "native_package_repair_basic" {
  role       = aws_iam_role.native_package_repair.id
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
resource "aws_iam_role_policy" "native_package_repair" {
  role = aws_iam_role.native_package_repair.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:Scan", "dynamodb:GetItem"], Resource = var.native_package_jobs_table_arn },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem"], Resource = var.native_repair_table_arn, Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["packages"] } } },
      { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.native_package_jobs.arn },
    ]
  })
}
module "native_package_repair_lambda" {
  source                         = "terraform-aws-modules/lambda/aws"
  version                        = "~> 8.0"
  function_name                  = "${var.project_name}-native-package-repair-${var.environment}"
  handler                        = "repair.handler"
  runtime                        = "nodejs24.x"
  architectures                  = ["arm64"]
  memory_size                    = 512
  timeout                        = 900
  reserved_concurrent_executions = 1
  create_role                    = false
  lambda_role                    = aws_iam_role.native_package_repair.arn
  source_path = [{
    path     = "${path.module}/../../../../lambda/native-package-worker"
    patterns = ["!.build/.*", "!.probe-build/.*", "!.repair-build/.*"]
    commands = ["cd ../.. && npm run build:repair -w native-package-worker", ":zip lambda/native-package-worker/.repair-build"]
  }]
  hash_extra                        = local.native_package_worker_sources_hash
  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7
  environment_variables = {
    NATIVE_PACKAGE_JOBS_ENABLED    = tostring(local.native_package_jobs_active)
    NATIVE_PACKAGE_JOBS_TABLE      = var.native_package_jobs_table_name
    NATIVE_PACKAGE_JOBS_QUEUE_URL  = aws_sqs_queue.native_package_jobs.url
    NATIVE_REPAIR_CHECKPOINT_TABLE = var.native_repair_table_name
  }
  depends_on = [aws_iam_role_policy.native_package_repair, aws_iam_role_policy_attachment.native_package_repair_basic]
}
resource "aws_cloudwatch_event_rule" "native_package_repair" {
  name                = "${var.project_name}-native-package-repair-${var.environment}"
  schedule_expression = "rate(5 minutes)"
  state               = local.native_package_jobs_active ? "ENABLED" : "DISABLED"
}
resource "aws_cloudwatch_event_target" "native_package_repair" {
  rule = aws_cloudwatch_event_rule.native_package_repair.name
  arn  = module.native_package_repair_lambda.lambda_function_arn
}
resource "aws_lambda_permission" "native_package_repair" {
  action        = "lambda:InvokeFunction"
  function_name = module.native_package_repair_lambda.lambda_function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.native_package_repair.arn
}
resource "aws_cloudwatch_metric_alarm" "native_package_repair_stalled" {
  count               = local.native_package_jobs_active ? 1 : 0
  alarm_name          = "${var.project_name}-native-package-repair-stalled-${var.environment}"
  alarm_description   = "No successful package repair sweep; owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Inspect scoped checkpoint, native_repair_scan logs and dispatch/worker DLQs. Diagnostic window, not an agreed SLO."
  namespace           = "NativeRepair"
  metric_name         = "ScanCompleted"
  dimensions          = { Scope = "packages", SourceTable = var.native_package_jobs_table_name }
  statistic           = "Sum"
  period              = var.native_operations.full_scan_alarm_seconds
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
}
resource "aws_cloudwatch_metric_alarm" "native_package_repair_work_errors" {
  alarm_name          = "${var.project_name}-native-package-repair-work-errors-${var.environment}"
  namespace           = "NativeRepair"
  metric_name         = "RepairErrors"
  dimensions          = { Scope = "packages", SourceTable = var.native_package_jobs_table_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
  alarm_description   = "Package repair row failure; owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Inspect native_repair_row_failed pointers and current job, preserve pins and attempt budgets."
}
resource "aws_cloudwatch_metric_alarm" "native_package_function_errors" {
  for_each = {
    worker = module.native_package_worker_lambda.lambda_function_name
    repair = module.native_package_repair_lambda.lambda_function_name
  }
  alarm_name          = "${var.project_name}-native-package-${each.key}-errors-${var.environment}"
  alarm_description   = "Package Lambda error/timeout; owner=${var.native_operations.incident_owner == "" ? "UNASSIGNED" : var.native_operations.incident_owner}. Inspect function logs, lease expiry and DLQs; repair cannot revive terminal jobs."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.native_operations.alarm_actions
  ok_actions          = var.native_operations.alarm_actions
}

# Partial batch failures return HTTP success to Lambda; Errors alone misses them.
resource "aws_cloudwatch_log_metric_filter" "native_repair_partial_failures" {
  name           = "${var.project_name}-native-package-retries-${var.environment}"
  log_group_name = "/aws/lambda/${module.native_package_worker_lambda.lambda_function_name}"
  pattern        = "{ ($.event = \"native_package_worker_retry\") || ($.event = \"native_package_worker_terminal_failure\") }"
  metric_transformation {
    name          = "${var.project_name}-native-package-worker-failures-${var.environment}"
    namespace     = "NativeRepair"
    value         = "1"
    default_value = 0
  }
}
resource "aws_cloudwatch_metric_alarm" "native_repair_partial_failures" {
  alarm_name          = "${var.project_name}-native-package-retries-${var.environment}"
  namespace           = "NativeRepair"
  metric_name         = "${var.project_name}-native-package-worker-failures-${var.environment}"
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
