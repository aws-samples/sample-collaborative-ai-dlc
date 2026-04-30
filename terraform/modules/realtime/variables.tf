variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
}

variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  type        = string
}

variable "cognito_client_id" {
  description = "Cognito User Pool Client ID"
  type        = string
}

variable "connections_table_name" {
  description = "DynamoDB table name for WebSocket connections"
  type        = string
}

variable "connections_table_arn" {
  description = "DynamoDB table ARN for WebSocket connections"
  type        = string
}

variable "websocket_stage_name" {
  description = "Stage name for the WebSocket API Gateway (used as the URL path segment)"
  type        = string
  default     = "ws"
}