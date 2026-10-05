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
