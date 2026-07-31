output "certificate_arn" {
  description = "ARN of the us-east-1 certificate CloudFront should use, or an empty string when no custom domain is configured. Resolves through the validation resource so consumers implicitly wait for the certificate to be issued."
  value       = local.resolved_certificate_arn
}

output "certificate_managed" {
  description = "Whether Terraform issued the certificate (true) or it was supplied as an existing ARN (false)."
  value       = local.issue_certificate
}

output "domain_names" {
  description = "All hostnames covered by this domain configuration, canonical name first."
  value       = var.enabled ? concat([var.domain_name], local.subject_alternative_names) : []
}
