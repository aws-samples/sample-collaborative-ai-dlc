variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
}

variable "kms_key_arn" {
  description = "Optional customer-managed KMS key ARN. When set it encrypts the unsubscribe signing secret; empty uses the AWS-managed key."
  type        = string
  default     = ""
}

# Data-plane inputs consumed by the downstream notification units, which add
# their own <unit>.tf files to this module.
variable "notifications_table_name" {
  description = "Name of the notifications (inbox) table"
  type        = string
}

variable "notifications_table_arn" {
  description = "ARN of the notifications (inbox) table"
  type        = string
}

variable "preferences_table_name" {
  description = "Name of the namespaced preferences table"
  type        = string
}

variable "preferences_table_arn" {
  description = "ARN of the namespaced preferences table"
  type        = string
}

variable "v2_executions_stream_arn" {
  description = "Stream ARN of the v2 executions table (NEW_AND_OLD_IMAGES)"
  type        = string
}

variable "escalation_worker_timeout_seconds" {
  description = "Timeout of the Lambda that consumes the escalation queue. The queue visibility timeout is six times this value."
  type        = number
  default     = 30

  validation {
    condition     = var.escalation_worker_timeout_seconds >= 1 && var.escalation_worker_timeout_seconds <= 900
    error_message = "escalation_worker_timeout_seconds must be between 1 and 900 (the Lambda maximum)."
  }
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
