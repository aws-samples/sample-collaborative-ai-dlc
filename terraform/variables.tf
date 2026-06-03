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

variable "neptune_name_prefix" {
  description = "Override name_prefix for the Neptune module. Used for state-compatible migrations where the cluster was created with a different prefix (e.g. staging cluster created with a '-dev' prefix). Empty string uses the default '<project>-<environment>'."
  type        = string
  default     = ""
}
