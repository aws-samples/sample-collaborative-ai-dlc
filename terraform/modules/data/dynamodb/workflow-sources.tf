# Separate from application repository bindings and agent-writable process
# state. Export this table explicitly; never add it to a shared table-ARN list.
resource "aws_dynamodb_table" "workflow_source_bindings" {
  name         = "${var.project_name}-workflow-source-bindings-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "projectId"
  range_key    = "sourceId"

  attribute {
    name = "projectId"
    type = "S"
  }

  attribute {
    name = "sourceId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  # Deleted bindings remain revision-bearing tombstones. Expiring them could
  # let an old create request restore authority after a concurrent deletion.
  tags = var.tags
}

output "workflow_source_bindings_table_name" {
  description = "Name of the isolated workflow-source binding table"
  value       = aws_dynamodb_table.workflow_source_bindings.name
}

output "workflow_source_bindings_table_arn" {
  description = "ARN of the isolated workflow-source binding table"
  value       = aws_dynamodb_table.workflow_source_bindings.arn
}
