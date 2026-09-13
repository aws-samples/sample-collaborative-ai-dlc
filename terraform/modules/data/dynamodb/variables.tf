variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key ARN for DynamoDB encryption. Empty uses the AWS-owned service default."
  type        = string
  default     = ""
}

variable "deletion_protection" {
  description = "Protect durable DynamoDB tables from deletion"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
