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

variable "neptune_cluster_arn" {
  description = "Neptune cluster ARN for IAM policy"
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

variable "agent_questions_table_name" {
  description = "DynamoDB table name for agent questions"
  type        = string
  default     = ""
}

variable "agent_questions_table_arn" {
  description = "DynamoDB table ARN for agent questions (scoped IAM permission for the questions Lambda)"
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

# ---------------------------------------------------------------------------
# ECS / IAM scoping inputs for the agents-orchestrator role.
#
# The agents Lambda launches ECS Fargate tasks via RunTask and must pass the
# task + execution roles to the ECS service. Exposing these ARNs as variables
# lets us scope the IAM policy tightly (specific cluster, specific task-def
# family, specific task/execution roles) instead of Resource = "*".
# ---------------------------------------------------------------------------

variable "ecs_cluster_arn" {
  description = "ARN of the ECS cluster used by agent tasks. Used as the ecs:cluster condition value to constrain RunTask/DescribeTasks/StopTask to this cluster only."
  type        = string
  default     = ""
}

variable "agent_task_definition_family_arn" {
  description = "Family ARN (without revision) of the agent task definition. Used in IAM Resource as '<family_arn>:*' so RunTask can launch any revision of this specific family without a policy update per revision."
  type        = string
  default     = ""
}

variable "agent_task_role_arn" {
  description = "ARN of the ECS task role passed to the agent container. Used to scope iam:PassRole so the Lambda can only pass this specific role."
  type        = string
  default     = ""
}

variable "agent_execution_role_arn" {
  description = "ARN of the ECS execution role used by Fargate to pull images and write logs. Used to scope iam:PassRole."
  type        = string
  default     = ""
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
