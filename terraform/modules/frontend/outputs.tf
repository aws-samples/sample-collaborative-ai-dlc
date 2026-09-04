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

output "cloudfront_hosted_zone_id" {
  description = "CloudFront's fixed hosted zone ID, used as the alias target zone for Route53 A/AAAA records pointing at this distribution."
  value       = aws_cloudfront_distribution.frontend.hosted_zone_id
}

output "application_domain" {
  description = "Canonical hostname the application is reachable on: the first configured alias when a custom domain is in use, otherwise the CloudFront-assigned domain."
  value       = length(var.aliases) > 0 ? var.aliases[0] : aws_cloudfront_distribution.frontend.domain_name
}

output "cloudfront_origin_secret" {
  description = "Shared secret that CloudFront injects as X-Origin-Verify. Used when enable_cloudfront_origin_policy is enabled on the api module."
  value       = random_password.cloudfront_origin_secret.result
  sensitive   = true
}