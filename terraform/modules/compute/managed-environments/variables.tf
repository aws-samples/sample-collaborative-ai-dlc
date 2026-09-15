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

variable "tags" {
  description = "Tags applied to resources"
  type        = map(string)
  default     = {}
}

variable "instances_compute_enabled" {
  description = "Allow managed environments to target the AgentCore Instances compute type (EC2 managed instances via capacity providers)"
  type        = bool
  default     = false
}

variable "core_image_uri_amd64" {
  description = "ECR repository URI of the amd64 core image (required for x86_64 environments)"
  type        = string
  default     = ""
}

variable "core_image_digest_amd64" {
  description = "Digest of the amd64 core image (required for x86_64 environments)"
  type        = string
  default     = ""
}

variable "instances_allowed_instance_types" {
  description = "EC2 instance types allowed on the platform-managed capacity providers"
  type        = list(string)
  default     = ["t3.large"]
}

variable "instances_workspace_gib" {
  description = "Size in GiB of the persistent EBS workspace volume on Instances sessions"
  type        = number
  default     = 50
}
