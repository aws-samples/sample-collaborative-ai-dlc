variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "yjs_alb_dns_name" {
  description = "DNS name of the Yjs ALB"
  type        = string
  default     = ""
}

variable "access_logs_bucket_domain_name" {
  description = "Domain name of the shared access logging S3 bucket"
  type        = string
}
variable "yjs_alb_arn" {
  description = "ARN of the Yjs ALB (used for VPC Origin)"
  type        = string
  default     = ""
}
variable "yjs_enabled" {
  description = "Whether to create the Yjs VPC Origin and CloudFront behavior"
  type        = bool
  default     = false
}

variable "api_gateway_domain_name" {
  description = "Domain name of the API Gateway used as CloudFront origin for /api/* and /github/callback. Empty disables API routing through CloudFront."
  type        = string
  default     = ""
}

variable "api_gateway_stage_path" {
  description = "Stage path prefix of the API Gateway (e.g. /staging) used as CloudFront origin_path so /api/* rewrites to /<stage>/*."
  type        = string
  default     = ""
}

variable "websocket_domain_name" {
  description = "Domain name of the WebSocket API Gateway. Empty disables WebSocket routing through CloudFront."
  type        = string
  default     = ""
}