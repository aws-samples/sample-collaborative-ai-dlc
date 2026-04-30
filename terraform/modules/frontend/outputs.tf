output "s3_bucket_name" {
  description = "Name of the S3 bucket for frontend hosting"
  value       = aws_s3_bucket.frontend.bucket
}

output "s3_bucket_arn" {
  description = "ARN of the S3 bucket for frontend hosting"
  value       = aws_s3_bucket.frontend.arn
}

output "cloudfront_distribution_id" {
  description = "ID of the CloudFront distribution"
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_distribution_arn" {
  description = "ARN of the CloudFront distribution"
  value       = aws_cloudfront_distribution.frontend.arn
}

output "cloudfront_domain_name" {
  description = "Domain name of the CloudFront distribution"
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "website_url" {
  description = "URL of the frontend website"
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "cloudfront_origin_secret" {
  description = "Shared secret that CloudFront injects as X-Origin-Verify. Used when enable_cloudfront_origin_policy is enabled on the api module."
  value       = random_password.cloudfront_origin_secret.result
  sensitive   = true
}