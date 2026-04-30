variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
}

variable "connections_table_name" {
  description = "DynamoDB connections table name"
  type        = string
}

variable "connections_table_arn" {
  description = "DynamoDB connections table ARN"
  type        = string
}

variable "websocket_api_endpoint" {
  description = "WebSocket API endpoint URL"
  type        = string
}

variable "websocket_execution_arn" {
  description = "WebSocket API execution ARN"
  type        = string
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

