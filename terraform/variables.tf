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

variable "git_author_name" {
  description = "Git author name used by agents for commits they create"
  type        = string
  default     = "AI-DLC Agent"
}

variable "git_author_email" {
  description = "Git author email used by agents for commits they create"
  type        = string
  default     = "ai-dlc@example.com"
}
