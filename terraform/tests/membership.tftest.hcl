mock_provider "aws" {}

variables {
  project_name        = "test"
  environment         = "test"
  deletion_protection = true
  kms_key_arn         = "arn:aws:kms:us-east-1:123456789012:key/test"
}

run "durable_membership_and_history" {
  command = plan
  module {
    source = "./modules/data/dynamodb"
  }

  assert {
    condition = (
      aws_dynamodb_table.access.hash_key == "pk" &&
      aws_dynamodb_table.access.range_key == "sk" &&
      aws_dynamodb_table.access.billing_mode == "PAY_PER_REQUEST" &&
      length(aws_dynamodb_table.access.global_secondary_index) == 1 &&
      one(aws_dynamodb_table.access.global_secondary_index).name == "by-user" &&
      contains(one(aws_dynamodb_table.access.global_secondary_index).key_schema, {
        attribute_name = "userId", key_type = "HASH"
      }) &&
      contains(one(aws_dynamodb_table.access.global_secondary_index).key_schema, {
        attribute_name = "pk", key_type = "RANGE"
      }) &&
      one(aws_dynamodb_table.access.global_secondary_index).projection_type == "ALL"
    )
    error_message = "Access must support consistent per-space reads and user-space discovery with all attributes."
  }

  assert {
    condition = (
      aws_dynamodb_table.audit.hash_key == "pk" &&
      aws_dynamodb_table.audit.range_key == "sk" &&
      aws_dynamodb_table.audit.billing_mode == "PAY_PER_REQUEST" &&
      length(aws_dynamodb_table.audit.global_secondary_index) == 0 &&
      length(aws_dynamodb_table.audit.ttl) == 0
    )
    error_message = "History must remain separately queryable and must not expire through TTL."
  }

  assert {
    condition = (
      aws_dynamodb_table.access.deletion_protection_enabled &&
      aws_dynamodb_table.audit.deletion_protection_enabled &&
      one(aws_dynamodb_table.access.point_in_time_recovery).enabled &&
      one(aws_dynamodb_table.audit.point_in_time_recovery).enabled &&
      one(aws_dynamodb_table.access.server_side_encryption).enabled &&
      one(aws_dynamodb_table.audit.server_side_encryption).enabled &&
      one(aws_dynamodb_table.access.server_side_encryption).kms_key_arn == var.kms_key_arn &&
      one(aws_dynamodb_table.audit.server_side_encryption).kms_key_arn == var.kms_key_arn
    )
    error_message = "Both tables must preserve the platform's durable storage protections."
  }
}
