variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
}

variable "powertools_service_name" {
  description = "Service name included in Powertools structured logs"
  type        = string
}

variable "powertools_log_level" {
  description = "Log level for Powertools structured logging"
  type        = string

  validation {
    condition     = contains(["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL", "SILENT"], var.powertools_log_level)
    error_message = "powertools_log_level must be one of DEBUG, INFO, WARN, ERROR, CRITICAL or SILENT."
  }
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
variable "doc_token_enforce" {
  description = "Enforce realtime scope tokens on the app-WS connect path (operational kill switch)"
  type        = bool
  default     = true
}
