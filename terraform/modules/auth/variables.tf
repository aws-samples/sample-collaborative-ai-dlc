variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (dev, prod, etc.)"
  type        = string
}

variable "powertools_service_name" {
  description = "Service name included in Powertools structured logs"
  type        = string
}

variable "powertools_log_level" {
  description = "Log level for Powertools structured logging"
  type        = string

  validation {
    condition     = contains(["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL", "SILENT"], var.powertools_log_level)
    error_message = "powertools_log_level must be one of DEBUG, INFO, WARN, ERROR, CRITICAL or SILENT."
  }
}

variable "app_url" {
  description = "Canonical public application URL used for Cognito callbacks and logout."
  type        = string
}

variable "auth_mode" {
  description = "Authentication mode: local, hybrid, or sso-only."
  type        = string
}

variable "sso_providers" {
  description = "Normalized OIDC and SAML provider definitions."
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
}

variable "custom_domain" {
  description = "Custom hostname for the Cognito managed-login domain. Empty uses only the generated *.amazoncognito.com prefix domain."
  type        = string
  default     = ""
}

variable "custom_domain_active" {
  description = "Select the custom domain for login outputs only after the operator has verified DNS and upstream IdP callback readiness."
  type        = bool
  default     = false
}

variable "custom_domain_certificate_arn" {
  description = "ARN of an issued us-east-1 ACM certificate covering custom_domain. Required when custom_domain is set."
  type        = string
  default     = ""
}

variable "lambda_vpc_scope" {
  description = "Lambda VPC placement scope"
  type        = string
  default     = "required"
}

variable "vpc_subnet_ids" {
  description = "Private subnet IDs used when lambda_vpc_scope is all"
  type        = list(string)
  default     = []
}

variable "vpc_security_group_ids" {
  description = "Security group IDs used when lambda_vpc_scope is all"
  type        = list(string)
  default     = []
}

variable "web_acl_arn" {
  description = "ARN of a regional AWS WAFv2 web ACL. Empty leaves the user pool without AWS WAF."
  type        = string
  default     = ""
}

variable "waf_enabled" {
  description = "Whether to associate the user pool with AWS WAF"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
