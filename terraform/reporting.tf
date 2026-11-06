# Optional reporting lake: every v2-executions change in S3, queryable through
# Athena views. Off by default; see docs/using-the-platform/reporting.md.

variable "reporting_enabled" {
  description = "Create the reporting lake: a change stream from the v2-executions table into S3, with a Glue table and Athena views. Run the backfill once after enabling it."
  type        = bool
  default     = false
}

variable "reporting_buffer_seconds" {
  description = "How long Firehose buffers changes before writing them to the reporting lake (60-900): the lake's latency."
  type        = number
  default     = 60

  validation {
    condition     = var.reporting_buffer_seconds >= 60 && var.reporting_buffer_seconds <= 900
    error_message = "reporting_buffer_seconds must be between 60 and 900 when dynamic partitioning is on."
  }
}

variable "reporting_kinesis_shard_count" {
  description = "Provisioned shards for the reporting change stream; 0 switches to on-demand capacity."
  type        = number
  default     = 1

  validation {
    condition     = var.reporting_kinesis_shard_count >= 0 && floor(var.reporting_kinesis_shard_count) == var.reporting_kinesis_shard_count
    error_message = "reporting_kinesis_shard_count must be a whole number, 0 or more."
  }
}

variable "reporting_athena_bytes_scanned_cutoff" {
  description = "Per-query scan limit in the reporting Athena workgroup, in bytes (at least 10 MB), as a guard against runaway queries."
  type        = number
  default     = 10737418240 # 10 GiB

  validation {
    condition     = var.reporting_athena_bytes_scanned_cutoff >= 10485760
    error_message = "reporting_athena_bytes_scanned_cutoff must be at least 10485760 (10 MB), Athena's minimum."
  }
}

variable "reporting_lake_start_date" {
  description = "First day (yyyy-MM-dd) the reporting tables look at. Leave empty to use the day the lake is created; set it earlier only when the bucket already holds older data."
  type        = string
  default     = ""

  validation {
    condition     = var.reporting_lake_start_date == "" || can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", var.reporting_lake_start_date))
    error_message = "reporting_lake_start_date must be empty or a date in yyyy-MM-dd form."
  }
}

variable "reporting_alarm_actions" {
  description = "SNS topic ARNs notified when the reporting lake falls behind or its transform fails."
  type        = list(string)
  default     = []
}

module "reporting" {
  source = "./modules/reporting"
  count  = var.reporting_enabled ? 1 : 0

  project_name                 = var.project_name
  environment                  = var.environment
  aws_sdk_ua_app_id            = local.aws_sdk_ua_app_id
  powertools_service_name      = local.powertools_service_name
  powertools_log_level         = var.powertools_log_level
  iam_role_path                = var.iam_role_path
  iam_permissions_boundary_arn = var.iam_permissions_boundary_arn
  kms_key_arn                  = var.kms_key_arn
  v2_executions_table_name     = module.agentcore.v2_executions_table_name
  v2_executions_table_arn      = module.agentcore.v2_executions_table_arn
  deletion_protection          = var.deletion_protection
  buffer_seconds               = var.reporting_buffer_seconds
  kinesis_shard_count          = var.reporting_kinesis_shard_count
  athena_bytes_scanned_cutoff  = var.reporting_athena_bytes_scanned_cutoff
  lake_start_date              = var.reporting_lake_start_date
  alarm_actions                = var.reporting_alarm_actions
}

output "reporting_lake_bucket_name" {
  description = "S3 bucket holding the reporting lake (null when reporting is off)"
  value       = one(module.reporting[*].lake_bucket_name)
}

output "reporting_glue_database_name" {
  description = "Glue database with the reporting views (null when reporting is off)"
  value       = one(module.reporting[*].glue_database_name)
}

output "reporting_athena_workgroup_name" {
  description = "Athena workgroup for reporting queries (null when reporting is off)"
  value       = one(module.reporting[*].athena_workgroup_name)
}

output "reporting_reader_policy_arn" {
  description = "IAM policy granting read-only Athena access to the reporting lake (null when reporting is off)"
  value       = one(module.reporting[*].reader_policy_arn)
}

output "reporting_backfill_function_name" {
  description = "Lambda that copies existing executions into the reporting lake (null when reporting is off)"
  value       = one(module.reporting[*].backfill_function_name)
}
