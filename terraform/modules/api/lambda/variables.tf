variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for Lambda functions"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for Lambda VPC config"
  type        = list(string)
}

variable "neptune_endpoint" {
  description = "Neptune cluster endpoint"
  type        = string
}


variable "neptune_cluster_resource_id" {
  description = "Neptune cluster resource ID for IAM auth"
  type        = string
}

variable "dynamodb_table_arns" {
  description = "List of DynamoDB table ARNs for IAM policy"
  type        = list(string)
}

variable "artifacts_bucket_name" {
  description = "S3 bucket name for artifacts"
  type        = string
}

variable "artifacts_bucket_arn" {
  description = "S3 bucket ARN for artifacts"
  type        = string
}

variable "blocks_table_name" {
  description = "Name of the building-blocks table"
  type        = string
}

variable "blocks_table_arn" {
  description = "ARN of the building-blocks table"
  type        = string
}

variable "aidlc_repo_ref" {
  description = "Pinned ref (commit SHA, tag, or branch) of awslabs/aidlc-workflows the seed-blocks lambda fetches the baseline from"
  type        = string
  default     = "ba0cfe999856033ecb909a9135b46fe10811bf55"
}

variable "github_oauth_secret_name" {
  description = "Secrets Manager secret name for GitHub OAuth credentials"
  type        = string
  default     = ""
}

variable "github_oauth_secret_arn" {
  description = "Secrets Manager secret ARN for GitHub OAuth credentials"
  type        = string
  default     = ""
}

variable "github_app_private_key_secret_name" {
  description = "Secrets Manager secret name for the GitHub App private key (PEM)"
  type        = string
  default     = ""
}

variable "github_app_private_key_secret_arn" {
  description = "Secrets Manager secret ARN for the GitHub App private key (PEM)"
  type        = string
  default     = ""
}

variable "github_auth_mode_param_name" {
  description = "SSM parameter name holding the platform-wide GitHub auth mode ('oauth' | 'app')"
  type        = string
  default     = ""
}

variable "github_auth_mode_param_arn" {
  description = "SSM parameter ARN holding the platform-wide GitHub auth mode"
  type        = string
  default     = ""
}

variable "github_app_config_param_name" {
  description = "SSM parameter name holding the GitHub App config JSON ({appId, installationId})"
  type        = string
  default     = ""
}

variable "github_app_config_param_arn" {
  description = "SSM parameter ARN holding the GitHub App config JSON"
  type        = string
  default     = ""
}

variable "git_connections_table_name" {
  description = "DynamoDB table name for git connections"
  type        = string
  default     = ""
}

variable "git_connections_table_arn" {
  description = "DynamoDB table ARN for git connections"
  type        = string
  default     = ""
}

variable "git_provider_connections_table_name" {
  description = "DynamoDB table name for per-provider git connections (composite key userId+provider)"
  type        = string
  default     = ""
}

variable "git_provider_connections_table_arn" {
  description = "DynamoDB table ARN for per-provider git connections"
  type        = string
  default     = ""
}

variable "tracker_connections_table_name" {
  description = "DynamoDB table name for tracker connections (Jira / GitHub Issues / …)"
  type        = string
  default     = ""
}

variable "tracker_connections_table_arn" {
  description = "DynamoDB table ARN for tracker connections"
  type        = string
  default     = ""
}

variable "github_redirect_uri" {
  description = "OAuth redirect URI for GitHub callback"
  type        = string
  default     = ""
}

variable "gitlab_oauth_secret_name" {
  description = "Secrets Manager secret name for GitLab OAuth credentials"
  type        = string
  default     = ""
}

variable "gitlab_oauth_secret_arn" {
  description = "Secrets Manager secret ARN for GitLab OAuth credentials"
  type        = string
  default     = ""
}

variable "gitlab_redirect_uri" {
  description = "OAuth redirect URI for GitLab callback"
  type        = string
  default     = ""
}

variable "bitbucket_oauth_secret_name" {
  description = "Secrets Manager secret name for Bitbucket OAuth credentials"
  type        = string
  default     = ""
}

variable "bitbucket_oauth_secret_arn" {
  description = "Secrets Manager secret ARN for Bitbucket OAuth credentials"
  type        = string
  default     = ""
}

variable "bitbucket_redirect_uri" {
  description = "OAuth redirect URI for Bitbucket callback"
  type        = string
  default     = ""
}

variable "jira_oauth_secret_name" {
  description = "Secrets Manager secret name for Jira Cloud OAuth credentials"
  type        = string
  default     = ""
}

variable "jira_oauth_secret_arn" {
  description = "Secrets Manager secret ARN for Jira Cloud OAuth credentials"
  type        = string
  default     = ""
}

variable "jira_redirect_uri" {
  description = "OAuth redirect URI for Jira Cloud callback"
  type        = string
  default     = ""
}



variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID for listing users"
  type        = string
}

variable "cognito_user_pool_arn" {
  description = "Cognito User Pool ARN for IAM permissions"
  type        = string
}

variable "cors_allowed_origins" {
  description = "Comma-separated list of allowed CORS origins (e.g. https://d3c2j...cloudfront.net,http://localhost:5173)"
  type        = string
  default     = "*"
}

variable "realtime_doc_secret_param_arn" {
  description = "SSM parameter ARN of the realtime doc-token secret (discussions lambda reads it to sign scope tokens)"
  type        = string
}

variable "realtime_doc_secret_param_name" {
  description = "SSM parameter name of the realtime doc-token secret"
  type        = string
}

variable "discussion_locks_table_name" {
  description = "DynamoDB table name for discussion creation guards / message guards / assist locks"
  type        = string
}

variable "discussion_locks_table_arn" {
  description = "DynamoDB table ARN for discussion locks"
  type        = string
}

variable "discussion_read_state_table_name" {
  description = "DynamoDB table name for per-user discussion read cursors"
  type        = string
}

variable "discussion_read_state_table_arn" {
  description = "DynamoDB table ARN for discussion read state"
  type        = string
}

variable "connections_table_name" {
  description = "DynamoDB table name for WebSocket connections (discussions fan-out)"
  type        = string
}

variable "connections_table_arn" {
  description = "DynamoDB table ARN for WebSocket connections"
  type        = string
}

variable "websocket_api_endpoint_https" {
  description = "WebSocket API management endpoint (https:// form) for PostToConnection fan-out"
  type        = string
}

variable "websocket_execution_arn" {
  description = "Execution ARN of the WebSocket API (ManageConnections IAM scope)"
  type        = string
}

# ── v2 intents + orchestrator ──

variable "v2_executions_table_name" {
  description = "DynamoDB table name for the v2 process/execution state"
  type        = string
}

variable "v2_executions_table_arn" {
  description = "DynamoDB table ARN for the v2 process/execution state"
  type        = string
}

variable "yjs_documents_table_name" {
  description = "DynamoDB table name for realtime Yjs documents (intent-scoped docs are removed on intent delete)"
  type        = string
}

variable "yjs_documents_table_arn" {
  description = "DynamoDB table ARN for realtime Yjs documents"
  type        = string
}

variable "agentcore_runtime_arn" {
  description = "AgentCore stage-executor runtime ARN the orchestrator invokes"
  type        = string
}
