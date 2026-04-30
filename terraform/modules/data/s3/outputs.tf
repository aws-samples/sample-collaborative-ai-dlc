output "artifacts_bucket_name" {
  description = "Name of the artifacts S3 bucket"
  value       = aws_s3_bucket.artifacts.bucket
}

output "artifacts_bucket_arn" {
  description = "ARN of the artifacts S3 bucket"
  value       = aws_s3_bucket.artifacts.arn
}

output "code_snapshots_bucket_name" {
  description = "Name of the code snapshots S3 bucket"
  value       = aws_s3_bucket.code_snapshots.bucket
}

output "code_snapshots_bucket_arn" {
  description = "ARN of the code snapshots S3 bucket"
  value       = aws_s3_bucket.code_snapshots.arn
}

output "access_logs_bucket_name" {
  description = "Name of the shared access logging S3 bucket"
  value       = aws_s3_bucket.access_logs.bucket
}

output "access_logs_bucket_domain_name" {
  description = "Domain name of the shared access logging S3 bucket"
  value       = aws_s3_bucket.access_logs.bucket_domain_name
}