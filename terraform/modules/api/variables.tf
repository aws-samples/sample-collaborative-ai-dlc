variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
}

variable "cognito_user_pool_arn" {
  description = "ARN of the Cognito User Pool for authorization"
  type        = string
}

variable "projects_lambda_invoke_arn" {
  description = "Invoke ARN of the projects Lambda"
  type        = string
}

variable "projects_lambda_name" {
  description = "Name of the projects Lambda function"
  type        = string
}

variable "users_lambda_invoke_arn" {
  description = "Invoke ARN of the users Lambda"
  type        = string
}

variable "users_lambda_name" {
  description = "Name of the users Lambda function"
  type        = string
}

variable "sprints_lambda_invoke_arn" {
  type = string
}
variable "sprints_lambda_name" {
  type = string
}
variable "requirements_lambda_invoke_arn" {
  type = string
}
variable "requirements_lambda_name" {
  type = string
}
variable "user_stories_lambda_invoke_arn" {
  type = string
}
variable "user_stories_lambda_name" {
  type = string
}
variable "tasks_lambda_invoke_arn" {
  type = string
}
variable "tasks_lambda_name" {
  type = string
}
variable "general_info_lambda_invoke_arn" {
  type = string
}
variable "general_info_lambda_name" {
  type = string
}
variable "code_files_lambda_invoke_arn" {
  type = string
}
variable "code_files_lambda_name" {
  type = string
}
variable "reviews_lambda_invoke_arn" {
  type = string
}
variable "reviews_lambda_name" {
  type = string
}
variable "questions_lambda_invoke_arn" {
  type = string
}
variable "questions_lambda_name" {
  type = string
}
variable "sprint_graph_lambda_invoke_arn" {
  type = string
}
variable "sprint_graph_lambda_name" {
  type = string
}

variable "timeline_events_lambda_invoke_arn" {
  type = string
}
variable "timeline_events_lambda_name" {
  type = string
}

variable "discussions_lambda_invoke_arn" {
  type = string
}
variable "discussions_lambda_name" {
  type = string
}

variable "enable_agents" {
  description = "Whether to enable agent API endpoints"
  type        = bool
  default     = true
}

variable "agent_questions_table_name" {
  description = "Name of the agent questions DynamoDB table"
  type        = string
  default     = ""
}

variable "agents_lambda_role_arn" {
  description = "ARN of the IAM role dedicated to the agents Lambda (agents-orchestrator). This role is the most privileged Lambda role (Neptune + multiple DDB tables + SSM agent-settings + ECS RunTask + IAM PassRole) and is intentionally isolated from the other 15 REST-API Lambdas."
  type        = string
  default     = ""
}

variable "gitlab_oauth_secret_name" {
  description = "Secrets Manager secret name holding the GitLab OAuth client credentials. Used by the agents Lambda's POST /git/refresh-token to refresh expired GitLab access tokens for long-running construction jobs."
  type        = string
  default     = ""
}

variable "gitlab_redirect_uri" {
  description = "GitLab OAuth redirect URI. Required on the refresh_token grant (must match the original authorization request) — without it GitLab rejects refresh with invalid_grant. Used by the agents Lambda's POST /git/refresh-token."
  type        = string
  default     = ""
}

variable "github_lambda_invoke_arn" {
  description = "Invoke ARN of the github Lambda"
  type        = string
  default     = ""
}

variable "github_lambda_name" {
  description = "Name of the github Lambda function"
  type        = string
  default     = ""
}

variable "gitlab_lambda_invoke_arn" {
  description = "Invoke ARN of the gitlab Lambda"
  type        = string
  default     = ""
}

variable "gitlab_lambda_name" {
  description = "Name of the gitlab Lambda function"
  type        = string
  default     = ""
}

variable "trackers_lambda_invoke_arn" {
  description = "Invoke ARN of the trackers Lambda"
  type        = string
  default     = ""
}

variable "trackers_lambda_name" {
  description = "Name of the trackers Lambda function"
  type        = string
  default     = ""
}

variable "cognito_users_lambda_invoke_arn" {
  description = "Invoke ARN of the cognito-users Lambda"
  type        = string
}

variable "cognito_users_lambda_name" {
  description = "Name of the cognito-users Lambda function"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for Lambda VPC config"
  type        = list(string)
  default     = []
}

variable "lambda_security_group_ids" {
  description = "Security group IDs for Lambda VPC config"
  type        = list(string)
  default     = []
}

variable "neptune_endpoint" {
  description = "Neptune cluster endpoint"
  type        = string
  default     = ""
}

variable "ecs_cluster_arn" {
  description = "ARN of the ECS cluster for running agent tasks"
  type        = string
  default     = ""
}

variable "agent_task_definition_arn" {
  description = "ARN of the unified agent ECS task definition"
  type        = string
  default     = ""
}

variable "agent_security_group_id" {
  description = "Security group ID for agent ECS tasks"
  type        = string
  default     = ""
}

variable "agent_pool_table_name" {
  description = "DynamoDB agent pool table name"
  type        = string
  default     = ""
}

variable "git_connections_table_name" {
  description = "DynamoDB table name for user GitHub connections"
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

variable "agent_outputs_table_name" {
  description = "DynamoDB agent outputs table name"
  type        = string
  default     = ""
}

variable "pool_size" {
  description = "Number of warm pool workers"
  type        = number
  default     = 5
}

variable "ecr_repository_name" {
  description = "ECR repository name for agents - used to resolve latest image version"
  type        = string
  default     = ""
}

variable "agent_image_tag" {
  description = "Current agent Docker image tag, used as POOL_VERSION for the agents Lambda"
  type        = string
  default     = "unknown"
}

variable "cors_allowed_origins" {
  description = "Comma-separated list of allowed CORS origins (e.g. https://d3c2j...cloudfront.net,http://localhost:5173)"
  type        = string
  default     = "*"
}

variable "cloudfront_origin_secret" {
  description = "Shared secret that CloudFront injects as the X-Origin-Verify header. When non-empty, a REST API resource policy is attached that denies every request whose X-Origin-Verify header does not equal this value, so the API Gateway invoke URL is only reachable via the CloudFront distribution."
  type        = string
  default     = ""
  sensitive   = true
}

variable "enable_cloudfront_origin_policy" {
  description = "Whether to attach a CloudFront origin-verify resource policy to the API Gateway. Separate from the secret so the value is known at plan time."
  type        = bool
  default     = false
}

variable "api_gateway_account_id" {
  description = "ID of the aws_api_gateway_account resource. Passed through to create a depends_on edge so the REST API stage waits for account-level CloudWatch logging to be configured."
  type        = string
}

variable "connections_table_name" {
  description = "DynamoDB table name for WebSocket connections (server-origin event fanout)"
  type        = string
  default     = ""
}

variable "websocket_api_endpoint_https" {
  description = "WebSocket API management endpoint (https:// form) for PostToConnection fanout"
  type        = string
  default     = ""
}
