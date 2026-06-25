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

variable "neptune_endpoint" {
  description = "Neptune cluster endpoint"
  type        = string
}

variable "neptune_cluster_resource_id" {
  description = "Neptune cluster resource ID for IAM DB authentication"
  type        = string
}

variable "artifacts_bucket_name" {
  description = "S3 bucket holding block bodies + the commit-pinned runtime snapshot"
  type        = string
}

variable "artifacts_bucket_arn" {
  description = "ARN of the artifacts bucket"
  type        = string
}

variable "blocks_table_name" {
  description = "DynamoDB blocks table (workflow + block definitions) name"
  type        = string
}

variable "blocks_table_arn" {
  description = "ARN of the blocks table"
  type        = string
  default     = ""
}

variable "connections_table_name" {
  description = "WebSocket connections table name (for realtime fan-out)"
  type        = string
  default     = ""
}

variable "connections_table_arn" {
  description = "ARN of the connections table"
  type        = string
  default     = ""
}

variable "websocket_endpoint" {
  description = "API Gateway Management API endpoint for the realtime websocket"
  type        = string
  default     = ""
}

variable "websocket_execution_arn" {
  description = "Execution ARN of the websocket API (for execute-api:ManageConnections)"
  type        = string
  default     = ""
}

variable "aidlc_repo_ref" {
  description = "Pinned awslabs/aidlc-workflows ref the runtime snapshot was seeded from"
  type        = string
}

variable "bedrock_model" {
  description = "Default Bedrock inference profile id for stage agents"
  type        = string
}

variable "bedrock_bearer_token_ssm_name" {
  description = "SSM parameter name holding the Bedrock bearer token (Claude/Kiro auth)"
  type        = string
  default     = ""
}

variable "kiro_api_key_ssm_name" {
  description = "SSM parameter name holding the Kiro API key"
  type        = string
  default     = ""
}

variable "agent_settings_ssm_arns" {
  description = "ARNs of the SSM parameters the runtime may read at startup (bearer token, api key, models)"
  type        = list(string)
  default     = []
}

# AgentCore Runtime network mode. NOTE: Neptune lives in a private VPC. If the
# runtime only supports PUBLIC networking in your region/account, the container
# cannot reach Neptune directly — see docs/v2-open.md §4. Switch to the VPC mode
# (and wire subnets/security groups) once confirmed available.
variable "network_mode" {
  description = "AgentCore Runtime network mode (PUBLIC or VPC)"
  type        = string
  default     = "PUBLIC"
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
