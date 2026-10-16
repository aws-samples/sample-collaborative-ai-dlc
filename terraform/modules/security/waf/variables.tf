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
