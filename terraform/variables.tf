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
  default     = "ba0cfe999856033ecb909a9135b46fe10811bf55"
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

variable "github_app_id" {
  description = "GitHub App ID. Used by the agents Lambda to mint installation tokens for projects with git_auth_mode='app'. Empty disables App auth."
  type        = string
  default     = ""
}

variable "github_app_installation_id" {
  description = "GitHub App installation ID for the target org/repos. Empty disables App auth."
  type        = string
  default     = ""
}

variable "github_app_allowed_repos" {
  description = "Comma-separated owner/repo allowlist permitted to use GitHub App auth (git_auth_mode='app'). Empty disables App auth. Enforced by the projects and agents Lambdas."
  type        = string
  default     = ""
}
