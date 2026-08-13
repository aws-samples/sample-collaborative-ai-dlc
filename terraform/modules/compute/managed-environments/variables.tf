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

variable "core_image_size_bytes" {
  description = "Compressed size of the protected AgentCore image"
  type        = number
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

variable "neptune_endpoint" {
  description = "Neptune endpoint used by the destructive environment reset"
  type        = string
}

variable "neptune_cluster_resource_id" {
  description = "Neptune cluster resource id used for IAM authentication"
  type        = string
}

variable "vpc_subnet_ids" {
  description = "Private subnets for the environment reset Lambda"
  type        = list(string)
}

variable "vpc_security_group_ids" {
  description = "Security groups for the environment reset Lambda"
  type        = list(string)
}

variable "v2_executions_table_name" {
  description = "Intent execution table name"
  type        = string
}

variable "v2_executions_table_arn" {
  description = "Intent execution table ARN"
  type        = string
}

variable "v2_orchestrator_qualified_name" {
  description = "Qualified durable orchestrator function name"
  type        = string
}

variable "v2_orchestrator_qualified_arn" {
  description = "Qualified durable orchestrator function ARN"
  type        = string
}

variable "tags" {
  description = "Tags applied to resources"
  type        = map(string)
  default     = {}
}
