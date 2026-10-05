output "cloudfront_web_acl_arn" {
  description = "ARN of the CloudFront-scoped web ACL, or an empty string when disabled"
  value       = var.enabled ? aws_wafv2_web_acl.cloudfront[0].arn : ""
}

output "regional_web_acl_arn" {
  description = "ARN of the regional web ACL, or an empty string when disabled"
  value       = var.enabled ? aws_wafv2_web_acl.regional[0].arn : ""
}
