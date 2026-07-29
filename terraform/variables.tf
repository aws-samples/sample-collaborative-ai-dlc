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

variable "codex_model" {
  description = "Default Codex-on-Bedrock model id (exact openai.* id, e.g. openai.gpt-5.5) seeded into the cli-models SSM parameter (empty = none)"
  type        = string
  default     = "openai.gpt-5.5"
}

variable "aidlc_repo_ref" {
  description = "Pinned ref (commit SHA/tag/branch) of awslabs/aidlc-workflows the seed + AgentCore runtime use. Keep in sync with the seed-blocks lambda."
  type        = string
  default     = "83ed7a812c4024904f2c5e4d744e28077e0a5acd"
}

variable "docker_build_args" {
  description = "Optional arguments for local Docker image builds, such as HTTP_PROXY, HTTPS_PROXY, and NO_PROXY. Sensitive values are hidden in CLI output but remain stored in Terraform state."
  type        = map(string)
  default     = {}
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Authentication and enterprise federation
# ---------------------------------------------------------------------------

variable "auth_mode" {
  description = "Login methods exposed by the deployment: local Cognito credentials, local plus enterprise SSO, or SSO only."
  type        = string
  default     = "local"

  validation {
    condition     = contains(["local", "hybrid", "sso-only"], var.auth_mode)
    error_message = "auth_mode must be one of: local, hybrid, sso-only."
  }
}

variable "sso_providers" {
  description = "Named OIDC or SAML identity providers federated through the Cognito User Pool."
  type = map(object({
    display_name          = string
    type                  = string
    issuer_url            = optional(string, "")
    client_id             = optional(string, "")
    client_secret_arn     = optional(string, "")
    scopes                = optional(list(string), ["openid", "email", "profile"])
    metadata_url          = optional(string, "")
    metadata_xml          = optional(string, "")
    email_claim           = string
    name_claim            = optional(string, "")
    role_claim            = optional(string, "")
    role_mappings         = optional(map(list(string)), {})
    required_claim_values = optional(list(string), [])
  }))
  default   = {}
  sensitive = true

  validation {
    condition = alltrue([
      for name, provider in var.sso_providers :
      can(regex("^[A-Za-z][A-Za-z0-9_-]{0,31}$", name)) && upper(name) != "COGNITO"
    ])
    error_message = "Every SSO provider name must be 1-32 alphanumeric, underscore, or hyphen characters, start with a letter, and not be COGNITO."
  }

  validation {
    condition = alltrue([
      for provider in values(var.sso_providers) :
      contains(["oidc", "saml"], lower(provider.type))
    ])
    error_message = "Every SSO provider type must be oidc or saml."
  }

}

# ---------------------------------------------------------------------------
# Custom domain (optional)
#
# Every public request path — the SPA, /api/*, /ws and /yjs/* — is served by a
# single CloudFront distribution, so a custom domain needs exactly one
# certificate and one distribution change. No API Gateway custom domain is
# involved.
# Enterprise SSO uses a separate Cognito managed-login domain for redirects;
# it does not serve the application. No ALB certificate is involved.
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
