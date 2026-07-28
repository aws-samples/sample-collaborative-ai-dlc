variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name"
  type        = string
  default     = "collaborative-ai-dlc"
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
  default     = "dev"
}

variable "bedrock_model" {
  description = "Bedrock inference profile ID for the primary model. E.g. us.anthropic.claude-sonnet-4-6"
  type        = string
  default     = "us.anthropic.claude-sonnet-4-6"
}

variable "aidlc_repo_ref" {
  description = "Pinned ref (commit SHA/tag/branch) of awslabs/aidlc-workflows the seed + AgentCore runtime use. Keep in sync with the seed-blocks lambda."
  type        = string
  default     = "83ed7a812c4024904f2c5e4d744e28077e0a5acd"
}

# ---------------------------------------------------------------------------
# Custom domain (optional)
#
# Every public request path — the SPA, /api/*, /ws and /yjs/* — is served by a
# single CloudFront distribution, so a custom domain needs exactly one
# certificate and one distribution change. No API Gateway custom domain, no
# Cognito hosted-UI domain (the app uses SRP only) and no ALB certificate are
# involved.
#
# Leaving app_domain empty keeps the deployment on the CloudFront-assigned
# *.cloudfront.net domain and creates no additional resources.
# ---------------------------------------------------------------------------

variable "app_domain" {
  description = "Canonical custom hostname for the application (e.g. aidlc.example.com). Empty serves on the CloudFront *.cloudfront.net domain. Drives the OAuth redirect URIs and the frontend build, so it must be a single value."
  type        = string
  default     = ""

  validation {
    condition     = var.app_domain == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.app_domain))
    error_message = "app_domain must be a bare lowercase hostname without scheme, port or path (e.g. aidlc.example.com)."
  }
}

variable "app_domain_aliases" {
  description = "Additional hostnames served by the same distribution (e.g. www.aidlc.example.com). Added to the CloudFront aliases and the CORS allowlist, but never used for OAuth redirect URIs — providers match redirect_uri exactly, so only app_domain can be canonical."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for a in var.app_domain_aliases : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", a))])
    error_message = "Every app_domain_aliases entry must be a bare lowercase hostname without scheme, port or path."
  }
}

variable "acm_certificate_arn" {
  description = "ARN of an existing ACM certificate in us-east-1 covering app_domain and app_domain_aliases. Use this when certificates are managed centrally, imported, or issued from a private CA. Leave empty to have Terraform request and DNS-validate one, which requires route53_zone_id."
  type        = string
  default     = ""

  validation {
    condition     = var.acm_certificate_arn == "" || can(regex("^arn:aws[a-z-]*:acm:us-east-1:[0-9]{12}:certificate/", var.acm_certificate_arn))
    error_message = "acm_certificate_arn must be an ACM certificate ARN in us-east-1 — CloudFront only accepts certificates from that region."
  }
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID in this account. When set, Terraform creates the A/AAAA alias records for app_domain plus app_domain_aliases and, if acm_certificate_arn is empty, the certificate validation records. Leave empty to manage DNS externally and use the dns_target output."
  type        = string
  default     = ""
}

