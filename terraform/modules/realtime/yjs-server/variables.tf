variable "project_name" {
  description = "Name of the project"
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
  description = "Private subnet IDs for ECS tasks and ALB"
  type        = list(string)
}

variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID used to verify JWTs on WebSocket upgrade"
  type        = string
}

variable "cognito_client_id" {
  description = "Cognito User Pool Client ID used to verify JWTs on WebSocket upgrade"
  type        = string
}

