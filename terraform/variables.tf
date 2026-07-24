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

variable "docker_build_args" {
  description = "Optional arguments for local Docker image builds, such as HTTP_PROXY, HTTPS_PROXY, and NO_PROXY. Sensitive values are hidden in CLI output but remain stored in Terraform state."
  type        = map(string)
  default     = {}
  sensitive   = true
}
