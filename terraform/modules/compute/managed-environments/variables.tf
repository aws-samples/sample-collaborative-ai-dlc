variable "project_name" {
  description = "Project name used in resource names"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "registry_table_name" {
  description = "Managed environment registry table name"
  type        = string
}

variable "registry_table_arn" {
  description = "Managed environment registry table ARN"
  type        = string
}

variable "core_image_uri" {
  description = "Protected AgentCore image repository URL"
  type        = string
}

variable "core_image_digest" {
  description = "Immutable protected AgentCore image digest"
  type        = string
}

variable "core_runtime_arn" {
  description = "Protected AgentCore runtime ARN"
  type        = string
}

variable "core_runtime_version" {
  description = "Protected AgentCore runtime version"
  type        = string
}

variable "runtime_compatibility_version" {
  description = "Protected runtime contract version"
  type        = string
}

variable "runtime_role_arn" {
  description = "Execution role used by managed AgentCore runtimes"
  type        = string
}

variable "runtime_network_mode" {
  description = "Network mode inherited by managed AgentCore runtimes"
  type        = string
}

variable "runtime_subnet_ids" {
  description = "Subnets inherited by managed AgentCore runtimes"
  type        = list(string)
}

variable "runtime_security_group_ids" {
  description = "Security groups inherited by managed AgentCore runtimes"
  type        = list(string)
}

variable "runtime_environment_variables" {
  description = "Protected environment variables inherited by managed AgentCore runtimes"
  type        = map(string)
}

variable "core_repository_arn" {
  description = "Protected AgentCore ECR repository ARN"
  type        = string
}

variable "environment_repository_name" {
  description = "Managed environment ECR repository name"
  type        = string
}

variable "environment_repository_url" {
  description = "Managed environment ECR repository URL"
  type        = string
}

variable "environment_repository_arn" {
  description = "Managed environment ECR repository ARN"
  type        = string
}

variable "cors_allowed_origins" {
  description = "Comma-separated CORS origins"
  type        = string
}

variable "tags" {
  description = "Tags applied to resources"
  type        = map(string)
  default     = {}
}
