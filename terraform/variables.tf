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

variable "lambda_vpc_scope" {
  description = "Lambda VPC placement scope: required keeps only private-resource Lambdas in the VPC; public-egress also routes selected public-service traffic through NAT"
  type        = string
  default     = "required"

  validation {
    condition     = contains(["required", "public-egress"], var.lambda_vpc_scope)
    error_message = "lambda_vpc_scope must be one of: required, public-egress."
  }
}

variable "bedrock_model" {
  description = "Bedrock inference profile ID for the primary model. E.g. us.anthropic.claude-sonnet-4-6"
  type        = string
  default     = "us.anthropic.claude-sonnet-4-6"
}

variable "codex_model" {
  description = "Default Codex-on-Bedrock model id seeded into the cli-models SSM parameter (empty = none). Must be a cross-Region inference profile id such as global.openai.gpt-5.6-sol: Codex uses the Bedrock Runtime OpenAI-compatible endpoint, which refuses a bare foundation-model id with \"on-demand throughput isn't supported\""
  type        = string
  default     = "global.openai.gpt-5.6-sol"
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

# ── Bedrock IAM-role credential mode ──
# Consumed by bedrock-role-grant.tf, which renders the customer-side grant, the
# trust policy and the session-policy ceiling from these three inputs.

# The account that OWNS the Bedrock role. Defaults to this deployment's account,
# which is the same-account case. For a central Bedrock account, set this to that
# account id: every ARN in the grant must name the account owning the role, not
# the platform account (req-model-grant-families).
variable "bedrock_role_account_id" {
  description = "AWS account id owning the Bedrock role the broker assumes. Defaults to this deployment's account (the same-account case)."
  type        = string
  default     = ""

  validation {
    condition     = var.bedrock_role_account_id == "" || can(regex("^[0-9]{12}$", var.bedrock_role_account_id))
    error_message = "bedrock_role_account_id must be a 12-digit AWS account id, or empty to use this deployment's account."
  }
}

# See modules/api/lambda/variables.tf for the full rationale. Declared at root too
# so an operator can set it in their .tfvars without reaching into a module.
variable "bedrock_assumable_role_arns" {
  description = "IAM role ARNs the credential broker may assume for Bedrock access. Path-scoped by default; set [\"*\"] to opt out of the naming convention."
  type        = list(string)
  default     = ["arn:aws:iam::*:role/aidlc-bedrock-*"]

  validation {
    condition     = length(var.bedrock_assumable_role_arns) > 0
    error_message = "bedrock_assumable_role_arns must not be empty; the broker would be unable to resolve any role binding."
  }
}

# Which spaces the rendered trust policy admits. EMPTY — the default — renders the
# shared form every space can use, which is the only form a PLATFORM-SCOPE binding
# can work with: a platform binding has no single space, so the broker's bind-time
# preflight probes with the session name `aidlc-preflight`
# (lambda/shared/bedrock-role.js), which a single-space StringEquals condition
# rejects by design. Set this only for a SPACE-SCOPE binding, to the space ids from
# the space URLs, and the policy narrows to exactly those sessions.
variable "bedrock_role_trusted_space_ids" {
  description = "Space (project) ids the rendered Bedrock trust policy admits. Empty renders the shared form required by a platform-scope binding; set ids only for space-scope bindings."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for id in var.bedrock_role_trusted_space_ids : can(regex("^[A-Za-z0-9._=,@-]{1,58}$", id))
    ])
    error_message = "Each id must be a space id as it appears in the space URL; sts:RoleSessionName caps the composed aidlc-<id> at 64 characters."
  }
}
