variable "enabled" {
  description = "Whether to create the AWS WAF web ACLs"
  type        = bool
}

variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment name"
  type        = string
}

variable "cloudfront_origin_secret" {
  description = "Secret injected by CloudFront as X-Origin-Verify and required by the REST API ACL"
  type        = string
  sensitive   = true
}

variable "body_content_exempt_paths" {
  description = "URI path prefixes where the Common Rule Set body-content rules (XSS, LFI, RFI, EC2 metadata SSRF) do not block. Empty keeps them blocking everywhere."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for path in var.body_content_exempt_paths : can(regex("^/[A-Za-z0-9._~/-]*/$", path)) && !strcontains(path, "..")])
    error_message = "Each body_content_exempt_paths entry must be an absolute path prefix ending in /, using only letters, digits and ._~/- (no ..)."
  }
}
