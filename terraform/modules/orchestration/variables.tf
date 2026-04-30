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

variable "ecs_cluster_arn" {
  description = "ECS cluster ARN"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for agent tasks"
  type        = list(string)
}

variable "agent_security_group_id" {
  description = "Security group ID for agent tasks"
  type        = string
}

variable "agent_execution_role_arn" {
  description = "ARN of the agent execution IAM role"
  type        = string
}

variable "agent_task_role_arn" {
  description = "ARN of the agent task IAM role"
  type        = string
}

variable "agent_task_definition_arn" {
  description = "ARN of the unified Agent task definition (revision-pinned, used in Step Functions Parameters)"
  type        = string
}

variable "agent_task_definition_family_arn" {
  description = "ARN of the Agent task definition without the revision suffix (used as base for IAM 'family:*' scoping of ecs:RunTask)"
  type        = string
  default     = ""
}

variable "agent_questions_table_name" {
  description = "DynamoDB agent questions table name"
  type        = string
}

variable "agent_questions_table_arn" {
  description = "DynamoDB agent questions table ARN"
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

variable "agent_outputs_table_name" {
  description = "DynamoDB agent outputs table name"
  type        = string
}

variable "agent_outputs_table_arn" {
  description = "DynamoDB agent outputs table ARN"
  type        = string
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

