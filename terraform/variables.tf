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
  default     = "fde1e1af7aae16f4c4defc991abaa3877ee2ac26"
}


