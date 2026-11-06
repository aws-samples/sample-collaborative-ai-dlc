variable "project_name" {
  description = "Project name, used in resource names"
  type        = string
}

variable "environment" {
  description = "Environment name, used in resource names"
  type        = string
}

variable "aws_sdk_ua_app_id" {
  description = "AWS SDK user-agent app ID for the reporting Lambdas"
  type        = string
}

variable "powertools_service_name" {
  description = "Powertools service name for the reporting Lambdas"
  type        = string
}

variable "powertools_log_level" {
  description = "Powertools log level for the reporting Lambdas"
  type        = string
}

variable "iam_role_path" {
  description = "Path for the IAM roles and policy this module creates"
  type        = string
}

variable "iam_permissions_boundary_arn" {
  description = "Permissions boundary for the IAM roles this module creates. Empty for none."
  type        = string
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key of the DynamoDB tables, so the backfill can read the executions table. Empty when the tables use service-owned encryption."
  type        = string
}

variable "v2_executions_table_name" {
  description = "Name of the v2-executions table the lake is fed from"
  type        = string
}

variable "v2_executions_table_arn" {
  description = "ARN of the v2-executions table the lake is fed from"
  type        = string
}

variable "deletion_protection" {
  description = "Keep the lake bucket from being destroyed while it holds objects. The lake's change history can't be rebuilt from the table."
  type        = bool
}

variable "buffer_seconds" {
  description = "How long Firehose buffers changes before writing to S3: the lake's latency"
  type        = number
}

variable "kinesis_shard_count" {
  description = "Provisioned shards for the change stream; 0 for on-demand"
  type        = number
}

variable "athena_bytes_scanned_cutoff" {
  description = "Per-query scan limit in the reporting Athena workgroup, in bytes"
  type        = number
}

variable "lake_start_date" {
  description = "First day (yyyy-MM-dd) the Glue partition projection covers. Empty uses the day the lake was created."
  type        = string
}

variable "alarm_actions" {
  description = "SNS topic ARNs notified when the lake falls behind or the transform fails"
  type        = list(string)
}
