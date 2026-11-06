output "lake_bucket_name" {
  description = "S3 bucket holding the reporting lake"
  value       = aws_s3_bucket.lake.bucket
}

output "glue_database_name" {
  description = "Glue database with the changes table and the reporting views"
  value       = aws_glue_catalog_database.reporting.name
}

output "athena_workgroup_name" {
  description = "Athena workgroup for reporting queries"
  value       = aws_athena_workgroup.reporting.name
}

output "reader_policy_arn" {
  description = "Managed IAM policy that grants read-only Athena access to the lake"
  value       = aws_iam_policy.reader.arn
}

output "backfill_function_name" {
  description = "Lambda that copies existing v2-executions rows into the lake"
  value       = module.backfill_lambda.lambda_function_name
}
