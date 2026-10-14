# Progress only: never export this table through shared runtime table grants.
# No TTL or job/execution data. Scopes bind to their exact source table.
resource "aws_dynamodb_table" "native_repair" {
  name         = "${var.project_name}-native-repair-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "scope"
  attribute {
    name = "scope"
    type = "S"
  }
  server_side_encryption { enabled = true }
  point_in_time_recovery { enabled = true }
  tags = var.tags
}
output "native_repair_table_name" { value = aws_dynamodb_table.native_repair.name }
output "native_repair_table_arn" { value = aws_dynamodb_table.native_repair.arn }
