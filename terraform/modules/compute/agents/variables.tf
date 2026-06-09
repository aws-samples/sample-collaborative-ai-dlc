variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for agent tasks"
  type        = list(string)
}

variable "neptune_endpoint" {
  description = "Neptune cluster endpoint"
  type        = string
}

variable "neptune_cluster_arn" {
  description = "Neptune cluster ARN"
  type        = string
}

variable "neptune_cluster_resource_id" {
  description = "Neptune cluster resource ID for IAM DB authentication"
  type        = string
}

variable "artifacts_bucket_name" {
  description = "S3 bucket name for artifacts"
  type        = string
}

variable "artifacts_bucket_arn" {
  description = "S3 bucket ARN for artifacts"
  type        = string
}

variable "code_snapshots_bucket_name" {
  description = "S3 bucket name for code snapshots"
  type        = string
}

variable "code_snapshots_bucket_arn" {
  description = "S3 bucket ARN for code snapshots"
  type        = string
}

variable "agent_questions_table_arn" {
  description = "DynamoDB agent questions table ARN"
  type        = string
}

variable "submit_question_lambda_name" {
  description = "Name of the submit question Lambda function"
  type        = string
  default     = ""
}

variable "submit_question_lambda_arn" {
  description = "ARN of the submit question Lambda function"
  type        = string
  default     = ""
}

variable "agent_outputs_table_name" {
  description = "DynamoDB agent outputs table name"
  type        = string
  default     = ""
}

variable "agent_outputs_table_arn" {
  description = "DynamoDB agent outputs table ARN"
  type        = string
  default     = ""
}

variable "git_connections_table_name" {
  description = "DynamoDB git connections table name"
  type        = string
  default     = ""
}

variable "git_connections_table_arn" {
  description = "DynamoDB git connections table ARN"
  type        = string
  default     = ""
}

variable "agent_questions_table_name" {
  description = "DynamoDB agent questions table name"
  type        = string
  default     = ""
}

variable "connections_table_name" {
  description = "DynamoDB connections table name (for WebSocket broadcast)"
  type        = string
  default     = ""
}

variable "connections_table_arn" {
  description = "DynamoDB connections table ARN"
  type        = string
  default     = ""
}

variable "websocket_endpoint" {
  description = "WebSocket API endpoint for real-time communication"
  type        = string
  default     = ""
}

variable "websocket_execution_arn" {
  description = "WebSocket API execution ARN for IAM permissions"
  type        = string
  default     = ""
}

variable "ecs_cluster_arn" {
  description = "ARN of the ECS cluster to run agent tasks"
  type        = string
  default     = ""
}

variable "agent_pool_table_name" {
  description = "DynamoDB agent pool table name"
  type        = string
  default     = ""
}

variable "agent_pool_table_arn" {
  description = "DynamoDB agent pool table ARN"
  type        = string
  default     = ""
}

variable "pool_size" {
  description = "Number of warm pool workers to keep running"
  type        = number
  default     = 5
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

variable "agents_lambda_name" {
  description = "Name of the agents Lambda function (for MCP tools to invoke)"
  type        = string
  default     = ""
}

variable "agents_lambda_arn" {
  description = "ARN of the agents Lambda function"
  type        = string
  default     = ""
}

variable "create_pr_lambda_name" {
  description = "Name of the create-pr Lambda function"
  type        = string
  default     = ""
}

variable "create_pr_lambda_arn" {
  description = "ARN of the create-pr Lambda function"
  type        = string
  default     = ""
}

variable "kiro_model" {
  description = "Model identifier to configure in kiro-cli (e.g. amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0)"
  type        = string
  default     = ""
}

variable "bedrock_model" {
  description = "Bedrock inference profile ID for the primary model (used by claude and opencode drivers). E.g. us.anthropic.claude-sonnet-4-6"
  type        = string
  default     = "us.anthropic.claude-sonnet-4-6"
}

variable "bedrock_small_fast_model" {
  description = "Bedrock inference profile ID for the small/fast model (used by claude driver). E.g. us.anthropic.claude-haiku-4-5-20251001-v1:0"
  type        = string
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "git_author_name" {
  description = "Git author name used by agents for commits they create (pool-worker reads GIT_AUTHOR_NAME)"
  type        = string
  default     = "AI-DLC Agent"
}

variable "git_author_email" {
  description = "Git author email used by agents for commits they create (pool-worker reads GIT_AUTHOR_EMAIL)"
  type        = string
  default     = "ai-dlc@example.com"
}
