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

variable "building_blocks_lambda_invoke_arn" {
  description = "Invoke ARN of the building-blocks CRUD Lambda"
  type        = string
}
variable "building_blocks_lambda_name" {
  description = "Name of the building-blocks CRUD Lambda"
  type        = string
}

variable "workflows_lambda_invoke_arn" {
  description = "Invoke ARN of the workflows composition Lambda"
  type        = string
}
variable "workflows_lambda_name" {
  description = "Name of the workflows composition Lambda"
  type        = string
}

variable "intents_lambda_invoke_arn" {
  description = "Invoke ARN of the v2 intents Lambda"
  type        = string
}
variable "intents_lambda_name" {
  description = "Name of the v2 intents Lambda"
  type        = string
}

variable "agent_questions_table_name" {
  description = "Name of the agent questions DynamoDB table"
  type        = string
  default     = ""
}

variable "agents_lambda_role_arn" {
  description = "ARN of the IAM role dedicated to the agents Lambda (agents-orchestrator). This role is the most privileged Lambda role (Neptune + multiple DDB tables + SSM agent-settings + AgentCore invoke) and is intentionally isolated from the other REST-API Lambdas."
  type        = string
  default     = ""
}

variable "agentcore_runtime_arn" {
  description = "AgentCore v2 stage-executor runtime ARN. The agents Lambda invokes its `capabilities` command (GET /agents/capabilities?models=1) to discover Kiro's model list + per-CLI auth state. Empty on v1-only stacks."
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

variable "bitbucket_lambda_invoke_arn" {
  description = "Invoke ARN of the bitbucket Lambda"
  type        = string
  default     = ""
}

variable "bitbucket_lambda_name" {
  description = "Name of the bitbucket Lambda function"
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




variable "agent_outputs_table_name" {
  description = "DynamoDB agent outputs table name"
  type        = string
  default     = ""
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
  description = "An attribute of the aws_api_gateway_account resource (its cloudwatch_role_arn). The value is unused — it is interpolated into the stage description to create an implicit dependency so the REST API stage waits for account-level CloudWatch logging to be configured."
  type        = string
}
