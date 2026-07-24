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

variable "codex_model" {
  description = "Default Codex-on-Bedrock model id (exact openai.* id, e.g. openai.gpt-5.5) seeded into the cli-models SSM parameter (empty = none)"
  type        = string
  default     = "openai.gpt-5.5"
}

variable "aidlc_repo_ref" {
  description = "Pinned ref (commit SHA/tag/branch) of awslabs/aidlc-workflows the seed + AgentCore runtime use. Keep in sync with the seed-blocks lambda."
  type        = string
  default     = "83ed7a812c4024904f2c5e4d744e28077e0a5acd"
}


