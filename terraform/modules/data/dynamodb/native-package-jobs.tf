# Protected package jobs are not agent execution state. Never include this
# table in the shared table-ARN outputs used by runtime/orchestrator roles.
resource "aws_dynamodb_table" "native_package_jobs" {
  name             = "${var.project_name}-native-package-jobs-${var.environment}"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "projectId"
  range_key        = "jobId"
  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  attribute {
    name = "projectId"
    type = "S"
  }

  attribute {
    name = "jobId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  # No TTL: a retained job/candidate is required to reconcile a lost archive
  # commit receipt. Stream retention is separate from table/PITR retention.
  tags = var.tags
}

output "native_package_jobs_table_name" {
  description = "Name of the protected native package job table"
  value       = aws_dynamodb_table.native_package_jobs.name
}

output "native_package_jobs_table_arn" {
  description = "ARN of the protected native package job table"
  value       = aws_dynamodb_table.native_package_jobs.arn
}

output "native_package_jobs_table_stream_arn" {
  description = "ARN of the NEW_IMAGE native package job stream"
  value       = aws_dynamodb_table.native_package_jobs.stream_arn
}
