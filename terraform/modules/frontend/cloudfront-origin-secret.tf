
resource "random_password" "cloudfront_origin_secret" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "cloudfront_origin_secret" {
  name        = "/${var.project_name}/${var.environment}/cloudfront-origin-secret"
  description = "Shared secret injected by CloudFront as X-Origin-Verify header. Used when enable_cloudfront_origin_policy is enabled on the API module."
  type        = "SecureString"
  value       = random_password.cloudfront_origin_secret.result

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}
